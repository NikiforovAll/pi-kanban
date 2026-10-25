'use strict';

// Runs the optional companion dashboards (pi-cost, pi-inspect) as children of the board, so a pane
// can show them. The embed contract the tools follow: `node <bin> --port <n> --host 127.0.0.1
// --no-open` with PI_CODING_AGENT_DIR set, an explicit port binds exactly (taken: exit 1), and
// GET /api/companion answers {name, version, session}, where session is a path with {id}.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const { spawn: nodeSpawn } = require('node:child_process');
const { writeJsonAtomic } = require('./atomic-write');
const { isPidAlive: pidAlive } = require('./live-sessions');
const { readSettings } = require('./claude-settings');
const { companionStatus } = require('./companions');

const START_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 1500;
const POLL_MS = 100;

function binPath(dir) {
  const pkg = readSettings(path.join(dir, 'package.json'));
  const bin = typeof pkg?.bin === 'string' ? pkg.bin : (pkg?.bin?.[pkg.name] ?? Object.values(pkg?.bin || {})[0]);
  return typeof bin === 'string' ? path.join(dir, bin) : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The record in <dir>/<id>.json keeps the last port, so a pane URL saved before a board restart
// still works, and the pid, so a board that ended without stopping its child (kill -9) can adopt it.
// Only global packages run: the start route takes no token, so it must not run a project's code.
function createCompanionHost({ agentDir, dir, spawn = nodeSpawn, isPidAlive = pidAlive, log = console, startTimeoutMs = START_TIMEOUT_MS }) {
  const running = new Map();
  const starting = new Map();
  const ownedPids = new Set();
  const recordFile = (id) => path.join(dir, `${id}.json`);

  async function probe(c, port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/companion`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const info = res.ok ? await res.json() : null;
      return info?.name === c.pkg ? info : null;
    } catch {
      return null;
    }
  }

  function pipeLog(c, child) {
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) readline.createInterface({ input: stream }).on('line', (line) => log.log(`[${c.id}] ${line}`));
    }
  }

  async function ready(c, child, port) {
    const end = Date.now() + startTimeoutMs;
    while (child.exitCode === null && child.signalCode === null && Date.now() < end) {
      const info = await probe(c, port);
      if (info) return info;
      await wait(POLL_MS);
    }
    return null;
  }

  async function launch(c, preferredPort) {
    const bin = c.dir && binPath(c.dir);
    if (!bin || !fs.existsSync(bin)) return { error: `${c.pkg} is not in the global pi packages`, status: 404 };
    for (const want of [preferredPort, 0]) {
      const port = want || await freePort();
      const child = spawn(process.execPath, [bin, '--port', String(port), '--host', '127.0.0.1', '--no-open'], {
        cwd: c.dir,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      ownedPids.add(child.pid);
      child.once('exit', (code, signal) => {
        ownedPids.delete(child.pid);
        if (running.get(c.id)?.pid === child.pid) running.delete(c.id);
        log.log(`[${c.id}] exited (${signal || code})`);
      });
      child.once('error', (e) => log.error(`[${c.id}] ${e.message}`));
      pipeLog(c, child);
      const info = await ready(c, child, port);
      if (info) {
        const entry = { pid: child.pid, port, session: info.session };
        running.set(c.id, entry);
        await writeJsonAtomic(recordFile(c.id), { pid: child.pid, port, boardPid: process.pid });
        return entry;
      }
      child.kill();
    }
    return { error: `${c.pkg} did not start`, status: 502 };
  }

  async function open(c) {
    const rec = readSettings(recordFile(c.id));
    const info = rec?.port ? await probe(c, rec.port) : null;
    if (!info) return launch(c, rec?.port);
    // Another live board on this agent dir shares the child and stops it itself.
    if (rec.boardPid === process.pid || !isPidAlive(rec.boardPid)) {
      ownedPids.add(rec.pid);
      await writeJsonAtomic(recordFile(c.id), { ...rec, boardPid: process.pid });
    }
    const entry = { pid: rec.pid, port: rec.port, session: info.session };
    running.set(c.id, entry);
    return entry;
  }

  async function start(id) {
    const c = companionStatus({ agentDir }).find((r) => r.id === id && r.optional);
    if (!c) return { error: 'unknown companion', status: 404 };
    const live = running.get(id);
    if (live && isPidAlive(live.pid)) return live;
    if (!starting.has(id)) starting.set(id, open(c).finally(() => starting.delete(id)));
    return starting.get(id);
  }

  const url = (entry, sessionId) => `http://127.0.0.1:${entry.port}${sessionId ? entry.session.replace('{id}', encodeURIComponent(sessionId)) : '/'}`;

  // Sync, for process 'exit'. The child is node itself, not a shell, so killing its pid ends the tool.
  function stop() {
    for (const pid of ownedPids) try { process.kill(pid); } catch { /* already gone */ }
    ownedPids.clear();
    running.clear();
  }

  return { start, url, stop };
}

module.exports = { createCompanionHost };
