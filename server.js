#!/usr/bin/env node
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const chokidar = require('chokidar');
const open = require('open').default || require('open');
const parsers = require('./lib/pi-parsers');
const taskStore = require('./lib/task-store');
const pkg = require('./package.json');

function enrichTask(t, sessionId, project) {
  return {
    id: String(t.id),
    subject: t.subject || '',
    status: t.status || 'pending',
    description: t.description ?? null,
    sessionId,
    project,
  };
}

async function tasksForSession(sessionId, project) {
  const tasks = await taskStore.listTasksAsync(sessionId);
  return tasks.map((t) => enrichTask(t, sessionId, project));
}

async function allStoredTasks() {
  const [sids, sessionFiles] = await Promise.all([
    taskStore.listSessionIdsAsync(),
    parsers.listSessionFiles(),
  ]);
  const projectBySid = new Map();
  for (const meta of sessionFiles) {
    const slug = parsers.slugFromFile(meta.file);
    if (!projectBySid.has(slug)) projectBySid.set(slug, meta.cwd);
  }
  const groups = await Promise.all(sids.map(async (sid) => {
    const tasks = await taskStore.listTasksAsync(sid);
    if (!tasks.length) return [];
    const project = projectBySid.get(sid) || null;
    return tasks.map((t) => enrichTask(t, sid, project));
  }));
  return groups.flat();
}


const PORT = Number(process.env.PORT) || 3460;
const args = process.argv.slice(2);
const shouldOpen = args.includes('--open');

const BUILTIN_THEME_DIR = path.join(__dirname, 'themes');
const USER_THEME_DIR = process.env.KANBAN_THEME_DIR
  || path.join(os.homedir(), '.pi', 'agent', 'kanban', 'themes');
const LIGHT_THEME_ID = process.env.KANBAN_LIGHT_THEME || 'pi-light';
const DARK_THEME_ID = process.env.KANBAN_DARK_THEME || 'pi-dark';

const REQUIRED_COLOR_KEYS = [
  'bgDeep', 'bgSurface', 'bgElevated', 'bgHover',
  'border',
  'textPrimary', 'textSecondary', 'textTertiary', 'textMuted',
  'accent', 'accentText',
  'success', 'warning', 'plan',
];

const themes = new Map();

async function loadThemesFromDir(dir, builtin) {
  let entries;
  try { entries = await fsp.readdir(dir); }
  catch (e) {
    if (e.code !== 'ENOENT') console.warn(`themes: cannot read ${dir}: ${e.message}`);
    return;
  }
  const jsons = entries.filter((f) => f.toLowerCase().endsWith('.json'));
  await Promise.all(jsons.map(async (f) => {
    const full = path.join(dir, f);
    const id = f.replace(/\.json$/i, '');
    try {
      const raw = await fsp.readFile(full, 'utf8');
      const obj = JSON.parse(raw);
      if (obj.mode !== 'light' && obj.mode !== 'dark') {
        console.warn(`themes: skip ${full}: invalid mode`); return;
      }
      const colors = obj.colors || {};
      const missing = REQUIRED_COLOR_KEYS.filter((k) => typeof colors[k] !== 'string');
      if (missing.length) {
        console.warn(`themes: skip ${full}: missing colors ${missing.join(',')}`); return;
      }
      themes.set(id, {
        id,
        name: obj.name || id,
        displayName: obj.displayName || obj.name || id,
        mode: obj.mode,
        colors,
        builtin,
      });
    } catch (e) {
      console.warn(`themes: skip ${full}: ${e.message}`);
    }
  }));
}

