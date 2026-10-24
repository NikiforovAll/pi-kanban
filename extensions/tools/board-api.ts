import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PORT = 3460;

export const BOARD_DOWN = 'The pi-kanban board is not running. Ask the user to start it with "pi-kanban".';

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

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
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
