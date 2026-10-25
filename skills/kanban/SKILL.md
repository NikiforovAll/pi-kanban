---
name: kanban
description: pi-kanban board CLI. Use to keep a dev server, page or file open as a board tab, link or unlink a doc or PR, preview a file now, list or remove this session's tabs, open this session's cost or what pi loaded (tools, skills, system prompt), open or pin a session, or read the sessions and tasks on the board.
---

# pi-kanban CLI

The skill is a thin wrapper over the `pi-kanban` CLI.

The CLI takes this session from `$PI_KANBAN_SESSION_ID`, so pass `--session` or an id only for another session.

## Commands

| The user wants | Command |
|---|---|
| A dev server, page or file opened on the board, as a tab beside it | `pane add <url\|file> [--title <t>]` · `pane list` · `pane rm <id>` |
| A doc, file or PR kept with the session, to open later | `doc link <file\|url>` · `doc unlink <file\|url>` · `doc list` |
| A file on screen now, in a modal over the user's work | `doc preview <file>` |
| A card you make: table, chart, diagram | `show <file>`, see the show skill |
| This session's cost, tokens and models | `session cost` |
| What pi loaded: system prompt, tools, extensions, skills, context | `session inspect` |
| Another session | `session list` · `session search <text>` · `session open\|view\|agents\|pin <id>` · `session group <id> <group>` · `session ungroup <id>` |
| Sidebar groups | `group list\|prune` · `group create <name>` · `group rename <group> <name>` · `group rm <group>` |
| Tasks and projects | `task list` · `project list` |
| Terminals running in pi-kanban | `terminal list` |
| A task run by another pi session | the dispatch skill |

## Run a command

1. Read `pi-kanban help <command> <subcommand>` for the flags. It matches the installed CLI, so its flags are the ones that work.
2. Run the command and report its output line to the user.

## Keep the board still

The user works in other windows while you run, so pick the quiet command. `pane add` and `doc link` add an entry the user opens when ready. `doc preview` is the one command that opens a modal on the user's screen: use it when the user asks to see something now.

To show the user a page, a prototype or a collage of screenshots, write it as HTML and add or preview that file. The board renders HTML as written in a sandboxed frame and inlines its local stylesheets, scripts and images, so the file alone is enough.

## Another session

Read its transcript. `session view <id>` and `session search <text> --json` print the path.

## Troubleshooting

- "Cannot reach pi-kanban server…": the error names the agent dir and the port it tried. Ask the user to start the board with `pi-kanban`. When it runs elsewhere, set `PORT=<n>` or `PK_URL=<url>` for the command.
- "No terminal token…": `session cost`, `session inspect` and `dispatch start` need a board started with its terminal on.
