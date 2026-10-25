#!/usr/bin/env node

// #region SETUP
const express = require('express');
const path = require('node:path');
const fs = require('node:fs').promises;
const { existsSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, rmSync, mkdirSync, renameSync, realpathSync } = require('node:fs');
const _readline = require('node:readline');
const chokidar = require('chokidar');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { assertOpenTarget, openInEditor, whichSync, exeBehindShim } = require('./lib/open-editor');
const { createNetGuard } = require('./lib/net-guard');
const { isContained, realpathDeepest } = require('./lib/contain');
const { resolveScratchSubdir, listScratchDir } = require('./lib/scratch-files');
const { fileUrlToPath } = require('./lib/file-url');
const { httpError: previewError } = require('./lib/http-error');
const { MODEL_WINDOWS_FILE, contextOf } = require('./lib/model-windows');
const { readSettings } = require('./lib/claude-settings');
const { companionStatus, installPlan, refreshLatest } = require('./lib/companions');
const { createCompanionHost } = require('./lib/companion-host');

const {
  readRecentMessages: _readRecentMessagesUncached,
  readMessagesPage: _readMessagesPageUncached,
  readSessionInfoFromJsonl,
  transcriptActivityMs,
  modelDisplayName,
  buildSessionDigest,
  readArtifactLinks,
  readScratchpadCreations,
  extractPromptFromTranscript,
  extractModelFromTranscript,
  extractAgentResultFromTranscript,
  readFullToolResult,
  readUserImage,
  readToolResultImage,
  readCachedImage,
  readLines
} = require('./lib/parsers');
const { inlineHtmlAssets, MIME_BY_EXT } = require('./lib/inline-assets');
const { buildDecision, decisionFileName, isDecisionFile, approvalsFrom, boardRefusal } = require('./lib/approvals');
const { resolvePiAgentDir, boardDir, getArgValue,storageNamespace } = require('./lib/board-dir');
const { readTerminalConfig } = require('./lib/terminal');
const { THINKING_LEVELS } = require('./lib/pi-agents');
const { createTerminalClient } = require('./lib/terminal-client');
const { createShowStore, mountShowRoutes, showBodyParser, SHOW_PATH } = require('./lib/show');
const { createAskStore, mountAskRoutes, terminalAskRoutes, askBodyParser, ASK_PATH, SESSION_ASK_PATH, SESSION_ASK_ROUTES } = require('./lib/ask');
const { readLiveSessions, isPidAlive, isSessionLive, noteReplacedSessions } = require('./lib/live-sessions');
const { createProcStats } = require('./lib/proc-stats');
const { createUserGroupStore } = require('./lib/user-groups');
const { createSessionPinStore } = require('./lib/session-pins');
const { stampedJsonFile } = require('./lib/stamped-json-file');
const { parseReviewSource, parseActionBody, formatActionMarkdown } = require('./lib/preview-action');
const { createDispatchedStore, pruneSessionDirs, pruneTaskMaps, retentionMs } = require('./lib/retention');
const { createDispatchReports, parseReport } = require('./lib/dispatch-reports');
const { createModelCache, listPiModels } = require('./lib/pi-models');
const { createWorktreeStore } = require('./lib/worktrees');
const { createScratchpadDirResolver, defaultScratchpadRoot } = require('./lib/scratchpad-dir');
const { readGitBranch, sessionGitBranch } = require('./lib/git-branch');
const { createLinkedDocStore, canonicalPath, linkUrl } = require('./lib/linked-docs');
const { createPaneStore, isOwnOrigin } = require('./lib/panes');
const { probeFraming, parseOrigin } = require('./lib/frame-policy');
const { pickFolder } = require('./lib/folder-dialog');
const { loadSessionCache, saveSessionCache } = require('./lib/session-cache');
const { countTaskDir } = require('./lib/task-counts');
const { readTaskDir } = require('./lib/task-dir');
const { foldAgentLines } = require('./lib/agent-log');
const { projectMatcher, normalizeProjectPath, sessionProjectKey } = require('./public/project-match');
const { sessionRoots, listSessionFiles, readSessionHeader, describeSessionFile, decodeProjectDir, scanSessionIds } = require('./lib/pi-sessions');

if (!require("./cli").runCli(process.argv)) {
  startServer();
}

// Not indented: the formatter is off for this file, and a reindent would rewrite every line.
function startServer() {

const app = express();
const PORT = parseInt(getArgValue('port') || process.env.PORT || '3460', 10);

// Mounted before express.json() so a rejected request never buffers a body, and
// before the /api catch-all so no route escapes the check.
// The board frames the terminal from its other loopback name, so Chrome runs it in its own process.
const net = createNetGuard({ appName: 'pi-kanban', selfFramedPaths: ['/terminal.html'] });
app.use(net.hostGuard);
app.use(net.frameGuard);
app.use(net.originGuard);

const PI_AGENT_DIR = resolvePiAgentDir();
const PK_DIR = boardDir(PI_AGENT_DIR);
const TASKS_DIR = path.join(PK_DIR, 'tasks');
const SESSION_DIR_FLAG = getArgValue('session-dir');
// A pi started with its own --session-dir reports that dir in the live registry. The board keeps
// it, so those sessions stay listed after that pi exits and after a board restart.
const SESSION_DIRS_FILE = path.join(PK_DIR, 'session-dirs.json');
const savedSessionDirs = readJsonOrNull(SESSION_DIRS_FILE);
const reportedSessionDirs = new Set(Array.isArray(savedSessionDirs) ? savedSessionDirs : []);
const rootsFor = (cwds) => sessionRoots({ agentDir: PI_AGENT_DIR, sessionDir: SESSION_DIR_FLAG, cwds, sessionDirs: [...reportedSessionDirs] });
const SESSION_OPTS = { roots: rootsFor() };
const SESSIONS_DIR = path.join(PK_DIR, 'live');
const AGENT_ACTIVITY_DIR = path.join(PK_DIR, 'agent-activity');
const MODEL_WINDOWS_PATH = path.join(PK_DIR, MODEL_WINDOWS_FILE);
const ATTACHMENTS_DIR = path.join(PK_DIR, 'attachments');
const PINS_FILE = path.join(PK_DIR, 'pins.json');
const USER_GROUPS_FILE = path.join(PK_DIR, 'groups.json');
const DISPATCHED_FILE = path.join(PK_DIR, 'dispatched.json');
const WORKTREES_FILE = path.join(PK_DIR, 'worktrees.json');
const LINKED_DOCS_FILE = path.join(PK_DIR, 'linked-docs.json');
const PLANS_FILE = path.join(PK_DIR, 'plans.json');
const PANES_FILE = path.join(PK_DIR, 'panes.json');
const SERVER_INFO_FILE = path.join(PK_DIR, 'server.json');
const TERMINAL_TOKENS_DIR = path.join(PK_DIR, 'terminal-tokens');
const SESSION_CACHE_FILE = path.join(PK_DIR, 'session-cache.json');
// Every board on a config dir rewrites the whole file, so a test board points this elsewhere.
const TERMINALS_FILE = process.env.PK_TERMINALS_FILE ? path.resolve(process.env.PK_TERMINALS_FILE) : path.join(PK_DIR, 'terminals.json');
// os.tmpdir() can be an 8.3 short path on Windows; transcripts record the long form.
const TEMP_ROOT = (() => {
  try { return realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); }
})();
// The kanban extension makes the per-session pad under this root and records it in the session.
// Used only for a session that does not record its scratchpad dir.
// The root may not exist yet, so its deepest existing parent gives the long form.
const SCRATCHPAD_ROOT = realpathDeepest(defaultScratchpadRoot());

// #endregion

