const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { registerHooks } = require('node:module');

// The extension imports its siblings as .js, as tsc emits them; Node runs the .ts source.
const canRunTs = typeof registerHooks === 'function' && !!process.features.typescript;
if (canRunTs) {
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (e) {
        if (!specifier.endsWith('.js') || !context.parentURL?.includes('/extensions/')) throw e;
        return next(specifier.replace(/\.js$/, '.ts'), context);
      }
    },
  });
}

describe('pane_add and companion_open', { skip: !canRunTs && 'needs Node with registerHooks and type stripping' }, () => {
  const requests = [];
  let server;
  let root;
  let addPane;
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
    ({ addPane, openCompanion } = await import('../extensions/tools/panes.ts'));
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
  });

  it('sends a target without the token', async () => {
    await addPane('s1', root, { target: 'report.html', title: 'R' });
    assert.deepEqual(requests.at(-1), { url: '/api/panes/s1', token: undefined, body: { target: path.join(root, 'report.html'), title: 'R' } });
  });
});
