import { isUrl, okJson, postJson, terminalToken } from "./board-api.js";

const postBoardJson = (path: string, body: unknown, headers?: Record<string, string>) => okJson(postJson(path, body, { headers }));

export async function linkDoc(sessionId: string, target: string, opts: { unlink?: boolean; open?: boolean } = {}): Promise<string> {
	const out = await postBoardJson("/api/document/link", { path: target, sessionId, unlink: !!opts.unlink, open: !!opts.open });
	const what = isUrl(target) ? "URL" : "Document";
	const line = `${what} ${opts.unlink ? "unlinked from" : "linked to"} the session: ${out.path}`;
	return !opts.unlink && out.tabs === 0 ? `${line}\nNo board tab is open; the board shows it when one opens.` : line;
}

// A URL cannot open in the preview modal, so it is linked and the board tab on screen offers an Open button.
// A sessionId also moves the board to that session.
export async function previewDoc(target: string, sessionId: string | null): Promise<string> {
	if (isUrl(target)) {
		if (!sessionId) throw new Error("A URL is linked to a session, and this pi session has no id yet.");
		return linkDoc(sessionId, target, { open: true });
	}
	await postBoardJson("/api/preview", { path: target, sessionId });
	return `Preview opened on the board: ${target}`;
}

// The board starts the tool, which runs package code, so a companion pane takes the terminal token.
// With a board terminal id, the board tab that shows that terminal switches to the pane.
export async function openCompanion(sessionId: string, companion: string, terminal?: string) {
	return postBoardJson(`/api/panes/${encodeURIComponent(sessionId)}`, { companion, terminal }, { "x-terminal-token": terminalToken() });
}
