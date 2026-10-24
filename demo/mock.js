// Static-demo network shim. Serves the replies scripts/record-demo.js saved from a real board
// (window.__PI_KANBAN_DEMO__) in place of fetch, and mutes the event stream. Runs before app.js.

(function () {
  const D = window.__PI_KANBAN_DEMO__;
  if (!D) {
    console.error('[demo] mock-data.js not loaded');
    return;
  }

  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const MS_KEY = /(At|^at|timestamp|^ts)$/;
  const shift = Date.now() - D.recordedAt;
  const moved = (v, k) => {
    if (typeof v === 'string') return ISO.test(v) ? new Date(Date.parse(v) + shift).toISOString() : v;
    if (typeof v === 'number') return MS_KEY.test(k) && v > 1e12 ? v + shift : v;
    if (Array.isArray(v)) return v.map((x) => moved(x, k));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, moved(x, kk)]));
    return v;
  };
  const R = moved(D.responses, '');
  delete window.__PI_KANBAN_DEMO__;

  // The board shows the terminal only with a token; the fake socket in terminal.html takes any.
  try {
    sessionStorage.setItem('terminal-token', 'd'.repeat(64));
    if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'dark');
    if (!localStorage.getItem('terminal-sessions')) {
      localStorage.setItem('terminal-sessions', JSON.stringify(R['/api/terminals'].sessions.map((s) => s.id)));
    }
  } catch {}

  if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.resolve();

  const json = (body, status = 200, headers = {}) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }));
  const notFound = () => json({ error: 'not in the demo' }, 404);

  const recorded = new Map();
  for (const k of Object.keys(R)) {
    const u = new URL(k, location.origin);
    if (!recorded.has(u.pathname)) recorded.set(u.pathname, []);
    recorded.get(u.pathname).push({ k, query: [...u.searchParams] });
  }

  // The recorded reply whose query the request carries in full, ignoring the page size.
  function lookup(u) {
    let best = null;
    for (const r of recorded.get(decodeURIComponent(u.pathname)) || []) {
      const fits = r.query.every(([n, v]) => n === 'limit' || u.searchParams.get(n) === v);
      if (fits && (!best || r.query.length > best.query.length)) best = r;
    }
    return best && R[best.k];
  }

  // Nothing writes in the demo, so a session touched in the last hour reads as recently active.
  const RECENT_MS = 60 * 60_000;
  for (const s of R['/api/sessions?limit=200']) {
    if (Date.now() - Date.parse(s.modifiedAt) < RECENT_MS) Object.assign(s, { hasRecentLog: true, hasRecentActivity: true });
  }

  function sessions(q) {
    let list = R['/api/sessions?limit=200'];
    const include = new Set((q.get('include') || '').split(',').filter(Boolean));
    const project = q.get('project');
    if (project) list = list.filter((s) => s.project === project || include.has(s.id));
    if (q.get('filter') === 'active') list = list.filter((s) => s.active || s.hasRecentLog || s.pin || include.has(s.id));
    const limit = parseInt(q.get('limit') || '20', 10);
    return json(list.slice(0, limit), 200, { 'X-Has-More': String(list.length > limit) });
  }

  function messages(u, reply) {
    const limit = parseInt(u.searchParams.get('limit') || '10', 10);
    const before = u.searchParams.get('before');
    let list = reply.messages;
    if (before) list = list.filter((m) => m.timestamp < before);
    return json({ ...reply, messages: list.slice(-limit), hasMore: list.length > limit });
  }

  function route(u, method) {
    if (method !== 'GET') return json({ ok: true });
    const p = u.pathname.replace(/^.*?(?=\/api\/)/, '');
    const at = new URL(p + u.search, location.origin);
    if (at.pathname === '/api/sessions') return sessions(at.searchParams);
    const reply = lookup(at);
    if (!reply) return notFound();
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(at.pathname)) return messages(at, reply);
    return json(reply);
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.includes('/api/')) {
      const method = (init?.method || input?.method || 'GET').toUpperCase();
      return route(new URL(url, location.href), method);
    }
    return origFetch(input, init);
  };

  window.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({ type: 'open' });
      }, 0);
    }
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.readyState = 2;
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.id = 'demo-banner';
    banner.textContent = 'Demo: sample data, no live updates';
    banner.style.cssText = [
      'position:fixed', 'bottom:8px', 'right:12px', 'z-index:99999',
      'padding:6px 10px', 'border-radius:6px',
      'background:rgba(0,0,0,.65)', 'color:#fff',
      'font:12px/1.4 system-ui,sans-serif', 'pointer-events:none',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    ].join(';');
    document.body.appendChild(banner);
  });
})();
