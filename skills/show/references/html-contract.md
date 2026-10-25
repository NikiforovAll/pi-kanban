# HTML card contract

Show and ask cards share these rules.

- Write a body fragment: no `<!doctype>`, `<html>`, `<head>` or `<body>`. The board wraps it in a sandboxed document. `<style>` and `<script>` work; the script has no network and no access to the page around it.
- Open links with `<a href="https://...">`; the board opens them in a new browser tab.
- Take every color and font from these variables, so the card follows the user's light or dark theme:

| Variable | Use |
|---|---|
| `--color-bg`, `--color-bg-subtle` | Page and panel background |
| `--color-text`, `--color-text-muted` | Body text, secondary text |
| `--color-border` | Lines, box outlines |
| `--color-accent` | The one thing to look at |
| `--color-info`, `--color-success`, `--color-warning`, `--color-danger` | Status |
| `--color-series-1` … `--color-series-8` | Chart series, in order |
| `--color-ramp-1` … `--color-ramp-5` | One-hue magnitude, least to most |
| `--font-sans`, `--font-mono` | Fonts |
