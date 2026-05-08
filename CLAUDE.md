# AGENTS.md

## Architecture

pi-kanban is a **read-only observability dashboard** for the [pi coding agent](https://pi.dev). It reads pi's session JSONL files from `~/.pi/agent/sessions/**/*.jsonl` and renders sessions, todos, messages, and subagents. It does not mutate pi's state.

### Three runtime pieces

1. **`server.js`** — Express server. Watches `~/.pi/agent/sessions` with chokidar and broadcasts changes via SSE (`/api/events`). Exposes session/task/agent endpoints (all delegate parsing to `lib/pi-parsers.js`) plus markdown preview, "open in editor", and theme APIs.

2. **`public/`** — vanilla HTML/CSS/JS frontend. **Everything lives in one file: `public/app.js` organized by `//#region` blocks. No bundler, no framework.

3. **`extensions/kanban.ts`** — pi extension exposing the `/kanban` slash command (`start | stop | status | open | app | pin | sticky-pin | unpin | preview | link`). Spawns `server.js` as a child process on port 3460 and proxies pin/preview commands via HTTP. This is the entry point when installed via `pi install npm:pi-kanban`.

### Session parsing (`lib/pi-parsers.js`)

pi stores sessions as JSONL files under `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`. The encoded cwd uses `--` as separators and a leading drive letter on Windows (`--C--Users-foo--` → `C:\Users\foo`); `decodeProjectDir` reverses this. All session/task/agent endpoints in `server.js` call functions from this module — keep parsing logic here, not in route handlers.

### Frontend conventions

- All state lives in module-scope `let`s in `app.js`; localStorage persists user prefs (`theme`, `sidebar-collapsed`, `sidebar-width`, etc.).
- `app.js` is organized by `//#region NAME` / `//#endregion` blocks (folded by VS Code). When editing, place new code in the matching region; when adding new functionality that doesn't fit any existing region, add a new region rather than appending to the bottom. Grep `^//#region` to list them.

  Current regions, in order: `STATE`, `DOM`, `DATA_FETCHING`, `BULK_DELETE`, `LIVE_UPDATES`, `MESSAGE_PANEL`, `PINNING`, `MODALS`, `TOAST`, `TOOL_RENDERING`, `AGENTS`, `RENDERING`, `KANBAN`, `DRAG_DROP`, `KEYBOARD_NAV`, `TASK_DETAIL`, `HELP`, `SCRATCHPAD`, `STORAGE_MANAGER`, `KEYBOARD_SHORTCUTS`, `MARKDOWN_PREVIEW`, `SSE`, `CONTEXT_WINDOW`, `UTILS`, `FILTERS`, `EVENT_DELEGATION`, `THEME`, `SIDEBAR_LAYOUT`, `PREFERENCES`, `SESSION_INFO`, `PLAN`, `LAYOUT_SYNC`, `PWA`, `INIT`.

### Adding endpoints

Route handlers in `server.js` should be thin: validate input, call a parser, JSON-respond. Long-running or stateful work (chokidar watchers, SSE streams) is set up at module scope, not per-request — see the `/api/sessions/:id/agents/:agentId/messages/stream` pattern for per-connection watchers.

## Conventions specific to this repo

- **CommonJS in `server.js` and `lib/`**, ESM-style TS in `extensions/kanban.ts`. Don't mix.
- Windows is a first-class target — paths use `path.join`, drive-letter encoding lives in `decodeProjectDir`. Avoid POSIX-only assumptions.
- No emojis in code or UI unless explicitly requested.
