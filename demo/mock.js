// Static-demo network shim. Intercepts fetch + EventSource and serves
// the synthesized dataset in window.__PI_KANBAN_DEMO__.
//
// Runs before app.js. The original fetch is kept for non-/api requests
// (HTML, CSS, JS, manifest, icons).

(function () {
  const D = window.__PI_KANBAN_DEMO__;
  if (!D) {
    console.error('[demo] mock-data.js not loaded');
    return;
  }

  // Default to dark theme on first visit. Users can still toggle via the UI.
  if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'dark');

  const origFetch = window.fetch.bind(window);

  function jsonResponse(body, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  const ok = (body) => jsonResponse(body, 200);
  const notFound = () => jsonResponse({ error: 'not found' }, 404);

  function decodePath(url) {
    try { return new URL(url, location.origin); } catch { return null; }
  }

  function route(u) {
    const p = u.pathname;
    const q = u.searchParams;

    if (p === '/api/version') return ok({ name: 'pi-kanban', version: 'demo' });
    if (p === '/api/context-status') return ok({});
    if (p === '/api/themes') return ok(D.themes);
    if (p === '/api/projects') return ok(D.projects);

    if (p === '/api/sessions') {
      const project = q.get('project');
      const limit = parseInt(q.get('limit') || '200', 10);
      let list = D.sessions.slice();
      if (project) list = list.filter((s) => s.project === project);
      list.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
      return ok(list.slice(0, limit));
    }

    if (p === '/api/tasks/all') {
      const out = {};
      for (const sid of Object.keys(D.tasksBySession)) out[sid] = D.tasksBySession[sid];
      return ok(out);
    }

    let m;

    m = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (m) return ok(D.tasksBySession[decodeURIComponent(m[1])] || []);

    m = p.match(/^\/api\/sessions\/([^/]+)\/agents$/);
    if (m) {
      const sid = decodeURIComponent(m[1]);
      return ok(D.agentsBySession[sid] || { agents: [], waitingForUser: false });
    }

    m = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (m) {
      const sid = decodeURIComponent(m[1]);
      const msgs = (D.messagesBySession[sid] || []).slice().reverse();
      const limit = parseInt(q.get('limit') || '15', 10);
      return ok({ messages: msgs.slice(0, limit), hasMore: msgs.length > limit, sessionId: sid });
    }

    m = p.match(/^\/api\/sessions\/([^/]+)\/plan$/);
    if (m) {
      const sid = decodeURIComponent(m[1]);
      const plan = D.plansBySession[sid];
      return plan ? ok(plan) : ok({ sessionId: sid, content: null });
    }

    m = p.match(/^\/api\/sessions\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (m) {
      const sid = decodeURIComponent(m[1]);
      const agentId = decodeURIComponent(m[2]);
      const a = (D.agentsBySession[sid]?.agents || []).find((x) => x.agentId === agentId);
      const text = a ? (a.lastMessage || '') : '';
      return ok({
        messages: text ? [{ type: 'assistant', role: 'assistant', text, timestamp: a.updatedAt }] : [],
        hasMore: false,
        sessionId: sid,
        agentId,
      });
    }

    m = p.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (m) {
      const enc = decodeURIComponent(m[1]);
      const proj = D.projects.find((p) => p.encoded === enc);
      if (!proj) return ok({});
      const out = {};
      for (const s of D.sessions.filter((s) => s.project === proj.project)) {
        out[s.id] = D.tasksBySession[s.id] || [];
      }
      return ok(out);
    }

    if (p === '/api/preview') {
      return ok({ html: '<p><em>Preview unavailable in static demo.</em></p>' });
    }

    // Mutating endpoints — accept and echo, but state is in-memory only.
    if (p === '/api/session/pin') return ok({ ok: true });
    if (p.match(/^\/api\/sessions\/[^/]+\/agents\/[^/]+\/stop$/)) return ok({ ok: true });
    if (p.match(/^\/api\/tasks\/[^/]+\/[^/]+$/)) return ok({ ok: true });
    if (p.match(/^\/api\/sessions\/[^/]+\/tasks\/[^/]+$/)) return ok({ ok: true });

    return notFound();
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/')) {
      const u = decodePath(url);
      if (u) return route(u);
    }
    return origFetch(input, init);
  };

  // EventSource shim — never emits; demo is static.
  class DemoEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null; this.onmessage = null; this.onerror = null;
      setTimeout(() => {
        this.readyState = 1;
        if (typeof this.onopen === 'function') this.onopen({ type: 'open' });
      }, 0);
    }
    addEventListener() {}
    removeEventListener() {}
    close() { this.readyState = 2; }
  }
  window.EventSource = DemoEventSource;

  // Banner so visitors know it's a demo.
  window.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.textContent = 'DEMO — synthesized data, no live updates';
    banner.style.cssText = [
      'position:fixed', 'bottom:8px', 'right:12px', 'z-index:99999',
      'padding:6px 10px', 'border-radius:6px',
      'background:rgba(0,0,0,.65)', 'color:#fff',
      'font:12px/1.4 system-ui,sans-serif', 'pointer-events:none',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    ].join(';');
    document.body.appendChild(banner);
  });

  console.info('[demo] mock layer active — synthesized dataset in window.__PI_KANBAN_DEMO__');
})();
