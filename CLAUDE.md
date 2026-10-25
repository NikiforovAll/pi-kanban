# AGENTS.md

## Architecture

pi-kanban is an agent development environment (ADE) for the [pi coding agent](https://pi.dev). The board runs pi sessions in a browser terminal and shows each session's todos, subagents, and linked docs. It reads pi's session JSONL files from `~/.pi/agent/sessions/**/*.jsonl`. Its skills teach the agent the `pi-kanban` CLI to post cards, add panes, and dispatch tasks to other sessions through the board; its `ask` tool asks the user on a card.

### Runtime pieces

1. **`server.js`** — Express server and the `pi-kanban` bin. Watches `~/.pi/agent/sessions` with chokidar and broadcasts changes via SSE (`/api/events`). Exposes session/task/agent endpoints (all delegate parsing to `lib/pi-sessions.js`, `lib/pi-transcript.js` and `lib/parsers.js`), plus terminal, dispatch, show/ask, pane, preview, and "open in editor" APIs. With a subcommand (`pi-kanban doc|pane|show|session|group|task|project|dispatch|terminal|skills`), it runs `cli.js` against a running board instead.

2. **Board terminal** — on by default, `--no-terminal` turns it off. `lib/terminal.js` keeps one PTY per session and serves it over a WebSocket behind the Host, Origin, and token gates. The PTYs live in a forked host process (`lib/terminal-host.js`, driven over IPC by `lib/terminal-client.js`), so a closed socket does not end pi. The token goes to the browser in the URL fragment (`#t=...`). `public/terminal.html` and `public/terminal-frame.js` render it with xterm.

3. **`public/`** — vanilla HTML/CSS/JS frontend. **Everything lives in one file: `public/app.js` organized by `//#region` blocks. No bundler, no framework. `public/themes.css` holds the color themes.

4. **`extensions/kanban.ts`** — pi extension, the entry point when installed via `pi install npm:pi-kanban`. It does not start the board: the user installs it with `npm install -g pi-kanban` and runs `pi-kanban`. It registers the `/kanban` command: `open` (the default, opens the board URL with the token; not offered when pi runs in the board terminal) and `session open | pin | sticky-pin | unpin | view-doc | link-doc`, which POST to the board. It also registers the tools in `extensions/tools/`.

### pi tools (`extensions/tools/`)

- **`board-api.ts`** — finds the board (`PK_URL`, then the `server.json` beacon, then port 3460), wraps fetch, and loads the board's CommonJS `lib/` modules. A down board raises `BoardDownError`.
- **`panes.ts`** — link, preview and companion helpers for the `/kanban` command. Panes, docs, cards and dispatch are CLI verbs (`pi-kanban pane|doc|show|session|dispatch`), taught by the skills in `skills/`.
- **`ask.ts`** — `ask` opens a modal and long-polls for the answer, with a pi TUI fallback when the board is down.
- **`dispatch.ts`** — the worker's `dispatch_report` tool and prompt, active only in a dispatched session.
- **`inbox.ts`** — long-polls `/api/sessions/:id/events` and delivers board messages (review comments, card answers, task moves) to pi as user messages. The ack rides on the next poll.
- **`scratchpad.ts`** — a folder per session, given to pi in the system prompt and `$PI_SCRATCHPAD_DIR`, pruned 7 days after the session ends.

### Board-mediated dispatch

The parent never talks to the worker. `pi-kanban dispatch start` POSTs `/api/dispatch` with the terminal token, and the board starts a new pi session in its terminal and records it as dispatched (with parent and group). The worker calls `dispatch_report` once, which POSTs `/api/dispatch/:session/report` (no token: the worker holds none, and `lib/net-guard.js` refuses cross-site requests). `lib/dispatch-reports.js` keeps the report on the dispatch marker, so it survives a late `dispatch wait` poll, an ended worker terminal, or a board restart.

### Session parsing (`lib/pi-sessions.js`, `lib/pi-transcript.js`, `lib/parsers.js`)

pi stores sessions as JSONL files under `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`, or flat in a custom dir. The board picks the dir the way pi does: `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `<agentDir>/settings.json` or a project's `<cwd>/.pi/settings.json`. The cwds come from session headers and the live registry, so `server.js` recomputes the roots after each full scan and keeps one watcher per root. The encoded cwd uses `--` as separators and a leading drive letter on Windows (`--C--Users-foo--` → `C:\Users\foo`); `decodeProjectDir` in `lib/pi-sessions.js` reverses this, but the header `cwd` wins. `lib/pi-sessions.js` finds session files and reads their headers, `lib/pi-transcript.js` maps pi entries to the lines `lib/parsers.js` reads. All session/task/agent endpoints in `server.js` call functions from these modules — keep parsing logic there, not in route handlers.

### Frontend conventions

- All state lives in module-scope `let`s in `app.js`; localStorage persists user prefs (`theme`, `sidebar-collapsed`, `sidebar-width`, etc.).
- `app.js` is organized by `//#region NAME` / `//#endregion` blocks (folded by VS Code). When editing, place new code in the matching region; when adding new functionality that doesn't fit any existing region, add a new region rather than appending to the bottom. Grep `^//#region` to list them.

  Current regions, in order: `STATE`, `DOM`, `DATA_FETCHING`, `SEARCH`, `SESSION_ACTIVITY`, `TIMINGS`, `AGENT_FETCHING`, `MESSAGE_PANEL`, `PINNING`, `MODALS`, `TOAST`, `TOOL_RENDERING`, `FINDINGS`, `AGENTS`, `RENDERING`, `KANBAN`, `DRAG_DROP`, `SESSION_GROUPS`, `SESSION_GROUPS_RENAME`, `SESSION_GROUPS_DND`, `SESSION_GROUPS_MENU`, `KEYBOARD_NAV`, `TASK_DETAIL`, `HELP`, `SCRATCHPAD`, `STORAGE_MANAGER`, `KEYBOARD_SHORTCUTS`, `REVIEW`, `MARKDOWN_PREVIEW`, `SSE`, `CONTEXT_WINDOW`, `UTILS`, `FILTERS`, `EVENT_DELEGATION`, `THEME`, `SIDEBAR_LAYOUT`, `SESSION_INFO`, `SESSION_PICKER`, `PROJECT_PICKER`, `TOOL_STATS_MODAL`, `PANES`, `TERMINAL`, `ASK`, `SHOW`, `NEW_SESSION`, `PWA`, `INIT`, `LINKS`.

### Adding endpoints

Route handlers in `server.js` should be thin: validate input, call a parser, JSON-respond. Long-running or stateful work (chokidar watchers, SSE streams) is set up at module scope, not per-request — see the `/api/sessions/:id/agents/:agentId/messages/stream` pattern for per-connection watchers.

## Conventions specific to this repo

- **CommonJS in `server.js` and `lib/`**, ESM-style TS in `extensions/kanban.ts`. Don't mix.
- Windows is a first-class target — paths use `path.join`, drive-letter encoding lives in `decodeProjectDir`. Avoid POSIX-only assumptions.
- No emojis in code or UI unless explicitly requested.
