# pi-kanban

Web dashboard for the [pi coding agent](https://pi.dev) — sessions, todos, subagents, observability.

## Installation

```sh
pi install npm:pi-kanban
```

Then use `/kanban start | open | app | pin | preview` from inside pi.

Or run standalone:

```sh
npx pi-kanban
```

---

## Theming

pi-kanban ships with four built-in themes and supports user-defined themes. Themes are simple JSON files declaring 15 design-token colors; derived `*-dim` / `*-glow` variants are computed automatically.

### Built-in themes

| ID                    | Mode  | Description                             |
| --------------------- | ----- | --------------------------------------- |
| `pi-light`            | light | pi.dev palette, light variant (default) |
| `pi-dark`             | dark  | pi.dev palette, dark variant (default)  |
| `kanban-default`      | light | Original kanban light theme             |
| `kanban-dark-default` | dark  | Original kanban dark theme              |

The dark/light toggle button switches between the configured light and dark themes.

### Configuring themes

Configure themes via `~/.pi/agent/kanban/settings.json`:

```json
{
  "themes": {
    "light": "pi-light",
    "dark": "pi-dark"
  }
}
```

### Environment variable overrides

Take precedence over `settings.json`. Useful for one-off runs.

| Variable             | Effect                      |
| -------------------- | --------------------------- |
| `KANBAN_LIGHT_THEME` | Theme ID used in light mode |
| `KANBAN_DARK_THEME`  | Theme ID used in dark mode  |
| `KANBAN_THEME_DIR`   | User theme directory        |

### Authoring a custom theme

Drop a JSON file in `~/.pi/agent/kanban/themes/` (or your configured `themes.dir`):

```json
{
  "name": "my-theme",
  "displayName": "My Theme",
  "mode": "dark",
  "colors": {
    "bgDeep": "#0d1116",
    "bgSurface": "#161d27",
    "bgElevated": "#212730",
    "bgHover": "#252f3d",
    "border": "#495059",
    "textPrimary": "#ebe7e4",
    "textSecondary": "#d5d8db",
    "textTertiary": "#9fa4ab",
    "textMuted": "#757d89",
    "accent": "#6a9fcc",
    "accentText": "#8fb6d8",
    "success": "#4ade80",
    "warning": "#fbbf24",
    "team": "#60a5fa",
    "plan": "#c084fc"
  }
}
```

Required fields: `name`, `mode` (`"light"` or `"dark"`), and all 15 `colors.*` keys. Themes failing validation are skipped with a server-side warning.

Reference it from `~/.pi/agent/kanban/settings.json`:

```json
{ "themes": { "dark": "my-theme" } }
```

Restart the server (`/kanban stop` + `/kanban start`) to pick up new themes.
