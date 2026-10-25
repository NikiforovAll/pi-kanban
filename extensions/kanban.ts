import { dirname, join as joinPath } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { boardFetch, boardTerminalId, boardUrl, errorText, kanbanDir, lib, okJson, postJson, terminalToken } from "./tools/board-api.js";
import { linkDoc, previewDoc, registerPaneTools, resolveTarget } from "./tools/panes.js";
import { registerDispatch } from "./tools/dispatch.js";
import { registerInbox } from "./tools/inbox.js";
import { registerScratchpad } from "./tools/scratchpad.js";
import { ASK_CLOSE, ASK_OPEN, ASK_TOOL, type AskOpen, registerShowAsk } from "./tools/show-ask.js";

type Line = Record<string, unknown>;

type SessionLines = { sessionId: string; lines: Line[] } | null;

const taskStore = lib("task-store.js") as {
	reconcileFromSnapshot: (sessionId: string, snapshot: unknown[]) => Promise<void>;
};
const liveSessions = lib("live-sessions.js") as {
	writeLiveSession: (dir: string, entry: Line) => Promise<void>;
	removeLiveSession: (dir: string, pid: number) => Promise<void>;
	removeLiveSessionSync: (dir: string, pid: number) => void;
	sweepDeadLiveSessions: (dir: string) => Promise<void>;
};
const agentLog = lib("agent-log.js") as {
	appendAgentLines: (dir: string, records: Line[]) => Promise<void>;
	promptMarker: (prompt: { kind: string; title?: string }, tool: { toolName: string; args: unknown } | undefined, cwd: string, now: string) => Line;
	writeWaiting: (dir: string, marker: Line) => Promise<void>;
	clearWaiting: (dir: string) => Promise<void>;
	markStopped: (dir: string) => Promise<void>;
	clearStopped: (dir: string) => Promise<void>;
};
const piAgents = lib("pi-agents.js") as {
	createSubagentTracker: () => {
		start: (sessionId: string, toolCallId: string, args: unknown, now: string) => Line[];
		update: (toolCallId: string, partial: unknown, now: string) => SessionLines;
		end: (toolCallId: string, result: unknown, isError: boolean, now: string) => SessionLines;
		asyncComplete: (payload: unknown, now: string) => Promise<SessionLines>;
	};
};

const { SESSION_ID_ENV } = lib("board-dir.js") as { SESSION_ID_ENV: string };

const LIVE_DIR = joinPath(kanbanDir(), "live");
const ACTIVITY_DIR = joinPath(kanbanDir(), "agent-activity");

// pi's default dir is <agentDir>/sessions/<encoded cwd>, which the board scans already. Only a
// dir pi was told to use (--session-dir, env, settings) goes in the live entry.
function ownSessionDir(dir: string): string | null {
	return dir && dirname(dir) !== joinPath(getAgentDir(), "sessions") ? dir : null;
}

// A pi in the board terminal already runs inside the board page.
const CAN_OPEN = !boardTerminalId();
const SUBCOMMANDS = CAN_OPEN ? ["open", "session"] : ["session"];

const SESSION_SUBCOMMANDS = [
	"open",
	"pin",
	"sticky-pin",
	"unpin",
	"view-doc",
	"link-doc",
] as const;
type SessionSub = (typeof SESSION_SUBCOMMANDS)[number];

// Whole commands, never an argument: Enter on a completion must not replace a typed path.
const COMPLETIONS = [...SUBCOMMANDS, ...SESSION_SUBCOMMANDS.map((s) => `session ${s}`)];

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

// The board reads the token from the hash and drops it from the address bar. A board started
// without the terminal has no token, and opens read-only.
async function boardPageUrl(): Promise<string> {
	const res = await boardFetch("/", { method: "HEAD" });
	if (!res.ok) throw new Error(await errorText(res));
	const url = boardUrl()!;
	try {
		return `${url}/#t=${terminalToken()}`;
	} catch {
		return url;
	}
}

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const EXIT_GUARD = Symbol.for("pi-kanban.live-exit-guard");

