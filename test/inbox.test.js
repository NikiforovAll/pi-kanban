const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SKIP_TS } = require('./ts-hooks');

describe('the pi inbox', { skip: SKIP_TS }, () => {
  const polls = [];
  let server;
  let root;
  let registerInbox;
  const env = {};

  before(async () => {
    server = http.createServer((req) => {
      const url = new URL(req.url, 'http://x');
      polls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-inbox-'));
    for (const [k, v] of Object.entries({ PK_URL: `http://127.0.0.1:${server.address().port}`, PI_CODING_AGENT_DIR: root, PI_SUBAGENT_CHILD: undefined })) {
      env[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    ({ registerInbox } = await import('../extensions/tools/inbox.ts'));
  });

  after(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function nextPoll(n) {
    for (let i = 0; i < 200 && polls.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(polls.length, n);
    return polls[n - 1];
  }

  // pi loads the extension again for each session, so each start registers a fresh inbox.
  async function start(id, reason, previousSessionFile) {
    const handlers = {};
    registerInbox({ on: (name, fn) => { handlers[name] = fn; }, sendUserMessage() {} });
    await handlers.session_start({ type: 'session_start', reason, previousSessionFile }, {
      sessionManager: { getSessionId: () => id },
      hasUI: true,
      isIdle: () => true,
    });
    return handlers;
  }

  it('sends the old session id as prev after /new and /fork, not after a resume', async () => {
    const file = (id) => path.join(root, 'sessions', `2026-10-25T10-00-00-000Z_${id}.jsonl`);
    const runs = [];

    runs.push(await start('s1', 'startup'));
    const p1 = await nextPoll(1);
    assert.equal(p1.path, '/api/sessions/s1/events');
    assert.equal(p1.query.first, '1');
    assert.equal(p1.query.prev, undefined);

    runs.push(await start('s2', 'new', file('s1')));
    const p2 = await nextPoll(2);
    assert.equal(p2.path, '/api/sessions/s2/events');
    assert.equal(p2.query.prev, 's1');

    runs.push(await start('s3', 'resume', file('s2')));
    assert.equal((await nextPoll(3)).query.prev, undefined);

    runs.push(await start('s4', 'fork', file('s3')));
    assert.equal((await nextPoll(4)).query.prev, 's3');

    for (const h of runs) await h.session_shutdown();
  });
});
