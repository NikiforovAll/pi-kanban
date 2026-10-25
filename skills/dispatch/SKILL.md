---
name: dispatch
description: Dispatch or delegate a task to a new pi session in the pi-kanban terminal, wait for its report, or run several sessions in a pattern.
---

# Dispatch

The guide ships with the `pi-kanban` CLI, so it always matches the commands the CLI takes. Load it before you run any dispatch command:

```bash
pi-kanban skills get dispatch
```

When `pi-kanban` is not on PATH, run `node <this skill's folder>/../../server.js` in its place.

## Handoff

When the user asks for no report, or to hand the task off, the session owns the task and the user follows it on the board. Start it and do not wait for it.

## Orchestration patterns

Use request-reply, handoff or orchestrator-workers directly. When another shape fits better (a separate reviewer, steps that feed each other, a sub-orchestrator, a decision for the user), propose it in one line, the pattern and why, and dispatch only after the user agrees, unless the user named it. Details: [references/orchestration-patterns.md](references/orchestration-patterns.md).