// A subagent child is shown on its parent's card, so it does not register as a live session.
function registerLiveState(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD) return;

	let session: { sessionId: string; cwd: string; sessionDir: string | null; name: string | null } | null = null;
	let status: "busy" | "idle" | "waiting" = "idle";
	let statusUpdatedAt = Date.now();
	let running = false;
	let openPrompts = 0;
	let queue: Promise<unknown> = Promise.resolve();
	let published = "";
	const toolsInFlight = new Map<string, { toolName: string; args: unknown }>();
	const subagents = piAgents.createSubagentTracker();

	const now = () => new Date().toISOString();
	const activityDir = (sessionId: string) => joinPath(ACTIVITY_DIR, sessionId);

	// Writes run one at a time, so the files change in the order the events came.
	function enqueue(label: string, job: () => Promise<unknown>) {
		queue = queue.then(job).catch((e: any) => console.warn(`pi-kanban: ${label} failed: ${e?.message ?? e}`));
	}

	function inActivityDir(label: string, job: (dir: string) => Promise<unknown>) {
		if (!session) return;
		const dir = activityDir(session.sessionId);
		enqueue(label, () => job(dir));
	}

	function appendLines(batch: SessionLines) {
		if (!batch?.lines.length) return;
		const dir = activityDir(batch.sessionId);
		enqueue("agent activity", () => agentLog.appendAgentLines(dir, batch.lines));
	}

	function publish(next?: typeof status) {
		if (next && next !== status) {
			status = next;
			statusUpdatedAt = Date.now();
		}
		if (!session) return;
		const entry = { sessionId: session.sessionId, pid: process.pid, cwd: session.cwd, sessionDir: session.sessionDir, startedAt: PROCESS_STARTED_AT, status, statusUpdatedAt, name: session.name };
		const text = JSON.stringify(entry);
		if (text === published) return;
		published = text;
		enqueue("live session", () => liveSessions.writeLiveSession(LIVE_DIR, entry));
	}

	const g = globalThis as Record<symbol, unknown>;
	if (!g[EXIT_GUARD]) {
		g[EXIT_GUARD] = true;
		process.once("exit", () => {
			try { liveSessions.removeLiveSessionSync(LIVE_DIR, process.pid); } catch {}
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		session = { sessionId, cwd: ctx.sessionManager.getCwd(), sessionDir: ownSessionDir(ctx.sessionManager.getSessionDir()), name: ctx.sessionManager.getSessionName() ?? null };
		running = false;
		openPrompts = 0;
		toolsInFlight.clear();
		enqueue("sweep", () => liveSessions.sweepDeadLiveSessions(LIVE_DIR));
		inActivityDir("waiting", agentLog.clearWaiting);
		publish("idle");
	});

	pi.on("session_info_changed", async (event) => {
		if (!session) return;
		session.name = event.name ?? null;
		publish();
	});

	// /new, /resume and /fork keep the process, and the next session_start rewrites its file.
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit" || !session) return;
		session = null;
		published = "";
		enqueue("live session", () => liveSessions.removeLiveSession(LIVE_DIR, process.pid));
	});

	pi.on("agent_start", async () => {
		if (!session) return;
		running = true;
		inActivityDir("stop marker", agentLog.clearStopped);
		publish("busy");
	});

	pi.on("agent_settled", async (event) => {
		if (!session) return;
		running = false;
		if (!event.aborted) inActivityDir("stop marker", agentLog.markStopped);
		publish(openPrompts ? "waiting" : "idle");
	});

	function openPrompt(prompt: { kind: string; title?: string }, tool?: { toolName: string; args: unknown }) {
		if (!session) return;
		openPrompts++;
		const marker = agentLog.promptMarker(prompt, tool, session.cwd, now());
		inActivityDir("waiting", (dir) => agentLog.writeWaiting(dir, marker));
		publish("waiting");
	}

	function closePrompt() {
		if (!session || openPrompts === 0 || --openPrompts > 0) return;
		inActivityDir("waiting", agentLog.clearWaiting);
		publish(running ? "busy" : "idle");
	}

	pi.on("ui_prompt_start", async (event) => openPrompt(event, [...toolsInFlight.values()].at(-1)));
	pi.on("ui_prompt_end", async () => closePrompt());

	pi.events.on(ASK_OPEN, (data) => {
		const { title, args } = data as AskOpen;
		openPrompt({ kind: "input", title }, { toolName: ASK_TOOL, args });
	});
	pi.events.on(ASK_CLOSE, () => closePrompt());

	pi.on("tool_execution_start", async (event) => {
		toolsInFlight.set(event.toolCallId, { toolName: event.toolName, args: event.args });
		if (!session || event.toolName !== "subagent") return;
		const { sessionId } = session;
		appendLines({ sessionId, lines: subagents.start(sessionId, event.toolCallId, event.args, now()) });
	});

	pi.on("tool_execution_update", async (event) => {
		appendLines(subagents.update(event.toolCallId, event.partialResult, now()));
	});

	pi.on("tool_execution_end", async (event) => {
		toolsInFlight.delete(event.toolCallId);
		appendLines(subagents.end(event.toolCallId, event.result, event.isError, now()));
	});

	// pi-subagents emits this in the parent process when an async run's result file appears.
	pi.events.on("subagent:async-complete", (data: unknown) => {
		enqueue("agent activity", async () => {
			const batch = await subagents.asyncComplete(data, now());
			if (batch?.lines.length) await agentLog.appendAgentLines(activityDir(batch.sessionId), batch.lines);
		});
	});
}