// #region SERVER_STATE
function writeJsonAtomic(file, obj, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// The pi extension reads task files while the board writes them, so it must never see half a file.
// On Windows a rename over a file another handle has open fails with EPERM or EBUSY until it closes.
let taskWriteSeq = 0;
async function writeTaskFile(file, task) {
  const tmp = `${file}.${process.pid}.${++taskWriteSeq}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(task, null, 2));
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        break;
      } catch (e) {
        if (attempt >= 10 || (e.code !== 'EPERM' && e.code !== 'EBUSY')) throw e;
        await new Promise((r) => setTimeout(r, attempt * 10));
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// For state that is also held in memory: a failed save is logged and the server goes on.
function writeJsonAtomicOrLog(file, obj, mode) {
  try {
    writeJsonAtomic(file, obj, mode);
  } catch (e) {
    console.error(`Failed to write ${path.basename(file)}:`, e.message);
  }
}

function readJsonOrNull(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

const jsonFile = (file) => ({
  load: () => readJsonOrNull(file),
  save: (data) => writeJsonAtomicOrLog(file, data),
});

const sessionPins = createSessionPinStore(stampedJsonFile(PINS_FILE, writeJsonAtomic));

// Port discovery for out-of-process helpers (the plugin's doorbell mod, the CLI).
// The pid rides along so a reader can tell a live server from a file left behind by
// a crashed one.
function writeServerInfo(port) {
  writeJsonAtomicOrLog(SERVER_INFO_FILE, { port, pid: process.pid });
}

// For `dispatch start`: a local process as the same user can already run pi itself,
// so handing it the token adds little. A browser still cannot read the file.
// One file per port: two boards on one config dir each keep a token, so the CLI can
// reach the board PK_URL names even when the other one owns server.json.
// The sweep also drops terminal-token.json, the single file that older versions wrote.
let terminalTokenFile = null;
function writeTerminalToken(port) {
  if (terminal.unavailableReason()) return;
  let stale = [path.join(PK_DIR, 'terminal-token.json')];
  try { stale = stale.concat(readdirSync(TERMINAL_TOKENS_DIR).map(name => path.join(TERMINAL_TOKENS_DIR, name))); } catch (_) { /* no dir yet */ }
  for (const file of stale) {
    const pid = ownerPid(file);
    if (pid !== null && !isPidAlive(pid)) try { unlinkSync(file); } catch (_) { /* already gone */ }
  }
  terminalTokenFile = path.join(TERMINAL_TOKENS_DIR, `${port}.json`);
  writeJsonAtomicOrLog(terminalTokenFile,{ pid: process.pid, token: terminal.token }, 0o600);
}

function ownerPid(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).pid ?? null; } catch (_) { return null; }
}

// A beacon that outlives its server sends the doorbell mod and the CLI to a closed
// port. The next server can take another port, so a stale beacon never comes back on its own — drop ours on
// the way out. Only when the file is still ours: a newer server on the same config
// dir has already claimed it. The terminal token file goes the same way.
function removeServerInfo() {
  for (const file of [SERVER_INFO_FILE, terminalTokenFile]) {
    if (file && ownerPid(file) === process.pid) try { unlinkSync(file); } catch (_) { /* already gone */ }
  }
}

// A second server on the same config dir (a test run, say) takes the beacon and removes it on
// exit, which leaves this live server undiscoverable. A newer live owner keeps it.
function reclaimServerInfo(port) {
  const pid = ownerPid(SERVER_INFO_FILE);
  if (pid !== null && isPidAlive(pid)) return;
  writeServerInfo(port);
}

process.on('exit', removeServerInfo);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    removeServerInfo();
    process.exit(0);
  });
}

// #endregion

// #region TIMINGS
const PERMISSION_TTL_MS = 30 * 60 * 1000;
const AGENT_TTL_MS = 60 * 60 * 1000;
const AGENT_STALE_MS = 30 * 60 * 1000; // safety net for crashed sessions
const SESSION_STALE_MS = 5 * 60 * 1000;
// Keep an idle session in the active list this long after its last log write, so it
// doesn't vanish the instant a turn ends. Ungated by registry-idle — visibility only,
// never the "active" status (which stays accurate via hasRecentLog).
const SESSION_GRACE_MS = 2 * 60 * 1000;
const WAITING_RESOLVE_GRACE_MS = 15 * 1000;
const CLEANUP_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_FIRST_RUN_MS = 5 * 60 * 1000;
// #endregion

// #region AGENT_ACTIVITY

function readAgentJsonl(filePath) {
  return foldAgentLines(readFileSync(filePath, 'utf8'));
}

// Agent-activity record files in a session dir, excluding the `_`-prefixed sidecars
// (_waiting.json, _stop.json, _name-*). Returns [] if the dir is missing/unreadable.
function listAgentFiles(agentDir) {
  try {
    return readdirSync(agentDir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('_'));
  } catch (_) {
    return [];
  }
}

function persistAgent(dir, agent) {
  const file = path.join(dir, `${agent.agentId}.jsonl`);
  fs.appendFile(file, `${JSON.stringify({ ...agent, event: 'server-update' })}\n`, 'utf8').catch(() => {});
}

// <PK_DIR>/config.json — pi-kanban's own settings, per pi agent dir.
// Normalization lives in lib/approvals (kept in sync with the gate's own parse).
const PK_CONFIG_FILE = path.join(PK_DIR, 'config.json');
const LEGACY_APPROVALS_FILE = path.join(PK_DIR, 'approvals.json');
const pkConfigCache = new Map();
const readCckConfig = () => JSON.parse(readFileSync(PK_CONFIG_FILE, 'utf8'));
function approvalsConfig() {
  return cachedByMtime(pkConfigCache, 'approvals', PK_CONFIG_FILE,
    () => approvalsFrom(readCckConfig()), approvalsFrom(null));
}
function boardEventsEnabled() {
  return cachedByMtime(pkConfigCache, 'boardEvents', PK_CONFIG_FILE,
    () => boardEventsOn(readCckConfig()), boardEventsOn(null));
}
// approvals.json predates config.json (and was opt-in). Fold it into
// config.json once so an existing opt-in keeps its tuning, then drop it.
function migrateLegacyApprovalsConfig() {
  if (!existsSync(LEGACY_APPROVALS_FILE)) return;
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_APPROVALS_FILE, 'utf8'));
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(PK_CONFIG_FILE, 'utf8')) || {}; } catch { /* absent */ }
    if (!cfg.approvals) writeJsonAtomicOrLog(PK_CONFIG_FILE, { ...cfg, approvals: legacy });
    unlinkSync(LEGACY_APPROVALS_FILE);
    pkConfigCache.clear();
  } catch (e) {
    console.error(`[pi-kanban] could not migrate ${LEGACY_APPROVALS_FILE}: ${e.message}`);
  }
}

function checkWaitingForUser(agentDir, logMtime) {
  try {
    const data = JSON.parse(readFileSync(path.join(agentDir, '_waiting.json'), 'utf8'));
    if (data.status === 'waiting' && data.timestamp) {
      const waitTime = new Date(data.timestamp).getTime();
      const age = Date.now() - waitTime;
      if (age >= PERMISSION_TTL_MS) return null;
      // After grace period, check if session resumed activity (user already responded)
      if (movedOnSince(waitTime, logMtime)) return null;
      // The mod sees the ask before auto mode's classifier decides it, and no dialog may follow.
      // An ask from a settings rule always opens the dialog.
      if (data.kind === 'permission' && !data.rule && loadSessionMetadata()[path.basename(agentDir)]?.permissionMode === 'auto') return null;
      // Opted out reads the same as lapsed to the board: the ask is only
      // answerable in the terminal, so no buttons.
      if (boardRefusal(data, approvalsConfig())) return { ...data, lapsed: true };
      return data;
    }
  } catch { /* skip — missing or invalid */ }
  return null;
}

function agentDisplayName(agent) {
  return agent.type || agent.name;
}

function isGhostAgent(agent) {
  if (agent.startedAt !== agent.updatedAt || agent.lastMessage) return false;
  return (Date.now() - new Date(agent.startedAt).getTime()) >= AGENT_STALE_MS;
}

function getContextFields(meta) {
  const reply = meta?.lastReply;
  return {
    context: contextOf(reply, readSettings(MODEL_WINDOWS_PATH) || {}),
    cache: reply ? { ttl: meta.cacheTtl || null, ...reply, modelName: modelDisplayName(reply.model) } : null,
    totals: meta?.totals || null,
  };
}

function isAgentFresh(agent) {
  if (isGhostAgent(agent)) return false;
  const ts = agent.updatedAt || agent.startedAt;
  if (!ts) return true;
  return (Date.now() - new Date(ts).getTime()) < AGENT_TTL_MS;
}

function isAgentLive(agent) {
  return agent.status === 'active' || agent.status === 'idle';
}

// A pi session records no git branch. Resolve it on demand from the session cwd. Cached per-cwd
// with a short TTL so a list refresh across N sessions sharing one cwd reads HEAD at most once per
// TTL window.
const gitBranchCache = new Map();
const GIT_BRANCH_TTL_MS = 30000;
const GIT_BRANCH_CACHE_MAX = 500;
function getGitBranch(cwd) {
  if (!cwd) return null;
  const now = Date.now();
  const cached = gitBranchCache.get(cwd);
  if (cached && now - cached.ts < GIT_BRANCH_TTL_MS) return cached.branch;
  const branch = readGitBranch(cwd);
  gitBranchCache.set(cwd, { branch, ts: now });
  if (gitBranchCache.size > GIT_BRANCH_CACHE_MAX) {
    const firstKey = gitBranchCache.keys().next().value;
    gitBranchCache.delete(firstKey);
  }
  return branch;
}

const worktrees = createWorktreeStore(jsonFile(WORKTREES_FILE));

function getSessionLogStat(meta) {
  if (!meta.jsonlPath) return { mtime: null, hasMessages: false };
  try {
    const st = statSync(meta.jsonlPath);
    return { mtime: transcriptActivityMs(meta.jsonlPath, st), hasMessages: st.size > 1000 };
  } catch { return { mtime: null, hasMessages: false }; }
}

// A transcript write past the grace window after a marker means the session went on.
function movedOnSince(markerMs, logMtime) {
  return !!logMtime && logMtime > markerMs + WAITING_RESOLVE_GRACE_MS;
}

// The mod cannot delete _stop.json when the session works again.
function resumedSince(markerPath, logMtime) {
  if (!logMtime) return false;
  try { return movedOnSince(statSync(markerPath).mtimeMs, logMtime); }
  catch { return true; }
}

function checkAgentStatus(agentDir, stale, logMtime) {
  const result = { hasActive: false, hasRunning: false, waitingForUser: null, unread: false };
  let names;
  try { names = readdirSync(agentDir); } catch { return result; }
  if (names.includes('_waiting.json')) result.waitingForUser = checkWaitingForUser(agentDir, logMtime);
  if (result.waitingForUser) result.hasActive = true;
  const stopped = names.includes('_stop.json') && !resumedSince(path.join(agentDir, '_stop.json'), logMtime);
  if (stale) {
    result.unread = stopped;
    return result;
  }
  try {
    for (const file of names.filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))) {
      try {
        const agent = readAgentJsonl(path.join(agentDir, file));
        // Idle agents never mark a session active.
        if (agent.status === 'active' && isAgentFresh(agent)) {
          result.hasActive = true;
          result.hasRunning = true;
        }
        if (result.hasRunning) break;
      } catch { /* skip invalid */ }
    }
  } catch { /* ignore */ }
  result.unread = stopped && !result.hasRunning;
  return result;
}

// #endregion

// #region LIVE_SESSIONS
function sessionMetaFor(sessionId) {
  return loadSessionMetadata()[sessionId];
}

let liveSessionsCache = null;
let lastLiveSessionsScan = 0;
const LIVE_SESSIONS_TTL = 5000;
const replacedSessions = new Map();

function loadLiveSessions() {
  const now = Date.now();
  if (liveSessionsCache && now - lastLiveSessionsScan < LIVE_SESSIONS_TTL) return liveSessionsCache;
  const prev = liveSessionsCache;
  liveSessionsCache = readLiveSessions(SESSIONS_DIR);
  lastLiveSessionsScan = now;
  noteReplacedSessions(prev, liveSessionsCache, replacedSessions, now, SESSION_STALE_MS);
  return liveSessionsCache;
}

// An open-but-idle interactive session keeps touching its JSONL (metadata-line
// rewrites), so mtime alone reads as activity for as long as the terminal stays
// open. The live-session registry the pi extension writes knows the real state — trust its
// 'idle' over the mtime. No registry entry (or any other status) falls back to
// the mtime rule.
function isRegistryIdle(sessionId) {
  const live = loadLiveSessions().find(s => s.sessionId === sessionId);
  return live?.status === 'idle';
}

function hasRecentLogActivity(sessionId, logAge) {
  return logAge <= SESSION_STALE_MS && !isRegistryIdle(sessionId) && !replacedSessions.has(sessionId);
}

// Visibility-only recency: hasRecentLogActivity widened by the post-turn grace
// window (ungated by registry-idle). Drives whether a session appears in the
// active list — never the "active" status badges, which stay on hasRecentLog.
function hasVisibleLogActivity(sessionId, logAge) {
  if (replacedSessions.has(sessionId)) return false;
  return logAge <= SESSION_GRACE_MS || hasRecentLogActivity(sessionId, logAge);
}

// #endregion

// #region SHARED_STATE
// SSE clients for live updates
const clients = new Set();

// Cache for session metadata (refreshed periodically)
let sessionMetadataCache = {};
let lastMetadataRefresh = 0;
const METADATA_CACHE_TTL = 10000; // 10 seconds
// Watcher-driven invalidation. `change` events (append to existing jsonl) only
// dirty the one path so we can do a targeted refresh; `add` / `unlink` events
// are structural and force a full rescan.
const dirtyMetadataPaths = new Set();
let metadataNeedsFullScan = true;

// #endregion

// #region REQUEST_GUARDS
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID_RE.test(id);
}

app.param('sessionId', (_req, res, next, val) => {
  if (!isSafeId(val)) return res.status(400).json({ error: 'Invalid session ID' });
  next();
});
app.param('taskId', (_req, res, next, val) => {
  if (!isSafeId(val)) return res.status(400).json({ error: 'Invalid task ID' });
  next();
});

app.use(SHOW_PATH, showBodyParser());
app.use(ASK_PATH, askBodyParser());
app.use(SESSION_ASK_PATH, askBodyParser());
// Parse JSON bodies. A review of 50 comments at the field caps is about 450 kB.
app.use(express.json({ limit: '1mb' }));
// #endregion

// #region STATIC

// app.js reads localStorage synchronously at startup, before any fetch could deliver the
// namespace, so it is injected into the page instead of served from an endpoint.
const STORAGE_NS = storageNamespace(PI_AGENT_DIR);
const NS_DECL = 'window.__STORAGE_NS__ = null;';
const RAW_INDEX = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
if (!RAW_INDEX.includes(NS_DECL)) throw new Error(`public/index.html is missing "${NS_DECL}"`);
const INDEX_HTML = RAW_INDEX.replace(NS_DECL, `window.__STORAGE_NS__ = ${JSON.stringify(STORAGE_NS)};`);
app.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML);
});

// Serve static files
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));
// #endregion

// #region SESSION_LIST

const messageCache = new Map();
const MESSAGE_CACHE_TTL = 5000;
const MAX_CACHE_ENTRIES = 200;
const taskCountsCache = new Map();
const TASK_MAPS_DIR = path.join(AGENT_ACTIVITY_DIR, '_task-maps');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s) { return UUID_RE.test(s); }

function evictStaleCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

let sessionToTaskListCache = null;
let lastTaskMapScan = 0;
const TASK_MAP_SCAN_TTL = 5000;

function loadAllTaskMaps() {
  const now = Date.now();
  if (sessionToTaskListCache && now - lastTaskMapScan < TASK_MAP_SCAN_TTL) return sessionToTaskListCache;

  const sessionToList = {};
  const listToSessions = {};
  if (!existsSync(TASK_MAPS_DIR)) {
    sessionToTaskListCache = { sessionToList, listToSessions };
    lastTaskMapScan = now;
    return sessionToTaskListCache;
  }
  try {
    for (const file of readdirSync(TASK_MAPS_DIR).filter(f => f.endsWith('.json'))) {
      const taskListName = file.replace(/\.json$/, '');
      const mapPath = path.join(TASK_MAPS_DIR, file);
      try {
        const map = JSON.parse(readFileSync(mapPath, 'utf8'));
        listToSessions[taskListName] = map;
        for (const sessionId of Object.keys(map)) {
          sessionToList[sessionId] = taskListName;
        }
      } catch { /* skip invalid */ }
    }
  } catch { /* ignore */ }
  sessionToTaskListCache = { sessionToList, listToSessions };
  lastTaskMapScan = now;
  return sessionToTaskListCache;
}

function getCustomTaskDir(sessionId) {
  const { sessionToList } = loadAllTaskMaps();
  const taskListName = sessionToList[sessionId];
  if (taskListName) {
    const dir = path.join(TASKS_DIR, taskListName);
    if (existsSync(dir)) return dir;
  }
  return null;
}

// Where a session's task files live. The custom-list and team lookups can both miss, and
// the fallback is the plain per-session dir -- every route that touches a task file needs
// that same resolution, so it lives in one place.
function taskDirFor(sessionId) {
  return getCustomTaskDir(sessionId) || path.join(TASKS_DIR, sessionId);
}

function getTaskCounts(sessionPath) {
  const cached = taskCountsCache.get(sessionPath);
  if (cached) return cached;

  const { completed, inProgress, pending, newestTaskMtime } = countTaskDir(sessionPath);
  // Directory mtime bumps when task files are added/removed, so it dates an emptied dir
  // (task list closed) that has no files left to date.
  let dirMtime = 0;
  try { dirMtime = statSync(sessionPath).mtimeMs; } catch (_) {}

  const taskCount = completed + inProgress + pending;
  const result = { taskCount, completed, inProgress, pending, newestTaskMtime, dirMtime };
  taskCountsCache.set(sessionPath, result);
  return result;
}

// A promise from loadFn is cached as is, so concurrent callers share one read, and a newer
// mtime starts no second read while it is pending: full-transcript scans stream for seconds.
function cachedByMtime(cache, cacheKey, filePath, loadFn, fallback) {
  try {
    const cached = cache.get(cacheKey);
    if (cached && (cached.pending || Date.now() - cached.ts < MESSAGE_CACHE_TTL)) return cached.data;
    const st = statSync(filePath);
    if (cached && cached.mtime === st.mtimeMs) {
      cached.ts = Date.now();
      return cached.data;
    }
    const entry = { data: loadFn(), mtime: st.mtimeMs, ts: Date.now() };
    if (typeof entry.data?.then === 'function') {
      entry.pending = true;
      entry.data = entry.data.catch(() => {
        if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
        return fallback;
      }).finally(() => {
        entry.pending = false;
        entry.ts = Date.now();
      });
    }
    cache.set(cacheKey, entry);
    evictStaleCache(cache);
    return entry.data;
  } catch (_) { return fallback; }
}

// Express 4 does not pass a rejected handler promise to next(), and Node 24 exits on it.
function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

const sessionDigestCache = new Map();
function getSessionDigest(jsonlPath) {
  return cachedByMtime(sessionDigestCache, jsonlPath, jsonlPath, () => buildSessionDigest(jsonlPath), { progressMap: {}, terminated: new Map() });
}

async function getProgressMap(jsonlPath) {
  return (await getSessionDigest(jsonlPath)).progressMap;
}

function readRecentMessages(jsonlPath, limit = 10) {
  return cachedByMtime(messageCache, `${jsonlPath}:${limit}`, jsonlPath, () => _readRecentMessagesUncached(jsonlPath, limit), []);
}

/**
 * Scan all project directories to find session JSONL files and extract slugs
 */
// Returns false when sessionId is unknown — caller must promote to full scan.
function refreshSessionMetadataPath(jsonlPath) {
  const entry = sessionMetadataOf(jsonlPath);
  if (!entry || !sessionMetadataCache[entry.sessionId]) return false;
  sessionMetadataCache[entry.sessionId] = entry.meta;
  return true;
}

// Null for a file that is not a pi session or has an unsafe id.
function sessionMetadataOf(jsonlPath) {
  let info;
  try {
    info = readSessionInfoFromJsonl(jsonlPath);
  } catch (_) {
    return null;
  }
  if (!info.sessionId || !isSafeId(info.sessionId)) return null;
  return {
    sessionId: info.sessionId,
    meta: {
      project: info.projectPath || decodeProjectDir(path.basename(path.dirname(jsonlPath))),
      cwd: info.cwd,
      customTitle: info.customTitle,
      jsonlPath,
      lastReply: info.lastReply,
      totals: info.totals,
      scratchpadDir: info.scratchpadDir,
      firstPrompt: info.firstPrompt,
      title: info.title,
      parentSessionPath: info.parentSessionPath,
      created: info.createdAt,
    },
  };
}

function loadSessionMetadata() {
  const now = Date.now();

  if (!metadataNeedsFullScan && now - lastMetadataRefresh < METADATA_CACHE_TTL) {
    if (dirtyMetadataPaths.size > 0) {
      for (const p of dirtyMetadataPaths) {
        if (!refreshSessionMetadataPath(p)) {
          // Unknown sessionId — structural change snuck in. Promote to full.
          metadataNeedsFullScan = true;
          break;
        }
      }
      dirtyMetadataPaths.clear();
      if (!metadataNeedsFullScan) return sessionMetadataCache;
    } else {
      return sessionMetadataCache;
    }
  }

  const metadata = {};
  const scanInto = (opts) => {
    for (const file of listSessionFiles(opts)) {
      const entry = sessionMetadataOf(file);
      if (entry) metadata[entry.sessionId] = entry.meta;
    }
  };

  try {
    scanInto(SESSION_OPTS);
    // A project .pi/settings.json can move a cwd's sessions to a dir of its own; the cwds come
    // from the headers just read and from the live registry, so a new root needs one more pass.
    const live = loadLiveSessions();
    const cwds = new Set([...Object.values(metadata), ...live].map((m) => m.cwd).filter(Boolean));
    const known = reportedSessionDirs.size;
    for (const s of live) if (s.sessionDir) reportedSessionDirs.add(s.sessionDir);
    if (reportedSessionDirs.size !== known) writeJsonAtomicOrLog(SESSION_DIRS_FILE, [...reportedSessionDirs]);
    const added = syncSessionRoots(cwds);
    if (added.length) {
      scanInto({ roots: added });
      broadcast({ type: 'metadata-update' });
    }
  } catch (e) {
    console.error('Error loading session metadata:', e);
  }

  sessionMetadataCache = metadata;
  lastMetadataRefresh = now;
  metadataNeedsFullScan = false;
  dirtyMetadataPaths.clear();
  return metadata;
}

const plans = createLinkedDocStore({ ...jsonFile(PLANS_FILE), max: 1 });
const planPaths = () => Object.values(plans.all()).flat();
const planTitles = new Map();

function readPlanTitle(planPath) {
  try {
    const match = readFileSync(planPath, 'utf8').slice(0, 512).match(/^#\s+(.+)$/m);
    return { title: match ? match[1].trim() : null };
  } catch {
    return { title: null };
  }
}

// Every session list build asks for each session, so the title is read once per file change.
function getPlanInfo(sessionId) {
  const [planPath] = plans.get(sessionId);
  const head = planPath && cachedByFileStat(planTitles, planPath, () => readPlanTitle(planPath));
  if (!head) return { hasPlan: false, planTitle: null, planPath: null };
  return { hasPlan: true, planTitle: head.title, planPath };
}

function getSessionDisplayName(meta) {
  return meta?.customTitle || meta?.title || null;
}

const getScratchpadDir = createScratchpadDirResolver({
  root: SCRATCHPAD_ROOT,
  // Transcripts record the 8.3 short form on Windows; path checks and the watcher need the long one.
  toLong: realpathDeepest,
});

function buildSessionObject(id, meta, overrides = {}) {
  const logStat = overrides._logStat || getSessionLogStat(meta);
  const logMtime = logStat.mtime;
  const logAge = logMtime ? Date.now() - logMtime : Infinity;
  const worktree = worktrees.resolve(meta.project);
  return {
    id,
    name: getSessionDisplayName(meta),
    project: meta.project || null,
    cwd: meta.cwd || null,
    description: meta.description || null,
    gitBranch: sessionGitBranch(meta, !!worktree, getGitBranch),
    worktree,
    customTitle: meta.customTitle || null,
    firstPrompt: meta.firstPrompt || null,
    taskCount: 0,
    completed: 0,
    inProgress: 0,
    pending: 0,
    createdAt: meta.created || null,
    modifiedAt: overrides.modifiedAt || new Date(0).toISOString(),
    hasMessages: logStat.hasMessages,
    hasActiveAgents: false,
    hasRunningAgents: false,
    hasWaitingForUser: false,
    unread: false,
    hasRecentLog: hasRecentLogActivity(id, logAge),
    hasRecentActivity: hasVisibleLogActivity(id, logAge),
    jsonlPath: meta.jsonlPath || null,
    tasksDir: null,
    projectDir: meta.jsonlPath ? path.dirname(meta.jsonlPath) : null,
    scratchpadDir: getScratchpadDir(id, meta),
    ...getContextFields(meta),
    ...getPlanInfo(id),
    ...overrides,
    // Remove internal-only field
    _logStat: undefined,
  };
}

// #endregion

// #region SESSION_ROUTES
// API: List all sessions
app.get('/api/sessions', async (req, res) => {
  // Prevent browser caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    // Parse limit parameter (default: 20, "all" for unlimited)
    const limitParam = req.query.limit || '20';
    const limit = limitParam === 'all' ? null : parseInt(limitParam, 10);

    // `pinned=` from a board page loaded before the server kept pins is ignored.
    const includeIds = req.query.include ? new Set(req.query.include.split(',').filter(Boolean)) : new Set();
    const pins = req.query.pins === 'off' ? {} : sessionPins.state().pins;
    const pinnedIds = new Set(Object.keys(pins));
    for (const id of includeIds) pinnedIds.add(id);
    const activeFilter = req.query.filter === 'active';
    const terminalIds = new Set(terminal.ids());

    const metadata = loadSessionMetadata();
    const sessionsMap = new Map();

    // First, add sessions that have tasks directories
    if (existsSync(TASKS_DIR)) {
      const entries = readdirSync(TASKS_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() && isUUID(entry.name)) {
          const sessionPath = path.join(TASKS_DIR, entry.name);
          const { taskCount, completed, inProgress, pending, newestTaskMtime, dirMtime } = getTaskCounts(sessionPath);

          // Get metadata for this session
          const meta = metadata[entry.name] || {};

          const logStat = getSessionLogStat(meta);
          const logMtime = logStat.mtime;
          const logAge = logMtime ? Date.now() - logMtime : Infinity;
          const stale = logAge > AGENT_STALE_MS;

          const agentStatus = checkAgentStatus(path.join(AGENT_ACTIVITY_DIR, entry.name), stale, logMtime);

          // Cheap-probe: when filter=active, skip expensive enrichment for inactive non-pinned sessions.
          // Mirrors the post-filter predicate using only signals already computed above.
          if (activeFilter && !pinnedIds.has(entry.name) && !terminalIds.has(entry.name)) {
            const cheaplyActive = logStat.hasMessages && (
              hasVisibleLogActivity(entry.name, logAge)
              || agentStatus.hasActive
              || !!agentStatus.waitingForUser
              || (pending > 0 || inProgress > 0)
            );
            if (!cheaplyActive) continue;
          }

          // Use newest of: task file mtime, JSONL mtime, directory mtime
          let modifiedAt = (newestTaskMtime || new Date(dirMtime)).toISOString();
          if (logMtime) {
            const jsonlMtime = new Date(logMtime).toISOString();
            if (jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
          }

          sessionsMap.set(entry.name, buildSessionObject(entry.name, meta, {
            _logStat: logStat,
            taskCount,
            completed,
            inProgress,
            pending,
            modifiedAt,
            hasActiveAgents: agentStatus.hasActive,
            hasRunningAgents: agentStatus.hasRunning,
            hasWaitingForUser: !!agentStatus.waitingForUser,
            unread: agentStatus.unread,
            tasksDir: sessionPath,
          }));
        }
      }

      // Process custom task lists (non-UUID directories mapped via _task-maps)
      const { listToSessions } = loadAllTaskMaps();
      for (const [taskListName, map] of Object.entries(listToSessions)) {
        const customTaskDir = path.join(TASKS_DIR, taskListName);
        if (!existsSync(customTaskDir)) continue;
        const counts = getTaskCounts(customTaskDir);

        for (const [sessionId, info] of Object.entries(map)) {
          const existing = sessionsMap.get(sessionId);
          if (existing) {
            Object.assign(existing, {
              taskCount: counts.taskCount,
              completed: counts.completed,
              inProgress: counts.inProgress,
              pending: counts.pending,
              tasksDir: customTaskDir,
              sharedTaskList: taskListName,
            });
          } else {
            const meta = { ...(metadata[sessionId] || {}) };
            if (!meta.project && info.project) meta.project = info.project;
            const logStat = getSessionLogStat(meta);
            const logMtime = logStat.mtime;
            const logAge = logMtime ? Date.now() - logMtime : Infinity;
            const stale = logAge > AGENT_STALE_MS;
            const agentDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
            const agentStatus = checkAgentStatus(agentDir, stale, logMtime);
            let modifiedAt = info.updatedAt || new Date(0).toISOString();
            if (logMtime) {
              const jsonlMtime = new Date(logMtime).toISOString();
              if (jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
            }
            sessionsMap.set(sessionId, buildSessionObject(sessionId, meta, {
              _logStat: logStat,
              taskCount: counts.taskCount,
              completed: counts.completed,
              inProgress: counts.inProgress,
              pending: counts.pending,
              modifiedAt,
              hasActiveAgents: agentStatus.hasActive,
              hasRunningAgents: agentStatus.hasRunning,
              hasWaitingForUser: !!agentStatus.waitingForUser,
              unread: agentStatus.unread,
              tasksDir: customTaskDir,
              sharedTaskList: taskListName,
            }));
          }
        }
      }
    }

    // Add sessions from metadata that don't have task directories
    for (const [sessionId, meta] of Object.entries(metadata)) {
      if (!sessionsMap.has(sessionId)) {
        const logStat = getSessionLogStat(meta);
        const logMtime = logStat.mtime;
        const logAge = logMtime ? Date.now() - logMtime : Infinity;
        const stale = logAge > AGENT_STALE_MS;
        const metaAgentDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
        const metaAgentStatus = checkAgentStatus(metaAgentDir, stale, logMtime);

        // Cheap-probe: no tasks here (metadata-only), so active = recent log OR live agent.
        if (activeFilter && !pinnedIds.has(sessionId) && !terminalIds.has(sessionId)) {
          const cheaplyActive = logStat.hasMessages && (
            hasVisibleLogActivity(sessionId, logAge) || metaAgentStatus.hasActive || !!metaAgentStatus.waitingForUser
          );
          if (!cheaplyActive) continue;
        }

        let modifiedAt = meta.created || null;
        if (logMtime) {
          const jsonlMtime = new Date(logMtime).toISOString();
          if (!modifiedAt || jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
        }
        sessionsMap.set(sessionId, buildSessionObject(sessionId, meta, {
          _logStat: logStat,
          modifiedAt: modifiedAt || new Date(0).toISOString(),
          hasActiveAgents: metaAgentStatus.hasActive,
          hasRunningAgents: metaAgentStatus.hasRunning,
          hasWaitingForUser: !!metaAgentStatus.waitingForUser,
          unread: metaAgentStatus.unread,
        }));
      }
    }

    // Add sessions from agent-activity that have _waiting.json but no tasks/metadata
    if (existsSync(AGENT_ACTIVITY_DIR)) {
      try {
        for (const dir of readdirSync(AGENT_ACTIVITY_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory() || sessionsMap.has(dir.name)) continue;
          const agentDir = path.join(AGENT_ACTIVITY_DIR, dir.name);
          const meta = metadata[dir.name] || {};
          const logStat = getSessionLogStat(meta);
          const waiting = checkWaitingForUser(agentDir, logStat.mtime);
          if (!waiting) continue;
          sessionsMap.set(dir.name, buildSessionObject(dir.name, meta, {
            _logStat: logStat,
            modifiedAt: waiting.timestamp || new Date().toISOString(),
            hasActiveAgents: true,
            hasWaitingForUser: true,
          }));
        }
      } catch { /* ignore */ }
    }

    // Ensure pinned sessions are in the map even if they weren't discovered
    for (const pid of pinnedIds) {
      if (sessionsMap.has(pid)) continue;
      const meta = metadata[pid];
      if (!meta) continue;
      const pinnedLogStat = getSessionLogStat(meta);
      const pinnedLogMtime = pinnedLogStat.mtime;
      let modifiedAt = meta.created || null;
      if (pinnedLogMtime) {
        const jsonlMtime = new Date(pinnedLogMtime).toISOString();
        if (!modifiedAt || jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
      }
      sessionsMap.set(pid, buildSessionObject(pid, meta, {
        _logStat: pinnedLogStat,
        modifiedAt: modifiedAt || new Date(0).toISOString(),
      }));
    }

    // The sidebar's Active rule (getFilteredSessions in public/app.js); the CLI reads `active`
    // instead of keeping its own copy. Pinned IDs bypass the filter.
    for (const [id, s] of sessionsMap) {
      s.active = terminalIds.has(id) || !!(s.hasMessages && (
        (!s.sharedTaskList && (s.pending > 0 || s.inProgress > 0))
        || s.hasActiveAgents
        || s.hasWaitingForUser
        || s.hasRecentActivity
      ));
      if (activeFilter && !s.active && !pinnedIds.has(id)) sessionsMap.delete(id);
    }

    // Convert map to array and sort by most recently modified
    let sessions = Array.from(sessionsMap.values());
    sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

    // Apply project filter before limit so the limit is per-project
    const projectFilter = req.query.project;
    // `include` is narrower than a pin: pinned rows survive the limit but still obey
    // the project filter, because pinning is a preference and the filter is an intent.
    // The client sends the session it currently has open, which it cannot render at all
    // if the row is missing — that one is not a preference.
    if (projectFilter) {
      const matches = projectMatcher(String(projectFilter));
      sessions = sessions.filter(s => matches(s.project, s.worktree?.repo) || includeIds.has(s.id));
    }
    // The sidebar's 24h filter: projects with any transcript written in the window, so an older
    // session of such a project stays in.
    const recentHours = Number(req.query.recentHours);
    if (recentHours > 0) {
      const cutoff = Date.now() - recentHours * 3600 * 1000;
      const activity = projectActivity();
      sessions = sessions.filter(s => (activity.get(s.project) || 0) > cutoff || pinnedIds.has(s.id));
    }

    const paged = limit !== null && limit > 0;
    // The sidebar loads the next page on scroll while this is true. A header, so the body stays a plain array.
    res.setHeader('X-Has-More', String(paged && sessions.length > limit));
    res.setHeader('X-Total-Count', String(sessions.length));
    // Apply limit if specified, but always include pinned sessions
    if (paged) {
      const top = sessions.slice(0, limit);
      const topIds = new Set(top.map(s => s.id));
      const missingPinned = sessions.filter(s => pinnedIds.has(s.id) && !topIds.has(s.id));
      sessions = [...top, ...missingPinned];
    }

    for (const s of sessions) s.pin = pins[s.id] || null;

    res.json(withDispatchMarker(sessions));
    startPrewarm();
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Ids of sessions whose id, name or first prompt contains q, from any transcript, newest first. The client
// gets the rows through `/api/sessions?include=`. A linear scan is enough: ~4 ms for 10k ids,
// plus one stat per hit for the sort.
const SESSION_SEARCH_MIN = 3;
const SESSION_SEARCH_MAX = 20;
app.get('/api/sessions/search', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const text = String(req.query.q || '').trim().toLowerCase();
  if (text.length < SESSION_SEARCH_MIN) return res.json([]);
  const idQ = text.replace(/-/g, '');
  const searchIds = idQ.length >= SESSION_SEARCH_MIN && /^[0-9a-f]+$/.test(idQ);
  const hits = [];
  for (const [id, meta] of Object.entries(loadSessionMetadata())) {
    const name = getSessionDisplayName(meta);
    if ((searchIds && id.replace(/-/g, '').includes(idQ)) || name?.toLowerCase().includes(text) || meta.firstPrompt?.toLowerCase().includes(text)) {
      hits.push({ id, mtime: getSessionLogStat(meta).mtime || 0 });
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  res.json(hits.slice(0, SESSION_SEARCH_MAX).map((h) => h.id));
});

app.get('/api/sessions/known', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const known = new Map();
    for (const [id, meta] of Object.entries(loadSessionMetadata())) {
      known.set(id, { id, project: meta.project || null, name: getSessionDisplayName(meta) });
    }
    const add = (id, project = null) => {
      if (!known.has(id)) known.set(id, { id, project, name: null });
    };
    for (const dir of [TASKS_DIR, AGENT_ACTIVITY_DIR]) {
      if (!existsSync(dir)) continue;
      for (const d of readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) add(d.name);
    }
    for (const map of Object.values(loadAllTaskMaps().listToSessions)) {
      for (const [id, info] of Object.entries(map)) add(id, info.project || null);
    }
    res.json([...known.values()]);
  } catch (error) {
    console.error('Error listing known sessions:', error);
    res.status(500).json({ error: 'Failed to list known sessions' });
  }
});

function isTempPath(p) {
  const rel = path.relative(TEMP_ROOT, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Project path → newest transcript mtime among its sessions (undefined when none has one).
function projectActivity() {
  const activity = new Map();
  for (const meta of Object.values(loadSessionMetadata())) {
    if (!meta.project) continue;
    const mtime = getSessionLogStat(meta).mtime;
    const prev = activity.get(meta.project);
    if (!prev || (mtime && mtime > prev)) activity.set(meta.project, mtime);
  }
  return activity;
}

// API: Get distinct project paths with last-modified timestamps. A linked worktree is folded
// into its repo, which lists it under `worktrees`; the repo row exists even when only its
// worktrees have transcripts.
app.get('/api/projects', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const byRepo = new Map();
  for (const [project, mtime] of projectActivity()) {
    const repo = worktrees.resolve(project)?.repo || project;
    const key = normalizeProjectPath(repo);
    let row = byRepo.get(key);
    if (!row) {
      row = { path: repo, mtime: 0, worktrees: [] };
      byRepo.set(key, row);
    }
    if (repo === project) row.path = project;
    else row.worktrees.push(project);
    row.mtime = Math.max(row.mtime, mtime || 0);
  }
  const projects = [...byRepo.values()]
    .map((r) => ({
      path: r.path,
      modifiedAt: r.mtime ? new Date(r.mtime).toISOString() : null,
      ...(isTempPath(r.path) && { temp: true }),
      ...(r.worktrees.length && { worktrees: r.worktrees.sort() }),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  res.json(projects);
});

app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    // A session that never used the board has no task dir. That is the common case and
    // an answer, not a failure; a 404 only reached the browser console.
    const tasks = (await readTaskDir(taskDirFor(req.params.sessionId))).map(({ task }) => task);

    // Sort by ID (numeric)
    tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    res.json(tasks);
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// API: Get combined tasks for a project (all sessions + shared task lists)
app.get('/api/projects/:encodedPath/tasks', async (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf8');
    const metadata = loadSessionMetadata();
    const taskDirs = new Set(
      Object.entries(metadata)
        .filter(([, m]) => m.project === projectPath)
        .map(([id]) => taskDirFor(id)),
    );

    const tasks = [];
    for (const dir of taskDirs) {
      const seenIds = new Set();
      for (const { task } of await readTaskDir(dir)) {
        if (seenIds.has(task.id)) continue;
        seenIds.add(task.id);
        task._taskDir = path.basename(dir);
        tasks.push(task);
      }
    }
    tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    res.json(tasks);
  } catch (error) {
    console.error('Error getting project tasks:', error);
    res.status(500).json({ error: 'Failed to get project tasks' });
  }
});

// API: Get session plan
app.get('/api/sessions/:sessionId/plan', async (req, res) => {
  try {
    // Most sessions have no saved plan, and the info modal asks for one every time it
    // opens, so "no plan" is a normal answer rather than a 404 in the console.
    const { planPath } = getPlanInfo(req.params.sessionId);
    if (!planPath) return res.json({ content: null });

    const content = await fs.readFile(planPath, 'utf8');
    res.json({ content, path: planPath });
  } catch (error) {
    console.error('Error reading plan:', error);
    res.status(500).json({ error: 'Failed to read plan' });
  }
});

// The pi `bind_plan` tool. A session has one plan; binding another replaces it.
app.post('/api/sessions/:sessionId/plan', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const raw = req.body?.path;
    if (linkUrl(raw)) throw previewError(400, 'A plan is a local markdown file, not a URL', 'bad_target');
    const abs = realpathDeepest(resolveFileTarget(raw));
    await statFileTarget(abs);
    const [old] = plans.get(sessionId);
    plans.link(sessionId, abs);
    plansWatcher.add(abs);
    const oldLong = old && realpathDeepest(old);
    if (oldLong && !planPaths().some((p) => canonicalPath(realpathDeepest(p)) === canonicalPath(oldLong))) plansWatcher.unwatch(oldLong);
    broadcast({ type: 'metadata-update' });
    res.json({ path: abs, title: getPlanInfo(sessionId).planTitle });
  } catch (error) {
    if (!error.status) console.error('Error binding plan:', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to bind plan', code: error.code });
  }
});

// Memo for a cold read keyed on the file's identity, so a repeat ask costs the one stat
// it already pays to notice the file grew. `load` may return a promise: the promise is
// what gets cached, so concurrent callers share a single read, and a file that grows while
// it is pending starts no second one. Null when the file is gone.
function cachedByFileStat(cache, filePath, load) {
  let stat;
  try { stat = statSync(filePath); } catch (_) { return null; }
  const hit = cache.get(filePath);
  if (hit && (hit.pending || (hit.mtimeMs === stat.mtimeMs && hit.size === stat.size))) return hit.value;
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, value: load() };
  if (typeof entry.value?.then === 'function') {
    entry.pending = true;
    entry.value.finally(() => { entry.pending = false; }).catch(() => {});
  }
  cache.set(filePath, entry);
  return entry.value;
}

// Cold path — a full transcript scan, so the result is held until the file grows.
// The zen panel asks again on every re-render, which then costs one stat.
const artifactsByPath = new Map();

function getArtifactLinks(jsonlPath) {
  return cachedByFileStat(artifactsByPath, jsonlPath, () => readArtifactLinks(jsonlPath)) || [];
}

app.get('/api/sessions/:sessionId/artifacts', async (req, res) => {
  try {
    const meta = sessionMetaFor(req.params.sessionId);
    if (!meta?.jsonlPath) return res.json({ artifacts: [] });
    res.json({ artifacts: await getArtifactLinks(meta.jsonlPath) });
  } catch (error) {
    console.error('Error reading artifacts:', error);
    res.status(500).json({ error: 'Failed to read artifacts' });
  }
});

// A scratchpad is a folder plus a `scratchpad.json` manifest, rendered by the
// external `scratch` CLI. pi-kanban only recognizes the shape and launches the viewer —
// it reads nothing from the manifest but `name`, `created` and `id`, so the two stay
// independently versioned.
const SCRATCHPAD_MANIFEST = 'scratchpad.json';

// Fallback only, for a `scratch new` whose output the transcript never captured. A pad
// has no central registry — the CLI treats the folder path as the pad's identity and
// finds pads by scanning — and `_scratchpads/` is one user's habit, not a convention it
// knows, so there is no layout to guess. Depth 3 rather than a deeper walk for the
// reason docs/session-scanning.md records: pruned, it measures 0-3 ms on the worst-case
// project dirs, while an unpruned walk of the same dirs costs ~800 ms.
const PAD_SCAN_IGNORE = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build']);
const PAD_SCAN_MAX_DEPTH = 3;
// A pad manifest's `created` is written after the tool call starts, so the match is
// a window, not an instant. Measured lag on a real `scratch new` was 4.1 s; the
// window is wide enough to survive a slow disk and far too narrow to reach a pad
// made in an earlier session.
const PAD_CREATE_WINDOW_MS = 120000;

async function findPads(root, depth = 0) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (_) { return []; }
  // A pad is never nested inside another pad, so a manifest ends the descent.
  if (entries.some((e) => e.isFile() && e.name === SCRATCHPAD_MANIFEST)) return [root];
  if (depth >= PAD_SCAN_MAX_DEPTH) return [];
  const nested = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !PAD_SCAN_IGNORE.has(e.name))
      .map((e) => findPads(path.join(root, e.name), depth + 1)),
  );
  return nested.flat();
}

// The pads a session made, as linked-doc rows. Derived on every read rather than
// stored, so re-reading a transcript cannot drift; the client links each pad once
// and records that it did, which is what stops a re-read undoing an unlink.
async function readCreatedPads(meta) {
  const creations = await readScratchpadCreations(meta.jsonlPath);
  // No `scratch new` in the transcript means no disk work at all, so sessions that
  // never touch the CLI pay a substring pass over the transcript and nothing more.
  if (!creations.length) return [];
  const reported = new Set(creations.filter((c) => c.path).map((c) => c.path));
  const unresolved = creations.filter((c) => !c.path);
  const askedFor = new Set(unresolved.map((c) => c.name).filter(Boolean));
  // Only a call whose name could not be read falls back to the clock, and it compares
  // against the call's second, not the call: the manifest records `created` to the
  // second while the transcript timestamps to the millisecond, so a pad written during
  // the same second as its own command otherwise reads as older than it.
  const byClock = unresolved.filter((c) => !c.name).map((c) => Math.floor(c.ts / 1000) * 1000);
  const sessionId = path.basename(meta.jsonlPath, '.jsonl');
  // The project, not `meta.cwd`: cwd is wherever the session last stood, which drifts
  // into subdirectories — a session that made a pad and then worked inside it reports
  // a cwd below the pad, and a scan from there finds nothing above it.
  // The session's own scratchpad dir too: a pad made there sits outside the project.
  const roots = unresolved.length ? [meta.project || meta.cwd, getScratchpadDir(sessionId, meta)] : [];
  const scanned = (await Promise.all(roots.filter(Boolean).map((r) => findPads(r)))).flat();
  const candidates = [...new Set([...reported, ...scanned.map((dir) => path.join(dir, SCRATCHPAD_MANIFEST))])];
  const rows = await Promise.all(
    candidates.map(async (file) => {
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { return null; }
      const created = Date.parse(manifest?.created);
      if (!Number.isFinite(created)) return null;
      const name = manifest.name || path.basename(path.dirname(file));
      // A path the CLI printed names its pad outright. Otherwise `scratch new --id`
      // settles it: the flag stamps the session that asked for the pad into the
      // manifest, so an id decides ownership both ways — one naming another session
      // disowns the pad whatever the name or the clock say. Only a pad with no id is
      // guessed at, by the name the command asked for and then by the clock.
      const claimed =
        reported.has(file) ||
        (manifest.id
          ? manifest.id === sessionId
          : askedFor.has(name) || byClock.some((from) => created >= from && created - from <= PAD_CREATE_WINDOW_MS));
      if (!claimed) return null;
      return { path: file, name, created: manifest.created, ts: created };
    }),
  );
  return rows
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts)
    .map(({ ts: _ts, ...row }) => row);
}

// Cold path — a full transcript scan, and a directory walk when the transcript did not
// carry the pad paths, so the result is held until the transcript grows.
const padsByPath = new Map();

function getCreatedPads(meta) {
  return cachedByFileStat(padsByPath, meta.jsonlPath, () => readCreatedPads(meta)) || [];
}

app.get('/api/sessions/:sessionId/pads', async (req, res) => {
  try {
    const meta = sessionMetaFor(req.params.sessionId);
    if (!meta?.jsonlPath) return res.json({ pads: [] });
    res.json({ pads: await getCreatedPads(meta) });
  } catch (error) {
    console.error('Error reading created pads:', error);
    res.status(500).json({ error: 'Failed to read created pads' });
  }
});

// API: List one level of a session's scratchpad dir — the root, or the folder named by
// `?path=`, which is the absolute path a previous listing handed out and must still sit
// under the root. One readdir per request, never a walk: sessions drop clones and
// build output in there, and an unpruned walk costs three orders of magnitude more than
// the readdir. The client asks for a folder only when the user opens it. Measurements
// in docs/session-scanning.md.
app.get('/api/sessions/:sessionId/scratchpad-files', async (req, res) => {
  try {
    const id = req.params.sessionId;
    const meta = sessionMetaFor(id);
    const root = meta ? getScratchpadDir(id, meta) : null;
    if (!root) return res.json({ files: [] });

    const dir = resolveScratchSubdir(root, req.query.path);
    if (!dir) return res.status(400).json({ error: 'Path is outside the scratchpad dir' });

    // The harness creates the dir lazily, so "missing" is the common case and lists as empty.
    res.json({ files: await listScratchDir(dir) });
  } catch (error) {
    console.error('Error listing scratchpad files:', error);
    res.status(500).json({ error: 'Failed to list scratchpad files' });
  }
});

// API: Open session plan in VS Code
app.post('/api/sessions/:sessionId/plan/open', (req, res) => {
  try {
    const { planPath } = getPlanInfo(req.params.sessionId);
    if (!planPath) return res.status(404).json({ error: 'No plan found' });

    openInEditor([planPath]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error opening plan in editor:', error);
    res.status(500).json({ error: 'Failed to open plan' });
  }
});

// #endregion

// #region OPEN_TARGETS
// API: Open folder (and optionally a file within it) in editor
app.post('/api/open-folder', (req, res) => {
  try {
    const { folder, file } = req.body;
    const targets = [folder ? assertOpenTarget(folder, 'folder') : PI_AGENT_DIR];
    if (file) targets.push(assertOpenTarget(file, 'file'));
    openInEditor(targets);
    res.json({ success: true });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error opening folder:', error);
    res.status(500).json({ error: 'Failed to open folder' });
  }
});

// API: Open file in editor — either an existing path ({ file }) or content as a temp file ({ content, title })
app.post('/api/open-in-editor', (req, res) => {
  try {
    const { content, title, file } = req.body;
    if (file) {
      const resolved = assertOpenTarget(file, 'file');
      openInEditor([resolved]);
      return res.json({ success: true, path: resolved });
    }
    if (!content) return res.status(400).json({ error: 'No content provided' });

    const safeName = (title || 'message').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    const tmpFile = path.join(os.tmpdir(), `pi-kanban-${safeName}-${hash}.md`);
    require('node:fs').writeFileSync(tmpFile, content, 'utf8');

    openInEditor([tmpFile]);
    res.json({ success: true, path: tmpFile });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error opening in editor:', error);
    res.status(500).json({ error: 'Failed to open in editor' });
  }
});

// Resolve a linked path to the pad the viewer wants: `<parent>/<name>` where
// `<name>/scratchpad.json` exists. Accepts either the manifest or its directory.
function resolveScratchpad(value) {
  const target = assertOpenTarget(value, 'path');
  const dir = path.basename(target).toLowerCase() === SCRATCHPAD_MANIFEST ? path.dirname(target) : target;
  if (!existsSync(path.join(dir, SCRATCHPAD_MANIFEST))) throw previewError(400, 'Not a scratchpad');
  return { name: path.basename(dir), parent: path.dirname(dir) };
}

// API: Open a scratchpad in the external `scratch` viewer — the window outlives
// this request and pi-kanban never waits on it.
app.post('/api/scratchpad/open', (req, res) => {
  try {
    const bin = whichSync('scratch');
    if (!bin) return res.status(501).json({ error: 'scratch CLI not found on PATH' });
    const { name, parent } = resolveScratchpad(req.body?.path);
    // .cmd/.bat cannot be spawned without a shell since the CVE-2024-27980 fix;
    // scratch ships a real .exe, so resolve it rather than reintroducing one.
    const ext = path.extname(bin).toLowerCase();
    const file = ext === '.cmd' || ext === '.bat' ? exeBehindShim(bin) : bin;
    if (!file) return res.status(501).json({ error: 'scratch CLI cannot be launched without a shell' });
    // `scratch ui` is a foreground supervisor: it reloads the window on edits and
    // quits on stdin EOF. So stdin must be an open pipe we never write to —
    // 'ignore' is /dev/null, which reads as EOF and closes the viewer at once.
    //
    // And no `detached`: on Windows that means DETACHED_PROCESS, which overrides
    // the CREATE_NO_WINDOW `windowsHide` asks for, so the bun shim allocates its
    // own console and a blank terminal window pops up next to the viewer.
    const child = spawn(file, ['ui', name, '--dir', parent], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', (e) => console.error('scratch ui failed to start:', e.message));
    // Nothing is ever written to it, but an unhandled EPIPE when the user closes
    // the viewer would take the server down with it.
    child.stdin.on('error', () => {});
    child.stdin.unref();
    child.unref();
    res.json({ success: true, pad: name });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error opening scratchpad:', error);
    res.status(500).json({ error: 'Failed to open scratchpad' });
  }
});

// #endregion

// #region AGENT_ROUTES
// API: Get agents for a session
// The resultUnavailable latch is persisted on the agent record. Bump this when
// extractAgentResultFromTranscript finds more, so agents latched earlier rescan once.
const RESULT_SCAN = 3;
// Same for the modelUnavailable latch and extractModelFromTranscript.
const MODEL_SCAN = 2;

app.get('/api/sessions/:sessionId/agents', async (req, res) => {
  const sessionId = req.params.sessionId;
  const agentDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
  if (!existsSync(agentDir)) return res.json({ agents: [], waitingForUser: null });
  try {
    const meta = sessionMetaFor(sessionId) || {};
    const logMtime = getSessionLogStat(meta).mtime;
    const sessionStale = logMtime ? (Date.now() - logMtime) > AGENT_STALE_MS : true;

    const files = listAgentFiles(agentDir);
    const agents = [];
    for (const file of files) {
      try {
        const agent = readAgentJsonl(path.join(agentDir, file));
        if (isGhostAgent(agent)) continue;
        const agentTs = agent.updatedAt || agent.startedAt;
        const agentStale = !sessionStale && agentTs && (Date.now() - new Date(agentTs).getTime()) > AGENT_STALE_MS;
        if ((!isAgentFresh(agent) || sessionStale || agentStale) && isAgentLive(agent)) {
          agent.status = 'stopped';
          if (!agent.stoppedAt) agent.stoppedAt = agent.updatedAt || agent.startedAt;
        }
        agents.push(agent);
      } catch { /* skip invalid */ }
    }
    const digest = meta.jsonlPath ? await getSessionDigest(meta.jsonlPath) : null;
    const liveAgents = agents.filter(isAgentLive);
    if (liveAgents.length && meta.jsonlPath) {
      try {
        const { terminated } = digest;
        if (terminated.size) {
          for (const agent of liveAgents) {
            const agentName = agentDisplayName(agent);
            if (agentName && terminated.has(agentName)) {
              const terminatedAt = terminated.get(agentName);
              if (terminatedAt && agent.startedAt && terminatedAt < agent.startedAt) continue;
              agent.status = 'stopped';
              agent.stoppedAt = agent.stoppedAt || new Date().toISOString();
              persistAgent(agentDir, agent);
            }
          }
        }
      } catch (_) {}
      // Mark agents whose spawning Agent tool_use was rejected by the user as stopped:
      // the parent will never read their output, so they're orphans. Match by agentId
      // when the digest already correlated tool_use→agent, else fall back to prompt text
      // (the plugin's mod doesn't record the spawning tool_use_id).
      try {
        const { rejectedAgentIds = new Set(), rejectedPrompts = new Set(), killedAgentIds = new Set() } = digest;
        if (rejectedAgentIds.size || rejectedPrompts.size || killedAgentIds.size) {
          for (const agent of liveAgents) {
            if (!isAgentLive(agent)) continue;
            let reason = null;
            if (killedAgentIds.has(agent.agentId)) reason = 'killed-by-harness';
            else if (rejectedAgentIds.has(agent.agentId) || (agent.prompt && rejectedPrompts.has(agent.prompt))) {
              reason = 'orphaned-by-rejection';
            }
            if (!reason) continue;
            agent.status = 'stopped';
            agent.stoppedAt = agent.stoppedAt || new Date().toISOString();
            agent.stopReason = agent.stopReason || reason;
            persistAgent(agentDir, agent);
          }
        }
      } catch (_) {}
    }

    const dirty = new Set();

    // Agents may be missing prompt/name/description because the parent's agent_progress
    // event or the subagent's own transcript hadn't been written yet at last poll. While
    // the agent is still active, keep retrying instead of latching *Unavailable permanently
    // (same pattern as agentsNeedingModel below). Each field shares the same resolve flow:
    // look up in progressMap by agentId, fall back to per-field extractor, persist only
    // on actual change.
    // progressMap is keyed by tool_use_id; re-key by agentId, first value per field wins.
    const byAgentId = {};
    if (meta.jsonlPath) {
      try {
        for (const entry of Object.values(digest.progressMap)) {
          byAgentId[entry.agentId] ||= {};
          const e = byAgentId[entry.agentId];
          for (const f of ['prompt', 'name', 'description', 'usage']) {
            if (entry[f] && !e[f]) e[f] = entry[f];
          }
        }
      } catch (_) {}
    }
    const reconcileFields = [
      {
        field: 'prompt',
        flag: 'promptUnavailable',
        lookup: (a) => {
          if (byAgentId[a.agentId]?.prompt) return byAgentId[a.agentId].prompt;
          try { return extractPromptFromTranscript(subagentJsonlForExtraction(a)); } catch (_) { return null; }
        },
      },
      { field: 'agentName',   flag: 'agentNameUnavailable',   lookup: (a) => byAgentId[a.agentId]?.name || null },
      { field: 'description', flag: 'descriptionUnavailable', lookup: (a) => byAgentId[a.agentId]?.description || null },
    ];
    for (const { field, flag, lookup } of reconcileFields) {
      for (const agent of agents) {
        if (agent[field]) continue;
        // Workflow subagents nest their transcript under subagents/workflows/;
        // pre-fix builds latched *Unavailable using the flat path, so always
        // re-attempt for them (the extractor resolves the nested path now).
        if (agent[flag] && !isAgentLive(agent) && agent.type !== 'workflow-subagent') continue;
        const value = lookup(agent);
        if (value) {
          agent[field] = value;
          delete agent[flag];
          dirty.add(agent);
        } else if (!isAgentLive(agent) && !agent[flag]) {
          agent[flag] = true;
          dirty.add(agent);
        }
      }
    }

    // The plugin's start record carries the model; this covers sessions without it.
    const agentsNeedingModel = agents.filter(a => !a.model && a.modelUnavailable !== MODEL_SCAN);
    if (agentsNeedingModel.length) {
      for (const agent of agentsNeedingModel) {
        let model = null;
        try { model = extractModelFromTranscript(subagentJsonlForExtraction(agent)); } catch (_) {}
        if (model) {
          agent.model = model;
          delete agent.modelUnavailable;
          delete agent.modelAlias;
          dirty.add(agent);
          continue;
        }
        if (agent.status === 'stopped') {
          agent.modelUnavailable = MODEL_SCAN;
          dirty.add(agent);
        }
      }
    }

    // Workflow-spawned subagents given a schema end on a forced StructuredOutput
    // tool call (background subagents on SubagentHandback) and never emit a text
    // lastMessage — surface that result as the agent's response.
    // Only stopped agents (complete transcript); latch
    // resultUnavailable so we tail-read at most once per agent. Workflow subagents
    // are exempt from the latch: the poll that flips them to "stopped" can beat the
    // transcript's final StructuredOutput line to disk, latching resultUnavailable
    // against an incomplete transcript — so always re-attempt for them, mirroring
    // the prompt/name/description reconcile above.
    const agentsNeedingResult = agents.filter(
      (a) => !a.lastMessage && !isAgentLive(a) && (a.resultUnavailable !== RESULT_SCAN || a.type === 'workflow-subagent'),
    );
    if (agentsNeedingResult.length) {
      for (const agent of agentsNeedingResult) {
        let result = null;
        try { result = extractAgentResultFromTranscript(subagentJsonlForExtraction(agent)); } catch (_) {}
        if (result) agent.lastMessage = result;
        else agent.resultUnavailable = RESULT_SCAN;
        dirty.add(agent);
      }
    }

    for (const agent of dirty) persistAgent(agentDir, agent);

    const waitingForUser = checkWaitingForUser(agentDir, logMtime);
    // Attached after persistAgent so it stays response-only.
    for (const agent of agents) {
      const usage = byAgentId[agent.agentId]?.usage;
      if (usage) agent.usage = usage;
    }
    res.json({ agents, waitingForUser });
  } catch {
    res.json({ agents: [], waitingForUser: null });
  }
});

function clearActivityMarker(sessionId, file) {
  try { unlinkSync(path.join(AGENT_ACTIVITY_DIR, sessionId, file)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

app.post('/api/sessions/:sessionId/waiting/discard', (req, res) => {
  try {
    clearActivityMarker(req.params.sessionId, '_waiting.json');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to discard waiting' });
  }
});

app.post('/api/sessions/:sessionId/read', (req, res) => {
  try {
    clearActivityMarker(req.params.sessionId, '_stop.json');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to mark session read' });
  }
});

// UI-driven approvals: answers the ask the plugin's mod is polling for by writing
// _decision-<id>.json next to the marker. The mod cannot delete files, so it clears
// the marker and leaves the decision, and a write for an ask that is already over
// is accepted anyway (D13); cleanupAgentActivity's sweep removes both kinds.
app.post('/api/sessions/:sessionId/waiting/respond', (req, res) => {
  const sessionId = req.params.sessionId;
  const dir = path.join(AGENT_ACTIVITY_DIR, sessionId);
  let marker = null;
  try { marker = JSON.parse(readFileSync(path.join(dir, '_waiting.json'), 'utf8')); }
  catch { /* missing or invalid → buildDecision reports 410 */ }
  // The gate stopped polling after waitSeconds — an orphaned decision file would
  // sit unconsumed while the card pretends the click worked.
  const refusal = marker && boardRefusal(marker, approvalsConfig());
  if (refusal) return res.status(refusal.status).json({ error: refusal.error });
  const result = buildDecision(marker, req.body || {});
  if (result.error) return res.status(result.status).json({ error: result.error });
  try {
    writeJsonAtomic(path.join(dir, decisionFileName(marker.id)), result.decision);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to write decision' });
  }
});

app.post('/api/sessions/:sessionId/agents/:agentId/stop', (req, res) => {
  const sessionId = req.params.sessionId;
  const agentId = sanitizeAgentId(req.params.agentId);
  const agentFile = path.join(AGENT_ACTIVITY_DIR, sessionId, `${agentId}.jsonl`);
  if (!existsSync(agentFile)) return res.status(404).json({ error: 'Agent not found' });
  try {
    const agent = readAgentJsonl(agentFile);
    agent.status = 'stopped';
    agent.stoppedAt = new Date().toISOString();
    const stopEvt = { agentId, type: agent.type, event: 'user-stop', status: 'stopped', stoppedAt: agent.stoppedAt, updatedAt: agent.stoppedAt };
    writeFileSync(agentFile, `${readFileSync(agentFile, 'utf8') + JSON.stringify(stopEvt)}\n`, 'utf8'); // sync — response depends on write
    clearActivityMarker(sessionId, '_waiting.json');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to stop agent' });
  }
});

// #endregion

// #region SUBAGENT_RESOLUTION
function sanitizeAgentId(raw) {
  return path.basename(raw).replace(/[^a-zA-Z0-9_-]/g, '');
}

const inSessionRoots = (file) => typeof file === 'string' && SESSION_OPTS.roots.some((r) => isContained(file, r.dir));

// pi-subagents runs each subagent as a child pi session and reports its file in the
// tool result; the extension copies it into the agent record as sessionFile.
function subagentJsonlForExtraction(agent) {
  const file = agent?.sessionFile;
  return inSessionRoots(file) && existsSync(file) ? file : null;
}

function resolveSubagentJsonl(sessionId, agentId) {
  try {
    return subagentJsonlForExtraction(readAgentJsonl(path.join(AGENT_ACTIVITY_DIR, sessionId, `${agentId}.jsonl`)));
  } catch (_) {
    return null;
  }
}

// pi records a fork's parent in the session header (`parentSession`), so no scan is needed.
// pi compacts in place, so a parent is always a fork.
function lookupParentSession(sessionId) {
  const parentPath = loadSessionMetadata()[sessionId]?.parentSessionPath;
  const parent = inSessionRoots(parentPath) ? describeSessionFile(parentPath) : null;
  return {
    parentSessionId: parent?.sessionId || null,
    parentJsonlPath: parent ? parentPath : null,
    relation: parent ? 'fork' : 'none',
    isCompact: false,
    isFork: !!parent,
  };
}
// #endregion

// #region MESSAGE_ROUTES
app.get('/api/sessions/:sessionId/parent', (req, res) => {
  res.json(lookupParentSession(req.params.sessionId));
});

app.get('/api/sessions/:sessionId/agents/:agentId/messages', (req, res) => {
  const sessionId = req.params.sessionId;
  const agentId = sanitizeAgentId(req.params.agentId);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const meta = sessionMetaFor(sessionId);
  if (!meta?.jsonlPath) return res.json({ messages: [], agentId });
  const subagentJsonl = resolveSubagentJsonl(sessionId, agentId);
  if (!subagentJsonl) return res.json({ messages: [], agentId });
  const messages = readRecentMessages(subagentJsonl, limit);
  res.json({ messages, agentId });
});

app.get('/api/sessions/:sessionId/agents/:agentId/messages/stream', (req, res) => {
  const sessionId = req.params.sessionId;
  const agentId = sanitizeAgentId(req.params.agentId);
  const meta = sessionMetaFor(sessionId);
  if (!meta?.jsonlPath) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const subagentJsonl = resolveSubagentJsonl(sessionId, agentId);
  if (!subagentJsonl) {
    res.status(404).json({ error: 'Subagent transcript not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

  let lastSize = existsSync(subagentJsonl) ? statSync(subagentJsonl).size : 0;

  const watcher = chokidar.watch(subagentJsonl, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });

  let closed = false;
  const cleanup = () => { if (!closed) { closed = true; watcher.close(); } };

  function emitMessages() {
    const messages = readRecentMessages(subagentJsonl, 50);
    lastSize = statSync(subagentJsonl).size;
    res.write(`event: agent-log-update\ndata: ${JSON.stringify({ messages, agentId })}\n\n`);
  }

  watcher.on('change', () => {
    try {
      if (statSync(subagentJsonl).size <= lastSize) return;
      emitMessages();
    } catch (_) {}
  });

  watcher.on('add', () => {
    try { emitMessages(); } catch (_) {}
  });

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

async function sendSessionMessages(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const before = req.query.before || null;
  const meta = sessionMetaFor(req.params.sessionId);
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.json({ messages: [], hasMore: false, sessionId: req.params.sessionId });
  let messages, hasMore;
  if (before) {
    const page = _readMessagesPageUncached(jsonlPath, limit, before);
    messages = page.messages;
    hasMore = page.hasMore;
  } else {
    messages = readRecentMessages(jsonlPath, limit + 1);
    hasMore = messages.length > limit;
    if (hasMore) messages = messages.slice(-limit);
  }
  const agentMessages = messages.filter(m => m.tool === 'Agent' && m.toolUseId);
  if (agentMessages.length) {
    const progressMap = await getProgressMap(jsonlPath);
    const agentDir = path.join(AGENT_ACTIVITY_DIR, req.params.sessionId);
    for (const msg of agentMessages) {
      const entry = progressMap[msg.toolUseId];
      if (entry) {
        msg.agentId = entry.agentId;
        if (entry.description) msg.agentDescription = entry.description;
        if (entry.usageText) msg.agentUsage = entry.usageText;
        if (entry.prompt && !msg.agentPrompt) msg.agentPrompt = entry.prompt;
        try {
          const agentFile = path.join(agentDir, `${entry.agentId}.jsonl`);
          const agent = readAgentJsonl(agentFile);
          if (agent.lastMessage) msg.agentLastMessage = agent.lastMessage;
          if (agent.prompt && !msg.agentPrompt) msg.agentPrompt = agent.prompt;
          const prompt = msg.agentPrompt || entry.prompt;
          if (prompt && !agent.prompt) {
            agent.prompt = prompt;
            persistAgent(agentDir, agent);
          }
        } catch (_) {}
      }
    }
    // Mid-run fallback: the progressMap only carries agentId once the agent completes
    // (this build writes no agent_progress lines), so a still-running subagent's launch
    // row has no agentId yet — leaving its ⇗ link / agent modal inert until completion.
    // Correlate by PROMPT against the live agent-activity files (which know the agentId
    // from launch): the activity prompt is the launch prompt plus appended harness
    // boilerplate, so the tool_use prompt is a prefix. Resolving agentId here makes the
    // row behave identically while running as it does after it finishes.
    const unresolved = agentMessages.filter(m => !m.agentId && m.agentPrompt);
    if (unresolved.length && existsSync(agentDir)) {
      const activity = listAgentFiles(agentDir)
        .map((f) => { try { return readAgentJsonl(path.join(agentDir, f)); } catch (_) { return null; } })
        .filter((a) => a?.agentId && a.prompt);
      const usedIds = new Set(agentMessages.map(m => m.agentId).filter(Boolean));
      for (const msg of unresolved) {
        const key = msg.agentPrompt.slice(0, 200);
        const match = activity.find(a =>
          !usedIds.has(a.agentId) &&
          (!msg.agentType || a.type === msg.agentType) &&
          a.prompt.startsWith(key)
        );
        if (match) {
          msg.agentId = match.agentId;
          usedIds.add(match.agentId);
          if (match.lastMessage) msg.agentLastMessage = match.lastMessage;
        }
      }
    }
  }
  // The client keeps needing toolUseId when it builds a follow-up URL from it:
  // lazy-fetching a truncated tool result, or fetching each tool-result image.
  const clientNeedsToolUseId = (msg) => msg.toolResultTruncated || msg.toolResultImageCount;
  for (const msg of messages) {
    if (msg.toolUseId && !clientNeedsToolUseId(msg)) delete msg.toolUseId;
    delete msg.promptId;
  }
  res.json({ messages, hasMore, sessionId: req.params.sessionId });
}

app.get('/api/sessions/:sessionId/messages', asyncRoute(sendSessionMessages));

app.get('/api/sessions/:sessionId/tool-result/:toolUseId', asyncRoute(async (req, res) => {
  const meta = sessionMetaFor(req.params.sessionId);
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.status(404).json({ error: 'session not found' });
  const content = await readFullToolResult(jsonlPath, req.params.toolUseId);
  if (content == null) return res.status(404).json({ error: 'tool result not found' });
  res.json({ toolUseId: req.params.toolUseId, content });
}));

const toolStatsCache = new Map();

async function buildToolStats(jsonlPath) {
  const toolUseById = {};     // tool_use_id -> { displayName, isSkill }
  const seenResults = new Set();
  const toolMap = {};         // displayName -> { count, success, failed, outputBytes }
  const skillPromptIds = {};  // promptId -> [skillDisplayName, ...]
  const promptOutputBytes = {}; // promptId -> total outputBytes in that turn

  for await (const line of readLines(jsonlPath)) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }

    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_use' && block.name && block.id) {
          const isSkill = block.name === 'Skill';
          const displayName = isSkill && block.input?.skill
            ? `Skill(${block.input.skill})`
            : block.name === 'Agent' && block.input?.subagent_type
            ? `Agent(${block.input.subagent_type})`
            : block.name;
          toolUseById[block.id] = { displayName, isSkill };
        }
      }
    } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      const promptId = obj.promptId;
      for (const block of obj.message.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const entry = toolUseById[block.tool_use_id];
        if (!entry) continue;
        const { displayName, isSkill } = entry;
        seenResults.add(block.tool_use_id);
        if (!toolMap[displayName]) toolMap[displayName] = { count: 0, success: 0, failed: 0, rejected: 0, outputBytes: 0 };
        toolMap[displayName].count++;
        const raw = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
        const bytes = raw.length;
        toolMap[displayName].outputBytes += bytes;
        if (promptId) {
          promptOutputBytes[promptId] = (promptOutputBytes[promptId] || 0) + bytes;
          if (isSkill) {
            if (!skillPromptIds[promptId]) skillPromptIds[promptId] = [];
            skillPromptIds[promptId].push(displayName);
          }
        }
        const isRejected = typeof obj.toolUseResult === 'string' && /rejected/i.test(obj.toolUseResult);
        if (isRejected) toolMap[displayName].rejected++;
        else {
          const lower = raw.toLowerCase();
          const failed = /^error/i.test(raw.trimStart())
            || /exit code [1-9]/.test(lower)
            || lower.includes('command failed')
            || (lower.includes('failed') && lower.includes('error'));
          if (failed) toolMap[displayName].failed++;
          else toolMap[displayName].success++;
        }
      }
    }
  }

  // Count tool_use blocks that never got a tool_result
  for (const [id, { displayName }] of Object.entries(toolUseById)) {
    if (seenResults.has(id)) continue;
    if (!toolMap[displayName]) toolMap[displayName] = { count: 0, success: 0, failed: 0, rejected: 0, outputBytes: 0 };
    toolMap[displayName].count++;
  }

  // Approximate Skill impact: replace tiny dispatch bytes with the full turn's output
  for (const [promptId, skillNames] of Object.entries(skillPromptIds)) {
    const turnBytes = promptOutputBytes[promptId] || 0;
    for (const name of skillNames) {
      if (toolMap[name]) toolMap[name].outputBytes = turnBytes;
    }
  }

  let totalCalls = 0, totalFailed = 0, totalRejected = 0, totalOutputBytes = 0;
  for (const s of Object.values(toolMap)) {
    totalCalls += s.count;
    totalFailed += s.failed;
    totalRejected += s.rejected;
    totalOutputBytes += s.outputBytes || 0;
  }
  const uniqueTools = Object.keys(toolMap).length;

  const tools = [];
  for (const [name, stats] of Object.entries(toolMap)) {
    const impact = totalOutputBytes > 0 ? Math.round((stats.outputBytes || 0) / totalOutputBytes * 100) : 0;
    const displayName = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name;
    tools.push({ name: displayName, count: stats.count, success: stats.success, failed: stats.failed, rejected: stats.rejected, impact });
  }

  return { totalCalls, uniqueTools, totalFailed, totalRejected, tools };
}

app.get('/api/sessions/:sessionId/tool-stats', async (req, res) => {
  const meta = sessionMetaFor(req.params.sessionId);
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.status(404).json({ error: 'session not found' });
  try {
    const data = await cachedByMtime(toolStatsCache, jsonlPath, jsonlPath, () => buildToolStats(jsonlPath), null);
    if (!data) return res.status(404).json({ error: 'could not parse session' });
    res.json({ sessionId: req.params.sessionId, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function sendTranscriptImage(req, res, read) {
  const meta = sessionMetaFor(req.params.sessionId);
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.status(404).end();
  const img = await read(jsonlPath);
  if (!img) return res.status(404).end();
  const buf = Buffer.from(img.data, 'base64');
  res.setHeader('Content-Type', img.mediaType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
}

app.get('/api/sessions/:sessionId/user-image/:msgUuid/:blockIndex', asyncRoute((req, res) =>
  sendTranscriptImage(req, res, (p) => readUserImage(p, req.params.msgUuid, req.params.blockIndex))));

app.get('/api/sessions/:sessionId/tool-result-image/:toolUseId/:n', asyncRoute((req, res) =>
  sendTranscriptImage(req, res, (p) => readToolResultImage(p, req.params.toolUseId, req.params.n))));

app.get('/api/sessions/:sessionId/cached-image/:n', (req, res) => {
  const img = readCachedImage(req.params.sessionId, req.params.n, PI_AGENT_DIR);
  if (!img) return res.status(404).end();
  res.setHeader('Content-Type', img.mediaType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(img.buffer);
});

// #endregion

// #region META_ROUTES
app.get('/api/version', (_req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version });
});

app.get('/api/config', (_req, res) => {
  res.json({
    scratchAvailable: !!whichSync('scratch'),
    terminal: terminal.clientConfig(),
    thinkingLevels: [...THINKING_LEVELS],
  });
});

// #endregion

// #region TERMINAL
// Any existing folder is allowed: the terminal token already opens a shell PTY, so a folder
// list would block valid use without protecting anything.
function isAllowedFolder(dir) {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

// Restore runs before the first full metadata scan, so until that scan has run a session's
// folder is read from its own JSONL, by the same rules the scan uses.
function resolveSessionFolder(id) {
  if (lastMetadataRefresh || !isSafeId(id)) {
    const meta = loadSessionMetadata()[id];
    return meta ? meta.project || meta.cwd || null : null;
  }
  const suffix = `_${id}.jsonl`;
  const jsonlPath = listSessionFiles(SESSION_OPTS).find((f) => f.endsWith(suffix));
  const header = jsonlPath && readSessionHeader(jsonlPath);
  if (header?.id === id && header.cwd) return header.cwd;
  const meta = loadSessionMetadata()[id];
  return meta ? meta.project || meta.cwd || null : null;
}

// The host saves its terminals; pi-kanban adds the show map (terminal id → session id) beside them.
const terminalsFile = jsonFile(TERMINALS_FILE);
let savedTerminals = terminalsFile.load() || {};

function saveTerminals() {
  const kept = new Set(Object.values(savedTerminals.terminalIds || {}));
  const showSessions = show.prune((id) => kept.has(id) || terminal.hasTerminal(id));
  ask.prune((id) => terminal.hasTerminal(id), 'terminal ended');
  terminalsFile.save({ ...savedTerminals, showSessions });
}

const terminal = createTerminalClient({
  config: readTerminalConfig({ getArgValue }),
  net,
  piAgentDir: PI_AGENT_DIR,
  sessionsDir: SESSIONS_DIR,
  token: process.env.PK_TERMINAL_TOKEN,
  load: terminalsFile.load,
  save: (data) => {
    savedTerminals = data;
    saveTerminals();
  },
  // The project, not the last cwd: `pi --session` finds a session id under the
  // project dir it started in, and cwd drifts into subdirectories.
  resolveCwd: resolveSessionFolder,
  isAllowedFolder,
  onChange: () => broadcast({ type: 'terminals-update', ids: terminal.ids(), awaitingTrust: terminal.awaitingTrust() }),
  onExit: (id) => {
    if (!dispatched.get(id)) return;
    dispatchReports.notify(id);
    broadcast({ type: 'dispatch-update' });
  },
  onRekey: (from, to) => {
    if (dispatched.move(from, to)) broadcast({ type: 'dispatch-update' });
  },
});

// A call to the terminal host fails with 503 while the host restarts.
function terminalRoute(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
  });
}

let folderDialogOpen = false;
app.post('/api/terminal/pick-folder', async (req, res) => {
  const reason = terminal.unavailableReason();
  if (reason) return res.status(403).json({ error: reason });
  if (!terminal.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
  if (folderDialogOpen) return res.status(409).json({ error: 'a folder dialog is already open' });
  folderDialogOpen = true;
  try {
    const dir = await pickFolder(whichSync, { start: req.body?.start });
    res.json({ path: dir });
  } catch (e) {
    res.status(501).json({ error: e.message });
  } finally {
    folderDialogOpen = false;
  }
});

// The New session dialog's "Stay here": the PTY starts headless and the board keeps its view.
app.post('/api/terminal/start', terminalRoute(async (req, res) => {
  if (!terminal.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
  const { id, cwd, name, model, thinking, prompt } = req.body || {};
  const started = await terminal.startNew({ id, cwd, name, model, thinking, prompt });
  if (started.error) return res.status(started.status).json({ error: started.error });
  res.status(201).json({ session: started.id, cwd: started.cwd });
}));

// The New session dialog's images. The prompt names the saved path, and pi reads the file.
// The token check runs before the body parser, so a rejected upload is never buffered.
const ATTACHMENT_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
app.post('/api/terminal/attachments/:session', (req, res, next) => {
  const reason = terminal.unavailableReason();
  if (reason) return res.status(403).json({ error: reason });
  if (!terminal.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
  if (!isUUID(req.params.session)) return res.status(400).json({ error: 'invalid session id' });
  res.locals.ext = ATTACHMENT_TYPES[req.get('content-type')];
  if (!res.locals.ext) return res.status(415).json({ error: 'use a PNG, JPEG, GIF or WebP image' });
  next();
}, express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'empty image' });
  const dir = path.join(ATTACHMENTS_DIR, req.params.session);
  const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${res.locals.ext}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, req.body);
    res.status(201).json({ path: file });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/terminals', terminalRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sessions = await terminal.sessions();
  res.json({
    sessions: sessions.map((t) => {
      const marker = dispatched.get(t.id);
      return marker ? { ...t, dispatched: { parent: marker.parent || null } } : t;
    }),
  });
}));

const terminalProcStats = createProcStats();
app.get('/api/terminals/stats', terminalRoute(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { hostPid, piPids } = await terminal.stats();
  const byPid = await terminalProcStats([process.pid, hostPid, ...Object.values(piPids)].filter(Boolean));
  const terminals = {};
  for (const [id, pid] of Object.entries(piPids)) if (byPid[pid]) terminals[id] = byPid[pid];
  res.json({ pk: byPid[process.pid] || null, host: byPid[hostPid] || null, terminals });
}));

app.delete('/api/terminals/:id', terminalRoute(async (req, res) => {
  const by = req.query.by === 'dispatch' ? 'dispatch_end' : undefined;
  const err = await terminal.end(req.params.id, req.get('x-terminal-token'), by);
  if (err === 'auth') return res.status(401).json({ error: 'invalid terminal token' });
  if (err === 'not-found') return res.status(404).json({ error: 'no such terminal' });
  res.status(204).end();
  broadcast({ type: 'terminal:ended', id: req.params.id });
}));

app.get('/api/companions', (req, res) => {
  const companions = companionStatus({ agentDir: PI_AGENT_DIR, cwd: req.query.cwd });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ companions });
  refreshLatest(companions, { agentDir: PI_AGENT_DIR }).then((changed) => {
    if (changed) broadcast({ type: 'companions:changed' });
  });
});

const companionHost = createCompanionHost({ agentDir: PI_AGENT_DIR, dir: path.join(PK_DIR, 'companions') });
process.on('exit', companionHost.stop);

// Starting a companion runs package code, so it takes the terminal token like `pi install`.
async function startCompanion(req, id) {
  const reason = terminal.unavailableReason();
  if (reason) throw previewError(403, `Companions need the board terminal, which is ${reason}`, 'terminal_unavailable');
  if (!terminal.authorized(req.get('x-terminal-token'))) throw previewError(401, 'invalid terminal token', 'bad_token');
  const entry = await companionHost.start(id);
  if (entry.error) throw previewError(entry.status, entry.error, 'companion');
  return entry;
}

app.post('/api/companions/:id/start', async (req, res) => {
  try {
    const { port } = await startCompanion(req, req.params.id);
    res.json({ port });
  } catch (error) {
    paneRouteError(res, error, 'POST /api/companions/start');
  }
});

// `pi install` and `pi update` write the user's settings and run package code, so they take the terminal token.
app.post('/api/companions/install', terminalRoute(async (req, res) => {
  if (!terminal.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
  const plan = installPlan(req.body?.id, { agentDir: PI_AGENT_DIR, cwd: req.body?.cwd });
  if (!plan) return res.status(400).json({ error: 'unknown package' });
  const started = await terminal.startInstall(plan.piArgs, plan.cwd);
  if (started.error) return res.status(started.status).json({ error: started.error });
  res.status(202).json({ install: started.id });
}));

app.get('/api/companions/install/:id', terminalRoute(async (req, res) => {
  if (!terminal.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
  res.setHeader('Cache-Control', 'no-store');
  const status = await terminal.installStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'no such install' });
  res.json(status);
}));

const show = createShowStore({
  load: () => savedTerminals.showSessions,
  onChange: saveTerminals,
  onPosted: (e) => broadcast({ type: 'show:posted', ...e }),
  startedSession: terminal.sessionOfTerminal,
  resolveDir: (id) => {
    const meta = sessionMetaFor(id);
    return meta ? getScratchpadDir(id, meta) : null;
  },
});
mountShowRoutes(app, {
  store: show,
  authorized: (token) => terminal.authorized(token),
  hasTerminal: (id) => terminal.hasTerminal(id),
  readPreviewFile,
  broadcast,
  onRemoved: (sessionId, paths) => panes.removeShow(sessionId, paths),
});
const ask = createAskStore();
mountAskRoutes(app, {
  store: ask,
  ...terminalAskRoutes({
    authorized: (token) => terminal.authorized(token),
    hasTerminal: (id) => terminal.hasTerminal(id),
  }),
  readPreviewFile,
  broadcast,
});
const sessionAsk = createAskStore();
mountAskRoutes(app, { store: sessionAsk, ...SESSION_ASK_ROUTES, readPreviewFile, broadcast });
// A pi process that dies mid-question never cancels it.
setInterval(() => sessionAsk.prune((id) => isSessionLive(loadLiveSessions(), id), 'session ended'), 60_000).unref();

// Served from node_modules, never a CDN: any script on this page can use the token.
const XTERM_FILES = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-unicode11.js': '@xterm/addon-unicode11/lib/addon-unicode11.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
};
app.get('/vendor/xterm/:file', (req, res) => {
  const rel = Object.hasOwn(XTERM_FILES, req.params.file) ? XTERM_FILES[req.params.file] : null;
  if (!rel) return res.status(404).end();
  let file;
  try { file = require.resolve(rel); } catch { return res.status(404).end(); }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(file);
});
// #endregion

// #region DISPATCH
const dispatched = createDispatchedStore(jsonFile(DISPATCHED_FILE));
const dispatchReports = createDispatchReports({ dispatched, isRunning: (id) => terminal.isRunning(id) });

const linkedDocs = createLinkedDocStore(jsonFile(LINKED_DOCS_FILE));

function withDispatchMarker(sessions) {
  return sessions.map((s) => {
    const marker = dispatched.get(s.id);
    return marker ? { ...s, dispatched: { parent: marker.parent } } : s;
  });
}

// Starting a session needs the terminal token, as the browser does; the CLI reads it from
// TERMINAL_TOKEN_FILE. The started session never holds it.
app.post('/api/dispatch', terminalRoute(async (req, res) => {
  if (!terminal.authorized(req.get('x-terminal-token'))) return res.status(401).json({ error: 'invalid terminal token' });
  const { cwd, spec, name, model, thinking, parent, group, extraArgs } = req.body || {};
  if (typeof spec !== 'string' || !spec.trim()) return res.status(400).json({ error: 'spec is required' });
  if (parent != null && !(typeof parent === 'string' && isUUID(parent))) return res.status(400).json({ error: 'invalid parent' });
  if (group != null && !(typeof group === 'string' && group.trim())) return res.status(400).json({ error: 'group must be a group name, path or id' });
  const started = await terminal.startNew({ cwd, name, model, thinking, prompt: spec.trim(), extraArgs });
  if (started.error) return res.status(started.status).json({ error: started.error });
  dispatched.record(started.id, { parent, cwd: started.cwd, name, group });
  // Joined before dispatch-update, so the board places the session from its first frame. The
  // starter stays where it is: moving it would jump it under the user.
  let joined = null;
  let groupError;
  if (group) {
    try {
      userGroups.reload();
      joined = userGroups.joinDispatch(group, started.id);
      broadcast({ type: 'group:changed', rev: joined.rev });
    } catch (e) {
      groupError = e.message;
    }
  }
  broadcast({ type: 'dispatch-update' });
  res.status(201).json({
    session: started.id,
    cwd: started.cwd,
    group: joined?.path ?? null,
    ...(joined ? { groupId: joined.group, transient: joined.transient } : {}),
    ...(groupError ? { groupError } : {}),
  });
}));

app.get('/api/dispatch', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const parent = typeof req.query.parent === 'string' && req.query.parent ? req.query.parent : null;
  res.json({ running: dispatched.running(terminal.isRunning, { parent }) });
});

// No token on the report routes: the worker holds none, and net-guard refuses a cross-site request.
app.post('/api/dispatch/:session/report', (req, res) => {
  const { text, error } = parseReport(req.body);
  if (error) return res.status(400).json({ error });
  const report = dispatchReports.post(req.params.session, text);
  if (!report) return res.status(404).json({ error: 'not a dispatched session' });
  broadcast({ type: 'dispatch-update' });
  res.status(201).json(report);
});

app.get('/api/dispatch/:session/report', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const got = await dispatchReports.wait(req.params.session, Number(req.query.wait) || 0);
  if (!got) return res.status(404).json({ error: 'not a dispatched session' });
  res.json(got);
});
// #endregion

// #region NEW_SESSION
const piModels = createModelCache({ list: () => listPiModels({ env: { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR } }) });

// The New session dialog's model list: the models pi has auth for in this agent dir.
app.get('/api/pi/models', async (_req, res) => {
  try {
    res.json({ models: await piModels() });
  } catch (e) {
    res.status(502).json({ error: `pi --list-models failed: ${e.message}` });
  }
});
// #endregion

// #region TASK_ROUTES
// API: Get all tasks across all sessions
app.get('/api/tasks/all', async (_req, res) => {
  try {
    if (!existsSync(TASKS_DIR)) {
      return res.json([]);
    }

    const metadata = loadSessionMetadata();
    const { listToSessions } = loadAllTaskMaps();
    const sessionDirs = (await fs.readdir(TASKS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory());
    const dirTasks = await Promise.all(sessionDirs.map((d) => readTaskDir(path.join(TASKS_DIR, d.name))));

    const allTasks = [];

    sessionDirs.forEach((sessionDir, i) => {
      const meta = metadata[sessionDir.name] || {};

      // For custom task list directories (non-UUID dirs), resolve project from the
      // mapped sessions since those dirs don't have their own metadata entry.
      let project = meta.project || null;
      if (!project) {
        const mappedSessions = listToSessions[sessionDir.name];
        if (mappedSessions) {
          for (const [sid, info] of Object.entries(mappedSessions)) {
            project = metadata[sid]?.project || info.project || null;
            if (project) break;
          }
        }
      }

      const sessionName = getSessionDisplayName(meta);
      for (const { task } of dirTasks[i]) {
        allTasks.push({
          ...task,
          sessionId: sessionDir.name,
          sessionName,
          project
        });
      }
    });

    res.json(allTasks);
  } catch (error) {
    console.error('Error getting all tasks:', error);
    res.status(500).json({ error: 'Failed to get all tasks' });
  }
});

const {
  boardEventsOn,
  enqueueSessionEvent,
  formatReviewSubmitted,
  formatActionSubmitted,
  formatTaskMoved,
  handleSessionEvents,
  hasDoorbell,
  configureSessionEvents,
} = require('./lib/session-events');
app.get('/api/sessions/:sessionId/events', handleSessionEvents);

// API: Update task fields (subject, description)
app.put('/api/tasks/:sessionId/:taskId', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const { subject, description } = req.body;

    const sessionDir = taskDirFor(sessionId);
    const taskPath = path.join(sessionDir, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
    const prevStatus = task.status;

    if (subject !== undefined) task.subject = subject;
    if (description !== undefined) task.description = description;
    if (req.body.status !== undefined) task.status = req.body.status;

    await writeTaskFile(taskPath, task);

    // Ring the session only for a move. The direction has to ride in the line because
    // the write above destroyed the old status -- nothing downstream can recover it, and
    // which way a task moved is what decides whether to start work or stop it.
    if (task.status !== prevStatus && boardEventsEnabled()) {
      // The route param is a task *directory*, which for a shared list or team board is
      // not a session id -- and the doorbell polls with its own session id, so an unresolved
      // name would queue the line where nobody drains it.
      const line = formatTaskMoved(taskId, prevStatus, task);
      for (const sid of resolveSessionsForTaskDir(sessionId)) enqueueSessionEvent(sid, line);
    }

    res.json({ success: true, task });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// A deleted task can't block anything, so drop the dangling reference instead of
// refusing the delete -- a stale blockedBy id would pin the other task as BLOCKED forever.
async function deleteTasks(dir, shouldDelete) {
  const tasks = await readTaskDir(dir);
  const doomed = tasks.filter((t) => shouldDelete(t));
  const doomedIds = new Set(doomed.map(({ task }) => task.id));
  const strip = (ids) => ids?.filter((id) => !doomedIds.has(id));

  await Promise.all(
    tasks
      .filter(({ task }) => !doomedIds.has(task.id))
      .map(({ file, task }) => {
        const before = JSON.stringify(task);
        task.blockedBy = strip(task.blockedBy);
        task.blocks = strip(task.blocks);
        if (JSON.stringify(task) === before) return null;
        return writeTaskFile(path.join(dir, file), task);
      }),
  );
  // Delete the task file
  await Promise.all(doomed.map(({ file }) => fs.unlink(path.join(dir, file))));
  return [...doomedIds];
}

// API: Delete every task in a list, or with ?status=completed only the completed ones
app.delete('/api/tasks/:sessionId', async (req, res) => {
  try {
    const { status } = req.query;
    if (status !== undefined && status !== 'completed') return res.status(400).json({ error: 'Invalid status' });
    const deleted = await deleteTasks(taskDirFor(req.params.sessionId), ({ task }) => !status || task.status === status);
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Error deleting tasks:', error);
    res.status(500).json({ error: 'Failed to delete tasks' });
  }
});

// #endregion

// #region PREVIEW
// API: File preview — read file and broadcast to clients
// `text` files are shown as source, highlighted by extension, so the value doubles as
// the hljs language name where the two differ. An allowlist rather than byte sniffing:
// the client puts the whole response in the DOM, and a mislabelled binary would land
// there as megabytes of mojibake.
const PREVIEW_TEXT_EXTS =
  'txt log csv tsv json jsonl ndjson yml yaml toml ini cfg conf env js mjs cjs ts tsx jsx py rb go rs java kt cs c h cpp hpp php pl lua sh bash zsh ps1 psm1 bat cmd sql graphql css scss less xml svg patch diff';
// Served as bytes by GET /api/preview/image, so the NUL sniff below does not apply.
const PREVIEW_IMAGE_EXTS = 'png jpg jpeg gif webp avif bmp';
const PREVIEW_KINDS = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  ...Object.fromEntries(PREVIEW_TEXT_EXTS.split(' ').map((ext) => [`.${ext}`, 'text'])),
  ...Object.fromEntries(PREVIEW_IMAGE_EXTS.split(' ').map((ext) => [`.${ext}`, 'image'])),
};
// A scratchpad collects files whose real extension is buried under a trailing one —
// report.html.before, app.js.map, config.env.local, page.html~. One hop past an
// extension the allowlist does not know asks the question that actually decides the
// kind, "is the extension under it previewable", instead of enumerating the suffix
// conventions a session might invent. Compressed suffixes stop the hop: the bytes
// beneath them are binary, which is what the allowlist exists to keep out of the DOM.
const PREVIEW_OPAQUE_EXTS = new Set(['.gz', '.br', '.zst', '.xz', '.bz2', '.zip', '.7z']);

function previewExtFor(absPath) {
  const trimmed = absPath.replace(/~+$/, '');
  const ext = path.extname(trimmed).toLowerCase();
  if (PREVIEW_KINDS[ext] || !ext || PREVIEW_OPAQUE_EXTS.has(ext)) return ext;
  return path.extname(trimmed.slice(0, -ext.length)).toLowerCase();
}

function previewKindFor(absPath) {
  return PREVIEW_KINDS[previewExtFor(absPath)] || null;
}

// The hop makes a claim about bytes from a name, and PREVIEW_OPAQUE_EXTS can only stop
// it for suffixes it already knows: report.json.gpg, notes.md.enc and secrets.yml.age
// all hop to the extension underneath and would render their ciphertext. Enumerating
// the encryption conventions fails open the same way, so the claim is confirmed against
// the bytes instead — a NUL in the head is git's test for "not text", and encrypted or
// compressed output trips it immediately.
const TEXT_SNIFF_BYTES = 8192;

async function readHead(absPath) {
  const fh = await fs.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(TEXT_SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, TEXT_SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function confirmKind(absPath, kind) {
  if (!kind) return null;
  return (await readHead(absPath)).includes(0) ? null : kind;
}

// Whole files are pushed into a modal, so anything huge freezes the tab regardless of kind.
const PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
// Source in a modal is for reading, not for scrolling a generated bundle.
const PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;

// Existence + kind of a file target, with the HTTP status codes both the preview and
// the link-a-file endpoints report. `kind` is null for anything the previewer can't
// render — the caller decides whether that disqualifies the path.
async function statFileTarget(absPath) {
  try {
    const stats = await fs.stat(absPath);
    if (!stats.isFile()) throw previewError(400, 'Not a file', 'not_a_file');
    const kind = previewKindFor(absPath);
    return { size: stats.size, kind: kind === 'image' ? kind : await confirmKind(absPath, kind) };
  } catch (e) {
    if (e.status) throw e;
    if (e.code === 'ENOENT') throw previewError(404, 'File not found', 'file_not_found');
    if (e.code === 'EISDIR') throw previewError(400, 'Not a file', 'not_a_file');
    throw e;
  }
}

function enforcePreviewSize(kind, size) {
  const max = kind === 'text' ? PREVIEW_TEXT_MAX_BYTES : PREVIEW_MAX_BYTES;
  if (size > max) {
    throw previewError(400, `Preview too large (${Math.round(size / 1048576)}MB, max ${max / 1048576}MB)`, 'too_large');
  }
}

// Checks the file is previewable without reading it whole — the broadcast path needs the
// validation (and its status codes) but never the content.
async function validatePreviewFile(absPath) {
  const { kind, size } = await statFileTarget(absPath);
  if (!kind) throw previewError(400, 'Not a previewable text, markdown, HTML or image file', 'not_previewable');
  enforcePreviewSize(kind, size);
  return { kind, size };
}

async function readPreviewFile(absPath) {
  const { kind, size } = await statFileTarget(absPath);
  // A kind the previewer can't render is an answer, not a failure, reported the way
  // /api/file/resolve reports it: the caller opens the file in the editor instead. A 400
  // would only reach the browser console. A size refusal stays a 400 — that one is real.
  if (!kind) return { content: null, kind: null };
  enforcePreviewSize(kind, size);
  // Images travel as bytes through GET /api/preview/image; the client builds the URL from `path`.
  if (kind === 'image') return { content: null, kind };
  const raw = await fs.readFile(absPath, 'utf8');
  if (kind !== 'html') return { content: raw, kind };
  // The client renders HTML into a `srcdoc` iframe, which has no base URL — sibling
  // assets have to travel inside the document or they never load.
  try {
    const { html, skipped } = await inlineHtmlAssets(raw, absPath);
    for (const s of skipped) {
      console.warn(`Preview: skipped inlining ${s.path} (${s.reason}, ${s.size} bytes)`);
    }
    return { content: html, kind };
  } catch (e) {
    // Inlining is an enhancement: a failure here must not cost the user the preview.
    console.error('Preview: asset inlining failed, serving as authored:', e.message);
    return { content: raw, kind };
  }
}

// Paths copied out of a browser or a slide deck carry a URL fragment
// ("deck.html#10"). Dropped only when the literal path is missing and the trimmed one
// exists, so a filename that genuinely contains '#' still resolves to itself.
function dropUrlFragment(abs) {
  const i = abs.lastIndexOf('#');
  if (i <= 0 || existsSync(abs)) return abs;
  const trimmed = abs.slice(0, i);
  return existsSync(trimmed) ? trimmed : abs;
}

function resolvePreviewPath(rawPath, base) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  // Every path entering the preview/link surface passes through here, so accepting
  // `file://` once covers /api/preview, /api/document/link and /api/file/resolve.
  const filePath = fileUrlToPath(rawPath);
  // Normalized, not passed through: a linked document is identified by its path string,
  // and `C:/a/b` typed into the link editor has to reach the same string as the `C:\a\b`
  // a server-side `path.join` produces, or the same file is linked twice.
  if (path.isAbsolute(filePath)) return dropUrlFragment(path.normalize(filePath));
  if (base && typeof base === 'string' && path.isAbsolute(base)) {
    let baseDir = base;
    try {
      if (statSync(base).isFile()) baseDir = path.dirname(base);
    } catch {
      // base doesn't exist — fall back to dirname if it looks like a file
      if (path.extname(base)) baseDir = path.dirname(base);
    }
    return dropUrlFragment(path.resolve(baseDir, filePath));
  }
  return dropUrlFragment(path.resolve(filePath));
}

// A file a pane or a plan names: the board's cwd means nothing to the caller, so a relative path needs a base.
function resolveFileTarget(raw, base) {
  const hasBase = typeof base === 'string' && path.isAbsolute(base);
  if (typeof raw !== 'string' || (!hasBase && !path.isAbsolute(fileUrlToPath(raw)))) {
    throw previewError(400, 'target must be an http(s) URL, an absolute file path, or a relative path with an absolute base', 'bad_target');
  }
  return resolvePreviewPath(raw, base);
}

app.post('/api/preview', async (req, res) => {
  try {
    const { path: filePath, sessionId, base } = req.body || {};
    if (sessionId && !isSafeId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const abs = resolvePreviewPath(filePath, base);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    // Validate here so the CLI still gets 400/404, but broadcast the path only —
    // each tab fetches the document itself instead of it being fanned out over SSE.
    await validatePreviewFile(abs);
    broadcast({ type: 'preview:open', path: abs, sessionId: sessionId || null });
    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/preview:', error);
    res.status(error.status || 500).json({ error: error.message || 'Preview failed' });
  }
});

// API: Link a file to a session's sidebar docs without opening the preview modal.
// Not extension-restricted, matching /api/file/resolve — an unpreviewable link just
// opens in the editor. Unlinking skips the stat so a deleted file can still be removed.
// An http(s) URL is linked as it is. `open` comes from `doc preview <url>`: a tab cannot
// open a URL without a click, so the tab on screen offers an Open button.
app.post('/api/document/link', async (req, res) => {
  try {
    const { path: filePath, sessionId, unlink, open } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!isSafeId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const url = linkUrl(filePath);
    const abs = url || resolvePreviewPath(filePath);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    if (!unlink && !url) await statFileTarget(abs);
    if (unlink) linkedDocs.unlink(sessionId, abs);
    else linkedDocs.link(sessionId, abs);
    broadcast({ type: 'document:link', path: abs, sessionId, unlink: !!unlink, open: !!(url && open && !unlink) });
    res.json({ success: true, path: abs, tabs: clients.size });
  } catch (error) {
    console.error('Error in /api/document/link:', error);
    res.status(error.status || 500).json({ error: error.message || 'Link failed' });
  }
});

app.get('/api/document/links', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const sessionId = req.query.session ? String(req.query.session) : null;
  res.json(sessionId ? { [sessionId]: linkedDocs.get(sessionId) } : linkedDocs.all());
});

// The browser's own unlink: it already updated its list, so this only drops the server
// copy that would bring the doc back on the next merge. No path clears the session.
app.delete('/api/document/links/:sessionId', (req, res) => {
  const raw = String(req.query.path || '');
  const filePath = linkUrl(raw) || resolvePreviewPath(raw);
  res.json({ removed: linkedDocs.unlink(req.params.sessionId, filePath) });
});

app.get('/api/session/resolve', (req, res) => {
  try {
    const idArg = (req.query.id || '').toString();
    if (!idArg) return res.status(400).json({ error: 'id is required' });
    const metadata = loadSessionMetadata();
    const ids = Object.keys(metadata);
    if (Object.hasOwn(metadata, idArg)) {
      const m = metadata[idArg];
      return res.json({ id: idArg, customTitle: m?.customTitle || null });
    }
    // A session pi-kanban just dispatched has no transcript yet, and its starter groups it at once.
    const started = dispatched.get(idArg);
    if (started) return res.json({ id: idArg, customTitle: started.name || null });
    const matches = ids.filter(id => id.startsWith(idArg));
    if (matches.length === 0) return res.status(404).json({ matches: [] });
    if (matches.length > 1) {
      return res.status(409).json({
        matches: matches.slice(0, 50).map(id => ({ id, customTitle: metadata[id]?.customTitle || null }))
      });
    }
    const id = matches[0];
    res.json({ id, customTitle: metadata[id]?.customTitle || null });
  } catch (error) {
    console.error('Error in /api/session/resolve:', error);
    res.status(500).json({ error: error.message || 'Failed' });
  }
});

app.post('/api/session/open', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
    broadcast({ type: 'session:open', id });
    res.json({ success: true, id });
  } catch (error) {
    console.error('Error in /api/session/open:', error);
    res.status(500).json({ error: error.message || 'Failed' });
  }
});

