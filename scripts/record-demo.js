#!/usr/bin/env node
// Records the static demo's data: seeds fake pi sessions into a temp agent dir, runs server.js on
// it, and saves the replies of the routes the board reads to demo/mock-data.js. The terminal and
// its show and ask cards need a live pi, so their replies are built here from the seeded files.
//
// Run it after a change to the seed or to a route's reply shape: `npm run demo:record`.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'demo', 'mock-data.js');
const FAKE_HOME = '/home/dev';
// package.json keeps a dev version, and the release tag sets the real one.
const DEMO_VERSION = /^## (\d+\.\d+\.\d+)/m.exec(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'))?.[1];
if (!DEMO_VERSION) throw new Error('CHANGELOG.md has no "## x.y.z" release heading');
const TERMINALS = { limiter: '7e1a0000-0000-4000-8000-000000000001', checkout: '7e1a0000-0000-4000-8000-000000000003' };

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-demo-')));
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: path.join(tmp, '.pi', 'agent'),
  PI_KANBAN_TMPDIR: path.join(tmp, 'tmp'),
});
delete process.env.PI_DIR;
delete process.env.PI_CODING_AGENT_SESSION_DIR;

const { encodeProjectDirName } = require('../lib/board-dir');
const { createShowStore } = require('../lib/show');
const { readTerminalConfig, clientConfigFor } = require('../lib/terminal');
const { IDS, SHOW_IDS, LIVE_START_MIN, MODELS, seedFiles, seedLive, seedBoard } = require('../demo/seed');

// The server marks projects under its temp dir as temp, and the New session dialog hides those,
// so it gets a temp dir outside the seed. It runs without a terminal, so the terminal config and replies are built here.
function startServer() {
  const osTmp = path.join(tmp, 'os-tmp');
  fs.mkdirSync(osTmp);
  const env = { ...process.env, TMP: osTmp, TEMP: osTmp, TMPDIR: osTmp };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--no-terminal'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 20000);
    const onData = (d) => {
      log += d;
      const m = /running at http:\/\/localhost:(\d+)/.exec(log);
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve({ child, base: `http://127.0.0.1:${m[1]}` });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (log += d));
    child.on('exit', (code) => reject(new Error(`server exited with ${code}:\n${log}`)));
  });
}

function makeRewriter() {
  // The temp dir in every form a reply can carry it, longest first.
  const pairs = [
    [tmp, FAKE_HOME],
    [tmp.replace(/\\/g, '/'), FAKE_HOME],
    [encodeProjectDirName(tmp), encodeProjectDirName(FAKE_HOME)],
  ].sort(([a], [b]) => b.length - a.length);
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  const res = pairs.map(([from, to]) => [new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), to]);
  const slashes = new RegExp(`${FAKE_HOME}[^\\s"'\`)<>]*`, 'g');
  const str = (s) => {
    let out = s;
    for (const [re, to] of res) out = out.replace(re, to);
    return out === s ? s : out.replace(slashes, (p) => p.replace(/\\/g, '/'));
  };
  const walk = (v) => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), walk(x)]));
    return v;
  };
  // A reply's key is a URL, so its query is rewritten decoded.
  const rekey = (k) => {
    const u = new URL(k, 'http://demo');
    return key(str(decodeURIComponent(u.pathname)), Object.fromEntries([...u.searchParams].map(([n, v]) => [n, str(v)])));
  };
  return { walk, rekey };
}

