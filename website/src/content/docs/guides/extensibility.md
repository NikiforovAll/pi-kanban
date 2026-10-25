---
title: Extensibility
description: Open plans in panes, drive the board from skills and scripts, and let other pi packages feed it.
---

pi-kanban gives you mechanism, not policy. Bring your own planning flow, skills, and scripts. The board has these entry points:

- The `pi-kanban` command line, which talks to a running board. pi learns it from the skills that ship with pi-kanban: `kanban`, `show`, `ask`, `visualize`, and `dispatch`.
- Two pi tools: `ask`, and `dispatch_report` for dispatched sessions.
- The session files. Anything pi writes to `~/.pi/agent/sessions` shows on the board.

## Plans

A plan is a markdown file like any other. Have the agent open it with [`pi-kanban pane add`](../../reference/cli/#pane-add): it shows as a tab next to the board, refreshes on each save, and takes review comments that reach pi as a user message. pi-kanban does not care where the file comes from: a planning skill, a prompt template, a hand-edited `plan.md`, or an exported ticket.

Tell the agent when to do this in `AGENTS.md`, a prompt template, or a skill. For example:

```md
## Planning

When you write a plan markdown file, run `pi-kanban pane add <path>` so it shows in pi-kanban.
```

pi-kanban does not ship a planning extension. Pick or build one that fits your style and have it open the plan in a pane at the end.

## Cards and panes

Show cards take markdown or HTML, and ask cards take HTML, so a skill can teach the agent a card style. See [Card style](../show-and-ask/#card-style).

`pi-kanban pane add` puts any URL or local file next to the board as a tab: a dev server, a coverage report, a design file. See [Panes](../panes-and-docs/#panes).

## The command line

`pi-kanban <command>` talks to the running board. Use it from scripts and skills:

```sh
pi-kanban doc link ./design.md --session <id>
pi-kanban pane add http://localhost:5173 --session <id>
pi-kanban session list
```

Run `pi-kanban help <command>` for the subcommands and flags, or see the [CLI reference](../../reference/cli/). `pi-kanban skills get <name>` prints a skill guide that ships with this version.

## Themes

The board ships 17 color themes, each with a light and a dark variant. See [Theming](../../reference/theming/).

## Sessions

You do not extend session rendering. pi-kanban reads what pi writes, so anything that runs as a pi session, including subagents from `pi-subagents`, shows on the board.
