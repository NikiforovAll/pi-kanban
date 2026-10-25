const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempAgentDir, startServer, stopServer } = require('./server-harness');

const LIVE = '7e570000-0000-4000-8000-000000000001';
const DEAD = '7e570000-0000-4000-8000-000000000002';

describe('/api/session/resolve', () => {
  let srv;
  let port;

  before(async () => {
    const dir = tempAgentDir('pk-resolve-');
    const live = path.join(dir, 'kanban', 'live');
    fs.mkdirSync(live, { recursive: true });
    const entry = (sessionId, pid, name) => JSON.stringify({ sessionId, pid, kind: 'interactive', name });
    fs.writeFileSync(path.join(live, `${process.pid}.json`), entry(LIVE, process.pid, 'fresh one'));
    fs.writeFileSync(path.join(live, '1.json'), entry(DEAD, 999999999, 'crashed'));
    srv = startServer(['--no-terminal'], { dir });
    port = await srv.port;
  });

  after(() => stopServer(srv));

  const resolve = async (id) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/session/resolve?id=${encodeURIComponent(id)}`);
    return { status: res.status, body: await res.json() };
  };

  it('finds a live session that has no transcript yet, by id or prefix', async () => {
    assert.deepEqual(await resolve(LIVE), { status: 200, body: { id: LIVE, customTitle: 'fresh one' } });
    assert.deepEqual((await resolve(LIVE.slice(0, 30))).body.id, LIVE);
  });

  it('skips a registry entry whose pi is gone', async () => {
    assert.equal((await resolve(DEAD)).status, 404);
  });
});
