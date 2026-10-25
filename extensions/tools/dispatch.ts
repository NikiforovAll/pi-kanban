import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boardFetch, boardTerminalId, okJson, postJson, sessionIdOf, toolText as text } from "./board-api.js";

export const REPORT_TOOL = "dispatch_report";

const PROBE_TIMEOUT_MS = 5_000;

const WORKER_PROMPT = [
	"pi-kanban started this session for another pi session, which waits for your result.",
	`When the task is done, or you cannot finish it, call ${REPORT_TOOL} once with a short report: what you did, the outcome, and the paths of files with details.`,
	"Keep the report under 2000 characters; it is all the other session gets.",
].join("\n");

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