// #region SESSION_PINS
function broadcastPins(changed) {
  for (const { id, state } of changed) broadcast({ type: 'session:pin', id, state });
}

// Another board on this config dir wrote the file. The reload in each route covers a write that
// lands before the watcher fires.
chokidar.watch(PINS_FILE, { ignoreInitial: true }).on('all', (event) => {
  if (event === 'add' || event === 'change') broadcastPins(sessionPins.reload());
});

function pinsReply() {
  const { pins } = sessionPins.state();
  return { pins, items:Object.entries(pins).map(([id, state]) => ({ id, state })) };
}

function pinRoute(fn) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    broadcastPins(sessionPins.reload());
    res.json(fn(req.body || {}));
  };
}

app.post('/api/session/pin', pinRoute(({ ids, state }) => {
  broadcastPins(sessionPins.set(ids, state));
  return { success: true, ids, state };
}));

app.post('/api/session/pins/import', pinRoute((b) => {
  broadcastPins(sessionPins.importLocal(b));
  return pinsReply();
}));

app.get('/api/session/pins', pinRoute(() => pinsReply()));
// #endregion

// #region USER_GROUPS
const userGroups = createUserGroupStore(stampedJsonFile(USER_GROUPS_FILE, writeJsonAtomic));
// The watcher tells this board's pages about another board's write; the reload in each route
// covers a write that lands before the watcher fires.
chokidar.watch(USER_GROUPS_FILE, { ignoreInitial: true }).on('all', (event) => {
  if ((event === 'add' || event === 'change') && userGroups.reload()) {
    broadcast({ type: 'group:changed', rev: userGroups.state().rev });
  }
});

