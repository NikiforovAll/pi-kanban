# Orchestration patterns

Each pattern is only `dispatch start` plus `dispatch wait`. A **worker** is a session you dispatch. A worker reports once, to you, with its `dispatch_report` tool; workers cannot message each other, so you carry what one worker needs from another in its spec.

## Select

Use one of these directly:

| Pattern | When |
|---|---|
| Request-reply | The default |
| Handoff | The user asked for no report |
| Orchestrator-workers | The task splits into parts that do not depend on each other |

Propose these first, unless the user named one. Each adds steps, rounds or sessions the user did not ask for.

| Pattern | Fits when |
|---|---|
| Prompt chaining | A step needs the previous step's output |
| Evaluator-optimizer | There is a clear acceptance bar and a second look improves the result |
| Hierarchical | A part is itself large enough to split |
| Human-in-the-loop | The spec leaves a choice the user should make |

## Request-reply

One worker, one report. Start it, then `dispatch wait <session>`.

## Handoff

One worker, no wait. The worker owns the task, and the user follows it on the board.

## Orchestrator-workers

One worker per independent part, all started before you wait on any. They run at the same time, and each holds only its own part in context. Give each a unique `--name` and one shared `--group`, then `dispatch wait <session> <session>...` and combine the reports.

## Prompt chaining

Workers in sequence; each spec carries the previous report. You check each report before you start the next step, and stop the chain when a check fails.

## Evaluator-optimizer

A generator and a separate evaluator, which judges the work with fresh eyes. You relay: the evaluator's spec carries the generator's report and the acceptance bar, and the next generator's spec carries the evaluator's findings. Cap the rounds: stop after 3 and report what you have.

## Hierarchical

A worker that dispatches its own workers, waits for them, and reports once they all have. Your context then holds one report per part instead of one per leaf. Its spec says to dispatch and wait for its parts.

## Human-in-the-loop

A worker runs in the board terminal, so it can ask the user itself. Add to the worker's spec: `When you need a decision from the user, ask with the ask tool, and keep working on what does not depend on the answer.`
