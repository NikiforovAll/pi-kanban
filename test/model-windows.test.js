const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelWindows, recordModelWindows, contextOf } = require('../lib/model-windows');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-model-windows-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const tempFile = () => path.join(tmp, `${++n}`, 'model-windows.json');

describe('recordModelWindows', () => {
  it('writes the exact window of each model, keyed by provider and id', async () => {
    const file = tempFile();
    const changed = await recordModelWindows(file, [
      { provider: 'codemie', id: 'gpt-6-luna', contextWindow: 1050000 },
      { provider: 'anthropic', id: 'claude-opus-5-5', contextWindow: 200000 },
      { provider: 'local', id: 'no-window' },
    ]);
    assert.equal(changed, true);
    assert.deepEqual(readModelWindows(file), { 'codemie/gpt-6-luna': 1050000, 'anthropic/claude-opus-5-5': 200000 });
  });

  it('keeps the entries of other pi processes and skips a write when nothing changed', async () => {
    const file = tempFile();
    await recordModelWindows(file, [{ provider: 'a', id: 'x', contextWindow: 100 }]);
    assert.equal(await recordModelWindows(file, [{ provider: 'b', id: 'y', contextWindow: 200 }]), true);
    const mtime = fs.statSync(file).mtimeMs;
    assert.equal(await recordModelWindows(file, [{ provider: 'b', id: 'y', contextWindow: 200 }]), false);
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    assert.deepEqual(readModelWindows(file), { 'a/x': 100, 'b/y': 200 });
  });

  it('reads a missing or broken file as no windows', () => {
    const file = tempFile();
    assert.deepEqual(readModelWindows(file), {});
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[1]');
    assert.deepEqual(readModelWindows(file), {});
  });
});

describe('contextOf', () => {
  const windows = { 'codemie/gpt-6-luna': 1050000 };
  const usage = { input_tokens: 10, cache_read_input_tokens: 50000, cache_creation_input_tokens: 200, output_tokens: 300 };

  it('sums the last reply usage as pi does and pairs it with the model window', () => {
    assert.deepEqual(contextOf({ provider: 'codemie', model: 'gpt-6-luna', usage }, windows), { tokens: 50510, window: 1050000 });
  });

  it('is null when the window is unknown or there is no usage', () => {
    assert.equal(contextOf({ provider: 'other', model: 'gpt-6-luna', usage }, windows), null);
    assert.equal(contextOf({ provider: null, model: 'gpt-6-luna', usage }, windows), null);
    assert.equal(contextOf({ provider: 'codemie', model: 'gpt-6-luna', usage: null }, windows), null);
    assert.equal(contextOf(null, windows), null);
  });
});
