const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const SID = '01a30000-0000-7000-8000-000000000001';
const WORKER = '01a30000-0000-7000-8000-000000000002';

describe('CLI show, session cost and dispatch wait', () => {
  const hits = [];
  let srv;
  let dir;
  let url;
  let reportPolls = 0;

  before(async () => {
    srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        hits.push({ method: req.method, path: u.pathname, token: req.headers['x-terminal-token'] || null, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        if (u.pathname === '/api/session/resolve') return res.end(JSON.stringify({ id: u.searchParams.get('id') }));
        if (u.pathname.endsWith('/show')) return res.end(JSON.stringify({ title: 'Plan', key: 'plan', index: 1, count: 2 }));
        if (u.pathname.startsWith('/api/panes/')) {
          const j = JSON.parse(body);
          return res.end(JSON.stringify({ pane: { id: 'p1', title: j.title || j.companion }, added: true }));
        }
        if (u.pathname === `/api/dispatch/${WORKER}/report`) {
          reportPolls++;
          return res.end(JSON.stringify(reportPolls < 2 ? { status: 'pending' } : { status: 'reported', text: 'done' }));
        }
        res.statusCode = 404;
        res.end('{"error":"no route"}');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    url = `http://127.0.0.1:${port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-cli-show-'));
    fs.mkdirSync(path.join(dir, 'kanban', 'terminal-tokens'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'kanban', 'terminal-tokens', `${port}.json`), JSON.stringify({ token: 'tok' }));
  });

  after(() => {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(args, env = {}) {
    const clean = { ...process.env };
    for (const k of ['PORT', 'PK_URL', 'PK_TERMINAL_ID', 'PREVIEW_SESSION']) delete clean[k];
    const full = { ...clean, PI_CODING_AGENT_DIR: dir, PK_URL: url, PI_KANBAN_SESSION_ID: SID, ...env };
    return new Promise((resolve) => {
      execFile(process.execPath, [SERVER, ...args], { env: full, cwd: dir }, (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
  }

  const last = (p) => hits.filter((h) => h.path.includes(p)).at(-1);

  it('show posts to the overlay of the board terminal, with the token', async () => {
    const { code, stdout } = await run(['show', 'plan.md', '--key', 'plan', '--base', '.'], { PK_TERMINAL_ID: 't1' });
    assert.equal(code, 0);
    assert.match(stdout, /^Shown "Plan" \(plan, 1\/2\)\. The user sees the rendered card/);
    const h = last('/show');
    assert.equal(h.path, '/api/terminals/t1/show');
    assert.equal(h.token, 'tok');
    assert.deepEqual(h.body, { sessionId: SID, title: 'plan.md', file: path.join(dir, 'plan.md'), key: 'plan', base: dir });
  });

  it('show adds a background tab off the board terminal', async () => {
    const { code, stdout } = await run(['show', 'plan.md', '--title', 'The plan']);
    assert.equal(code, 0);
    assert.match(stdout, /^Added "The plan" as a background tab of session 01a30000/);
    const h = last('/api/panes/');
    assert.equal(h.path, `/api/panes/${SID}`);
    assert.deepEqual(h.body, { target: path.join(dir, 'plan.md'), title: 'The plan', show: true });
  });

  it('session cost opens pi-cost for this session and names the board terminal', async () => {
    const { code, stdout } = await run(['session', 'cost'], { PK_TERMINAL_ID: 't1' });
    assert.equal(code, 0);
    assert.equal(stdout.trim(), 'p1  pi-cost');
    const h = last('/api/panes/');
    assert.equal(h.token, 'tok');
    assert.deepEqual(h.body, { companion: 'pi-cost', terminal: 't1' });
  });

  it('session inspect takes a session id and sends no terminal off the board terminal', async () => {
    const { code } = await run(['session', 'inspect', WORKER]);
    assert.equal(code, 0);
    const h = last('/api/panes/');
    assert.equal(h.path, `/api/panes/${WORKER}`);
    assert.deepEqual(h.body, { companion: 'pi-inspect' });
  });

  it('dispatch wait polls until the report is in', async () => {
    const { code, stdout } = await run(['dispatch', 'wait', WORKER]);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), `Report from ${WORKER}:\ndone`);
    assert.equal(reportPolls, 2);
  });

  it('dispatch wait fails on a session that was not dispatched', async () => {
    const { code, stderr } = await run(['dispatch', 'wait', SID]);
    assert.equal(code, 1);
    assert.match(stderr, /Dispatch wait failed \(404\)/);
  });
});
