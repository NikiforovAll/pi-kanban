const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// cwd -> { branch: string|null, headMtimeMs: number, isRepo: boolean, checkedAt: number }
const cache = new Map();
const inflight = new Map();

const MAX_CONCURRENT = 4;
const SPAWN_TIMEOUT_MS = 500;
// re-check non-repos every 30s so newly-cloned repos surface without a server restart
const NEGATIVE_TTL_MS = 30_000;
// skip statSync within this window of a known-good cache hit; keeps list endpoints from
// hitting the FS once per session per request when the same cwds repeat
const POSITIVE_TTL_MS = 2_000;
let running = 0;
const queue = [];

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => { running--; pump(); });
  }
}

function headMtime(cwd) {
  try { return fs.statSync(path.join(cwd, '.git', 'HEAD')).mtimeMs; }
  catch { return null; }
}

function spawnGit(cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    let done = false;
    let proc;
    try {
      proc = spawn('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        windowsHide: true,
      });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { proc.kill(); } catch {}
      resolve(null);
    }, SPAWN_TIMEOUT_MS);
    proc.stdout.on('data', (b) => { stdout += b.toString(); });
    proc.on('error', () => {
      if (done) return;
      done = true; clearTimeout(timer); resolve(null);
    });
    proc.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code !== 0) { resolve(null); return; }
      const branch = stdout.trim();
      resolve(branch || null);
    });
  });
}

function getBranch(cwd, onResolved) {
  if (!cwd) return null;
  const entry = cache.get(cwd);
  const now = Date.now();

  if (entry && entry.isRepo && now - entry.checkedAt < POSITIVE_TTL_MS) {
    return entry.branch;
  }

  const mtime = headMtime(cwd);

  if (mtime === null) {
    if (entry && entry.isRepo === false && now - entry.checkedAt < NEGATIVE_TTL_MS) {
      return null;
    }
    cache.set(cwd, { branch: null, headMtimeMs: 0, isRepo: false, checkedAt: now });
    return null;
  }

  if (entry && entry.isRepo && entry.headMtimeMs === mtime) {
    entry.checkedAt = now;
    return entry.branch;
  }

  scheduleResolve(cwd, mtime, entry, onResolved);
  return entry && entry.isRepo ? entry.branch : null;
}

function scheduleResolve(cwd, mtime, prevEntry, onResolved) {
  if (inflight.has(cwd)) {
    if (onResolved) inflight.get(cwd).then((b) => {
      if (!prevEntry || prevEntry.branch !== b) onResolved(b);
    });
    return;
  }
  const prevBranch = prevEntry ? prevEntry.branch : undefined;
  const p = new Promise((resolve) => {
    queue.push(async () => {
      const branch = await spawnGit(cwd);
      cache.set(cwd, { branch, headMtimeMs: mtime, isRepo: branch !== null, checkedAt: Date.now() });
      inflight.delete(cwd);
      resolve(branch);
    });
    pump();
  });
  inflight.set(cwd, p);
  if (onResolved) p.then((b) => { if (b !== prevBranch) onResolved(b); });
}

module.exports = { getBranch };
