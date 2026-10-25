const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createCompanionHost } = require('../lib/companion-host');
const { isPidAlive } = require('../lib/live-sessions');

const TOOL = `
const http = require('node:http');
const i = process.argv.indexOf('--port');
const port = Number(process.argv[i + 1]);
const host = process.argv[process.argv.indexOf('--host') + 1];
http.createServer((req, res) => {
  if (req.url !== '/api/companion') return res.writeHead(404).end();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ name: 'pi-cost', version: '0.0.1', session: '/?session={id}', agentDir: process.env.PI_CODING_AGENT_DIR, noOpen: process.argv.includes('--no-open') }));
}).on('error', () => process.exit(1)).listen(port, host, () => console.log('pi-cost listening on http://localhost:' + port));
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await wait(20);
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

describe('companion host', () => {
  let root;
  let agentDir;
  let dir;
  const hosts = [];
  const quiet = { log() {}, error() {} };

  const host = (opts = {}) => {
    const h = createCompanionHost({ agentDir, dir, log: quiet, ...opts });
    hosts.push(h);
    return h;
  };
  const record = () => JSON.parse(fs.readFileSync(path.join(dir, 'pi-cost.json'), 'utf8'));

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-companion-host-'));
    agentDir = path.join(root, 'agent');
    dir = path.join(agentDir, 'kanban', 'companions');
    const tool = path.join(root, 'pi-cost');
    fs.mkdirSync(tool, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(tool, 'package.json'), JSON.stringify({ name: 'pi-cost', bin: { 'pi-cost': './server.js' } }));
    fs.writeFileSync(path.join(tool, 'server.js'), TOOL);
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: [path.relative(agentDir, tool)] }));
  });

  afterEach(() => {
    for (const h of hosts.splice(0)) h.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('starts the tool on loopback, records its port, and reuses the running child', async () => {
    const h = host();
    const first = await h.start('pi-cost');
    assert.ok(first.port > 0);
    const info = await (await fetch(`http://127.0.0.1:${first.port}/api/companion`)).json();
    assert.equal(info.agentDir, agentDir);
    assert.equal(info.noOpen, true);
    assert.deepEqual(record(), { pid: first.pid, port: first.port, boardPid: process.pid });
    assert.equal((await h.start('pi-cost')).pid, first.pid);
    assert.equal(h.url(first, 'a b'), `http://127.0.0.1:${first.port}/?session=a%20b`);
    assert.equal(h.url(first), `http://127.0.0.1:${first.port}/`);
  });

  it('starts one child for calls that overlap', async () => {
    const h = host();
    const [a, b] = await Promise.all([h.start('pi-cost'), h.start('pi-cost')]);
    assert.equal(a.pid, b.pid);
  });

  it('stops the child, and the next start takes the recorded port again', async () => {
    const h = host();
    const first = await h.start('pi-cost');
    h.stop();
    await until(() => !isPidAlive(first.pid));
    assert.equal(isPidAlive(first.pid), false);
    const again = await host().start('pi-cost');
    assert.notEqual(again.pid, first.pid);
    assert.equal(again.port, first.port);
  });

  it('adopts a child left by a board that died, without a new spawn', async () => {
    const srv = await listen((req, res) => res.end(JSON.stringify({ name: 'pi-cost', session: '/?session={id}' })));
    const { port } = srv.address();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pi-cost.json'), JSON.stringify({ pid: 4242, port, boardPid: 4243 }));
    let spawned = 0;
    const h = host({ spawn: () => { spawned++; throw new Error('no spawn'); }, isPidAlive: (pid) => pid === 4242 });
    try {
      const entry = await h.start('pi-cost');
      assert.equal(spawned, 0);
      assert.deepEqual([entry.pid, entry.port], [4242, port]);
      assert.equal(record().boardPid, process.pid);
    } finally {
      hosts.splice(hosts.indexOf(h), 1);
      srv.close();
    }
  });

  it('takes a new port when the recorded one belongs to something else', async () => {
    const srv = await listen((req, res) => res.writeHead(404).end());
    const { port } = srv.address();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pi-cost.json'), JSON.stringify({ pid: 4242, port, boardPid: 4243 }));
    try {
      const entry = await host({ isPidAlive: () => false }).start('pi-cost');
      assert.notEqual(entry.port, port);
      assert.equal(record().port, entry.port);
    } finally {
      srv.close();
    }
  });

  it('reports a tool that is not installed or not known', async () => {
    const h = host({ agentDir: path.join(root, 'empty') });
    assert.equal((await h.start('pi-inspect')).status, 404);
    assert.equal((await h.start('pi-subagents')).status, 404);
  });
});
