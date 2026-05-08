const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PI_DIR = process.env.PI_DIR || path.join(os.homedir(), '.pi');
const TASKS_DIR = path.join(PI_DIR, 'agent', 'kanban', 'tasks');

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

function listSessionIds() {
  try { return fs.readdirSync(TASKS_DIR); }
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

function normalizeTask(snapTask, existing) {
  const e = existing || {};
  return {
    id: String(snapTask.id),
    subject: snapTask.subject ?? snapTask.text ?? '',
    description: snapTask.description ?? null,
    activeForm: snapTask.activeForm ?? e.activeForm ?? null,
    status: snapTask.status ?? 'pending',
    blocks: Array.isArray(e.blocks) ? e.blocks : [],
    blockedBy: Array.isArray(e.blockedBy) ? e.blockedBy : [],
  };
}

function tasksEqual(a, b) {
  return a.subject === b.subject
    && a.description === b.description
    && a.activeForm === b.activeForm
    && a.status === b.status;
}

function cleanupIfAllCompleted(sessionId) {
  if (!sessionId) return false;
  const tasks = listTasks(sessionId);
  if (!tasks.length) return false;
  if (!tasks.every((t) => t.status === 'completed')) return false;
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

  const seen = new Set();
  for (const t of snapshot) {
    if (t == null || t.id === undefined || t.id === null) continue;
    const id = String(t.id);
    seen.add(id);
    const existing = readTask(sessionId, id);
    const merged = normalizeTask(t, existing);
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
  listSessionIds,
  listTasks,
  readTask,
  writeTask,
  deleteTask,
  reconcileFromSnapshot,
  cleanupIfAllCompleted,
};
