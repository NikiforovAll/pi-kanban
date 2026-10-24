import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lib } from "./tools/board-api.js";
import { linkDoc, previewDoc, registerPaneTools, resolveTarget } from "./tools/panes.js";
import { registerScratchpad } from "./tools/scratchpad.js";
import { registerShowAsk } from "./tools/show-ask.js";

const extDir = fileURLToPath(new URL('.', import.meta.url));

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

let child: ChildProcess | null = null;
let lastStderr = "";
const port = 3460;

const KANBAN_DIR = joinPath(getAgentDir(), "kanban");
const SETTINGS_PATH = joinPath(KANBAN_DIR, "settings.json");
const DEFAULT_THEME_DIR = joinPath(KANBAN_DIR, "themes");
const LIVE_DIR = joinPath(KANBAN_DIR, "live");
const ACTIVITY_DIR = joinPath(KANBAN_DIR, "agent-activity");

type KanbanSettings = {
	themes?: {
		light?: string;
		dark?: string;
		dir?: string;
	};
};

function readSettings(): KanbanSettings {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as KanbanSettings;
	} catch (e: any) {
		if (e?.code !== "ENOENT") console.warn(`pi-kanban: cannot read ${SETTINGS_PATH}: ${e.message}`);
		return {};
	}
}

function buildServerEnv(): NodeJS.ProcessEnv {
	const settings = readSettings();
	const t = settings.themes ?? {};
	const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
	env.KANBAN_THEME_DIR = process.env.KANBAN_THEME_DIR ?? t.dir ?? DEFAULT_THEME_DIR;
	if (process.env.KANBAN_LIGHT_THEME ?? t.light) {
		env.KANBAN_LIGHT_THEME = process.env.KANBAN_LIGHT_THEME ?? t.light;
	}
	if (process.env.KANBAN_DARK_THEME ?? t.dark) {
		env.KANBAN_DARK_THEME = process.env.KANBAN_DARK_THEME ?? t.dark;
	}
	return env;
}

const SUBCOMMANDS = [
	"start",
	"stop",
	"restart",
	"status",
	"open",
	"session",
] as const;
type Sub = (typeof SUBCOMMANDS)[number];

const SESSION_SUBCOMMANDS = [
	"open",
	"pin",
	"sticky-pin",
	"unpin",
	"view-doc",
	"link-doc",
] as const;
type SessionSub = (typeof SESSION_SUBCOMMANDS)[number];

function probePort(p: number, timeoutMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = createConnection({ port: p, host: "127.0.0.1" });
		const done = (ok: boolean) => {
			sock.destroy();
			resolve(ok);
		};
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => done(true));
		sock.once("timeout", () => done(false));
		sock.once("error", () => done(false));
	});
}

async function waitForPort(p: number, totalMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < totalMs) {
		if (await probePort(p)) return true;
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function postPin(id: string, state: "pinned" | "sticky" | "none"): Promise<Response> {
	return api("/api/session/pin", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id, state }),
	});
}

async function postSessionOpen(id: string): Promise<Response> {
	return api("/api/session/open", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id }),
	});
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function findPidsOnPort(p: number): number[] {
	if (process.platform === "win32") {
		const r = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
		if (r.status !== 0) return [];
		const pids = new Set<number>();
		for (const line of r.stdout.split(/\r?\n/)) {
			const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
			if (m && Number(m[1]) === p) pids.add(Number(m[2]));
		}
		return [...pids];
	}
	const r = spawnSync("lsof", ["-tiTCP:" + p, "-sTCP:LISTEN"], { encoding: "utf8" });
	if (r.status !== 0) return [];
	return r.stdout
		.split(/\s+/)
		.map((s) => Number(s))
		.filter((n) => Number.isFinite(n) && n > 0);
}

