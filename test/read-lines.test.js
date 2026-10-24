const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLines } = require('../lib/parsers');

async function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-lines-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, content);
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function linesOf(content) {
  return withFile(content, async (file) => {
    const out = [];
    for await (const line of readLines(file)) out.push(JSON.parse(line));
    return out;
  });
}

const header = JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: 't', cwd: 'C:\\proj' });
const user = (id, parentId, content) => JSON.stringify({ type: 'message', id, parentId, timestamp: 't', message: { role: 'user', content } });
const texts = (lines) => lines.map((l) => l.message.content);

describe('readLines', () => {
  it('yields the mapped lines of a pi session', async () => {
    const lines = await linesOf(`${header}\n${user('a', null, 'one')}\n${user('b', 'a', 'two')}\n`);
    assert.deepEqual(lines.map((l) => [l.type, l.uuid, l.sessionId]), [['user', 'a', 's1'], ['user', 'b', 's1']]);
    assert.deepEqual(texts(lines), ['one', 'two']);
  });

  const cases = {
    'no trailing newline': `${header}\n${user('a', null, 'one')}`,
    'blank lines': `\n${header}\n\n${user('a', null, 'one')}\n\n`,
    crlf: `${header}\r\n${user('a', null, 'one')}\r\n`,
  };
  for (const [name, content] of Object.entries(cases)) {
    it(`reads a session with ${name}`, async () => {
      assert.deepEqual(texts(await linesOf(content)), ['one']);
    });
  }

  it('keeps long lines and multi-byte chars whole', async () => {
    const long = 'é'.repeat(1 << 20);
    const cjk = '日本'.repeat(400000);
    assert.deepEqual(texts(await linesOf(`${header}\n${user('a', null, long)}\n${user('b', 'a', cjk)}\n`)), [long, cjk]);
  });

  it('skips a partial last line', async () => {
    const lines = await linesOf(`${header}\n${user('a', null, 'one')}\n${user('b', 'a', 'two').slice(0, 30)}`);
    assert.deepEqual(texts(lines), ['one']);
  });

  it('yields nothing for a file without a pi header', async () => {
    assert.deepEqual(await linesOf(`${user('a', null, 'one')}\n`), []);
    assert.deepEqual(await linesOf(''), []);
  });

  it('rejects for a missing file', async () => {
    await assert.rejects(async () => {
      for await (const _ of readLines(path.join(os.tmpdir(), 'pk-no-such-file.jsonl'))) {}
    });
  });
});
