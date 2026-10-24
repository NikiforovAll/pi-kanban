const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseModelTable, listPiModels, createModelCache } = require('../lib/pi-models');

const TABLE = [
  'provider  model         context  max-out  thinking  images',
  'codemie   gpt-6-luna    1.1M     128K     yes       yes',
  'local     tiny-1        8K       2K       no        no',
  '',
].join('\r\n');

describe('parseModelTable', () => {
  it('reads provider and id from each row', () => {
    assert.deepEqual(parseModelTable(TABLE), [
      { provider: 'codemie', id: 'gpt-6-luna' },
      { provider: 'local', id: 'tiny-1' },
    ]);
  });

  it('returns nothing for output that is not the table', () => {
    assert.deepEqual(parseModelTable('No models matching "zzz"\n'), []);
    assert.deepEqual(parseModelTable(''), []);
  });
});

describe('listPiModels', () => {
  it('runs pi offline and parses its output', async () => {
    let call;
    const exec = async (cmd, args, opts) => { call = { cmd, args, opts }; return { stdout: TABLE, stderr: '' }; };
    const models = await listPiModels({ exec, env: { X: '1' } });
    assert.equal(call.cmd, 'pi');
    assert.deepEqual(call.args, ['--offline', '--list-models']);
    assert.deepEqual(call.opts.env, { X: '1' });
    assert.equal(models.length, 2);
  });

  it('rejects when pi fails', async () => {
    const exec = async () => { throw new Error('ENOENT'); };
    await assert.rejects(listPiModels({ exec }), /ENOENT/);
  });
});

describe('createModelCache', () => {
  it('runs pi once per ttl and again after it', async () => {
    let t = 0;
    let runs = 0;
    const models = createModelCache({ list: async () => [++runs], now: () => t, ttl: 100 });
    assert.deepEqual(await models(), [1]);
    t = 50;
    assert.deepEqual(await models(), [1]);
    t = 150;
    assert.deepEqual(await models(), [2]);
  });

  it('does not keep a failed run', async () => {
    let fail = true;
    const models = createModelCache({ list: async () => { if (fail) throw new Error('down'); return ['ok']; } });
    await assert.rejects(models(), /down/);
    fail = false;
    assert.deepEqual(await models(), ['ok']);
  });
});
