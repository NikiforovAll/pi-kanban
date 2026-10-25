import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BoardDownError, boardFetch, boardTerminalId, okJson, pollSettled, POLL_MS, postJson, sessionIdOf, terminalToken, toolText as text } from "./board-api.js";
import { resolveTarget } from "./panes.js";

type Shown = { title: string; key?: string | null; index: number; count: number; path?: string | null };
type Answer = { status: "answered"; data: unknown } | { status: "dismissed" | "cancelled" | "gone" | "pending"; reason?: string };
export type AskOpen = { title: string; args: unknown };

export function shownText({ title, key, index, count, path }: Shown, claim: boolean): string {
	const at = `"${title}" (${key ? `${key}, ` : ""}${index}/${count})`;
	const reply = "The user sees the rendered card and you do not: in your reply, say what the card shows, and take the render as given.";
	return claim ? `Card ${at} is ready. Write it to ${path}; the card refreshes on each save. ${reply}` : `Shown ${at}. ${reply}`;
}

export const CLAIM_OFF_TERMINAL =
	"No overlay here: write the card to a markdown or HTML file in your scratchpad directory, then call show again with file.";

export function paneText(title: string, added: boolean): string {
	return added
		? `Added "${title}" as a background tab of this session on the pi-kanban board. In your reply, say what the card shows and that it waits there.`
		: "The board already has a tab for this file; it refreshes on each save.";
}

export function answerText(title: string, a: Answer): string {
	if (a.status === "answered") return `The user answered "${title}":\n${JSON.stringify(a.data, null, 2)}`;
	if (a.status === "dismissed" && a.reason === "replaced") return `"${title}" was replaced by a newer question.`;
	if (a.status === "dismissed") return `The user skipped "${title}" without answering. Go on with your best default, and ask in chat only when no default works.`;
	return `"${title}" is no longer open on the board; the user did not answer it.`;
}

const FORM = "Pick the form that makes the point best, a small widget or a mix of forms included.";

// One string for show and ask, so pi puts it in the prompt once.
const HTML_CONTRACT =
	"A show or ask HTML card is a body fragment, with no doctype, html, head or body tag; <style> and <script> work, with no network. Take colors and fonts from the board's CSS variables (--color-bg, --color-bg-subtle, --color-text, --color-text-muted, --color-border, --color-accent, --color-info, --color-success, --color-warning, --color-danger, --color-series-1 to --color-series-8, --font-sans, --font-mono) so the card follows the light or dark theme.";

const FILE = Type.String({ description: "Path of an existing markdown, HTML, image or text file: absolute, or relative to the session cwd" });

const PANE_SHOW = {
	description: `Show a card as a background tab of this session on the pi-kanban board. ${FORM} Write the card to a markdown or HTML file in your scratchpad directory and pass it as file. Edit the same file to update its tab, which refreshes on each save; post a new file for a new card.`,
	parameters: Type.Object({ title: Type.String({ description: "Tab title" }), file: FILE }),
};

const OVERLAY_SHOW = {
	description: `Show a card in the pi-kanban overlay above this terminal. ${FORM} Give each card a key that names what it shows (for example latency-chart); post again with that key to update the card in place. Without file, the tool answers with a path to write the card to; edit that file to change the card. Pass file to show a file that already exists.`,
	parameters: Type.Object({
		title: Type.String({ description: "Card title" }),
		kind: Type.Optional(
			Type.Union([Type.Literal("markdown"), Type.Literal("html")], {
				description: "markdown (default): mermaid, diff and code fences render. html: a body fragment",
			}),
		),
		file: Type.Optional(FILE),
		key: Type.Optional(Type.String({ description: "Card name: the same key replaces the card in place and keeps its file" })),
		base: Type.Optional(
			Type.String({
				description:
					"Absolute path of the folder that the card's path:line links resolve against, usually the repo root. Without it, links resolve against the session cwd",
			}),
		),
	}),
};

type ShowParams = { title: string; file?: string; kind?: "markdown" | "html"; key?: string; base?: string };

async function showOnTerminal(terminalId: string, sessionId: string, p: ShowParams): Promise<string> {
	const headers = { "x-terminal-token": terminalToken() };
	const out = await okJson(postJson(`/api/terminals/${encodeURIComponent(terminalId)}/show`, { sessionId, ...p }, { headers }));
	return shownText(out, p.file == null);
}

async function showAsPane(sessionId: string, p: ShowParams): Promise<string> {
	if (p.file == null) return CLAIM_OFF_TERMINAL;
	const out = await okJson(postJson(`/api/panes/${encodeURIComponent(sessionId)}`, { target: p.file, title: p.title, show: true }));
	return paneText(p.title, out.added);
}

