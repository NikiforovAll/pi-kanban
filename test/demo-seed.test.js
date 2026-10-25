const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedFiles } = require('../demo/seed');

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-seed-')));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('seedFiles target guard', () => {
  const KEYS = ['PI_DIR', 'PI_CODING_AGENT_DIR', 'PI_KANBAN_TMPDIR'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });
  const setEnv = (env) => {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
  };

  it('refuses the default agent dir when PI_CODING_AGENT_DIR is unset', async () => {
    setEnv({ PI_KANBAN_TMPDIR: path.join(ROOT, 'tmp') });
    await assert.rejects(seedFiles({ root: ROOT }), /default agent dir/);
  });

  it('refuses the default agent dir even when it lies under root', async () => {
    setEnv({ PI_CODING_AGENT_DIR: path.join(os.homedir(), '.pi', 'agent'), PI_KANBAN_TMPDIR: path.join(os.homedir(), 'tmp') });
    await assert.rejects(seedFiles({ root: os.homedir() }), /default agent dir/);
  });

  it('refuses an agent dir outside root', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-seed-other-'));
    after(() => fs.rmSync(other, { recursive: true, force: true }));
    setEnv({ PI_CODING_AGENT_DIR: path.join(other, 'agent'), PI_KANBAN_TMPDIR: path.join(ROOT, 'tmp') });
    await assert.rejects(seedFiles({ root: ROOT }), /PI_CODING_AGENT_DIR/);
    assert.equal(fs.existsSync(path.join(other, 'agent')), false);
  });

  it('refuses a scratchpad root outside root', async () => {
    setEnv({ PI_CODING_AGENT_DIR: path.join(ROOT, '.pi', 'agent') });
    await assert.rejects(seedFiles({ root: ROOT }), /PI_KANBAN_TMPDIR/);
    assert.equal(fs.existsSync(path.join(ROOT, '.pi')), false);
  });
});
