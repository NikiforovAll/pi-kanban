import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BoardDownError, boardFetch, boardTerminalId, okJson, pollSettled, POLL_MS, postJson, resolveTarget, sessionIdOf, terminalToken, toolText as text } from "./board-api.js";

type Answer = { status: "answered"; data: unknown } | { status: "dismissed" | "cancelled" | "gone" | "pending"; reason?: string };
export type AskOpen = { title: string; args: unknown };

function answerText(title: string, a: Answer): string {
	if (a.status === "answered") return `The user answered "${title}":\n${JSON.stringify(a.data, null, 2)}`;
	if (a.status === "dismissed" && a.reason === "replaced") return `"${title}" was replaced by a newer question.`;
	if (a.status === "dismissed") return `The user skipped "${title}" without answering. Go on with your best default, and ask in chat only when no default works.`;
	return `"${title}" is no longer open on the board; the user did not answer it.`;
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

export function registerAsk(pi: ExtensionAPI) {
	const terminal = boardTerminalId();

	pi.registerTool({
		name: ASK_TOOL,
		label: "Ask",
		description:
			"Ask the user through an HTML card in a modal on the pi-kanban board, and wait. The result is the data the card sent, as JSON, or a line that says the user skipped. Write the card to an HTML file in your scratchpad and pass it as file. The card sends the answer with pk.send(data), a <form data-pk-submit> or a <button data-pk-action>.",
		promptSnippet:
			"Ask the user on an HTML card on the pi-kanban board and wait for the answer, when it needs something to see or control: swatches, a diagram, sliders, a long form, a quiz sheet, a playground",
		promptGuidelines: ["Before you write an ask card, read the ask skill: it has the card's HTML contract and theme variables."],
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