// A 409 is a stale rev and carries the current state, so the board needs no second read.
function groupRoute(fn) {
  return (req, res, next) => {
    userGroups.reload();
    const before = userGroups.state().rev;
    let out;
    try {
      out = fn(req.body || {}, req.params);
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ error: e.message, ...userGroups.state() });
      return next(e);
    }
    res.json(out);
    if (out.rev !== before) broadcast({ type: 'group:changed', rev: out.rev });
  };
}

app.get('/api/groups', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  userGroups.reload();
  res.json(userGroups.state());
});
app.post('/api/groups', groupRoute((b) => userGroups.create(b)));
app.put('/api/groups', groupRoute((b) => userGroups.replace(b)));
app.post('/api/groups/import', groupRoute((b) => userGroups.importLocal(b)));
app.post('/api/groups/ungroup', groupRoute((b) => userGroups.ungroup(b)));
app.patch('/api/groups/:id', groupRoute((b, p) => userGroups.update(p.id, b)));
app.delete('/api/groups/:id', groupRoute((_b, p) => userGroups.remove(p.id)));
app.put('/api/groups/:id/members', groupRoute((b, p) => userGroups.place(p.id, b)));
app.post('/api/groups/path', groupRoute((b) => userGroups.createPath(b.path, b.transient === true)));
app.post('/api/groups/rename', groupRoute((b) => userGroups.rename(b.group, b.name)));
app.post('/api/groups/remove', groupRoute((b) => userGroups.removeByKey(b.group)));
app.post('/api/groups/prune', groupRoute((b) => {
  const known = loadSessionMetadata();
  return userGroups.prune({ dryRun: b.dryRun === true, isLive: liveGroupMember((id) => !!known[id]) });
}));
// `keep` is the ids of `/api/sessions?filter=active&limit=all`: the Active rule lives in that route.
// `hide` is the ids dismissed on the board: hidden there even while their terminal runs, unless pinned.
app.post('/api/groups/clean', groupRoute((b) => {
  if (!Array.isArray(b.keep)) throw previewError(400, 'keep must be an array of session ids');
  const keep = new Set(b.keep);
  const hide = new Set(Array.isArray(b.hide) ? b.hide : []);
  const pins = sessionPins.state().pins;
  const live = liveGroupMember((id) => keep.has(id));
  const isVisible = (m) => (Object.hasOwn(pins, m.ref) || !hide.has(m.ref)) && live(m);
  return userGroups.clean({ group: b.group ?? null, dryRun: b.dryRun === true, isVisible });
}));

