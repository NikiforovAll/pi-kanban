---
title: Extensibility
description: Open plans in panes, drive the board from skills and scripts, and let other pi packages feed it.
---

pi-kanban gives you mechanism, not policy. Bring your own planning flow, skills, and scripts. The board has these entry points:

- The pi tools: `show`, `ask`, `pane_add`, `link_doc`, `preview_doc`, and the `dispatch_*` tools.
- The `pi-kanban` command line, which talks to a running board.
- The session files. Anything pi writes to `~/.pi/agent/sessions` shows on the board.

## Plans

A plan is a markdown file like any other. Have the agent open it with `pane_add`: it shows as a tab next to the board, refreshes on each save, and takes review comments that reach pi as a user message. pi-kanban does not care where the file comes from: a planning skill, a prompt template, a hand-edited `plan.md`, or an exported ticket.

Tell the agent when to do this in `AGENTS.md`, a prompt template, or a skill. For example:

```md
## Planning

When you write a plan markdown file, call `pane_add` with its path so it shows in pi-kanban.
```

pi-kanban does not ship a planning extension. Pick or build one that fits your style and have it call `pane_add` at the end.

## Cards and panes

The `show` and `ask` tools take a markdown or HTML file, so a skill can teach the agent a card style. An HTML card is a body fragment. Take colors and fonts from the board's CSS variables (`--color-bg`, `--color-text`, `--color-accent`, `--font-sans`, and others) so the card follows the light or dark mode.

`pane_add` puts any URL or local file next to the board as a tab: a dev server, a coverage report, a design file.

## The command line

`pi-kanban <command>` finds the running board through `PK_URL`, then the `server.json` file the server writes, then port 3460. Use it from scripts and skills:

```sh
pi-kanban doc link ./design.md --session <id>
pi-kanban pane add http://localhost:5173 --session <id>
pi-kanban session list
```

Commands that act on one session take `--session` with a full id or a unique prefix. Without it, they use `$PREVIEW_SESSION`, else `$PI_KANBAN_SESSION_ID`.

Run `pi-kanban help <command>` for the subcommands and flags, or see the [CLI reference](../../reference/cli/). `pi-kanban skills get <name>` prints a skill guide that ships with this version.

## Themes

The board ships 17 color themes, each with a light and a dark variant. See [Theming](../../reference/theming/).

## Sessions

You do not extend session rendering. pi-kanban reads what pi writes, so anything that runs as a pi session, including subagents from `pi-subagents`, shows on the board.
