const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { schemaValidator } = require('./schema-validator');

const PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-tasks-'));
process.env.PI_DIR = PI_DIR;
const taskStore = require('../lib/task-store');
const { countTaskDir } = require('../lib/task-counts');

const validateTask = schemaValidator('task.schema.json');

const byId = (tasks) => Object.fromEntries(tasks.map((t) => [t.id, t]));

// rpiv-todo snapshots from a ~/.pi-dev session, plus a dependency and a tombstone.
const SNAP_START = [
  { id: 1, subject: 'count', status: 'in_progress', activeForm: 'counting files' },
  { id: 2, subject: 'report', status: 'pending', blockedBy: [1] },
  { id: 3, subject: 'wrap', status: 'pending', blockedBy: [1, 2] },
];
const SNAP_END = [
  { id: 1, subject: 'count', status: 'completed', activeForm: 'counting files' },
  { id: 2, subject: 'report', status: 'completed', activeForm: 'reporting file count', blockedBy: [1] },
  { id: 3, subject: 'wrap', status: 'deleted', blockedBy: [1, 2] },
];

describe('reconcileFromSnapshot', () => {
  before(() => {
    assert.equal(taskStore.getTasksDir(), path.join(PI_DIR, 'agent', 'kanban', 'tasks'));
  });
  after(() => fs.rmSync(PI_DIR, { recursive: true, force: true }));

  it('writes schema-valid tasks with both sides of each dependency', async () => {
    await taskStore.reconcileFromSnapshot('s1', SNAP_START);
    const tasks = byId(taskStore.listTasks('s1'));
    for (const t of Object.values(tasks)) assert.ok(validateTask(t), JSON.stringify(validateTask.errors));
    assert.deepEqual(tasks['1'].blocks, ['2', '3']);
    assert.deepEqual(tasks['2'].blockedBy, ['1']);
    assert.deepEqual(tasks['2'].blocks, ['3']);
    assert.deepEqual(tasks['3'].blockedBy, ['1', '2']);
    assert.equal(tasks['1'].activeForm, 'counting files');
  });

  it('counts match the snapshot', () => {
    const counts = countTaskDir(taskStore.sessionDir('s1'));
    assert.deepEqual([counts.completed, counts.inProgress, counts.pending], [0, 1, 2]);
  });

  it('drops a deleted task and keeps a list that is all completed', async () => {
    await taskStore.reconcileFromSnapshot('s1', SNAP_END);
    const tasks = byId(taskStore.listTasks('s1'));
    assert.deepEqual(Object.keys(tasks).sort(), ['1', '2']);
    assert.deepEqual(tasks['1'].blocks, ['2']);
    const counts = countTaskDir(taskStore.sessionDir('s1'));
    assert.deepEqual([counts.completed, counts.inProgress, counts.pending], [2, 0, 0]);
  });

  it('does not rewrite a task that did not change', async () => {
    const file = path.join(taskStore.sessionDir('s1'), '1.json');
    const before = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, new Date(0), new Date(0));
    await taskStore.reconcileFromSnapshot('s1', SNAP_END);
    assert.equal(fs.statSync(file).mtimeMs, 0);
    assert.ok(before > 0);
  });

  it('drops a dependency on a deleted task', async () => {
    await taskStore.reconcileFromSnapshot('s2', [
      { id: 1, subject: 'gone', status: 'deleted' },
      { id: 2, subject: 'next', status: 'pending', blockedBy: [1] },
    ]);
    const tasks = byId(taskStore.listTasks('s2'));
    assert.deepEqual(Object.keys(tasks), ['2']);
    assert.deepEqual(tasks['2'].blockedBy, []);
    assert.ok(validateTask(tasks['2']), JSON.stringify(validateTask.errors));
  });

  it('applies snapshots in the order they came', async () => {
    const first = taskStore.reconcileFromSnapshot('s3', [{ id: 1, subject: 'a', status: 'pending' }]);
    const second = taskStore.reconcileFromSnapshot('s3', [{ id: 1, subject: 'a', status: 'completed' }]);
    await Promise.all([first, second]);
    assert.equal(taskStore.readTask('s3', '1').status, 'completed');
  });
});
