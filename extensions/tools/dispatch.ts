import { resolve as resolvePath } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boardFetch, boardTerminalId, lib, okJson, pollSettled, POLL_MS, postJson, sessionIdOf, terminalToken, toolText as text } from "./board-api.js";

type Dispatch = { session: string; name: string | null; group: string | null; cwd: string | null; startedAt: number; reportedAt: number | null };
type Report = { status: "reported"; text: string; at: number } | { status: "pending" | "ended" };

const { dispatchLine, matchDispatches } = lib("dispatch-reports.js") as {
	dispatchLine: (d: Dispatch) => string;
	matchDispatches: (rows: Dispatch[], query: string) => Dispatch[];
};

export const REPORT_TOOL = "dispatch_report";

const PROBE_TIMEOUT_MS = 5_000;

const WORKER_PROMPT = [
	"pi-kanban started this session for another pi session, which waits for your result.",
	`When the task is done, or you cannot finish it, call ${REPORT_TOOL} once with a short report: what you did, the outcome, and the paths of files with details.`,
	"Keep the report under 2000 characters; it is all the other session gets.",
].join("\n");

export function reportText(session: string, r: Report): string {
	if (r.status === "reported") return `Report from ${session}:\n${r.text}`;
	if (r.status === "ended") return `The terminal of ${session} ended without a report.`;
	return `${session} has not reported yet.`;
}

async function listDispatches(parent: string | null): Promise<Dispatch[]> {
	const q = parent ? `?parent=${encodeURIComponent(parent)}` : "";
	const { running } = await okJson(boardFetch(`/api/dispatch${q}`, { cache: "no-store" }));
	return (running as Dispatch[]).sort((a, b) => b.startedAt - a.startedAt);
}

async function isDispatched(sessionId: string): Promise<boolean> {
	try {
		const res = await boardFetch(`/api/dispatch/${encodeURIComponent(sessionId)}/report`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		return res.ok;
	} catch (e: any) {
		console.warn(`pi-kanban: could not ask the board whether this session is a dispatch: ${e?.message ?? e}`);
		return false;
	}
}

export function registerDispatch(pi: ExtensionAPI) {
	let worker = false;

	// Only a session in the board's terminal can be a dispatch, and the board knows which ones are.
	// It asks on every start, so a dispatch the board resumed after a restart still reports.
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		worker = !!boardTerminalId() && (await isDispatched(sessionId));
		const active = pi.getActiveTools();
		if (active.includes(REPORT_TOOL) === worker) return;
		pi.setActiveTools(worker ? [...active, REPORT_TOOL] : active.filter((t) => t !== REPORT_TOOL));
	});

	pi.on("before_agent_start", async (event) => {
		if (worker) event.systemPromptOptions.sections.dispatch = WORKER_PROMPT;
		else delete event.systemPromptOptions.sections.dispatch;
	});

	pi.registerTool({
		name: "dispatch_start",
		label: "Dispatch",
		description:
			"Start a new pi session in the pi-kanban board's terminal with a task, sent as its first message. The session sees only the task, not this conversation, so make the task self-contained: goal, files, constraints, and what to report. It runs on its own; get its result with dispatch_wait.",
		promptSnippet: "Start another pi session in the pi-kanban terminal with a task",
		promptGuidelines: [
			"Dispatch a task only when the user asks to dispatch or delegate it. After dispatch_start, call dispatch_wait with the session id to get the report; the report comes only through it.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The task, self-contained" }),
			cwd: Type.Optional(Type.String({ description: "Folder to run in: absolute, or relative to this session's cwd (default: this session's cwd)" })),
			name: Type.Optional(Type.String({ description: "Session name, kebab-case, e.g. fix-login-redirect" })),
			model: Type.Optional(Type.String({ description: "pi model pattern, provider/id (default: pi's default)" })),
			thinking: Type.Optional(Type.String({ description: "off, minimal, low, medium, high, xhigh or max" })),
			group: Type.Optional(Type.String({ description: "Board group for the session: a name, path or id. Leave it out unless the user names a group" })),
		}),
		annotations: { destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, p, signal, _onUpdate, ctx) {
			// Models often fill optional params with "", and the board rejects an empty group.
			const opt = (s?: string) => s?.trim() || undefined;
			const body = { spec: p.task, cwd: resolvePath(ctx.cwd, opt(p.cwd) ?? "."), name: opt(p.name), model: opt(p.model), thinking: opt(p.thinking), group: opt(p.group), parent: sessionIdOf(ctx) };
			const out = await okJson(postJson("/api/dispatch", body, { headers: { "x-terminal-token": terminalToken() }, signal }));
			const grouped = out.group ? ` [${out.group}]` : out.groupError ? ` (not grouped: ${out.groupError})` : "";
			return text(`Started session ${out.session} in ${out.cwd}${grouped}. Call dispatch_wait with this session id for its report.`);
		},
	});

	pi.registerTool({
		name: "dispatch_list",
		label: "Dispatch list",
		description: "List the sessions this session dispatched that still run in the pi-kanban terminal, newest first. Each line: session id, name, group, cwd, and (reported) once it sent its report.",
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "Every dispatch on the board, not only this session's" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
			const rows = await listDispatches(p.all ? null : sessionIdOf(ctx));
			return text(rows.length ? rows.map(dispatchLine).join("\n") : "No dispatches.");
		},
	});

	pi.registerTool({
		name: "dispatch_wait",
		label: "Dispatch wait",
		description: "Wait for the report of a session this session dispatched, and return it. It returns at once when the report is already there, and says so when the session's terminal ended without one.",
		parameters: Type.Object({ session: Type.String({ description: "Session id from dispatch_start" }) }),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_toolCallId, p, signal) {
			const got = await pollSettled<Report>(`/api/dispatch/${encodeURIComponent(p.session)}/report?wait=${POLL_MS}`, { signal });
			return text(reportText(p.session, got));
		},
	});

	pi.registerTool({
		name: "dispatch_end",
		label: "Dispatch end",
		description: "End the terminal of a session this session dispatched, and the pi process in it. Use it once its report is in, or when the user asks.",
		parameters: Type.Object({ session: Type.String({ description: "Session id or unique prefix, or the session's name" }) }),
		annotations: { destructiveHint: true, openWorldHint: false },
		async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
			const rows = await listDispatches(sessionIdOf(ctx));
			const matches = matchDispatches(rows, p.session);
			if (matches.length !== 1) {
				throw new Error(matches.length ? `"${p.session}" matches ${matches.length} dispatches:\n${matches.map(dispatchLine).join("\n")}` : `No running dispatch of this session matches "${p.session}".`);
			}
			const { session } = matches[0];
			await okJson(boardFetch(`/api/terminals/${encodeURIComponent(session)}`, { method: "DELETE", headers: { "x-terminal-token": terminalToken() } }));
			return text(`Ended session ${session}.`);
		},
	});

	pi.registerTool({
		name: REPORT_TOOL,
		label: "Dispatch report",
		description: "Send your report to the pi session that dispatched you. Call it once, when the task is done or you cannot finish it.",
		parameters: Type.Object({ text: Type.String({ description: "The report: what you did, the outcome, paths of files with details" }) }),
		annotations: { destructiveHint: false, openWorldHint: false },
		defaultActive: false,
		async execute(_toolCallId, p, signal, _onUpdate, ctx) {
			await okJson(postJson(`/api/dispatch/${encodeURIComponent(sessionIdOf(ctx))}/report`, { text: p.text }, { signal }));
			return text("Report sent. Tell the user it was sent, then stop.");
		},
	});
}