function key(pathname, query) {
  const qs = new URLSearchParams(Object.entries(query || {}).sort(([a], [b]) => a.localeCompare(b))).toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

async function main() {
  const now = Date.now();
  const seeded = await seedFiles({ root: tmp, now });
  const { child, base } = await startServer();
  const responses = {};
  try {
    await seedLive({ ...seeded, pids: [process.pid, child.pid], now });
    const post = async (p, body) => {
      const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`POST ${p}: ${res.status} ${await res.text()}`);
    };
    await seedBoard({ post, ...seeded });

    const get = async (p, query) => {
      const k = key(p, query);
      if (k in responses) return responses[k];
      const res = await fetch(`${base}${k}`);
      if (!res.ok) throw new Error(`GET ${k}: ${res.status} ${await res.text()}`);
      responses[k] = await res.json();
      return responses[k];
    };

    for (const p of ['/api/config', '/api/projects', '/api/tasks/all', '/api/groups', '/api/session/pins', '/api/document/links', '/api/sessions/known', '/api/dispatch', '/api/companions']) await get(p);
    const list = await get('/api/sessions', { limit: 200 });
    const files = new Set();
    for (const { id } of list) {
      for (const sub of ['', '/tool-stats', '/pads', '/parent', '/artifacts']) await get(`/api/sessions/${id}${sub}`);
      await get(`/api/sessions/${id}/messages`, { limit: 50 });
      const { agents = [] } = await get(`/api/sessions/${id}/agents`);
      for (const a of agents) await get(`/api/sessions/${id}/agents/${a.agentId}/messages`);
      const panes = await get(`/api/panes/${id}`);
      for (const p of panes.panes || []) if (p.kind !== 'url' && p.kind !== 'message') files.add(p.target);
      const walkPad = async (query) => {
        const { files: entries = [] } = await get(`/api/sessions/${id}/scratchpad-files`, query);
        for (const e of entries) {
          if (e.kind === 'dir') await walkPad({ path: e.path });
          else files.add(e.path);
        }
      };
      await walkPad();
    }
    for (const docs of Object.values(responses['/api/document/links'])) for (const d of docs) files.add(typeof d === 'string' ? d : d.path);
    for (const { project, encoded } of responses['/api/projects']) if (encoded || project) await get(`/api/projects/${encodeURIComponent(encoded || project)}/tasks`).catch(() => {});
    for (const f of files) await get('/api/preview', { path: f });

    Object.assign(responses, liveReplies(seeded, list, now));
  } finally {
    child.kill();
  }

  const { walk, rekey } = makeRewriter();
  const rewritten = Object.fromEntries(Object.entries(responses).map(([k, v]) => [rekey(k), walk(v)]));
  // windowsPty describes the Windows build of the recording host, not of the viewer.
  const { windowsPty, ...terminal } = clientConfigFor(readTerminalConfig({ argv: [], env: {} }), true);
  rewritten['/api/config'].terminal = terminal;
  const data = { recordedAt: Date.now(), home: FAKE_HOME, responses: rewritten };
  const text = JSON.stringify(data, null, 1);
  const lower = text.toLowerCase();
  for (const leak of [os.userInfo().username, path.basename(tmp), 'AppData']) {
    const at = leak ? lower.indexOf(leak.toLowerCase()) : -1;
    if (at >= 0) throw new Error(`recorded data still names "${leak}": ...${text.slice(Math.max(0, at - 200), at + 100)}`);
  }
  fs.writeFileSync(OUT, `// Generated by \`npm run demo:record\` (scripts/record-demo.js). Do not edit.\nwindow.__PI_KANBAN_DEMO__ = ${text};\n`);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(responses).length} replies`);
}

// The terminal list and the cards a running pi would post, read from the seeded files.
function liveReplies({ pads, projects }, list, now) {
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  const startedAt = now - LIVE_START_MIN * 60_000;
  const term = (id, terminalId, cwd) => ({ id, terminalId, mode: 'resume', cwd, pid: null, clients: 1, startedAt, name: byId[id]?.name ?? null, edit: false, forkOf: null, piExited: false, awaitingTrust: false });
  const out = {
    '/api/version': { version: DEMO_VERSION },
    '/api/terminals': { sessions: [term(IDS.limiter, TERMINALS.limiter, projects.api), term(IDS.checkout, TERMINALS.checkout, projects.web)] },
    '/api/terminals/stats': { pk: null, host: null, terminals: {} },
    '/api/pi/models': { models: Object.values(MODELS).map((m) => ({ provider: m.provider, id: m.modelId })) },
  };
  const shows = createShowStore({ load: () => ({ [TERMINALS.limiter]: IDS.limiter }), onChange() {}, resolveDir: (id) => (id === IDS.limiter ? pads.limiter : null) });
  for (const terminalId of Object.values(TERMINALS)) {
    const index = shows.list(terminalId);
    out[`/api/terminals/${terminalId}/show`] = index;
    for (const { id } of index.posts) {
      const { entry, content, path: file } = shows.get(terminalId, id);
      out[`/api/terminals/${terminalId}/show/${id}`] = { id, title: entry.title, key: entry.key, kind: entry.kind, content, file: null, path: file, url: null };
    }
  }
  const askFile = path.join(pads.checkout, 'step-layout.html');
  const ask = { ask: { id: SHOW_IDS.ask, title: 'Step indicator layout', size: 'medium', file: askFile, sessionId: IDS.checkout, content: fs.readFileSync(askFile, 'utf8') } };
  out[`/api/terminals/${TERMINALS.checkout}/ask`] = ask;
  out[`/api/sessions/${IDS.checkout}/ask`] = ask;
  out[`/api/terminals/${TERMINALS.limiter}/ask`] = { ask: null };
  return out;
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
