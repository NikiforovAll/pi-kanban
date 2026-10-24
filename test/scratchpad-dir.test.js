const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createScratchpadDirResolver, scratchpadRoot, defaultScratchpadRoot, scratchpadPath, recordedPadDir, prunePads, TMPDIR_ENV, SCRATCHPAD_ENTRY,
} = require('../lib/scratchpad-dir');
const { encodeProjectDirName } = require('../lib/board-dir');

const ROOT = path.resolve('/tmp/pi-kanban');
const ID = '64601a65-8a20-45e6-aa35-5211fcfa4350';
const CWD = path.resolve('/dev/pi-kanban');
const DAY = 24 * 60 * 60 * 1000;

describe('getScratchpadDir', () => {
  it('builds the pad from the session cwd when none was recorded', () => {
    const get = createScratchpadDirResolver({ root: ROOT });
    assert.equal(get(ID, { cwd: CWD }), path.join(ROOT, encodeProjectDirName(CWD), ID, 'scratchpad'));
    assert.equal(get(ID, { project: CWD }), scratchpadPath(ROOT, CWD, ID));
  });

  it('returns null without a cwd', () => {
    assert.equal(createScratchpadDirResolver({ root: ROOT })(ID, {}), null);
  });

  it('takes the recorded dir, with its root in long form, over the convention', () => {
    const root = path.resolve('/SHORT~1/pi-kanban');
    const longRoot = path.resolve('/short-long/pi-kanban');
    let calls = 0;
    const get = createScratchpadDirResolver({ root: ROOT, toLong: (p) => (calls++, p === root ? longRoot : p) });
    const other = 'aaaaaaaa-8a20-45e6-aa35-5211fcfa4350';
    for (const id of [ID, other, ID]) {
      const meta = { cwd: CWD, scratchpadDir: path.join(root, 'x', id, 'scratchpad') };
      assert.equal(get(id, meta), path.join(longRoot, 'x', id, 'scratchpad'));
    }
    assert.equal(calls, 1);
  });
});

describe('recordedPadDir', () => {
  it('takes the last recorded pad and skips other entries', () => {
    const pad = (dir) => ({ type: 'custom', customType: SCRATCHPAD_ENTRY, data: { dir } });
    assert.equal(recordedPadDir([pad('/a'), { type: 'custom', customType: 'other', data: { dir: '/x' } }, pad('/b')]), '/b');
    assert.equal(recordedPadDir([pad(42)]), null);
    assert.equal(recordedPadDir([]), null);
  });
});

describe('defaultScratchpadRoot', () => {
  let saved;
  beforeEach(() => { saved = process.env[TMPDIR_ENV]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[TMPDIR_ENV];
    else process.env[TMPDIR_ENV] = saved;
  });

  it('takes an absolute override from the environment', () => {
    process.env[TMPDIR_ENV] = path.resolve('/override');
    assert.equal(path.dirname(defaultScratchpadRoot()), path.resolve('/override'));
  });
});

describe('scratchpadRoot', () => {
  it('sits in the OS temp dir, with the uid on Unix', () => {
    assert.equal(scratchpadRoot({ platform: 'linux', tmpdir: '/tmp', uid: 1000 }), '/tmp/pi-kanban-1000');
    assert.equal(scratchpadRoot({ platform: 'darwin', tmpdir: '/var/folders/x/T', uid: 501 }), '/var/folders/x/T/pi-kanban-501');
    assert.equal(scratchpadRoot({ platform: 'win32', tmpdir: 'C:\\Temp' }), 'C:\\Temp\\pi-kanban');
  });

  it('takes an absolute override and skips a relative one', () => {
    assert.equal(scratchpadRoot({ platform: 'linux', override: '/data/tmp/', tmpdir: '/tmp', uid: 1000 }), '/data/tmp/pi-kanban-1000');
    assert.equal(scratchpadRoot({ platform: 'linux', override: 'rel/dir', tmpdir: '/tmp', uid: 1000 }), '/tmp/pi-kanban-1000');
    assert.equal(scratchpadRoot({ platform: 'win32', override: 'D:/tmp', tmpdir: 'C:\\Temp' }), 'D:\\tmp\\pi-kanban');
  });
});

describe('prunePads', () => {
  let root;
  const now = Date.now();
  const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
  const FRESH = 'aaaaaaaa-0000-4000-8000-000000000002';
  const LIVE = 'aaaaaaaa-0000-4000-8000-000000000003';
  const TOUCHED = 'aaaaaaaa-0000-4000-8000-000000000004';

  function pad(project, id, ageDays, file = 'notes.md') {
    const dir = path.join(root, project, id, 'scratchpad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'x');
    const t = new Date(now - ageDays * DAY);
    for (const p of [path.join(dir, file), dir, path.dirname(dir)]) fs.utimesSync(p, t, t);
    return path.dirname(dir);
  }

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prune-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('removes old pads of sessions that are not live and keeps the rest', async () => {
    const old = pad('C--a', OLD, 10);
    const fresh = pad('C--a', FRESH, 1);
    const live = pad('C--b', LIVE, 30);
    const touched = pad('C--b', TOUCHED, 30);
    const t = new Date(now - DAY);
    fs.utimesSync(path.join(touched, 'scratchpad', 'notes.md'), t, t);
    fs.mkdirSync(path.join(root, 'C--c', 'not-a-session'), { recursive: true });

    const removed = await prunePads({ root, isLive: (id) => id === LIVE, now });

    assert.deepEqual(removed, [old]);
    assert.ok(!fs.existsSync(old));
    for (const dir of [fresh, live, touched, path.join(root, 'C--c', 'not-a-session')]) assert.ok(fs.existsSync(dir), dir);
  });

  it('removes a project dir that the prune left empty', async () => {
    pad('C--a', OLD, 10);
    await prunePads({ root, isLive: () => false, now });
    assert.ok(!fs.existsSync(path.join(root, 'C--a')));
  });

  it('returns nothing for a missing root', async () => {
    assert.deepEqual(await prunePads({ root: path.join(root, 'missing'), isLive: () => false, now }), []);
  });
});
