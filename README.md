# pi-kanban

Web dashboard for the [pi coding agent](https://pi.dev) — sessions, todos, subagents, observability.

![pi-kanban dashboard](assets/pi-kanban-poster.png)

## Try it now

**[→ Open the live demo](https://nikiforovall.blog/pi-kanban/)**

Click around a fully interactive dashboard with synthesized sessions, tasks, and subagents — no install. Toggle the theme, browse projects, expand a subagent's review, open the storage manager. Everything works in-browser.

When you're ready to run it on your own pi sessions, install below.

## Installation

```sh
pi install npm:pi-kanban
```

Then use `/kanban start | stop | restart | status | open | web | app | pin | sticky-pin | unpin | preview | link` from inside pi.

Or run standalone:

```sh
npx pi-kanban
```

### Companion pi extensions

pi-kanban surfaces data produced by two other pi extensions. Install them alongside for the full experience:

```sh
pi install npm:pi-subagents
pi install npm:@juicesharp/rpiv-todo
```

- [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) — spawns named subagent sessions; pi-kanban renders them under each parent session.
- [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo) — task tracking that pi-kanban displays as kanban columns.

## Documentation

- [User guide](docs/user-guide.md) — slash commands, layout, sessions, subagents, storage manager, keyboard shortcuts.
- [Theming](docs/theming.md) — built-in themes, configuration, custom theme authoring.
