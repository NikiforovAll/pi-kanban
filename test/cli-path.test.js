const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { SKIP_TS } = require('./ts-hooks');

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe('the pi-kanban shims on PATH', { skip: SKIP_TS }, () => {
  let dir;
  let addCliToPath;
  const saved = {};

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-cli-path-'));
    for (const k of ['PATH', 'PI_KANBAN_SERVER']) saved[k] = process.env[k];
    ({ addCliToPath } = await import('../extensions/tools/cli-path.ts'));
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puts the shim folder first on PATH, once, and names this package server.js', () => {
    addCliToPath(dir);
    addCliToPath(dir);
    const parts = process.env.PATH.split(path.delimiter);
    assert.equal(parts[0], dir);
    assert.equal(parts.filter(p => p === dir).length, 1);
    assert.equal(process.env.PI_KANBAN_SERVER, path.join(__dirname, '..', 'server.js'));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['pi-kanban', 'pi-kanban.cmd']);
  });

  it('runs the CLI through the sh shim', { skip: !hasSh && 'needs sh' }, () => {
    const out = execFileSync('sh', ['-c', 'command -v pi-kanban && pi-kanban help'], { encoding: 'utf8', env: process.env });
    const [found] = out.split('\n');
    assert.equal(path.basename(found), 'pi-kanban');
    assert.match(out, /Usage: pi-kanban/);
  });
});
