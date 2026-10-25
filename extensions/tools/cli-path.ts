import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { kanbanDir, readText } from "./board-api.js";

const SERVER_ENV = "PI_KANBAN_SERVER";

// The shims read the server from the env, so every pi process runs the server.js of the package
// that loaded it, whatever copy last wrote the shared shims.
const SHIMS: Record<string, string> = {
	"pi-kanban": `#!/bin/sh\nexec node "$${SERVER_ENV}" "$@"\n`,
	"pi-kanban.cmd": `@node "%${SERVER_ENV}%" %*\r\n`,
};

// The skills run `pi-kanban`. The shims go first on PATH, so the CLI is the version of the skills
// pi loaded, also when another version or none is installed globally. They are written here, not
// shipped, because an npm pack made on Windows drops the executable bit.
export function addCliToPath(dir = joinPath(kanbanDir(), "bin")): void {
	process.env[SERVER_ENV] = fileURLToPath(new URL("../../server.js", import.meta.url));
	try {
		mkdirSync(dir, { recursive: true });
		for (const [name, text] of Object.entries(SHIMS)) {
			const file = joinPath(dir, name);
			if (readText(file) === text) continue;
			writeFileSync(file, text);
			chmodSync(file, 0o755);
		}
	} catch (e: any) {
		console.warn(`pi-kanban: CLI shims failed: ${e?.message ?? e}`);
		return;
	}
	const parts = (process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== dir);
	process.env.PATH = [dir, ...parts].join(delimiter);
}
