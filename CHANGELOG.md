# Changelog

## 2.0.0

pi-kanban is now an agent development environment for pi. The board runs pi sessions in a browser terminal, next to their todos, subagents, and docs.

### Breaking changes

- The pi extension no longer starts the board. Install it with `npm install -g pi-kanban` and run `pi-kanban` in a shell.
- `/kanban start`, `stop`, `restart`, `status`, and `open web|app` are gone. `/kanban` and `/kanban open` open the board with its access token.
- The JSON themes are gone. The board has color themes in a palette menu, and `T` switches light and dark.

### Features

- **Board terminal.** Runs pi next to each session's board, on by default. `--no-terminal` turns it off. The terminal keeps running when the browser tab closes.
- **New session dialog.** Pick a folder or project, and set the name, first prompt, model, and thinking level. `Ctrl+Alt+R` resumes an older session.
- **pi tools.** `show` and `ask` cards; `pane_add`, `pane_rm`, and `pane_list`; and `link_doc`, `unlink_doc`, and `preview_doc`.
- **Dispatch.** `dispatch_start` hands a task to a new pi session in the board terminal. The worker calls `dispatch_report`, and the board keeps the report until the parent gets it with `dispatch_wait`.
- **Board messages to pi.** Review comments, card answers, and task moves reach pi as user messages.
- **Scratchpad.** A folder per session, given to pi in the system prompt and `$PI_SCRATCHPAD_DIR`, deleted 7 days after the session ends.
- **Command line.** `pi-kanban doc|pane|session|group|task|project|dispatch|terminal|skills` talks to a running board.
- Sessions get their title from the first prompt.

### Security

- The terminal and dispatch need a random token, which the board keeps in the URL fragment.
- The board refuses requests with a non-local `Host` header and cross-site requests that change data.
