# Extensibility

pi-kanban exposes a small surface so you can plug your own workflows into it without forking. Today that surface is:

- The `bind_plan` tool — attach any markdown file as the current session's plan
- Themes — swap or author the color palette
- (Implicit) the session JSONL format — anything pi writes to `~/.pi/agent/sessions/**` shows up automatically

The philosophy: **pi-kanban ships mechanism, not policy.** Bring your own planning flow, your own skills, your own theme.

## `bind_plan` tool

When the `/kanban` extension is loaded, pi-kanban registers a `bind_plan` tool with the agent:

| Field      | Value                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| Name       | `bind_plan`                                                                            |
| Parameters | `path: string` — absolute, or relative to the session cwd                              |
| Effect     | POSTs `{ id, path, title }` to `/api/session/plan`; the dashboard renders it in the Plan tab |

The agent decides *when* to call it. pi-kanban does not care how the file was produced — it can come from a planning skill, a `/plan` prompt template, a hand-edited `plan.md`, an exported Linear ticket, or any other source.

### Wiring it into your workflow

Tell the agent when to call `bind_plan` via `AGENTS.md`, a prompt template, or a skill. A minimal `AGENTS.md` snippet:

```md
## Planning

When you produce a plan markdown file, call `bind_plan` with its path so it
surfaces in pi-kanban. Re-call after material edits.
```

Example flows that compose with `bind_plan`:

- **Planning skill writes `./plan.md`** → skill instructs the agent to call `bind_plan` with the path on completion
- **Per-task plan dirs** (e.g. `~/.pi/_plans/<slug>/plan.md`) → the producer of those files instructs the agent to bind the latest one
- **Manual** → you write a plan, ask the agent to "bind the plan in plan.md"

pi-kanban intentionally does not ship a planning extension itself. Pick (or build) one that fits your style and have it call `bind_plan` at the end.

## Themes

Themes are JSON files declaring 15 design-token colors. Ship your own under `~/.pi/agent/kanban/themes/` and reference it from `~/.pi/agent/kanban/settings.json`. See [Theming](./theming.md) for the full token list, env-var overrides, and authoring guide.

## Sessions

You don't extend session rendering — pi-kanban reads whatever pi writes. Anything that runs as a pi session (including subagents from `pi-subagents`) appears automatically.

## What's intentionally not extensible (yet)

- No plugin hook in `server.js` for third-party routes
- No frontend extension API for custom panes
- No event bus the dashboard subscribes to beyond pi's own session stream

If you want any of these, open an issue describing the use case before building around it — the answer is often "wire it through an existing primitive" (e.g. write a markdown file and `bind_plan` it).
