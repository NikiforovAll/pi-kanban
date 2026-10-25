---
name: dispatch
description: Dispatch or delegate a task to a new pi session in the pi-kanban terminal, wait for its report, or run several sessions in a pattern.
---

# Dispatch

A dispatch is a plain pi session that pi-kanban starts in its embedded terminal, with your spec as the first message. It is an ordinary session: it shows in the sidebar, its card links back to you, and the user can open its terminal at any time.

## Spec

The started session sees only the spec, not this conversation, so the spec carries everything it needs: the goal, the files, the constraints, and what the report must say.

## Start

```bash
pi-kanban dispatch start --cwd <dir> --spec-file <spec.md> --name <name> --group <group> --json -- <pi args>
```

- `--name` is the sidebar name. Kebab-case and unique: `fix-login-redirect`.
- `--group` names the effort (`auth-refactor`, or a path like `auth-refactor/api`) and shows the session under that sidebar group. Pass it on every dispatch that belongs to the effort; a dispatch without it goes to its project. A group it makes goes when none of its sessions shows as active; an existing group stays.
- `--model` takes a pi model pattern (`provider/id`, see `pi --list-models`); `--thinking` takes a thinking level.
- `--spec-file` keeps a long spec out of shell quoting.
- Everything after `--` goes to `pi` as it is: any flag in `pi --help`, e.g. `-- --tools read,bash`. Keep each value one shell word of plain characters (no quotes, `%` or control characters); long text belongs in the spec. pi-kanban owns the session id, name, model and thinking level, so pass those with its own flags.
- After a pi-kanban restart the terminal comes back with `pi --session <id>` alone, so the args after `--` apply to the first run only.
- The result holds the `session` id.

## Report

The started session gets the `dispatch_report` tool and an instruction to call it once, with a short report, when it is done or cannot finish. The board keeps the report, so a report that comes before you wait is kept for you.

```bash
pi-kanban dispatch wait <session-id>...
```

It prints each report, or says that the session's terminal ended without one. It waits with no time limit, so run it without a timeout.

## Status and end

```bash
pi-kanban dispatch list --json            # still running in pi-kanban's terminal; reportedAt once it reported
pi-kanban dispatch end <session-id>       # ends its terminal
```

## Handoff

When the user asks for no report, or to hand the task off, the session owns the task and the user follows it on the board. Start it and do not wait for it.

## Orchestration patterns

Use request-reply, handoff or orchestrator-workers directly. When another shape fits better (a separate reviewer, steps that feed each other, a sub-orchestrator, a decision for the user), propose it in one line, the pattern and why, and dispatch only after the user agrees, unless the user named it. Details: [references/orchestration-patterns.md](references/orchestration-patterns.md).