// A session that runs in the terminal or is still starting has no transcript yet.
function liveGroupMember(isKnown) {
  const live = new Set([...terminal.ids(), ...Object.keys(sessionPins.state().pins)]);
  return (m) => m.type !== 'session' || isKnown(m.ref) || live.has(m.ref);
}

// Members dead in the previous sweep too, which is the grace period: a member has no timestamp.
let groupMembersDead = new Set();
function expireGroupMembers(known) {
  if (!known) return { members: 0, groups: 0 };
  const isLive = liveGroupMember((id) => known.has(id));
  const dead = new Set();
  userGroups.reload();
  const out = userGroups.expire((m) => {
    if (isLive(m)) return false;
    dead.add(m.ref);
    return groupMembersDead.has(m.ref);
  });
  groupMembersDead = dead;
  if (out.members) broadcast({ type: 'group:changed', rev: out.rev });
  return out;
}
// `with` names another session; its project is keyed as the board keys it, by the worktree's repo.
function groupPeer(id) {
  const meta = loadSessionMetadata()[id];
  if (!meta) throw previewError(404, `no session ${id}`);
  return {
    ref: id,
    project: sessionProjectKey({ project: meta.project, worktree: worktrees.resolve(meta.project) }),
    name: getSessionDisplayName(meta) || `Session ${id.slice(0, 8)}`,
  };
}
app.post('/api/sessions/:id/group', groupRoute((b, p) =>
  userGroups.groupSession(p.id, { ...b, peer: typeof b.with === 'string' ? groupPeer(b.with) : undefined })));
