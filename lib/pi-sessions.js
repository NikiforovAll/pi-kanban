const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getAgentDir } = require('./agent-dir');
const { isPiHeader } = require('./pi-transcript');

// Session discovery mirrors @earendil-works/pi-coding-agent: dist/main.js picks the session
// dir (--session-dir, then PI_CODING_AGENT_SESSION_DIR, then settings.sessionDir) and
// SessionManager writes <sessionsDir>/--<encoded cwd>--/<ISO>_<id>.jsonl by default, or
// <dir>/<ISO>_<id>.jsonl into a custom dir.

const ENV_SESSION_DIR = 'PI_CODING_AGENT_SESSION_DIR';

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (/^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  return p;
}

function readSettingsSessionDir(agentDir) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    return typeof settings?.sessionDir === 'string' && settings.sessionDir.trim() ? settings.sessionDir : null;
  } catch {
    return null;
  }
}

// The dirs to scan, configured one first. The default nested dir stays in the list when a
// custom dir is set, because sessions written before the change are still there. A caller
// that passes `roots` (from an earlier call) skips the settings.json read.
function sessionRoots({ roots, agentDir = getAgentDir(), env = process.env } = {}) {
  if (roots) return roots;
  const nested = { dir: path.join(agentDir, 'sessions'), flat: false };
  const custom = env[ENV_SESSION_DIR] || readSettingsSessionDir(agentDir);
  if (!custom) return [nested];
  const dir = path.resolve(expandTilde(custom));
  return path.resolve(nested.dir) === dir ? [nested] : [{ dir, flat: true }, nested];
}

const getSessionsRoot = (opts) => sessionRoots(opts)[0].dir;

function encodeProjectDir(cwd) {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// Lossy: a dash inside a folder name reads back as a separator. Prefer the header cwd.
function decodeProjectDir(name) {
  let s = name;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  const m = s.match(/^([A-Za-z])--(.*)$/);
  if (m) return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
  return `/${s.replace(/-/g, '/')}`;
}

const isJsonl = (name) => name.endsWith('.jsonl');

function jsonlIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && isJsonl(d.name))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function listSessionFiles(opts) {
  const files = [];
  for (const root of sessionRoots(opts)) {
    if (root.flat) {
      files.push(...jsonlIn(root.dir));
      continue;
    }
    let dirs;
    try { dirs = fs.readdirSync(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) if (d.isDirectory()) files.push(...jsonlIn(path.join(root.dir, d.name)));
  }
  return files;
}

const HEADER_MAX = 64 * 1024;

function readSessionHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(HEADER_MAX);
    const n = fs.readSync(fd, buf, 0, HEADER_MAX, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    const obj = JSON.parse(buf.toString('utf8', 0, nl === -1 ? n : nl));
    return isPiHeader(obj) ? obj : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

const headerCache = new Map();
const HEADER_CACHE_MAX = 5000;

function cachedHeader(file, stat) {
  const hit = headerCache.get(file);
  if (hit && hit.ino === stat.ino) return hit.header;
  const header = readSessionHeader(file);
  if (!header) return null;
  headerCache.set(file, { ino: stat.ino, header });
  if (headerCache.size > HEADER_CACHE_MAX) headerCache.delete(headerCache.keys().next().value);
  return header;
}

// Null for a file that is not a pi session. projectKey is the decoded cwd, the key the
// board groups sessions by; projectDir is the folder that holds the file.
function describeSessionFile(file, stat) {
  try {
    const st = stat || fs.statSync(file);
    const header = cachedHeader(file, st);
    if (!header) return null;
    const projectDir = path.dirname(file);
    return {
      sessionId: header.id,
      cwd: header.cwd || null,
      projectKey: header.cwd || decodeProjectDir(path.basename(projectDir)),
      projectDir,
      filePath: file,
      mtimeMs: st.mtimeMs,
      createdAt: header.timestamp || null,
      parentSession: header.parentSession || null,
    };
  } catch {
    return null;
  }
}

const listSessions = (opts) => listSessionFiles(opts).map((f) => describeSessionFile(f)).filter(Boolean);

// File names are <ISO timestamp>_<id>.jsonl, so the name answers most lookups without a read.
function findSessionFile(sessionId, opts) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const files = listSessionFiles(opts);
  const suffix = `_${sessionId}.jsonl`;
  for (const f of files) {
    if (!f.endsWith(suffix)) continue;
    if (readSessionHeader(f)?.id === sessionId) return f;
  }
  for (const f of files) {
    if (f.endsWith(suffix)) continue;
    if (describeSessionFile(f)?.sessionId === sessionId) return f;
  }
  return null;
}

function projectKey(fileOrDir) {
  if (!isJsonl(fileOrDir)) return decodeProjectDir(path.basename(fileOrDir));
  return describeSessionFile(fileOrDir)?.projectKey ?? decodeProjectDir(path.basename(path.dirname(fileOrDir)));
}

// For the retention sweep: the ids of the sessions on disk and the names of the folders that hold
// them. Null when there are none, so a missing or unreadable sessions root never reads as every
// session gone.
function scanSessionIds(opts) {
  const ids = new Set();
  const dirs = new Set();
  for (const s of listSessions(opts)) {
    ids.add(s.sessionId);
    dirs.add(path.basename(s.projectDir));
  }
  return ids.size ? { ids, dirs } : null;
}

module.exports = {
  ENV_SESSION_DIR,
  sessionRoots,
  getSessionsRoot,
  encodeProjectDir,
  decodeProjectDir,
  listSessionFiles,
  readSessionHeader,
  describeSessionFile,
  listSessions,
  findSessionFile,
  projectKey,
  scanSessionIds,
};
