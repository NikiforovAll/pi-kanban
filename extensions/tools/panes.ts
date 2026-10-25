import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boardFetch, lib, okJson, postJson, sessionIdOf, terminalToken, toolText as text } from "./board-api.js";

const { linkUrl } = createRequire(import.meta.url)("../../public/link-url.js") as { linkUrl: (v: unknown) => string | null };
const isUrl = (target: string) => linkUrl(target) !== null;

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

const boardJson = (path: string, init?: RequestInit) => okJson(boardFetch(path, init));
const postBoardJson = (path: string, body: unknown, headers?: Record<string, string>) => okJson(postJson(path, body, { headers }));

const panesPath = (sessionId: string, paneId?: string) =>
	`/api/panes/${encodeURIComponent(sessionId)}${paneId ? `/${encodeURIComponent(paneId)}` : ""}`;

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

const TARGET = Type.String({ description: "An http(s) URL, or a file path: absolute, relative to the session cwd, or starting with ~" });

const COMPANION_IDS: string[] = lib("companions.js").COMPANIONS.filter((c: any) => c.optional).map((c: any) => c.id);

export async function addPane(sessionId: string, cwd: string, params: { target: string; title?: string }) {
	return postBoardJson(panesPath(sessionId), { target: resolveTarget(cwd, params.target), title: params.title ?? "" });
}

// The board starts the tool, which runs package code, so a companion pane takes the terminal token.
export async function openCompanion(sessionId: string, companion: string) {
	return postBoardJson(panesPath(sessionId), { companion }, { "x-terminal-token": terminalToken() });
}

const paneLine = (out: { pane: { id: string; title: string }; added: boolean }) => `${out.pane.id}  ${out.pane.title}${out.added ? "" : " (already there)"}`;

export function registerPaneTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pane_add",
		label: "Add Pane",
		description:
			"Add a URL or a local HTML, markdown, text or image file to this session's view on the pi-kanban board, as a tab next to Board. The board does not switch to the pane; the user opens it when ready. Adding the same target again returns the pane it already has. Returns the pane id.",
		promptSnippet: "Add a URL or a local file as a background tab on the pi-kanban board",
		promptGuidelines: [
			"Use pane_add for a page the user will want to keep open beside the board, such as a dev server or a generated HTML report.",
		],
		parameters: Type.Object({
			target: TARGET,
			title: Type.Optional(Type.String({ description: "Tab title. Default: the host or the file name." })),
		}),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = sessionIdOf(ctx);
			const out = await addPane(sessionId, ctx.cwd, params);
			const { pane } = out;
			const lines = [paneLine(out)];
			if (pane.kind === "url") {
				const { frameable } = await boardJson(`${panesPath(sessionId, pane.id)}/framing`).catch(() => ({ frameable: null }));
				if (frameable === false) {
					lines.push(`note: ${new URL(pane.target).host} refuses framing, so the pane shows an "Open in new tab" card. Look for a URL of the same content that allows framing.`);
				}
			}
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "companion_open",
		label: "Open Companion",
		description:
			"Open a board-hosted tool for this session as a tab on the pi-kanban board. The board starts the tool if it is not running. pi-cost shows the session's cost, tokens and models. pi-inspect shows what pi loaded: the system prompt, tools, extensions, skills and context. Opening it again returns the pane it already has. Returns the pane id.",
		promptSnippet: "Open the pi-cost or pi-inspect page for this session on the pi-kanban board",
		promptGuidelines: [
			"When the user asks what this session costs, use companion_open with pi-cost. When the user asks what pi loaded (tools, extensions, skills, the system prompt), use companion_open with pi-inspect.",
		],
		parameters: Type.Object({
			companion: Type.Union(COMPANION_IDS.map((id) => Type.Literal(id)), { description: "The tool to open" }),
		}),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return text(paneLine(await openCompanion(sessionIdOf(ctx), params.companion)));
		},
	});

	pi.registerTool({
		name: "pane_rm",
		label: "Remove Pane",
		description: "Remove a pane from this session's view on the pi-kanban board, by the id pane_add or pane_list returned.",
		parameters: Type.Object({ id: Type.String({ description: "Pane id, such as p3" }) }),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await boardJson(panesPath(sessionIdOf(ctx), params.id), { method: "DELETE" });
			return text(`Removed pane ${params.id}`);
		},
	});

	pi.registerTool({
		name: "pane_list",
		label: "List Panes",
		description: "List the panes of this session on the pi-kanban board, in tab order: id, kind, title and target.",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { panes } = await boardJson(panesPath(sessionIdOf(ctx)));
			if (!panes.length) return text("No panes.");
			return text(panes.map((p: any) => `${p.id}  ${p.kind}  ${p.title}  ${p.target}`).join("\n"));
		},
	});

	pi.registerTool({
		name: "link_doc",
		label: "Link Doc",
		description:
			"Link a file or an http(s) URL to this session in the pi-kanban board, with no modal. The board keeps the link, so it shows when a board tab opens later. A file the preview cannot render opens in the editor.",
		promptSnippet: "Link a file or URL to this session in the pi-kanban board",
		promptGuidelines: [
			"Prefer link_doc and pane_add over preview_doc: the user works in other windows, and these add an entry the user opens when ready.",
		],
		parameters: Type.Object({ path: TARGET }),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return text(await linkDoc(sessionIdOf(ctx), resolveTarget(ctx.cwd, params.path)));
		},
	});

	pi.registerTool({
		name: "unlink_doc",
		label: "Unlink Doc",
		description: "Remove a linked file or URL from this session in the pi-kanban board. The file need not exist.",
		parameters: Type.Object({ path: TARGET }),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return text(await linkDoc(sessionIdOf(ctx), resolveTarget(ctx.cwd, params.path), { unlink: true }));
		},
	});

	pi.registerTool({
		name: "preview_doc",
		label: "Preview Doc",
		description:
			"Open a markdown, HTML, text or image file in the preview modal on every open pi-kanban board tab. It is the one tool that opens something on the user's screen, so use it only when the user asks to see a file now. HTML renders in a sandboxed frame with its local stylesheets, scripts and images inlined. An http(s) URL is linked to the session instead, and the board offers an Open button.",
		promptSnippet: "Open a file in the pi-kanban preview modal, when the user asks to see it now",
		parameters: Type.Object({ path: TARGET }),
		annotations: { destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = resolveTarget(ctx.cwd, params.path);
			return text(await previewDoc(target, isUrl(target) ? sessionIdOf(ctx) : null));
		},
	});

	pi.registerTool({
		name: "bind_plan",
		label: "Bind Plan",
		description:
			"Bind a markdown plan file to this session, so the pi-kanban board shows a plan icon on the session card and renders the plan. A session has one plan; a new bind replaces it.",
		promptSnippet: "Bind a markdown plan file to the current session; call after writing the plan file",
		promptGuidelines: ["Use bind_plan once a planning markdown file exists so it surfaces in pi-kanban."],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the plan markdown file. Absolute, or relative to the session cwd." }),
		}),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = sessionIdOf(ctx);
			const out = await postBoardJson(`/api/sessions/${encodeURIComponent(sessionId)}/plan`, { path: resolveTarget(ctx.cwd, params.path) });
			return text(out.title ? `Bound plan "${out.title}": ${out.path}` : `Bound plan: ${out.path}`);
		},
	});
}