// #endregion

app.get('/api/preview', async (req, res) => {
  const abs = resolvePreviewPath(req.query.path, req.query.base);
  if (!abs) return res.status(400).json({ error: 'path is required' });
  try {
    const { content, kind } = await readPreviewFile(abs);
    res.json({ path: abs, exists: true, content, kind });
  } catch (error) {
    // Reported the way /api/file/resolve reports it: a relative link inside a rendered
    // document is followed without knowing the target is there, so a link to a deleted
    // file would put a 404 in the browser console. The caller toasts it from `exists`.
    if (error.status === 404) return res.json({ path: abs, exists: false, content: null, kind: null });
    // A previewError carries the status it wants reported and is an answer, not a
    // failure — a missing file or one too large to render is the user's doing.
    if (!error.status) console.error('Error in GET /api/preview:', error);
    res.status(error.status || 500).json({ error: error.message || 'Preview failed' });
  }
});

app.get('/api/preview/image', async (req, res) => {
  const abs = resolvePreviewPath(req.query.path, req.query.base);
  if (!abs) return res.status(400).json({ error: 'path is required' });
  try {
    const { kind } = await statFileTarget(abs);
    if (kind !== 'image') throw previewError(400, 'Not an image');
    res.type(MIME_BY_EXT[previewExtFor(abs)]);
    res.sendFile(abs);
  } catch (error) {
    if (!error.status) console.error('Error in GET /api/preview/image:', error);
    res.status(error.status || 500).json({ error: error.message || 'Preview failed' });
  }
});