export default function kanbanExtension(pi: ExtensionAPI) {
	registerLiveState(pi);
	registerScratchpad(pi);
	registerShowAsk(pi);
	registerDispatch(pi);
	registerInbox(pi);

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "todo") return;
		const sessionId = ctx.sessionManager.getSessionId();
		const tasks = (event.details as any)?.tasks;
		if (sessionId && Array.isArray(tasks)) {
			try {
				await taskStore.reconcileFromSnapshot(sessionId, tasks);
			} catch (e: any) { console.warn(`pi-kanban: reconcile failed: ${e?.message ?? e}`); }
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		process.env[SESSION_ID_ENV] = sessionId;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			const msg: any = (entry as any).message;
			if (msg?.role !== "toolResult" || msg?.toolName !== "todo") continue;
			const tasks = msg?.details?.tasks;
			if (!Array.isArray(tasks)) continue;
			try {
				await taskStore.reconcileFromSnapshot(sessionId, tasks);
			} catch (e: any) { console.warn(`pi-kanban: backfill failed: ${e?.message ?? e}`); }
			return;
		}
	});

	registerPaneTools(pi);

	pi.registerCommand("kanban", {
		description: `pi-kanban board: ${CAN_OPEN ? "open | " : ""}session <verb>`,
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart();
			const items = COMPLETIONS.filter((c) => c.startsWith(typed)).map((c) => ({ value: c, label: c }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = splitArgs(args);
			const sub = tokens[0] || (CAN_OPEN ? "open" : "help");
			const rest = tokens.slice(1);
			const notify = (m: string, l: "info" | "error" = "info") => ctx.ui.notify(m, l);

			function showHelp() {
				const lines = [
					"Usage: /kanban <command>",
					"",
					...(CAN_OPEN ? ["  open             Open the board in the browser, with the terminal token", ""] : []),
					"Session commands (default to current session):",
					"  session open [<id>]",
					"  session pin [<id>]",
					"  session sticky-pin [<id>]",
					"  session unpin [<id>]",
					"  session view-doc <file> [<id>]",
					"  session link-doc <file> [<id>]",
				];
				notify(lines.join("\n"));
			}

			if (sub === "open" && CAN_OPEN) {
				try {
					const { default: open } = await import("open");
					await open(await boardPageUrl());
				} catch (e: any) {
					notify(`open failed: ${e?.message ?? e}`, "error");
				}
				return;
			}

			if (sub === "session") {
				const verb = rest[0] as SessionSub | undefined;
				const verbRest = rest.slice(1);

				if (!verb) {
					showHelp();
					return;
				}

				if (!(SESSION_SUBCOMMANDS as readonly string[]).includes(verb)) {
					notify(`Unknown session verb: ${verb}. Try: ${SESSION_SUBCOMMANDS.join(", ")}`, "error");
					return;
				}

				if (verb === "open") {
					const id = verbRest[0] ?? ctx.sessionManager.getSessionId() ?? null;
					if (!id) {
						notify("Usage: /kanban session open <session-id> (no current session to default to)", "error");
						return;
					}
					try {
						await okJson(postJson("/api/session/open", { id }));
					} catch (e: any) {
						notify(`open failed: ${e?.message ?? e}`, "error");
						return;
					}
					notify(`opened: ${id}${!verbRest[0] ? " (current)" : ""}`);
					return;
				}

				if (verb === "pin" || verb === "sticky-pin" || verb === "unpin") {
					const id = verbRest[0] ?? ctx.sessionManager.getSessionId() ?? null;
					if (!id) {
						notify(`Usage: /kanban session ${verb} <session-id> (no current session to default to)`, "error");
						return;
					}
					const PIN_STATE = { "sticky-pin": "sticky", "unpin": "none", "pin": "pinned" } as const;
					const state = PIN_STATE[verb];
					try {
						await okJson(postJson("/api/session/pin", { ids: [id], state }));
					} catch (e: any) {
						notify(`${verb} failed: ${e?.message ?? e}`, "error");
						return;
					}
					const pinVerb = verb === "unpin" ? "unpinned" : state;
					notify(`${pinVerb}: ${id}${!verbRest[0] ? " (current)" : ""}`);
					return;
				}

				if (verb === "view-doc" || verb === "link-doc") {
					const file = verbRest[0];
					if (!file) {
						notify(`Usage: /kanban session ${verb} <file.md> [session-id]`, "error");
						return;
					}
					const sessionId = verbRest[1] ?? ctx.sessionManager.getSessionId() ?? null;
					if (verb === "link-doc" && !sessionId) {
						notify("Usage: /kanban session link-doc <file.md> <session-id> (no current session to default to)", "error");
						return;
					}
					try {
						const target = resolveTarget(ctx.cwd, file);
						notify(verb === "link-doc" ? await linkDoc(sessionId!, target) : await previewDoc(target, sessionId));
					} catch (e: any) {
						notify(`${verb} failed: ${e?.message ?? e}`, "error");
					}
					return;
				}
			}

			showHelp();
		},
	});
}
