const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { noteReplacedSessions, readLiveSessions, writeLiveSession, removeLiveSession, removeLiveSessionSync, sweepDeadLiveSessions } = require('../lib/live-sessions');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-live-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tempDir = () => fs.mkdtempSync(path.join(ROOT, 'run-'));

function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim() * 1;
}

describe('live session files', () => {
  const entry = { sessionId: '01a16eb5-b912-7486-8548-41c706ab95bd', pid: process.pid, cwd: 'C:\\Users\\u\\sandbox', sessionDir: 'C:\\Users\\u\\pi-out', startedAt: 1, status: 'busy', statusUpdatedAt: 2, name: 'demo' };

  it('writes the registry the server reads', async () => {
    const dir = tempDir();
    await writeLiveSession(dir, entry);
    assert.deepEqual(fs.readdirSync(dir), [`${process.pid}.json`]);
    assert.deepEqual(readLiveSessions(dir), [entry]);
    await writeLiveSession(dir, { ...entry, sessionId: 'next', status: 'idle' });
    assert.deepEqual(readLiveSessions(dir).map((s) => [s.sessionId, s.status]), [['next', 'idle']]);
    await removeLiveSession(dir, process.pid);
    await removeLiveSession(dir, process.pid);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('removes the file without waiting, for an exit handler', async () => {
    const dir = tempDir();
    await writeLiveSession(dir, entry);
    removeLiveSessionSync(dir, process.pid);
    removeLiveSessionSync(dir, process.pid);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('sweeps the file of a pid that is gone', async () => {
    const dir = tempDir();
    const gone = deadPid();
    await writeLiveSession(dir, entry);
    await writeLiveSession(dir, { ...entry, pid: gone, sessionId: 'crashed' });
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
    await sweepDeadLiveSessions(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${process.pid}.json`, 'notes.json']);
    await sweepDeadLiveSessions(path.join(dir, 'missing'));
  });
});

describe('noteReplacedSessions', () => {
  const TTL = 1000;

  it('marks the id a pid held before /clear', () => {
    const replaced = new Map();
    noteReplacedSessions(null, [{ pid: 7, sessionId: 'a' }], replaced, 0, TTL);
    assert.equal(replaced.size, 0);
    noteReplacedSessions([{ pid: 7, sessionId: 'a' }], [{ pid: 7, sessionId: 'b' }], replaced, 10, TTL);
    assert.deepEqual([...replaced], [['a', 10]]);
  });

  it('ignores an exit and a new process', () => {
    const replaced = new Map();
    noteReplacedSessions([{ pid: 7, sessionId: 'a' }], [{ pid: 8, sessionId: 'b' }], replaced, 10, TTL);
    assert.equal(replaced.size, 0);
  });

  it('clears an id that is live again, and one older than the ttl', () => {
    const replaced = new Map([['a', 0], ['old', 0]]);
    noteReplacedSessions([], [{ pid: 9, sessionId: 'a' }], replaced, TTL + 1, TTL);
    assert.equal(replaced.size, 0);
  });
});
