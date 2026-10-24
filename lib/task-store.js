const fs = require('node:fs');
const path = require('node:path');
const { getAgentDir } = require('./agent-dir');

const TASKS_DIR = path.join(getAgentDir(), 'kanban', 'tasks');

function getTasksDir() {
  return TASKS_DIR;
}

function sessionDir(sessionId) {
  return path.join(TASKS_DIR, sessionId);
}

function taskPath(sessionId, taskId) {
  return path.join(sessionDir(sessionId), `${taskId}.json`);
}

function readTask(sessionId, taskId) {
  try {
    const raw = fs.readFileSync(taskPath(sessionId, taskId), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function listSessionIdsAsync() {
  try { return await fs.promises.readdir(TASKS_DIR); }
  catch { return []; }
}

function listTasks(sessionId) {
  const dir = sessionDir(sessionId);
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch { return []; }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      out.push(JSON.parse(raw));
    } catch {}
  }
  return out;
}

async function listTasksAsync(sessionId) {
  const dir = sessionDir(sessionId);
  let entries;
  try { entries = await fs.promises.readdir(dir); }
  catch { return []; }
  const jsons = entries.filter((n) => n.endsWith('.json'));
  const tasks = await Promise.all(jsons.map(async (name) => {
    try {
      const raw = await fs.promises.readFile(path.join(dir, name), 'utf8');
      return JSON.parse(raw);
    } catch { return null; }
  }));
  return tasks.filter(Boolean);
}

function writeTask(sessionId, task) {
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `${task.id}.json`);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, final);
}

function deleteTask(sessionId, taskId) {
  try { fs.unlinkSync(taskPath(sessionId, taskId)); return true; }
  catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

const ids = (list) => (Array.isArray(list) ? list.map(String) : []);

function normalizeTask(snapTask, existing, blocks = []) {
  const e = existing || {};
  return {
    id: String(snapTask.id),
    subject: snapTask.subject ?? snapTask.text ?? '',
    description: snapTask.description ?? null,
    activeForm: snapTask.activeForm ?? e.activeForm ?? null,
    status: snapTask.status ?? 'pending',
    blocks,
    blockedBy: ids(snapTask.blockedBy),
  };
}

const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

function tasksEqual(a, b) {
  return a.subject === b.subject
    && a.description === b.description
    && a.activeForm === b.activeForm
    && a.status === b.status
    && sameIds(a.blocks, b.blocks)
    && sameIds(a.blockedBy, b.blockedBy);
}

function cleanupIfAllCompleted(sessionId) {
  if (!sessionId) return false;
  const tasks = listTasks(sessionId);
  if (!tasks.length) return false;
  const live = tasks.filter((t) => t.status !== 'deleted');
  if (!live.length) return false;
  if (!live.every((t) => t.status === 'completed')) return false;
  const dir = sessionDir(sessionId);
  for (const t of tasks) {
    try { fs.unlinkSync(path.join(dir, `${t.id}.json`)); } catch {}
  }
  try { fs.rmdirSync(dir); } catch {}
  return true;
}

function reconcileFromSnapshot(sessionId, snapshot) {
  if (!sessionId || !Array.isArray(snapshot)) return;
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });

  // rpiv-todo keeps a deleted task as a tombstone; the board has no deleted status, so it gets no file.
  const live = snapshot.filter((t) => t != null && t.id !== undefined && t.id !== null && t.status !== 'deleted');
  const blocks = new Map();
  for (const t of live) {
    for (const dep of ids(t.blockedBy)) {
      if (!blocks.has(dep)) blocks.set(dep, []);
      blocks.get(dep).push(String(t.id));
    }
  }

  const seen = new Set();
  for (const t of live) {
    const id = String(t.id);
    seen.add(id);
    const existing = readTask(sessionId, id);
    const merged = normalizeTask(t, existing, blocks.get(id) || []);
    if (existing && tasksEqual(existing, merged)) continue;
    writeTask(sessionId, merged);
  }

  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (seen.has(id)) continue;
    try { fs.unlinkSync(path.join(dir, name)); } catch {}
  }
}

module.exports = {
  getTasksDir,
  sessionDir,
  listSessionIdsAsync,
  listTasks,
  listTasksAsync,
  readTask,
  writeTask,
  deleteTask,
  reconcileFromSnapshot,
  cleanupIfAllCompleted,
};
