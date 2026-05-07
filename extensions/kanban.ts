import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

let child: ChildProcess | null = null;
let lastStderr = "";
const port = 3460;

const SUBCOMMANDS = [
	"start",
	"stop",
	"status",
	"open",
	"app",
	"pin",
	"sticky-pin",
	"unpin",
	"preview",
	"link",
] as const;
type Sub = (typeof SUBCOMMANDS)[number];

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

async function postPreview(filePath: string, sessionId: string | null, link = false): Promise<Response> {
	return api("/api/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: filePath, sessionId, link }),
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

export default function kanbanExtension(pi: ExtensionAPI) {
	const here = fileURLToPath(new URL(".", import.meta.url));
	const serverPath = resolvePath(here, "..", "server.js");
	const url = `http://localhost:${port}`;

	pi.registerCommand("kanban", {
		description:
			"pi-kanban dashboard: start | stop | status | open | app | pin | sticky-pin | unpin | preview | link",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const tokens = splitArgs(args);
			const sub = (tokens[0] || "start") as Sub;
			const rest = tokens.slice(1);
			const notify = (m: string, l: "info" | "error" = "info") => ctx.ui.notify(m, l);

			if (sub === "start") {
				if (await probePort(port)) {
					notify(`pi-kanban already listening on ${url} — run /kanban open or /kanban app`);
					return;
				}
				lastStderr = "";
				child = spawn(process.execPath, [serverPath], {
					env: { ...process.env, PORT: String(port) },
					stdio: ["ignore", "ignore", "pipe"],
					detached: false,
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
					return;
				}
				notify(`pi-kanban started → ${url} — run /kanban open or /kanban app to launch it`);
				return;
			}

			if (sub === "stop") {
				if (child) child.kill("SIGINT");
				child = null;

				if (await probePort(port)) {
					const pids = findPidsOnPort(port);
					for (const pid of pids) killPid(pid);
					await new Promise((r) => setTimeout(r, 300));
					const stillUp = await probePort(port);
					notify(
						stillUp
							? `port ${port} still in use after killing pids ${pids.join(",") || "?"}`
							: `pi-kanban stopped (killed orphan pid${pids.length > 1 ? "s" : ""} ${pids.join(",")})`,
						stillUp ? "error" : "info",
					);
					return;
				}
				notify("pi-kanban stopped");
				return;
			}

			if (sub === "status") {
				const up = await probePort(port);
				const owned = child ? ` (pid ${child.pid})` : " (external)";
				notify(up ? `running on ${url}${owned}` : "not running");
				return;
			}

			if (sub === "open") {
				const { default: open } = await import("open");
				await open(url);
				return;
			}

			if (sub === "app") {
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

			if (sub === "pin" || sub === "sticky-pin" || sub === "unpin") {
				if (!(await ensureRunning(notify))) return;
				const id = rest[0] ?? ctx.sessionManager.getSessionId() ?? null;
				if (!id) {
					notify(`Usage: /kanban ${sub} <session-id> (no current session to default to)`, "error");
					return;
				}
				const state = sub === "sticky-pin" ? "sticky" : sub === "unpin" ? "none" : "pinned";
				const res = await postPin(id, state);
				if (!res.ok) {
					notify(`${sub} failed (${res.status}): ${await res.text()}`, "error");
					return;
				}
				const usedCurrent = !rest[0];
				notify(`${sub === "unpin" ? "unpinned" : state}: ${id}${usedCurrent ? " (current)" : ""}`);
				return;
			}

			if (sub === "preview" || sub === "link") {
				if (!(await ensureRunning(notify))) return;
				const file = rest[0];
				if (!file) {
					notify(`Usage: /kanban ${sub} <file.md> [session-id]`, "error");
					return;
				}
				const sessionId = rest[1] ?? ctx.sessionManager.getSessionId() ?? null;
				if (sub === "link" && !sessionId) {
					notify("Usage: /kanban link <file.md> <session-id> (no current session to default to)", "error");
					return;
				}
				const abs = isAbsolute(file) ? file : resolvePath(process.cwd(), file);
				const res = await postPreview(abs, sessionId, sub === "link");
				if (!res.ok) {
					notify(`${sub} failed (${res.status}): ${await res.text()}`, "error");
					return;
				}
				const usedCurrent = !rest[1] && sessionId;
				notify(`${sub}: ${abs}${sessionId ? ` → session ${sessionId}${usedCurrent ? " (current)" : ""}` : ""}`);
				return;
			}

			notify(`Unknown subcommand: ${sub}. Try: ${SUBCOMMANDS.join(", ")}`, "error");
		},
	});
}
