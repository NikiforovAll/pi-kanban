import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 3460;

const requireHere = createRequire(import.meta.url);
// The board's CommonJS modules, shared with the extension.
export const lib = (name: string) => requireHere(`../../lib/${name}`);

const { linkUrl } = requireHere("../../public/link-url.js") as { linkUrl: (v: unknown) => string | null };
export const isUrl = (target: string) => linkUrl(target) !== null;

// The board resolves a path against its own cwd, so a relative path is made absolute here.
// A file:// URL is left to the board, which converts it.
export function resolveTarget(cwd: string, input: string): string {
	const target = input.trim();
	if (!target) throw new Error("A path or URL is required.");
	if (isUrl(target) || /^file:/i.test(target)) return target;
	const expanded = target === "~" || /^~[\\/]/.test(target) ? joinPath(homedir(), target.slice(1)) : target;
	// Git Bash hands out `/c/x` for `C:\x`, as cliPath in cli.js also handles.
	const native = process.platform === "win32" ? expanded.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:/") : expanded;
	return isAbsolute(native) ? resolvePath(native) : resolvePath(cwd, native);
}

const BOARD_DOWN ='The pi-kanban board is not running. Ask the user to start it with "pi-kanban".';

export function kanbanDir(): string {
	return joinPath(getAgentDir(), "kanban");
}

// EPERM means the process exists but belongs to someone else.
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM";
	}
}

export function readText(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function readJson(file: string): any {
	try {
		return JSON.parse(readText(file) ?? "null");
	} catch {
		return null;
	}
}

// The same rule as cli.js: PK_URL, then this agent dir's server.json beacon, then the default port.
// Read on every call, so a board that restarted on another port is found. Null means the beacon
// names a server that is gone, so the default port could be another agent dir's board.
export function boardUrl(): string | null {
	if (process.env.PK_URL) return process.env.PK_URL.replace(/\/+$/, "");
	const beacon = readJson(joinPath(kanbanDir(), "server.json"));
	if (!beacon) return `http://127.0.0.1:${DEFAULT_PORT}`;
	return beacon.port && beacon.pid && isPidAlive(beacon.pid) ? `http://127.0.0.1:${beacon.port}` : null;
}

export class BoardDownError extends Error {
	constructor(cause?: unknown) {
		super(BOARD_DOWN, { cause });
		this.name = "BoardDownError";
	}
}

// Rejects with BoardDownError when no board answers, so a caller can tell "board down" from an HTTP error.
export async function boardFetch(path: string, init?: RequestInit): Promise<Response> {
	const url = boardUrl();
	if (!url) throw new BoardDownError();
	try {
		return await fetch(`${url}${path}`, init);
	} catch (e: any) {
		if (e?.name === "AbortError") throw e;
		throw new BoardDownError(e);
	}
}

// Read on every call: a restarted board writes a new token.
export function terminalToken(): string {
	const url = boardUrl();
	if (!url) throw new BoardDownError();
	const port = new URL(url).port;
	const token = readJson(joinPath(kanbanDir(), "terminal-tokens", `${port}.json`))?.token;
	if (typeof token === "string" && token) return token;
	throw new Error(`No terminal token for the pi-kanban board on port ${port}. It must run with the terminal enabled.`);
}

export const { boardTerminalId } = lib("board-dir.js") as { boardTerminalId: () => string | null };

// Under the board's 25 s cap on a long-poll, so each poll answers before the board gives up on it.
export const POLL_MS = 20_000;

export async function pollSettled<T extends { status: string }>(path: string, init: RequestInit = {}): Promise<T> {
	for (;;) {
		const got: T = await okJson(boardFetch(path, { cache: "no-store", ...init }));
		if (got.status !== "pending") return got;
	}
}

export function postJson(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
	return boardFetch(path, {
		...init,
		method: init.method ?? "POST",
		headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
		body: JSON.stringify(body),
	});
}

// The board answers errors as { error }.
export async function errorText(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	try {
		const { error } = JSON.parse(text);
		if (typeof error === "string" && error) return error;
	} catch {}
	return `pi-kanban answered HTTP ${res.status}`;
}

export async function okJson(pending: Promise<Response>): Promise<any> {
	const res = await pending;
	if (!res.ok) throw new Error(await errorText(res));
	return res.status === 204 ? null : res.json();
}

export function sessionIdOf(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId();
	if (!id) throw new Error("This pi session has no id yet.");
	return id;
}

export const toolText = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