// API: Resolve a hand-typed path to an absolute one, reporting whether it exists and
// what it is. Deliberately not extension-restricted — a linked file the previewer can't
// render (kind: null) is still linkable, the client just opens it in the editor instead.
app.get('/api/file/resolve', async (req, res) => {
  const abs = resolvePreviewPath(req.query.path, req.query.base);
  if (!abs) return res.status(400).json({ error: 'path is required' });
  try {
    // No size cap here — an unpreviewable file of any size is still linkable.
    res.json({ path: abs, exists: true, ...(await statFileTarget(abs)) });
  } catch (error) {
    // A path that is not there is an answer, not a transport failure: a linked-doc row
    // classifies its file through this endpoint, so a file since deleted would put a 404
    // in the browser console on every render. The link editor reports it from `exists`.
    if (error.status === 404) return res.json({ path: abs, exists: false, kind: null });
    console.error('Error in GET /api/file/resolve:', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to resolve file' });
  }
});

// #endregion

// #region PANES
// Tabs next to Board in a session view. Each change broadcasts the whole layout with its rev,
// so a tab replaces its copy when the rev is newer instead of applying a diff. Another board
// on the same config dir writes the same file; the watcher broadcasts its changes here.
const panesFileStamp = () => {
  try {
    const s = statSync(PANES_FILE);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
};
let panesStamp;
// File panes render the file once; this watch tells the boards when one changes. An editor
// or an agent often saves several times in a row, so each path waits for a quiet 200 ms.
const paneFileWatcher = chokidar.watch([], { ignoreInitial: true });
const paneFileTimers = new Map();
let paneFilesWatched = new Set();
let paneFileWatchQueued = false;
const panes = createPaneStore({
  load: () => {
    const stamp = panesFileStamp();
    if (stamp === panesStamp) return undefined;
    panesStamp = stamp;
    return readJsonOrNull(PANES_FILE);
  },
  save: (data) => {
    writeJsonAtomicOrLog(PANES_FILE, data);
    panesStamp = panesFileStamp();
  },
  onChange: (sessionId, layout) => {
    broadcast({ type: 'pane:changed', sessionId, layout });
    queuePaneFileWatch();
  },
});

// Deferred: the store's first load reports changes before `panes` is assigned, and a reload
// reports each changed session, which one sync covers.
function queuePaneFileWatch() {
  if (paneFileWatchQueued) return;
  paneFileWatchQueued = true;
  setImmediate(() => {
    paneFileWatchQueued = false;
    const next = panes.fileTargets();
    const added = [...next].filter((p) => !paneFilesWatched.has(p));
    const gone = [...paneFilesWatched].filter((p) => !next.has(p));
    if (added.length) paneFileWatcher.add(added);
    if (gone.length) paneFileWatcher.unwatch(gone);
    paneFilesWatched = next;
  });
}
paneFileWatcher.on('all', (event, filePath) => {
  if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
  clearTimeout(paneFileTimers.get(filePath));
  paneFileTimers.set(
    filePath,
    setTimeout(() => {
      paneFileTimers.delete(filePath);
      broadcast({ type: 'pane:file-changed', path: filePath });
    }, 200),
  );
});
chokidar.watch(PANES_FILE, { ignoreInitial: true }).on('all', (event) => {
  if (event === 'add' || event === 'change') panes.reload();
});

let boardPort = null;
const boardHosts = [...net.ALLOWED_HOSTS.split(','), net.EXPOSED ? net.BIND_HOST : '']
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function paneRouteError(res, error, what) {
  if (!error.status) console.error(`Error in ${what}:`, error);
  const code = error.status ? error.code : 'internal';
  res.status(error.status || 500).json({ error: error.message || `${what} failed`, code });
}

async function resolvePaneTarget(target, base) {
  const url = linkUrl(target);
  if (url) {
    if (isOwnOrigin(url, { boardPort, boardHosts })) {
      throw previewError(400, 'A pane cannot show the board itself', 'own_origin');
    }
    return { kind: 'url', target: url };
  }
  const abs = resolveFileTarget(target, base);
  const { kind } = await validatePreviewFile(abs);
  return { kind, target: await fs.realpath(abs) };
}

app.get('/api/panes/:sessionId', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(panes.get(req.params.sessionId));
});

app.post('/api/panes/:sessionId', async (req, res) => {
  try {
    const { target, base, title, kind, show, companion } = req.body || {};
    if (companion != null) {
      // The pane keeps the tool's own URL for this session, which only a started tool can give.
      const entry = await startCompanion(req, companion);
      const pane = { kind: 'url', target: companionHost.url(entry, req.params.sessionId), title: title || companion, companion };
      return res.json(panes.add(req.params.sessionId, pane));
    }
    if (typeof target !== 'string' || !target) throw previewError(400, 'target is required', 'bad_target');
    // A message target is a session log message id, which the board resolves when it shows the pane.
    const resolved = kind === 'message' ? { kind, target } : await resolvePaneTarget(target, base);
    res.json(panes.add(req.params.sessionId, { ...resolved, title, show: show === true }));
  } catch (error) {
    paneRouteError(res, error, 'POST /api/panes');
  }
});

app.patch('/api/panes/:sessionId', (req, res) => {
  try {
    res.json({ layout: panes.reorder(req.params.sessionId, req.body?.order) });
  } catch (error) {
    paneRouteError(res, error, 'PATCH /api/panes');
  }
});

// Probes only a pane's own target, so the route cannot fetch an arbitrary URL. `ancestors` is
// the comma-separated origins above the frame, starting with the board's page origin. The CLI
// has no page, so without it the board's own origin stands in.
app.get('/api/panes/:sessionId/:paneId/framing', async (req, res) => {
  try {
    const { sessionId, paneId } = req.params;
    const pane = panes.get(sessionId).panes.find((p) => p.id === paneId && p.kind === 'url');
    if (!pane) throw previewError(404, `No URL pane ${paneId} in session ${sessionId}`, 'no_pane');
    const ancestors = String(req.query.ancestors || `http://localhost:${boardPort}`)
      .split(',')
      .slice(0, 5)
      .filter((o) => parseOrigin(o));
    if (!ancestors.length) throw previewError(400, 'ancestors must name at least one http(s) origin', 'bad_ancestors');
    res.json({ frameable: await probeFraming(pane.target, ancestors) });
  } catch (error) {
    paneRouteError(res, error, 'GET /api/panes/framing');
  }
});

app.patch('/api/panes/:sessionId/:paneId', (req, res) => {
  try {
    const { sessionId, paneId } = req.params;
    const title = req.body?.title;
    if (typeof title !== 'string') throw previewError(400, 'title must be a string', 'bad_title');
    const layout = panes.rename(sessionId, paneId, title);
    if (!layout) throw previewError(404, `No pane ${paneId} in session ${sessionId}`, 'no_pane');
    res.json({ layout });
  } catch (error) {
    paneRouteError(res, error, 'PATCH /api/panes/:paneId');
  }
});

app.delete('/api/panes/:sessionId/:paneId', (req, res) => {
  const { sessionId, paneId } = req.params;
  const layout = panes.remove(sessionId, paneId);
  if (!layout) return res.status(404).json({ error: `No pane ${paneId} in session ${sessionId}`, code: 'no_pane' });
  res.json({ layout });
});
// #endregion

// #region REVIEW
// API: Send review comments on something the board shows (a file preview today) to a
// session. The source is described, not interpreted, so a new kind of preview needs a
// client change only. The batch is always written to a file: the doorbell is lossy and
// carries one line, and the file is what each route points at.
const REVIEW_DIR = path.join(PK_DIR, 'reviews');

// `<ts>.pending` holds the doorbell line of a review the mod has not acked yet.
configureSessionEvents({
  onDelivered: (entry) => fs.unlink(entry.marker).catch(() => {}),
  restore: async (sessionId) => {
    if (!isUUID(sessionId)) return [];
    const dir = path.join(REVIEW_DIR, sessionId);
    const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.pending')).sort();
    const lines = [];
    for (const name of names) {
      const marker = path.join(dir, name);
      const text = await fs.readFile(marker, 'utf8').catch(() => '');
      if (text) lines.push({ text, marker });
    }
    return lines;
  },
});
const REVIEW_MAX_COMMENTS = 50;
const REVIEW_MAX_CHARS = 4000;

function parseReviewBody(body) {
  const { source, comments } = body || {};
  const src = parseReviewSource(source);
  if (!Array.isArray(comments) || !comments.length || comments.length > REVIEW_MAX_COMMENTS) {
    throw previewError(400, `comments must hold 1 to ${REVIEW_MAX_COMMENTS} items`);
  }
  const field = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);
  // Element and selector are printed inside a markdown code span.
  const code = (v, max) => field(v, max)?.replace(/`/g, "'") || null;
  const items = comments.map((c) => ({
    quote: String(c?.quote || '').trim().slice(0, REVIEW_MAX_CHARS),
    comment: String(c?.comment || '').trim().slice(0, REVIEW_MAX_CHARS),
    heading: field(c?.heading, 200),
    line: Number.isInteger(c?.line) && c.line > 0 ? c.line : null,
    element: code(c?.element, 300),
    selector: code(c?.selector, 500),
  }));
  if (items.some((c) => !c.comment)) throw previewError(400, 'every comment needs text');
  return { ...src, items };
}

async function resolveReviewSource(src) {
  if (src.kind !== 'file') return;
  src.path = resolvePreviewPath(src.path);
  if (!src.path) throw previewError(400, 'source.path is required for a file');
  await statFileTarget(src.path);
}

function formatReviewMarkdown(src, items) {
  const parts = [
    `# Review of ${src.path || src.label}`,
    '',
    `Each comment is the user's instruction about the quoted text.${src.path ? ' A quote missing from the source means the source changed after the review: say so.' : ''}`,
  ];
  if (src.locate) parts.push('', src.locate);
  items.forEach((c, i) => {
    const where = [c.line && `line ${c.line}`, c.heading && `under "${c.heading}"`].filter(Boolean).join(', ');
    parts.push('', `## ${i + 1}${where ? ` (${where})` : ''}`, '');
    if (c.element) parts.push(`Element: \`${c.element}\`${c.selector ? ` at \`${c.selector}\`` : ''}`, '');
    if (c.quote) parts.push(...c.quote.split(/\r?\n/).map((l) => `> ${l}`), '');
    parts.push(c.comment);
  });
  return `${parts.join('\n')}\n`;
}

function isWaitingOnUser(sessionId) {
  const meta = loadSessionMetadata()[sessionId] || {};
  return !!checkWaitingForUser(path.join(AGENT_ACTIVITY_DIR, sessionId), getSessionLogStat(meta).mtime);
}

app.post('/api/sessions/:sessionId/review', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    if (!isUUID(sessionId)) return res.status(400).json({ error: 'invalid session id' });
    const src = parseReviewBody(req.body);
    await resolveReviewSource(src);
    const markdown = formatReviewMarkdown(src, src.items);
    const file = await writeReviewFile(sessionId, markdown);
    const delivered = await deliverReviewFile(req, sessionId, file, {
      line: formatReviewSubmitted(src.items.length, src.label, file),
      paste: `Address my review comments on ${src.label}: ${file}`,
    });
    res.json({ delivered, file, markdown });
  } catch (error) {
    if (!error.status) console.error('Error in POST /api/sessions/:id/review:', error);
    res.status(error.status || 500).json({ error: error.message || 'Review failed' });
  }
});

// A button or form in an HTML preview, sent by the board after the user's click. The file goes in
// REVIEW_DIR, so a review's restore and retention cover it.
app.post('/api/sessions/:sessionId/action', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    if (!isUUID(sessionId)) return res.status(400).json({ error: 'invalid session id' });
    const act = parseActionBody(req.body);
    await resolveReviewSource(act.src);
    const markdown = formatActionMarkdown(act);
    const file = await writeReviewFile(sessionId, markdown);
    const delivered = await deliverReviewFile(req, sessionId, file, {
      line: formatActionSubmitted(act.action, act.src.label, file),
      paste: `Act on my answer "${act.action}" on ${act.src.label}: ${file}`,
    });
    res.json({ delivered, file, markdown });
  } catch (error) {
    if (!error.status) console.error('Error in POST /api/sessions/:id/action:', error);
    res.status(error.status || 500).json({ error: error.message || 'Action failed' });
  }
});

async function writeReviewFile(sessionId, markdown) {
  const dir = path.join(REVIEW_DIR, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}.md`);
  await fs.writeFile(file, markdown);
  return file;
}

async function deliverReviewFile(req, sessionId, file, { line, paste }) {
  if (boardEventsEnabled() && hasDoorbell(sessionId)) {
    const marker = file.replace(/\.md$/, '.pending');
    await fs.writeFile(marker, line);
    enqueueSessionEvent(sessionId, line, { marker });
    return 'doorbell';
  }
  if (
    terminal.authorized(req.get('x-terminal-token')) &&
    terminal.isRunning(sessionId) &&
    !isWaitingOnUser(sessionId) &&
    (await terminal.paste(sessionId, paste))
  ) {
    return 'terminal';
  }
  return null;
}

// #endregion

// #region SSE
// SSE endpoint for live updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  clients.add(res);
  console.log(`[SSE] Client connected (total: ${clients.size})`);

  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[SSE] Client disconnected (total: ${clients.size})`);
  });

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
});

// Broadcast update to all SSE clients
function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (res.headersSent || !req.path.startsWith('/api/')) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error(`Error in ${req.method} ${req.path}:`, err);
  res.status(status).json({ error: status >= 500 && !err.expose ? 'Internal error' : err.message });
});

// Watch for file changes (chokidar handles non-existent paths)
const watcher = chokidar.watch(TASKS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2
});

watcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.json')) {
    const relativePath = path.relative(TASKS_DIR, filePath);
    const dirName = relativePath.split(path.sep)[0];

    taskCountsCache.delete(path.join(TASKS_DIR, dirName));

    broadcastToMappedSessions(dirName, event, filePath);
  }
});

// Which sessions own a task directory. Usually the dir name IS the session id, but a
// shared list is one directory several sessions map onto -- so anything
// addressing a session from a task path has to fan out the same way. One resolver for
// both readers of that mapping: the SSE broadcast and the doorbell.
// #endregion

// #region DOORBELL
function resolveSessionsForTaskDir(name) {
  if (isUUID(name)) return [name];
  const { listToSessions } = loadAllTaskMaps();
  const map = listToSessions[name];
  return map ? Object.keys(map) : [];
}

function broadcastToMappedSessions(taskListName, event, filePath) {
  for (const sid of resolveSessionsForTaskDir(taskListName)) {
    broadcast({ type: 'update', event, sessionId: sid, file: path.basename(filePath) });
  }
}

console.log(`Watching for changes in: ${TASKS_DIR}`);

// Watch task maps directory for session→task-list mapping changes
const taskMapsWatcher = chokidar.watch(TASK_MAPS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 1
});
taskMapsWatcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.json')) {
    lastTaskMapScan = 0;
    const taskListName = path.basename(filePath, '.json');
    taskCountsCache.delete(path.join(TASKS_DIR, taskListName));
    broadcastToMappedSessions(taskListName, event, filePath);
  }
});

const onSessionFileEvent = (event, filePath) => {
  if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
  if (!filePath.endsWith('.jsonl')) return;
  // add/unlink reshape the session set — promote to full rescan.
  if (event === 'change') dirtyMetadataPaths.add(filePath);
  else metadataNeedsFullScan = true;
  broadcast({ type: 'metadata-update' });
};

const projectsWatchers = new Map();

// Returns the roots that were not scanned before.
function syncSessionRoots(cwds) {
  const roots = rootsFor(cwds);
  const added = roots.filter((r) => !projectsWatchers.has(r.dir));
  SESSION_OPTS.roots = roots;
  watchSessionRoots();
  return added;
}

function watchSessionRoots() {
  const want = new Set(SESSION_OPTS.roots.map((r) => r.dir));
  for (const [dir, watcher] of projectsWatchers) {
    if (want.has(dir)) continue;
    watcher.close();
    projectsWatchers.delete(dir);
  }
  for (const root of SESSION_OPTS.roots) {
    if (projectsWatchers.has(root.dir)) continue;
    projectsWatchers.set(root.dir, chokidar.watch(root.dir, {
      persistent: true,
      ignoreInitial: true,
      depth: root.flat ? 0 : 1,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    }).on('all', onSessionFileEvent));
  }
}
watchSessionRoots();

// libuv aborts the process when a directory it watches on Windows is named in 8.3 short form
// (src/win/fs-event.c asserts that the changed file's name starts with the watched dir), and
// chokidar watches the parent dir of a plan file that is gone. Plans saved by older boards can
// name short paths, so the watcher gets only long ones.
const plansWatcher = chokidar.watch(planPaths().map(realpathDeepest), {
  persistent: true,
  ignoreInitial: true,
});

plansWatcher.on('all', (event) => {
  // Plan files don't affect cached session metadata — getPlanInfo is called
  // fresh from buildSessionObject on every list build. The broadcast alone
  // is enough to trigger a client refetch.
  broadcast({ type: 'metadata-update' });
  if (event === 'change') broadcast({ type: 'plan-update' });
});

// Watch agent-activity directory for subagent lifecycle events
const agentActivityWatcher = chokidar.watch(AGENT_ACTIVITY_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2,
  awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
});

const AGENT_FILE_CAP = 20;

agentActivityWatcher.on('all', (event, filePath) => {
  const base = path.basename(filePath);
  const isAgentEvent = filePath.endsWith('.jsonl') || base === '_waiting.json' || base === '_stop.json';
  if ((event === 'add' || event === 'change' || event === 'unlink') && isAgentEvent) {
    const relativePath = path.relative(AGENT_ACTIVITY_DIR, filePath);
    const sessionId = relativePath.split(path.sep)[0];
    // Cleanup: if session dir exceeds cap, delete oldest files by mtime
    if (event === 'add' && filePath.endsWith('.jsonl')) {
      try {
        const sessionDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
        const files = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'));
        if (files.length > AGENT_FILE_CAP) {
          const withStats = files.map(f => {
            const fp = path.join(sessionDir, f);
            return { file: fp, mtime: statSync(fp).mtimeMs };
          }).sort((a, b) => a.mtime - b.mtime);
          const toDelete = withStats.slice(0, files.length - AGENT_FILE_CAP);
          for (const { file } of toDelete) {
            fs.unlink(file).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
    const unreadOnly = base === '_stop.json';
    broadcast({ type: 'agent-update', sessionId, unreadOnly });
  }
});

// #endregion

// #region CLEANUP
async function cleanupAgentActivity() {
  try {
    const entries = await fs.readdir(AGENT_ACTIVITY_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(AGENT_ACTIVITY_DIR, entry.name);
      // Map files are rewritten in place, so the dir mtime does not track their use.
      if (dirPath === TASK_MAPS_DIR) continue;
      try {
        const contents = await fs.readdir(dirPath);
        const stat = await fs.stat(dirPath);
        const age = now - stat.mtimeMs;
        if ((contents.length === 0 && age > AGENT_STALE_MS) || age > CLEANUP_MAX_AGE_MS) {
          await fs.rm(dirPath, { recursive: true, force: true });
          continue;
        }
        // Mods cannot delete files, so every decision file is swept here. The mod
        // waits at most PERMISSION_TTL_MS, so anything older is unclaimable.
        for (const f of contents) {
          if (!isDecisionFile(f)) continue;
          const fp = path.join(dirPath, f);
          try {
            const fst = await fs.stat(fp);
            if (now - fst.mtimeMs > PERMISSION_TTL_MS) await fs.rm(fp, { force: true });
          } catch { /* ignore per-file errors */ }
        }
      } catch { /* ignore per-folder errors */ }
    }
  } catch { /* agent-activity dir may not exist */ }
}

// Dispatch markers, pane layouts, reviews, attachments and worktrees: see docs/retention.md.
async function runRetention() {
  try {
    const scan = scanSessionIds(SESSION_OPTS);
    const opts = { known: scan?.ids, maxAgeMs: retentionMs(PI_AGENT_DIR) };
    const markers = dispatched.prune(opts);
    const layouts = panes.prune(opts);
    if (layouts) queuePaneFileWatch();
    const reviews = await pruneSessionDirs(REVIEW_DIR, opts);
    const attachments = await pruneSessionDirs(ATTACHMENTS_DIR, opts);
    const wts = worktrees.prune(scan?.dirs);
    const taskMaps = await pruneTaskMaps(TASK_MAPS_DIR, opts);
    const grouped = expireGroupMembers(scan?.ids);
    if (markers || layouts || reviews || attachments || wts || taskMaps || grouped.members) {
      console.log(`[retention] removed ${markers} dispatch markers, ${layouts} pane layouts, ${reviews} reviews, ${attachments} attachments, ${wts} worktrees, ${taskMaps} task-list mappings, ${grouped.members} group members, ${grouped.groups} groups`);
    }
  } catch (e) {
    console.warn('[retention] failed:', e.message);
  }
}

cleanupAgentActivity();
setInterval(cleanupAgentActivity, CLEANUP_INTERVAL_MS);
// Later than the startup scan and prewarm, so the first sweep never competes with them.
setTimeout(() => {
  runRetention();
  setInterval(runRetention, CLEANUP_INTERVAL_MS);
}, RETENTION_FIRST_RUN_MS);

// Warm the metadata cache in the background so the first user
// request lands warm. The cheap-probe in /api/sessions skips per-session
// enrichment for inactive sessions, so we no longer drive a full self-request
// here — that was 690× wasted work for an active-filter first hit.
// Started on the ready line, the full read of every transcript competes for disk and CPU with
// the first page load and slows it. It starts after the first list is sent, or after the
// fallback when no client asks.
const PREWARM_FALLBACK_MS = 5000;
const SESSION_CACHE_SAVE_MS = 30000;
const persistSessionCache = () => saveSessionCache((data) => writeJsonAtomicOrLog(SESSION_CACHE_FILE, data));
let prewarmStarted = false;
function startPrewarm() {
  if (prewarmStarted) return;
  prewarmStarted = true;
  setImmediate(prewarmCaches);
}

function prewarmCaches() {
  const t0 = Date.now();
  try {
    const metadata = loadSessionMetadata();
    console.log(`[prewarm] done in ${Date.now() - t0}ms (${Object.keys(metadata).length} sessions)`);
    persistSessionCache();
  } catch (e) {
    console.warn('[prewarm] failed:', e.message);
  }
}

  const onReady = (actualPort) => {
    boardPort = Number(actualPort);
    terminal.setServerUrl(`http://127.0.0.1:${actualPort}`);
    // The port is configurable and falls back to a random one when taken, so the doorbell
    // mod cannot assume it -- publish the live one where it can read it.
    writeServerInfo(actualPort);
    writeTerminalToken(actualPort);
    console.log(`pi-kanban running at http://localhost:${actualPort}`);
    setInterval(() => reclaimServerInfo(actualPort), 30000).unref();
    migrateLegacyApprovalsConfig();
    const warning = net.exposureWarning();
    if (warning) console.log(warning);
    terminal.started.then((terminalReason) => {
      if (terminalReason && terminalReason !== 'disabled') console.log(`Terminal unavailable: ${terminalReason}`);
      if (!terminalReason) {
        console.log(`Terminal enabled - open http://localhost:${actualPort}/#t=${terminal.token}`);
      }
    });

    if (process.argv.includes('--open')) {
      import('open').then(open => open.default(`http://localhost:${actualPort}`));
    }
    terminal.restore();
    setTimeout(startPrewarm, PREWARM_FALLBACK_MS).unref();
  };

  loadSessionCache(SESSION_CACHE_FILE);
  // Started as a child of the pi extension, the board can end by TerminateProcess on Windows,
  // where no exit handler runs, so the cache is also saved on a timer.
  setInterval(persistSessionCache, SESSION_CACHE_SAVE_MS).unref();
  process.on('exit', persistSessionCache);

  const listenOpts = { onUpgrade: terminal.handleUpgrade };
  const server = net.listenLoopback(app, PORT, onReady, listenOpts);
  process.on('exit', terminal.shutdown);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} in use, trying random port...`);
      net.listenLoopback(app, 0, onReady, listenOpts);
    } else {
      throw err;
    }
  });
}
// #endregion