const ASK_PARAMS = Type.Object({
	title: Type.String({ description: "The question, short: it titles the modal and the chip that reopens it" }),
	file: Type.String({ description: "Path of the HTML card: absolute, or relative to the session cwd" }),
	size: Type.Optional(
		Type.Union([Type.Literal("md"), Type.Literal("lg"), Type.Literal("full")], {
			description: "Modal size: md for a short form, lg (default) for most cards, full for a playground or a quiz sheet",
		}),
	),
});

const INTERRUPTED = "Interrupted; the question was closed.";

export const ASK_TOOL = "ask";

// A board ask fires no UI prompt event, so the live state learns of it from these.
export const ASK_OPEN = "kanban:ask-open";
export const ASK_CLOSE = "kanban:ask-close";

// The call waits until the user answers or skips. An abort closes the modal, because the run went on without it.
async function askOnBoard(pi: ExtensionAPI, base: string, headers: Record<string, string>, body: object, open: AskOpen, signal?: AbortSignal): Promise<string> {
	const { id } = await okJson(postJson(base, body, { headers, signal }));
	const at = `${base}/${encodeURIComponent(id)}`;
	pi.events.emit(ASK_OPEN, open);
	try {
		return answerText(open.title, await pollSettled<Answer>(`${at}/wait?ms=${POLL_MS}`, { headers, signal }));
	} catch (e) {
		if (!signal?.aborted) throw e;
		await boardFetch(at, { method: "DELETE", headers }).catch(() => {});
		throw new Error(INTERRUPTED);
	} finally {
		pi.events.emit(ASK_CLOSE, open);
	}
}

// Without a board the TUI asks in a line of text: the card cannot render there.
async function askInTui(ctx: ExtensionContext, title: string, file: string, signal?: AbortSignal): Promise<string> {
	ctx.ui.notify(`The pi-kanban board is not running, so the card ${file} cannot open. Answer in text.`, "warning");
	const answer = await ctx.ui.input(title, "Type the answer, or press Esc to skip", { signal });
	if (signal?.aborted) throw new Error(INTERRUPTED);
	return answer === undefined ? answerText(title, { status: "dismissed" }) : answerText(title, { status: "answered", data: answer });
}

export function registerShowAsk(pi: ExtensionAPI) {
	const terminal = boardTerminalId();
	const show = terminal ? OVERLAY_SHOW : PANE_SHOW;

	pi.registerTool({
		name: "show",
		label: "Show",
		description: show.description,
		promptSnippet:
			"Card: a table, chart, diagram or mockup you make, on the pi-kanban board, when the user asks you to show, draw or visualize, or your answer compares 4 or more rows, traces a flow, or tracks numbers over time",
		promptGuidelines: [HTML_CONTRACT],
		parameters: show.parameters,
		annotations: { destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, params: ShowParams, _signal, _onUpdate, ctx) {
			const sessionId = sessionIdOf(ctx);
			const p = { ...params, file: params.file == null ? undefined : resolveTarget(ctx.cwd, params.file) };
			return text(terminal ? await showOnTerminal(terminal, sessionId, p) : await showAsPane(sessionId, p));
		},
	});

	pi.registerTool({
		name: ASK_TOOL,
		label: "Ask",
		description:
			"Ask the user through an HTML card in a modal on the pi-kanban board, and wait. The result is the data the card sent, as JSON, or a line that says the user skipped. Write the card to an HTML file in your scratchpad and pass it as file. Open the card with an <h2> that states the question. The card sends the answer with pk.send(data), any JSON value, from a click or a key press; or with <form data-pk-submit=\"name\">, which sends {action, label, fields}; or with <button data-pk-action=\"name\">, which sends its action and label. The first answer ends the question, so send once, with values that read without the card.",
		promptSnippet:
			"Ask the user on an HTML card on the pi-kanban board and wait for the answer, when it needs something to see or control: swatches, a diagram, sliders, a long form, a quiz sheet, a playground",
		promptGuidelines: [HTML_CONTRACT],
		parameters: ASK_PARAMS,
		annotations: { destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sessionId = sessionIdOf(ctx);
			const file = resolveTarget(ctx.cwd, params.file);
			const body = { sessionId, title: params.title, file, size: params.size };
			try {
				const [base, headers] = terminal
					? [`/api/terminals/${encodeURIComponent(terminal)}/ask`, { "x-terminal-token": terminalToken() }]
					: [`/api/sessions/${encodeURIComponent(sessionId)}/ask`, {}];
				return text(await askOnBoard(pi, base, headers, body, { title: params.title, args: params }, signal));
			} catch (e) {
				if (e instanceof BoardDownError && ctx.hasUI) return text(await askInTui(ctx, params.title, file, signal));
				throw e;
			}
		},
	});
}
