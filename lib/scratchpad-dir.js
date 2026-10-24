// The per-session scratchpad the pi-kanban extension makes: <root>/<encoded cwd>/<session id>/scratchpad.
// The extension and the board both build the path here, so a session that recorded none still resolves.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encodeProjectDirName } = require('./board-dir');

const TMPDIR_ENV = 'PI_KANBAN_TMPDIR';
// customType of the session entry in which the extension records the pad.
const SCRATCHPAD_ENTRY = 'pi-kanban.scratchpad';
const PAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A relative override is skipped. On Unix the uid keeps two users apart in a shared /tmp.
function scratchpadRoot({ platform, override, tmpdir, uid }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const base = typeof override === 'string' && p.isAbsolute(override) ? override : tmpdir;
  return p.join(base, platform === 'win32' || uid == null ? 'pi-kanban' : `pi-kanban-${uid}`);
}

// The extension and the board must agree on this root. os.tmpdir() can be an 8.3 short path on
// Windows, and the board compares long paths.
function defaultScratchpadRoot() {
  let tmpdir = os.tmpdir();
  try { tmpdir = fs.realpathSync.native(tmpdir); } catch { /* keep the short form */ }
  return scratchpadRoot({ platform: process.platform, override: process.env[TMPDIR_ENV], tmpdir, uid: process.getuid?.() });
}

function scratchpadPath(root, cwd, sessionId) {
  return path.join(root, encodeProjectDirName(cwd), sessionId, 'scratchpad');
}

// The last pad the extension recorded in a session's entries, or null.
function recordedPadDir(entries) {
  const pad = entries.findLast((e) => e?.type === 'custom' && e.customType === SCRATCHPAD_ENTRY);
  return typeof pad?.data?.dir === 'string' ? pad.data.dir : null;
}

function createScratchpadDirResolver({ root, toLong = (p) => p }) {
  // Long form per root, not per session: the recorded dir is <root>/<project>/<id>/scratchpad.
  const longRoots = new Map();

  return function getScratchpadDir(id, meta) {
    const recorded = meta.scratchpadDir;
    if (recorded) {
      const recordedRoot = path.dirname(path.dirname(path.dirname(recorded)));
      if (!longRoots.has(recordedRoot)) longRoots.set(recordedRoot, toLong(recordedRoot));
      return longRoots.get(recordedRoot) + recorded.slice(recordedRoot.length);
    }
    const cwd = meta.cwd || meta.project;
    return cwd ? scratchpadPath(root, cwd, id) : null;
  };
}

async function subdirs(dir) {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// A write deeper in the pad does not touch these mtimes, so only the top level counts.
async function newestMtime(sessionDir) {
  const pad = path.join(sessionDir, 'scratchpad');
  let names = [];
  try { names = await fs.promises.readdir(pad); } catch { /* no pad */ }
  const paths = [sessionDir, pad, ...names.map((n) => path.join(pad, n))];
  const stats = await Promise.all(paths.map((p) => fs.promises.lstat(p).catch(() => null)));
  return Math.max(...stats.map((s) => s?.mtimeMs ?? 0));
}

// Deletes the session dirs under `root` that are not live and have not changed for `maxAgeMs`.
// Only dirs named like a session id go, so a mistaken root loses nothing else.
async function prunePads({ root, isLive, now = Date.now(), maxAgeMs = PAD_MAX_AGE_MS }) {
  const removed = [];
  for (const project of await subdirs(root)) {
    const projectDir = path.join(root, project);
    for (const sessionId of await subdirs(projectDir)) {
      if (!UUID_RE.test(sessionId) || isLive(sessionId)) continue;
      const sessionDir = path.join(projectDir, sessionId);
      if (now - (await newestMtime(sessionDir)) <= maxAgeMs) continue;
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
      removed.push(sessionDir);
    }
    await fs.promises.rmdir(projectDir).catch(() => {});
  }
  return removed;
}

module.exports = {
  createScratchpadDirResolver, scratchpadRoot, defaultScratchpadRoot, scratchpadPath, recordedPadDir, prunePads,
  TMPDIR_ENV, SCRATCHPAD_ENTRY, PAD_MAX_AGE_MS,
};
