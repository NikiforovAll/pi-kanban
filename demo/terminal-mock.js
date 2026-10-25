// Static-demo terminal: a WebSocket that answers the board's hello and draws a still pi screen.
// Loaded into terminal.html before terminal-frame.js.

(function () {
  const ID = (n) => `01a30000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const esc = (c) => `\x1b[${c}m`;
  // The 16 ANSI colors, which the board maps to the light or dark theme.
  const dim = (s) => esc(90) + s + esc(0);
  const accent = (s) => esc(34) + s + esc(0);
  const ok = (s) => esc(32) + s + esc(0);
  const warn = (s) => esc(33) + s + esc(0);
  const bold = (s) => esc(1) + s + esc(0);
  const user = (s) => accent('› ') + bold(s);
  const tool = (s) => esc(36) + '● ' + esc(0) + s;
  const HEADER = bold('pi') + dim(' v0.70.2');

  const width = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

  function footer({ cwd, model, ctx }, cols) {
    const left = `${cwd} (main)   ↑18k ↓4.2k   ${ctx}/200k`;
    const right = `${model} • medium`;
    const gap = cols - left.length - right.length;
    return [
      dim('─'.repeat(cols)),
      `${accent('>')} `,
      dim('─'.repeat(cols)),
      gap >= 2 ? dim(left + ' '.repeat(gap) + right) : dim(left.slice(0, cols)),
    ];
  }

  // History at the top, the status and the editor on the last rows, as in a pi session that has run a while.
  function render({ history, status = [], ...info }, cols, rows) {
    const bottom = [...status, ...footer(info, cols)];
    const used = [...history, ...bottom].reduce((n, l) => n + Math.max(1, Math.ceil(width(l) / cols)), 0);
    const lines = [...history, ...Array(Math.max(0, rows - used)).fill(''), ...bottom];
    return '\x1b[3J\x1b[2J\x1b[H' + lines.join('\r\n') + `\x1b[${rows - 2};3H`;
  }

  const SCREENS = {
    [ID(1)]: {
      cwd: '~/code/acme-api',
      model: 'claude-sonnet-5-5',
      ctx: '41.8%',
      history: [
        HEADER,
        '',
        user('Add a Redis-backed rate limiter to the API. Plan it first and open the plan in a pane, then build it with tests.'),
        '',
        'I read how the middleware is wired. The plan is in _plans/rate-limiter.md and is open in a pane.',
        '',
        tool('$ pi-kanban pane add _plans/rate-limiter.md'),
        tool('subagent scout: list every public route that takes an API key'),
        dim('  scout: 14 public routes, 11 take an API key'),
        '',
        tool('$ npm test -- rate-limit'),
        ok('  PASS ') + 'test/rate-limit.test.ts (3 tests)',
        '',
        tool('$ pi-kanban show bench.html --title "Limiter benchmark"'),
        tool('$ pi-kanban dispatch start --cwd . --name rate-limit-load-test --spec-file load-test.md'),
        tool(`$ pi-kanban dispatch wait ${ID(4)}`),
        dim('  report: p95 21 ms, 429 rate 0.4%'),
        '',
        'The token bucket is in src/middleware/rate-limit.ts. The load test ran in its own session and reported back.',
        'Integration tests are next. The reviewer subagent is reading the diff now.',
      ],
      status: [warn('⠋') + ' Working... ' + dim('reviewer'), ''],
    },
    [ID(3)]: {
      cwd: '~/code/acme-web',
      model: 'gemini-2.5-pro',
      ctx: '22.4%',
      history: [
        HEADER,
        '',
        user('Split checkout into address, payment and review steps. Ask me before you pick a layout.'),
        '',
        'The review step works, and payment is behind checkout.payment-v2. One choice is yours: how the step indicator looks.',
        '',
        tool('ask "Step indicator layout" step-layout.html'),
        dim('  waiting for your answer on the board'),
      ],
      status: [''],
    },
  };

  const generic = (id) => ({
    cwd: '~/code',
    model: 'claude-sonnet-5-5',
    ctx: '9.6%',
    history: [HEADER, '', dim(`Resumed session ${id}`)],
    status: [''],
  });

  class DemoSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'blob';
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({ type: 'open' });
      }, 0);
    }
    send(data) {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        this.screen = SCREENS[msg.id] || generic(msg.id);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: 'ready', attached: true }) }), 0);
      }
      if (this.screen && (msg.t === 'hello' || msg.t === 'resize') && msg.cols > 0 && msg.rows > 0) {
        const data = new TextEncoder().encode(render(this.screen, msg.cols, msg.rows)).buffer;
        setTimeout(() => this.onmessage?.({ data }), 0);
      }
    }
    close() {
      this.readyState = 3;
    }
  }
  DemoSocket.CONNECTING = 0;
  DemoSocket.OPEN = 1;
  DemoSocket.CLOSING = 2;
  DemoSocket.CLOSED = 3;
  window.WebSocket = DemoSocket;
})();
