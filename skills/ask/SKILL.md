---
name: ask
description: Card guide for the ask tool, which asks the user on an HTML card in a pi-kanban modal and waits. Use when the question needs something to see or control, such as swatches, a diagram to pick from, sliders over a preview, a long form, a quiz sheet or a playground.
---

# Ask cards

The `ask` tool opens an HTML card as a modal on the pi-kanban board and waits. The user's answer comes back as the tool result. When the board is down, the tool asks in a line of text in the pi TUI instead.

When the request starts with `playground`, `quiz` or `form`, that word sets the card kind. For a playground, read [references/playground.md](references/playground.md) and build one. With no topic, ask the open question of this conversation.

## HTML contract

Write the card to an `.html` file in your scratchpad directory (`$PI_SCRATCHPAD_DIR`). Read [the HTML card contract](../show/references/html-contract.md) first: the body-fragment rules and the theme variables. Then:

- Pick the size with `size`: `md` 560 px wide for a short form, `lg` 960 px (default) for most cards, `full` the whole terminal for a playground or a quiz sheet. `md` and `lg` take the content's height up to the terminal's, then scroll, so keep their content in normal flow, without `position: fixed` or `100vh`. A `full` card always fills the terminal.
- Open the card with an `<h2>` that states the question. The tool's `title` is the short form of it.

## Sending the answer

- From a script: `pk.send(data)`, any JSON value, called from a click or a key press. Use it when the answer is state the card holds, such as a playground's settings or a quiz's picks.
- From markup: a form `<form data-pk-submit="name">` sends `{action, label, fields}` on submit, with each input's `name` as a field; `required` works. A button `<button data-pk-action="name">` sends its action and label. Action names use letters, digits, `.`, `_` and `-`.
- Put only the Send button where the card sends: the user's picks are already on screen.
- Send once, with everything you need: the first answer ends the question. Make each value self-explanatory, so the result reads without the card.
- A skip comes back as a line that says so. Go on without the answer, and ask in chat only if you cannot.

## Exhibits in the card

A picture the user answers about follows the show skill's guides, read before you draw: [chart](../show/references/chart.md), [diagram](../show/references/diagram.md), [mockup](../show/references/mockup.md). Their widths are for the narrower show card; the `size` above sets this one.
