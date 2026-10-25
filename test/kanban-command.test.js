const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SKIP_TS } = require('./ts-hooks');

describe('/kanban companion panes', { skip: SKIP_TS }, () => {
  const requests = [];
  let server;
  let root;
  let openCompanion;
  const env = {};

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const json = JSON.parse(body);
        requests.push({ url: req.url, token: req.headers['x-terminal-token'], body: json });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ pane: { id: 'p1', kind: 'url', title: json.title || json.companion, companion: json.companion }, added: true }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-pane-tools-'));
    fs.mkdirSync(path.join(root, 'kanban', 'terminal-tokens'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kanban', 'terminal-tokens', `${port}.json`), JSON.stringify({ token: 'tok' }));
    for (const [k, v] of Object.entries({ PK_URL: `http://127.0.0.1:${port}`, PI_CODING_AGENT_DIR: root })) {
      env[k] = process.env[k];
      process.env[k] = v;
    }
    ({ openCompanion } = await import('../extensions/tools/kanban-command.ts'));
  });

  after(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('asks the board for a companion pane with the terminal token', async () => {
    const out = await openCompanion('s1', 'pi-cost');
    assert.equal(out.pane.companion, 'pi-cost');
    assert.deepEqual(requests.at(-1), { url: '/api/panes/s1', token: 'tok', body: { companion: 'pi-cost' } });
    await openCompanion('s1', 'pi-inspect', 't1');
    assert.deepEqual(requests.at(-1).body, { companion: 'pi-inspect', terminal: 't1' });
  });

  it('/kanban offers no completion for a command typed in full, so the first Enter runs it', async () => {
    const { completionsFor } = await import('../extensions/kanban.ts');
    const values = (p) => completionsFor(p)?.map((c) => c.value) ?? null;
    assert.deepEqual(values('co'), ['cost']);
    assert.equal(values('cost'), null);
    assert.equal(values('session cost'), null);
    assert.deepEqual(values('session in'), ['session inspect']);
    assert.ok(values('session ').includes('session cost'));
  });
});
