---
name: show
description: Show the user a card on the pi-kanban board in place of a table or diagram in chat, such as a comparison, chart, diagram, mermaid, mockup, call stack, code tree or diff. Use when your answer compares options or has 4 or more rows, traces a flow, or tracks numbers over time, or when the user asks you to show, draw or chart something.
---

# Show cards

A card is a markdown or HTML file that `pi-kanban show` renders on the board. When pi runs in the board terminal, the card opens in the overlay above the terminal. Elsewhere it opens as a background tab of this session.

When the request starts with `explain`, `diagram`, `chart` or `mockup`, that word names the card kind: read its guide in [Card kinds](#card-kinds). With no kind, pick the one that makes the point best. With no topic, show the subject of this conversation.

## Post a card

1. Write the card to a `.md` or `.html` file in your scratchpad directory (`$PI_SCRATCHPAD_DIR`). A markdown card renders mermaid, diff and code fences.
2. Run `pi-kanban show <file> --title "<title>" --key <name>`. The key names what the card shows, such as `latency-chart`; a post with the same key replaces the card in place. `--base <repo root>` makes the card's `path:line` links resolve against that folder.
3. To change the card, edit the file. The card refreshes on each save.

## HTML contract

For an `.html` card, read [references/html-contract.md](references/html-contract.md) first: the body-fragment rules and the theme variables. Then:

- The card is about 360 to 640 px wide and sizes its height to the content. Keep the content in normal flow, without `position: fixed` or `100vh`.
- One chart or diagram per card, under an `<h2>` that says what to see. Keep it flat: solid fills and 1 px lines.
- To ask the user something, let the card answer for them. The answer comes to you as your next message, with the fields as JSON.
  - One choice: a button per answer, sent on click: `<button data-pk-action="approve">Approve</button>`.
  - Several inputs: one form, sent once on submit with every field: `<form data-pk-submit="plan">…<button>Send</button></form>`. Give each input a `name`. `required` works.
  - Action names use letters, digits, `.`, `_` and `-`. The button text is the label you get. Nothing else in the card sends.
  - When you must wait for the answer before you go on, use the `ask` tool instead.

## Card kinds

Any HTML that helps the user see the point is a good card: a comparison table, a checklist, a before and after, a diff, a small interactive widget, a mix of these. The HTML contract is all it needs. Four kinds have their own guide; read it before you write that kind:

- Chart, stat tile or meter: [references/chart.md](references/chart.md)
- Mockup of a screen, dialog or form: [references/mockup.md](references/mockup.md)
- Diagram in SVG of a system, flow, states or layers: [references/diagram.md](references/diagram.md)
- Explain code (call stack, pseudocode, component or file tree, or a diff of one), in markdown: [references/explain.md](references/explain.md)

## Mermaid

The card is narrow. Use `flowchart TD`, short node labels and `subgraph` blocks, and split a big system map into several cards.
