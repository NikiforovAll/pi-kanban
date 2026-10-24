const fs = require('node:fs');
const path = require('node:path');
const { getAgentDir } = require('./agent-dir');
const { writeJsonAtomic } = require('./atomic-write');

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
  return writeJsonAtomic(taskPath(sessionId, task.id), task);
}

function deleteTask(sessionId, taskId) {
  try { fs.unlinkSync(taskPath(sessionId, taskId)); return true; }
  catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

const ids = (list) => (Array.isArray(list) ? list.map(String) : []);

function normalizeTask(snapTask, existing, blocks, blockedBy) {
  const e = existing || {};
  return {
    id: String(snapTask.id),
    subject: snapTask.subject ?? snapTask.text ?? '',
    description: snapTask.description ?? null,
    activeForm: snapTask.activeForm ?? e.activeForm ?? null,
    status: snapTask.status ?? 'pending',
    blocks,
    blockedBy,
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

async function readTaskAsync(sessionId, taskId) {
  try { return JSON.parse(await fs.promises.readFile(taskPath(sessionId, taskId), 'utf8')); } catch { return null; }
}

async function reconcile(sessionId, snapshot) {
  // rpiv-todo keeps a deleted task as a tombstone; the board has no deleted status, so it gets no
  // file, and a dependency on it is dropped from both sides.
  const live = snapshot.filter((t) => t?.id != null && t.status !== 'deleted');
  const liveIds = new Set(live.map((t) => String(t.id)));
  const blockedBy = new Map(live.map((t) => [String(t.id), ids(t.blockedBy).filter((dep) => liveIds.has(dep))]));
  const blocks = new Map([...liveIds].map((id) => [id, []]));
  for (const [id, deps] of blockedBy) for (const dep of deps) blocks.get(dep).push(id);

  await Promise.all(live.map(async (t) => {
    const id = String(t.id);
    const existing = await readTaskAsync(sessionId, id);
    const merged = normalizeTask(t, existing, blocks.get(id), blockedBy.get(id));
    if (!existing || !tasksEqual(existing, merged)) await writeTask(sessionId, merged);
  }));

  const dir = sessionDir(sessionId);
  let entries;
  try { entries = await fs.promises.readdir(dir); } catch { return; }
  await Promise.all(entries
    .filter((name) => name.endsWith('.json') && !liveIds.has(name.slice(0, -5)))
    .map((name) => fs.promises.rm(path.join(dir, name), { force: true })));
}

let reconciling = Promise.resolve();

// Snapshots are applied one at a time, in the order they came.
function reconcileFromSnapshot(sessionId, snapshot) {
  if (!sessionId || !Array.isArray(snapshot)) return Promise.resolve();
  const run = reconciling.then(() => reconcile(sessionId, snapshot));
  reconciling = run.catch(() => {});
  return run;
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
};
