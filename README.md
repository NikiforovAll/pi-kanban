# pi-kanban

[![npm version](https://img.shields.io/npm/v/pi-kanban.svg)](https://www.npmjs.com/package/pi-kanban)

Web dashboard for the [pi coding agent](https://pi.dev/packages/pi-kanban?name=kanban) — sessions, todos, subagents, observability.

![pi-kanban dashboard](https://raw.githubusercontent.com/NikiforovAll/pi-kanban/main/assets/pi-kanban-poster.png)

## Documentation

**[→ See the documentation](https://nikiforovall.github.io/pi-kanban/docs/)**

## Try it now

**[→ Open the live demo](https://nikiforovall.blog/pi-kanban/)**

Click around a fully interactive dashboard with synthesized sessions, tasks, and subagents — no install. Toggle the theme, browse projects, expand a subagent's review, open the storage manager. Everything works in-browser.

When you're ready to run it on your own pi sessions, install below.

## Installation

```sh
pi install npm:pi-kanban
```

Then use `/kanban start | stop | restart | status | open web|app` for global controls, and `/kanban session open | pin | sticky-pin | unpin | view-doc | link-doc` for session-scoped actions.

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
- [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) — pi-kanban surfaces these as interactive Q&A cards.

## Demo


![pi-kanban demo](https://raw.githubusercontent.com/NikiforovAll/pi-kanban/main/assets/pi-kanban-demo.gif)
