import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boardFetch, errorText, kanbanDir, lib } from "./board-api.js";

const { isContained } = lib("contain.js") as { isContained: (child: string, root: string) => boolean };

type Events = { events: string[]; seqs: number[]; board: string };

// The board caps a wait at 120 s.
const WAIT_SEC = 110;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];

// A review or answer line ends with the path of the file that holds the batch (lib/session-events.js).
const FILE_RE = /: (.+\.md)$/;

async function withBatch(line: string): Promise<string> {
	const file = FILE_RE.exec(line)?.[1];
	if (!file) return line;
	if (!isContained(file, joinPath(kanbanDir(), "reviews"))) return line;
	const batch = await readFile(file, "utf8").catch(() => "");
	return batch ? `${line}\n\n${batch}` : line;
}

// Drains the board's queue for this session (reviews, preview answers, task moves) into the
// conversation. A line stays on the board until its ack, which rides on the next poll.
async function drain(pi: ExtensionAPI, ctx: ExtensionContext, sessionId: string, signal: AbortSignal) {
	let board = "";
	let seq = 0;
	let first = true;
	let fails = 0;
	while (!signal.aborted) {
		try {
			const q = new URLSearchParams({ wait: String(WAIT_SEC), got: String(seq), ack: String(seq), board });
			if (first) q.set("first", "1");
			const res = await boardFetch(`/api/sessions/${encodeURIComponent(sessionId)}/events?${q}`, { cache: "no-store", signal });
			if (!res.ok) throw new Error(await errorText(res));
			const got = (await res.json()) as Events;
			first = false;
			fails = 0;
			if (got.board !== board) seq = 0;
			board = got.board;
			const texts = await Promise.all(got.events.map(withBatch));
			if (signal.aborted) return;
			for (const text of texts) pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			if (got.seqs.length) seq = Math.max(seq, ...got.seqs);
		} catch (e: any) {
			if (signal.aborted) return;
			if (fails === 0 && e?.name !== "BoardDownError") console.warn(`pi-kanban: board inbox: ${e?.message ?? e}`);
			await sleep(RETRY_MS[Math.min(fails++, RETRY_MS.length - 1)], undefined, { signal }).catch(() => {});
		}
	}
}

export function registerInbox(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD) return;
	let stop: AbortController | null = null;

	pi.on("session_start", async (_event, ctx) => {
		stop?.abort();
		stop = null;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId || !ctx.hasUI) return;
		stop = new AbortController();
		void drain(pi, ctx, sessionId, stop.signal);
	});

	pi.on("session_shutdown", async () => {
		stop?.abort();
		stop = null;
	});
}
