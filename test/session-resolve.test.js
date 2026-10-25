const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIVE = '7e570000-0000-4000-8000-000000000001';
const DEAD = '7e570000-0000-4000-8000-000000000002';

describe('/api/session/resolve', () => {
  let child;
  let dir;
  let port;

  before(async () => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-resolve-')));
    const live = path.join(dir, 'kanban', 'live');
    fs.mkdirSync(live, { recursive: true });
    const entry = (sessionId, pid, name) => JSON.stringify({ sessionId, pid, kind: 'interactive', name });
    fs.writeFileSync(path.join(live, `${process.pid}.json`), entry(LIVE, process.pid, 'fresh one'));
    fs.writeFileSync(path.join(live, '1.json'), entry(DEAD, 999999999, 'crashed'));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--no-terminal'], {
      env: { ...process.env, PORT: '0', PI_CODING_AGENT_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    port = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/running at http:\/\/localhost:(\d+)/);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
  });

  after(() => {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    else child.kill();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked by the dying child */ }
  });

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
