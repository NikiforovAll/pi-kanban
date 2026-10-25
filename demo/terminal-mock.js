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

  function footer(cwd, model, ctx) {
    return [
      dim('─'.repeat(78)),
      `${accent('>')} `,
      dim('─'.repeat(78)),
      dim(`${cwd} (main)   ↑18k ↓4.2k   ${ctx}/200k`) + '          ' + dim(`${model} • medium`),
    ];
  }

  const SCREENS = {
    [ID(1)]: [
      HEADER,
      '',
      user('Add a Redis-backed rate limiter to the API. Plan it first and open the plan in a pane, then build it with tests.'),
      '',
      'I read how the middleware is wired. The plan is in _plans/rate-limiter.md and is open in a pane.',
      '',
      tool('pane_add _plans/rate-limiter.md'),
      tool('subagent scout: list every public route that takes an API key'),
      dim('  scout: 14 public routes, 11 take an API key'),
      '',
      tool('$ npm test -- rate-limit'),
      ok('  PASS ') + 'test/rate-limit.test.ts (3 tests)',
      '',
      tool('show "Limiter benchmark" (html)'),
      tool('dispatch_start rate-limit-load-test'),
      dim('  report: p95 21 ms, 429 rate 0.4%'),
      '',
      'The token bucket is in src/middleware/rate-limit.ts. The load test ran in its own session and reported back.',
      'Integration tests are next. The reviewer subagent is reading the diff now.',
      '',
      warn('⠋') + ' Working... ' + dim('reviewer'),
      '',
      ...footer('~/code/acme-api', 'claude-sonnet-4-5', '41.8%'),
    ],
    [ID(3)]: [
      HEADER,
      '',
      user('Split checkout into address, payment and review steps. Ask me before you pick a layout.'),
      '',
      'The review step works, and payment is behind checkout.payment-v2. One choice is yours: how the step indicator looks.',
      '',
      tool('ask "Step indicator layout" step-layout.html'),
      dim('  waiting for your answer on the board'),
      '',
      ...footer('~/code/acme-web', 'gemini-2.5-pro', '22.4%'),
    ],
  };

  const generic = (id) => [
    HEADER,
    '',
    dim(`Resumed session ${id}`),
    '',
    ...footer('~/code', 'claude-sonnet-4-5', '9.6%'),
  ];

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
        const lines = SCREENS[msg.id] || generic(msg.id);
        this.screen = new TextEncoder().encode('\x1b[3J\x1b[2J\x1b[H' + lines.join('\r\n'));
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: 'ready', attached: true }) }), 0);
      }
      if (this.screen && (msg.t === 'hello' || msg.t === 'resize')) {
        const data = this.screen.slice().buffer;
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
