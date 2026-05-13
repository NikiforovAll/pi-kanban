---
layout: home

hero:
  name: "pi-kanban"
  text: "Workspace for the pi coding agent"
  tagline: Sessions, todos, subagents, and plans — all in one view.
  image:
    src: https://raw.githubusercontent.com/NikiforovAll/pi-kanban/main/assets/pi-kanban-poster.png
    alt: pi-kanban dashboard
  actions:
    - theme: brand
      text: User Guide
      link: /user-guide
    - theme: alt
      text: View on GitHub
      link: https://github.com/NikiforovAll/pi-kanban
    - theme: alt
      text: Live Demo
      link: https://nikiforovall.github.io/pi-kanban/

features:
  - title: Zero-config observability
    details: Reads pi's session JSONL directly from ~/.pi/agent/sessions. No instrumentation, no daemon to configure.
  - title: Live updates
    details: Chokidar + SSE stream changes to the browser as pi writes them — no polling, no refresh.
  - title: Subagent-aware
    details: Nested sessions from pi-subagents render under their parent with full lifecycle inline.
  - title: Bring your own plan
    details: Any markdown file becomes a session plan via the bind_plan tool. No opinion on how it's produced.
  - title: Themed
    details: Four built-in themes (pi-light/dark, kanban-light/dark) plus 15-token custom themes loaded from disk.
  - title: Pi-native
    details: Installs as a pi package (pi install npm:pi-kanban). /kanban slash command controls the server and opens the dashboard via /kanban open web|app, with session actions under /kanban session <verb>.
---
