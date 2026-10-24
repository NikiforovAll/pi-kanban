import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { kanbanDir, lib } from "./board-api.js";

const pads = lib("scratchpad-dir.js") as {
	defaultScratchpadRoot: () => string;
	scratchpadPath: (root: string, cwd: string, sessionId: string) => string;
	recordedPadDir: (entries: unknown[]) => string | null;
	prunePads: (o: { root: string; isLive: (sessionId: string) => boolean }) => Promise<string[]>;
	SCRATCHPAD_ENTRY: string;
	PAD_MAX_AGE_MS: number;
};
const liveSessions = lib("live-sessions.js") as {
	readLiveSessions: (dir: string) => { sessionId: string; pid: number | null }[];
	isSessionLive: (sessions: unknown[], sessionId: string) => boolean;
};

export const SCRATCHPAD_ENV = "PI_SCRATCHPAD_DIR";

const DAY_MS = 24 * 60 * 60 * 1000;

function promptSection(dir: string): string {
	return [
		`Use this session's scratchpad dir for temporary files instead of /tmp or the project: ${dir}`,
		`It is also in $${SCRATCHPAD_ENV}. Put notes, scripts, logs and command output there. The pi-kanban board lists its files.`,
		`It is deleted ${Math.round(pads.PAD_MAX_AGE_MS / DAY_MS)} days after the session ends, so do not keep files there that the user needs.`,
	].join("\n");
}

async function prune(root: string, sessionId: string): Promise<void> {
	const live = liveSessions.readLiveSessions(joinPath(kanbanDir(), "live"));
	await pads.prunePads({ root, isLive: (id) => id === sessionId || liveSessions.isSessionLive(live, id) });
}

// A subagent child reuses the pad its parent put in the environment, so both write to one dir.
export function registerScratchpad(pi: ExtensionAPI) {
	const inherited = process.env.PI_SUBAGENT_CHILD ? process.env[SCRATCHPAD_ENV] : undefined;
	const root = pads.defaultScratchpadRoot();
	let dir: string | null = inherited ?? null;
	let pruned = false;

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		if (!inherited) {
			const next = pads.scratchpadPath(root, ctx.sessionManager.getCwd(), sessionId);
			try {
				mkdirSync(next, { recursive: true });
			} catch (e: any) {
				console.warn(`pi-kanban: cannot create scratchpad ${next}: ${e?.message ?? e}`);
				dir = null;
				delete process.env[SCRATCHPAD_ENV];
				return;
			}
			dir = next;
			process.env[SCRATCHPAD_ENV] = dir;
		}
		if (pads.recordedPadDir(ctx.sessionManager.getEntries()) !== dir) pi.appendEntry(pads.SCRATCHPAD_ENTRY, { dir });

		if (inherited || pruned) return;
		pruned = true;
		setImmediate(() => prune(root, sessionId).catch((e: any) => console.warn(`pi-kanban: scratchpad prune failed: ${e?.message ?? e}`)));
	});

	pi.on("before_agent_start", async (event) => {
		if (dir) event.systemPromptOptions.sections.scratchpad = promptSection(dir);
		else delete event.systemPromptOptions.sections.scratchpad;
	});
}