function killPid(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
	} else {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

async function ensureRunning(notify: (msg: string, level: "info" | "error") => void): Promise<boolean> {
	if (await probePort(port)) return true;
	notify(`pi-kanban not running. Start it with /kanban start`, "error");
	return false;
}

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
const EXIT_GUARD = Symbol.for("pi-kanban.live-exit-guard");

// A subagent child is shown on its parent's card, so it does not register as a live session.
function registerLiveState(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD) return;

	let session: { sessionId: string; cwd: string; name: string | null } | null = null;
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
		const entry = { sessionId: session.sessionId, pid: process.pid, cwd: session.cwd, startedAt: PROCESS_STARTED_AT, status, statusUpdatedAt, name: session.name };
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
		session = { sessionId, cwd: ctx.sessionManager.getCwd(), name: ctx.sessionManager.getSessionName() ?? null };
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

	pi.on("ui_prompt_start", async (event) => {
		if (!session) return;
		openPrompts++;
		const marker = agentLog.promptMarker(event, [...toolsInFlight.values()].at(-1), session.cwd, now());
		inActivityDir("waiting", (dir) => agentLog.writeWaiting(dir, marker));
		publish("waiting");
	});

	pi.on("ui_prompt_end", async () => {
		if (!session || openPrompts === 0 || --openPrompts > 0) return;
		inActivityDir("waiting", agentLog.clearWaiting);
		publish(running ? "busy" : "idle");
	});

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
	const serverPath = resolvePath(extDir, "..", "server.js");
	const url = `http://localhost:${port}`;

	registerLiveState(pi);
	registerScratchpad(pi);
	registerShowAsk(pi);

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

	type Notify = (m: string, l?: "info" | "error") => void;

	async function startServer(notify: Notify, opts: { silentSuccess?: boolean } = {}): Promise<boolean> {
		if (await probePort(port)) {
			notify(`pi-kanban already listening on ${url} — run /kanban open web to launch it`);
			return true;
		}
		lastStderr = "";
		child = spawn(process.execPath, [serverPath], {
			env: buildServerEnv(),
			stdio: ["ignore", "ignore", "pipe"],
			detached: true,
			windowsHide: true,
		});
		child.stderr?.on("data", (b) => {
			lastStderr += b.toString();
		});
		child.on("exit", () => {
			child = null;
		});

		if (!(await waitForPort(port))) {
			notify(
				`pi-kanban failed to start.\n${lastStderr.slice(-500) || "(no stderr)"}`,
				"error",
			);
			return false;
		}
		// Detach: stop holding the child to the parent's lifetime so /kanban survives
		// when the pi process that ran /kanban start exits.
		child.stderr?.removeAllListeners("data");
		child.stderr?.resume();
		child.unref();
		if (!opts.silentSuccess) {
			notify(`pi-kanban started → ${url} — run /kanban open web to launch it`);
		}
		return true;
	}

	async function stopServer(notify: Notify, opts: { silentSuccess?: boolean } = {}): Promise<boolean> {
		if (child) child.kill("SIGINT");
		child = null;

		if (await probePort(port)) {
			const pids = findPidsOnPort(port);
			for (const pid of pids) killPid(pid);
			await new Promise((r) => setTimeout(r, 300));
			const stillUp = await probePort(port);
			if (stillUp) {
				notify(
					`port ${port} still in use after killing pids ${pids.join(",") || "?"}`,
					"error",
				);
				return false;
			}
			if (!opts.silentSuccess) {
				notify(`pi-kanban stopped (killed orphan pid${pids.length > 1 ? "s" : ""} ${pids.join(",")})`);
			}
			return true;
		}
		if (!opts.silentSuccess) notify("pi-kanban stopped");
		return true;
	}

	pi.registerCommand("kanban", {
		description:
			"pi-kanban dashboard: start | stop | restart | status | open web|app | session <verb>",
		getArgumentCompletions: (prefix) => {
			const tokens = splitArgs(prefix);
			if (tokens.length >= 1 && tokens[0] === "session") {
				const verbPrefix = tokens[1] ?? "";
				return SESSION_SUBCOMMANDS
					.filter((s) => s.startsWith(verbPrefix))
					.map((s) => ({ value: `session ${s}`, label: s }));
			}
			return SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const tokens = splitArgs(args);
			const sub = (tokens[0] || "start") as Sub;
			const rest = tokens.slice(1);
			const notify = (m: string, l: "info" | "error" = "info") => ctx.ui.notify(m, l);

			function showHelp() {
				const lines = [
					"Usage: /kanban <command>",
					"",
					"Global commands:",
					"  start            Start the dashboard server",
					"  stop             Stop the dashboard server",
					"  restart          Restart the dashboard server",
					"  status           Show server status",
					"  open web          Open dashboard in browser",
					"  open app          Open dashboard as PWA",
					"",
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

			if (sub === "start") {
				await startServer(notify);
				return;
			}

			if (sub === "stop") {
				await stopServer(notify);
				return;
			}

			if (sub === "restart") {
				if (!(await stopServer(notify, { silentSuccess: true }))) return;
				if (!(await startServer(notify, { silentSuccess: true }))) return;
				notify(`pi-kanban restarted → ${url}`);
				return;
			}

			if (sub === "status") {
				const up = await probePort(port);
				const owned = child ? ` (pid ${child.pid})` : " (external)";
				notify(up ? `running on ${url}${owned}` : "not running");
				return;
			}

			if (sub === "open") {
				const verb = rest[0];
				if (verb === "web") {
					const { default: open } = await import("open");
					await open(url);
					return;
				}
				if (verb === "app") {
					const { default: open, apps } = await import("open");
					for (const name of [apps.chrome, apps.edge, apps.browser]) {
						try {
							await open(url, { app: { name, arguments: [`--app=${url}`] } });
							return;
						} catch {}
					}
					notify("Could not find Chrome/Edge for PWA window mode", "error");
					return;
				}
				notify(`Usage: /kanban open web|app${verb ? ` (unknown: ${verb})` : ""}`, "error");
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

				if (!(await ensureRunning(notify))) return;

				if (verb === "open") {
					const id = verbRest[0] ?? ctx.sessionManager.getSessionId() ?? null;
					if (!id) {
						notify("Usage: /kanban session open <session-id> (no current session to default to)", "error");
						return;
					}
					const res = await postSessionOpen(id);
					if (!res.ok) {
						notify(`open failed (${res.status}): ${await res.text()}`, "error");
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
					const res = await postPin(id, state);
					if (!res.ok) {
						notify(`${verb} failed (${res.status}): ${await res.text()}`, "error");
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
