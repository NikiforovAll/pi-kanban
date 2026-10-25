# Changelog

## 2.0.0

pi-kanban is now an agent development environment for pi. The board runs pi sessions in a browser terminal, next to their todos, subagents, and docs.

### Breaking changes

- The pi extension no longer starts the board. Install it with `npm install -g pi-kanban` and run `pi-kanban` in a shell.
- `/kanban start`, `stop`, `restart`, `status`, and `open web|app` are gone. `/kanban` and `/kanban open` open the board with its access token.
- The JSON themes are gone. The board has color themes in a palette menu, and `T` switches light and dark.
- The board no longer opens files or folders in your editor. A file the preview cannot show gets a card with a Copy path button.

### Features

- **Board terminal.** Runs pi next to each session's board, on by default. `--no-terminal` turns it off. The terminal keeps running when the browser tab closes.
- **New session dialog.** Pick a folder or project, and set the name, first prompt, model, and thinking level. `Ctrl+Alt+R` resumes an older session.
- **Skills.** `kanban`, `show`, `ask`, `visualize`, and `dispatch` teach pi the `pi-kanban` command, so the board adds skill descriptions to the system prompt in place of tool schemas. pi adds panes, links and previews docs, posts `show` cards, and opens pi-cost or pi-inspect through the command.
- **`ask` tool.** Shows an HTML question in a modal and waits for the answer. pi asks in its own prompt when the board is down.
- **Dispatch.** `pi-kanban dispatch start` hands a task to a new pi session in the board terminal. The worker calls the `dispatch_report` tool, and the board keeps the report until the parent gets it with `pi-kanban dispatch wait`.
- **Panes and preview.** Tabs next to the terminal hold files, URLs, pi-cost, and pi-inspect. The preview shows linked docs and scratchpad files in the board's colors.
- **Board messages to pi.** Review comments, card answers, and task moves reach pi as user messages.
- **Scratchpad.** A folder per session, given to pi in the system prompt and `$PI_SCRATCHPAD_DIR`, deleted 7 days after the session ends.
- **Command line.** `pi-kanban doc|pane|show|session|group|task|project|dispatch|terminal|skills` talks to a running board.
- Sessions get their title from the first prompt.

### Security

- The terminal and dispatch need a random token, which the board keeps in the URL fragment.
- The board refuses requests with a non-local `Host` header and cross-site requests that change data.
