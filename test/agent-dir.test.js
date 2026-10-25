const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const chokidar = require('chokidar');
const { getAgentDir, longPath } = require('../lib/agent-dir');
const { resolvePiAgentDir } = require('../lib/board-dir');

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-agent-dir-')));
const LONG = path.join(ROOT, 'long directory name');
fs.mkdirSync(LONG);
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function shortName(p) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const short = r.stdout.trim();
  return short && short.toLowerCase() !== p.toLowerCase() ? short : null;
}

describe('agent dir', () => {
  const saved = { argv: process.argv, env: { ...process.env } };
  let SHORT;
  before(() => { SHORT = shortName(LONG); });
  afterEach(() => {
    process.argv = saved.argv;
    for (const k of ['PI_DIR', 'PI_CODING_AGENT_DIR']) {
      if (saved.env[k] === undefined) delete process.env[k];
      else process.env[k] = saved.env[k];
    }
  });

  it('expands ~ in PI_CODING_AGENT_DIR', () => {
    delete process.env.PI_DIR;
    process.env.PI_CODING_AGENT_DIR = '~/pk-no-such-agent-dir';
    assert.equal(getAgentDir(), path.join(fs.realpathSync.native(os.homedir()), 'pk-no-such-agent-dir'));
  });

  it('gives the long form of a Windows 8.3 short dir', (t) => {
    if (!SHORT) return t.skip('no 8.3 short name on this volume');
    delete process.env.PI_DIR;
    process.env.PI_CODING_AGENT_DIR = SHORT;
    assert.equal(getAgentDir(), LONG);
    process.env.PI_CODING_AGENT_DIR = path.join(SHORT, 'not-yet', 'agent');
    assert.equal(getAgentDir(), path.join(LONG, 'not-yet', 'agent'));
    process.env.PI_DIR = SHORT;
    assert.equal(getAgentDir(), path.join(LONG, 'agent'));
    process.argv = [...saved.argv, '--dir', SHORT];
    assert.equal(resolvePiAgentDir(), LONG);
  });

  // libuv aborts the process when a file appears under a dir watched by its short name.
  it('gives a path that chokidar can watch for a file not created yet', { timeout: 10_000 }, async (t) => {
    if (!SHORT) return t.skip('no 8.3 short name on this volume');
    const watcher = chokidar.watch(longPath(path.join(SHORT, 'plan.md')), { ignoreInitial: true });
    t.after(() => watcher.close());
    const seen = new Promise((resolve) => watcher.on('add', resolve));
    for (let i = 0; i < 200 && !(LONG in watcher.getWatched()); i++) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(LONG, 'plan.md'), '# plan');
    assert.equal(await seen, path.join(LONG, 'plan.md'));
  });
});