async function loadAllThemes() {
  themes.clear();
  await loadThemesFromDir(BUILTIN_THEME_DIR, true);
  await loadThemesFromDir(USER_THEME_DIR, false);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const empty = (_req, res) => res.json([]);
const emptyObj = (_req, res) => res.json({});

app.get('/api/version', (_req, res) => res.json({ version: pkg.version, name: pkg.name }));

function resolveActiveTheme(mode) {
  const requestedId = mode === 'light' ? LIGHT_THEME_ID : DARK_THEME_ID;
  const fallbackId = mode === 'light' ? 'pi-light' : 'pi-dark';
  let t = themes.get(requestedId);
  if (t && t.mode !== mode) {
    console.warn(`themes: ${requestedId} mode=${t.mode}, expected ${mode}; using fallback`);
    t = null;
  }
  return t || themes.get(fallbackId) || null;
}

app.get('/api/themes', (_req, res) => {
  res.json({
    light: resolveActiveTheme('light'),
    dark: resolveActiveTheme('dark'),
    config: { lightId: LIGHT_THEME_ID, darkId: DARK_THEME_ID, themeDir: USER_THEME_DIR },
  });
});

app.get('/api/sessions', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const all = await parsers.listSessions();
    res.json(all.slice(0, limit));
  } catch (err) {
    console.error('listSessions error', err);
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  const meta = await parsers.findSessionFileById(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  try {
    res.json(await tasksForSession(req.params.id, meta.cwd));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/sessions/:id/summary', async (req, res) => {
  const meta = await parsers.findSessionFileById(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  try {
    res.json(await parsers.buildSessionSummary(meta));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/sessions/:id/messages', async (req, res) => {
  const meta = await parsers.findSessionFileById(req.params.id);
  if (!meta) return res.status(404).json({ messages: [], error: 'not found' });
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const before = req.query.before ? String(req.query.before) : null;
    const out = await parsers.buildMessages(meta.file, limit, before);
    out.sessionId = req.params.id;
    res.json(out);
  } catch (err) {
    res.status(500).json({ messages: [], error: String(err) });
  }
});

app.get('/api/sessions/:id/tool-result/:toolUseId', async (req, res) => {
  const meta = await parsers.findSessionFileById(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  try {
    const entries = await parsers.readSessionEntries(meta.file);
    const toolUseId = req.params.toolUseId;
    for (const e of entries) {
      if (e.type !== 'message') continue;
      const m = e.message;
      if (m && m.role === 'toolResult' && m.toolCallId === toolUseId) {
        const content = parsers.flattenContentToText(m.content);
        return res.json({ content });
      }
    }
    res.status(404).json({ error: 'tool result not found' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});


app.get('/api/sessions/:id/agents', async (req, res) => {
  const meta = await parsers.findSessionFileById(req.params.id);
  if (!meta) return res.status(404).json({ agents: [], error: 'not found' });
  try {
    const entries = await parsers.readSessionEntries(meta.file);
    const s = parsers.summarize(entries);
    const agents = await parsers.listAgentsForSession(meta, s);
    const waitingForUser = s.pendingAskUser
      ? { kind: 'question', toolName: 'AskUserQuestion', timestamp: s.pendingAskUser.timestamp }
      : null;
    res.json({ agents, waitingForUser });
  } catch (err) {
    res.status(500).json({ agents: [], error: String(err) });
  }
});

app.get('/api/sessions/:id/agents/:agentId/messages', async (req, res) => {
  const meta = await parsers.findSessionFileById(req.params.id);
  if (!meta) return res.status(404).json({ messages: [], error: 'not found' });
  try {
    const rec = await parsers.findAgentRecord(meta, req.params.agentId);
    if (!rec || !rec._sessionFile) {
      return res.json({ messages: [], agentId: req.params.agentId });
    }
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const out = await parsers.buildMessages(rec._sessionFile, limit);
    out.agentId = req.params.agentId;
    res.json(out);
  } catch (err) {
    res.status(500).json({ messages: [], error: String(err) });
  }
});

// Plan binding is browser-state: server only validates, broadcasts, and serves
// file content on demand. The browser is the source of truth for which plan
// is bound to which session (kept in localStorage), so this server has no
// in-memory store and no JSONL persistence path here.
app.get('/api/sessions/:id/plan', async (req, res) => {
  const planPath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!planPath) return res.json({});
  try {
    const stat = await fsp.stat(planPath);
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });
    const content = await fsp.readFile(planPath, 'utf8');
    res.json({ content, path: planPath });
  } catch (err) {
    res.status(404).json({ error: `plan file not readable: ${planPath}` });
  }
});

app.post('/api/session/plan', async (req, res) => {
  const { id, path: planPath, title } = req.body || {};
  if (!id || !planPath) return res.status(400).json({ error: 'id and path required' });
  try {
    const stat = await fsp.stat(planPath);
    if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });
  } catch {
    return res.status(404).json({ error: `plan file not found: ${planPath}` });
  }
  sseSend({ type: 'session:plan', id, path: planPath, title: title || null });
  res.json({ ok: true });
});

// Stubbed endpoints (later phases may fill these).
app.get('/api/tasks/all', async (_req, res) => {
  try { res.json(await allStoredTasks()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});
app.get('/api/projects', async (_req, res) => {
  try {
    const sessions = await parsers.listSessions();
    const byCwd = new Map();
    for (const s of sessions) {
      const mt = new Date(s.modifiedAt);
      const cur = byCwd.get(s.cwd);
      if (!cur || mt > cur) byCwd.set(s.cwd, mt);
    }
    const out = [...byCwd.entries()].map(([p, mt]) => ({ path: p, modifiedAt: mt.toISOString() }));
    out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get('/api/projects/:name/tasks', async (req, res) => {
  try {
    const all = await allStoredTasks();
    let decoded;
    try { decoded = Buffer.from(req.params.name, 'base64').toString('utf8'); }
    catch { decoded = parsers.decodeProjectDir(req.params.name); }
    res.json(all.filter((t) => t.project === decoded));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.delete('/api/sessions/:id/tasks/:taskId', (req, res) => {
  const { id, taskId } = req.params;
  const existing = taskStore.readTask(id, taskId);
  if (!existing) return res.status(404).json({ error: 'task not found' });
  const all = taskStore.listTasks(id);
  const blockedTasks = all
    .filter((t) => Array.isArray(t.blockedBy) && t.blockedBy.map(String).includes(String(taskId)))
    .map((t) => t.id);
  if (blockedTasks.length) {
    return res.status(400).json({ error: 'task blocks others', blockedTasks });
  }
  try {
    taskStore.deleteTask(id, taskId);
    sseSend({ type: 'task:update', sessionId: id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/context-status', emptyObj);

async function readMarkdownFile(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    const e = new Error('Only .md/.markdown files are allowed'); e.status = 400; throw e;
  }
  try { return await fsp.readFile(absPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') { const err = new Error('File not found'); err.status = 404; throw err; }
    if (e.code === 'EISDIR') { const err = new Error('Not a file'); err.status = 400; throw err; }
    throw e;
  }
}

function resolvePreviewPath(filePath, base) {
  if (!filePath || typeof filePath !== 'string') return null;
  if (filePath === '~' || filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    filePath = path.join(os.homedir(), filePath.slice(1));
  }
  if (path.isAbsolute(filePath)) return filePath;
  if (base && typeof base === 'string' && path.isAbsolute(base)) {
    let baseDir = base;
    try { if (fs.statSync(base).isFile()) baseDir = path.dirname(base); }
    catch { if (path.extname(base)) baseDir = path.dirname(base); }
    return path.resolve(baseDir, filePath);
  }
  return path.resolve(filePath);
}

app.get('/api/preview', async (req, res) => {
  try {
    const abs = resolvePreviewPath(req.query.path, req.query.base);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    const content = await readMarkdownFile(abs);
    res.json({ path: abs, content });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Preview failed' });
  }
});

app.post('/api/preview', async (req, res) => {
  try {
    const { path: filePath, sessionId, base, link } = req.body || {};
    const abs = resolvePreviewPath(filePath, base);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    const content = await readMarkdownFile(abs);
    sseSend({ type: 'preview:open', path: abs, content, sessionId: sessionId || null, link: !!link });
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Preview failed' });
  }
});

app.post('/api/session/pin', (req, res) => {
  const { id, state } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  sseSend({ type: 'session:pin', id, state: state || 'pinned' });
  res.json({ ok: true });
});

app.post('/api/session/open', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  sseSend({ type: 'session:open', id });
  res.json({ ok: true });
});

function openInEditor(...targets) {
  const editor = process.env.EDITOR || 'code';
  spawn(editor, ['-n', ...targets], { shell: true, stdio: 'ignore', detached: true }).unref();
}

app.post('/api/open-in-editor', (req, res) => {
  try {
    const { content, title, file } = req.body || {};
    if (file) { openInEditor(file); return res.json({ success: true, path: file }); }
    if (!content) return res.status(400).json({ error: 'No content provided' });
    const safeName = (title || 'message').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    const tmp = path.join(os.tmpdir(), `pi-kanban-${safeName}-${hash}.md`);
    fs.writeFileSync(tmp, content, 'utf8');
    openInEditor(tmp);
    res.json({ success: true, path: tmp });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post('/api/open-folder', (req, res) => {
  try {
    const { folder, file } = req.body || {};
    const targets = [];
    if (folder) targets.push(folder);
    if (file) targets.push(file);
    if (!targets.length) return res.status(400).json({ error: 'folder or file required' });
    openInEditor(...targets);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/sessions/:id/agents/:agentId/stop', (_req, res) => res.json({ ok: true }));

// SSE — broadcast file changes as session-changed events.
const sseClients = new Set();
function sseSend(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const r of sseClients) {
    try { r.write(payload); } catch {}
  }
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const ka = setInterval(() => res.write(': ka\n\n'), 30000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

app.get('/api/sessions/:id/agents/:agentId/messages/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  let watcherRef = null;
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 30000);
  req.on('close', () => {
    clearInterval(ka);
    if (watcherRef) { try { watcherRef.close(); } catch {} }
  });

  let meta;
  try { meta = await parsers.findSessionFileById(req.params.id); } catch { meta = null; }
  const rec = meta ? await parsers.findAgentRecord(meta, req.params.agentId).catch(() => null) : null;
  if (!rec || !rec._sessionFile) return;

  const send = async () => {
    try {
      const out = await parsers.buildMessages(rec._sessionFile, 50);
      out.agentId = req.params.agentId;
      res.write(`event: agent-log-update\ndata: ${JSON.stringify(out)}\n\n`);
    } catch {}
  };
  await send();
  watcherRef = chokidar.watch(rec._sessionFile, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcherRef.on('change', send).on('add', send);
});

const watcher = chokidar.watch(path.join(parsers.getSessionsDir(), '**/*.jsonl'), {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
});
parsers.setOnBranchResolved((cwd, branch) => {
  sseSend({ type: 'branch:resolved', cwd, branch });
});

for (const ev of ['add', 'change', 'unlink']) {
  watcher.on(ev, (f) => {
    parsers.invalidateSessionCache(f);
    sseSend({ type: 'update', sessionId: parsers.slugFromFile(f) });
  });
}

const taskWatcher = chokidar.watch(taskStore.getTasksDir(), {
  ignoreInitial: true,
  depth: 2,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
});
const tasksRoot = path.basename(taskStore.getTasksDir());
const pendingTaskSse = new Map();
function queueTaskUpdate(sid) {
  if (pendingTaskSse.has(sid)) return;
  pendingTaskSse.set(sid, setTimeout(() => {
    pendingTaskSse.delete(sid);
    sseSend({ type: 'task:update', sessionId: sid });
  }, 75));
}
taskWatcher.on('all', (_evt, file) => {
  if (!file || !file.endsWith('.json')) return;
  const sid = path.basename(path.dirname(file));
  if (sid && sid !== tasksRoot) queueTaskUpdate(sid);
});

const http = require('node:http');
const httpServer = http.createServer({ maxHeaderSize: 64 * 1024 }, app);
const server = httpServer.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`pi-kanban listening at ${url}`);
  console.log(`watching ${parsers.getSessionsDir()}`);
  await loadAllThemes();
  console.log(`themes loaded: ${themes.size} (user dir: ${USER_THEME_DIR})`);
  if (shouldOpen) open(url).catch(() => {});
});

process.on('SIGINT', () => { watcher.close(); taskWatcher.close(); server.close(() => process.exit(0)); });
