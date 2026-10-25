const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeToolInput,
  activeBranch,
  sessionName,
  toClaudeLines,
  readSession,
  readClaudeLines,
  readClaudeLineTexts,
  clearCache,
} = require('../lib/pi-transcript');

const HEADER = { type: 'session', version: 3, id: 's1', timestamp: 't0', cwd: 'C:\\proj' };
const line = (o) => `${JSON.stringify(o)}\n`;
const entry = (id, parentId, rest) => ({ id, parentId, timestamp: `t-${id}`, ...rest });
const user = (id, parentId, content) => entry(id, parentId, { type: 'message', message: { role: 'user', content } });
const text = (lines) => lines.map((l) => l.message?.content);

describe('pi-transcript: activeBranch', () => {
  it('walks from the last entry to the root', () => {
    const entries = [user('a', null, '1'), user('b', 'a', '2'), user('c', 'a', '3'), entry('d', 'b', { type: 'label', targetId: 'b' })];
    assert.deepEqual(activeBranch(entries).map((e) => e.id), ['a', 'b', 'd']);
  });

  it('keeps every entry of a session without ids', () => {
    assert.deepEqual(activeBranch([{ type: 'message' }, { type: 'message' }]).length, 2);
  });

  it('stops on a parentId cycle', () => {
    assert.deepEqual(activeBranch([user('a', 'b', '1'), user('b', 'a', '2')]).map((e) => e.id), ['a', 'b']);
  });
});

describe('pi-transcript: sessionName', () => {
  it('takes the latest name over the whole file, and a blank name clears it', () => {
    assert.equal(sessionName([entry('a', null, { type: 'session_info', name: 'One' }), user('b', 'a', 'x')]), 'One');
    assert.equal(sessionName([entry('a', null, { type: 'session_info', name: 'One' }), entry('b', null, { type: 'session_info', name: '' })]), null);
    assert.equal(sessionName([]), null);
  });
});

describe('pi-transcript: normalizeToolInput', () => {
  it('renames path to file_path for the file tools only', () => {
    assert.deepEqual(normalizeToolInput('read', { path: 'a', offset: 2 }), { file_path: 'a', offset: 2 });
    assert.deepEqual(normalizeToolInput('grep', { path: 'a' }), { path: 'a' });
  });

  it('flattens one edit and keeps several as a list', () => {
    assert.deepEqual(normalizeToolInput('edit', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] }), { file_path: 'a', old_string: 'x', new_string: 'y' });
    assert.deepEqual(normalizeToolInput('edit', { edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] }).edits, [
      { old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' },
    ]);
  });

  it('gives a subagent call its type and prompt, from a single, parallel or chain call', () => {
    const pick = (args) => { const p = normalizeToolInput('subagent', args); return [p.subagent_type, p.prompt]; };
    assert.deepEqual(pick({ agent: 'scout', task: 'look' }), ['scout', 'look']);
    assert.deepEqual(pick({ tasks: [{ agent: 'a', task: 't1' }, { agent: 'b', task: 't2' }] }), ['a', 't1']);
    assert.deepEqual(pick({ chain: [{ agent: 'c', task: 't3' }] }), ['c', 't3']);
    assert.deepEqual(pick({ chain: [{ parallel: [{ agent: 'd', task: 't4' }] }] }), ['d', 't4']);
    assert.deepEqual(pick({ action: 'status', id: 'r1' }), [undefined, undefined]);
  });

  it('returns an empty object for missing arguments and keeps other values', () => {
    assert.deepEqual(normalizeToolInput('bash', undefined), {});
    assert.equal(normalizeToolInput('bash', 'raw'), 'raw');
  });
});

describe('pi-transcript: toClaudeLines', () => {
  const map = (...entries) => toClaudeLines(HEADER, entries);

  it('stamps every line with the entry and header fields', () => {
    const [l] = map(user('a', null, 'hi'));
    assert.deepEqual(l, { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'a', parentUuid: null, timestamp: 't-a', sessionId: 's1', cwd: 'C:\\proj', isSidechain: false });
  });

  it('maps an assistant reply with usage and tool calls', () => {
    const [l] = map(entry('a', null, { type: 'message', message: {
      role: 'assistant', provider: 'p', model: 'm', stopReason: 'toolUse',
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      content: [{ type: 'thinking', thinking: 'hm' }, { type: 'toolCall', id: 'c|1', name: 'find', arguments: { pattern: '*.js' } }],
    } }));
    assert.deepEqual(l.message, {
      role: 'assistant', model: 'm', provider: 'p', stop_reason: 'toolUse',
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      content: [
        { type: 'thinking', thinking: 'hm' },
        { type: 'tool_use', id: 'c|1', name: 'Glob', input: { pattern: '*.js' } },
      ],
    });
  });

  it('maps an error reply to its message and drops its zero usage', () => {
    const [l] = map(entry('a', null, { type: 'message', message: {
      role: 'assistant', model: 'm', stopReason: 'error', errorMessage: 'boom', usage: { input: 0, output: 0 }, content: [],
    } }));
    assert.deepEqual(l.message, { role: 'assistant', model: 'm', provider: null, stop_reason: 'error', content: [{ type: 'text', text: 'Error: boom' }] });
  });

  it('maps a tool result with its error flag and details', () => {
    const [l] = map(entry('a', null, { type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'x' }], isError: true, details: { exitCode: 1 } } }));
    assert.deepEqual(l.message.content, [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'x' }], is_error: true }]);
    assert.deepEqual(l.toolUseResult, { exitCode: 1 });
  });

  it('labels a shell command, a branch summary and a shown extension message', () => {
    const lines = map(
      entry('a', null, { type: 'message', message: { role: 'bashExecution', command: 'ls', output: 'f', exitCode: 2 } }),
      entry('b', 'a', { type: 'branch_summary', fromId: 'a', summary: 'went back' }),
      entry('c', 'b', { type: 'custom_message', customType: 'note', content: 'hello', display: true }),
      entry('d', 'c', { type: 'custom_message', customType: 'hidden', content: 'x', display: false }),
    );
    assert.deepEqual(lines.map((l) => [l.systemLabel, l.message.content]), [
      ['Shell command', '$ ls\nf\n(exit 2)'],
      ['Branch summary', 'went back'],
      ['note', 'hello'],
    ]);
  });

  it('maps a compaction to a boundary and a summary line', () => {
    const lines = map(entry('a', null, { type: 'compaction', summary: 'sum', firstKeptEntryId: 'x', tokensBefore: 9 }));
    assert.deepEqual(lines.map((l) => [l.type, l.subtype, l.uuid, l.isCompactSummary]), [
      ['system', 'compact_boundary', 'a-boundary', undefined],
      ['user', undefined, 'a', true],
    ]);
    assert.deepEqual(lines[0].compactMetadata, { trigger: 'auto', preTokens: 9 });
  });

  it('maps model, thinking and name changes and drops state entries', () => {
    const lines = map(
      entry('a', null, { type: 'model_change', provider: 'p', modelId: 'm' }),
      entry('b', 'a', { type: 'thinking_level_change', thinkingLevel: 'high' }),
      entry('c', 'b', { type: 'session_info', name: 'Named' }),
      entry('d', 'c', { type: 'custom', customType: 'state', data: {} }),
      entry('e', 'd', { type: 'label', targetId: 'a', label: 'x' }),
      entry('f', 'e', { type: 'message', message: { role: 'system', content: 'x' } }),
    );
    assert.deepEqual(lines.map((l) => [l.type, l.subtype, l.model ?? l.thinkingLevel ?? l.customTitle]), [
      ['system', 'model_change', 'm'],
      ['system', 'thinking_level_change', 'high'],
      ['custom-title', undefined, 'Named'],
    ]);
  });
});

describe('pi-transcript: reading files', () => {
  let dir;
  let p;
  beforeEach(() => {
    clearCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-transcript-'));
    p = path.join(dir, 's.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the header, the entries and the active branch', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, '1')) + line(user('b', 'a', '2')) + line(user('c', 'a', '3')));
    const s = readSession(p);
    assert.equal(s.header.id, 's1');
    assert.equal(s.entries.length, 3);
    assert.deepEqual(s.branch.map((e) => e.id), ['a', 'c']);
    assert.deepEqual(text(s.lines), ['1', '3']);
    assert.deepEqual(readClaudeLineTexts(p).map((t) => JSON.parse(t).uuid), ['a', 'c']);
  });

  it('picks up appended entries', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, '1')));
    assert.deepEqual(text(readClaudeLines(p)), ['1']);
    fs.appendFileSync(p, line(user('b', 'a', '2')));
    assert.deepEqual(text(readClaudeLines(p)), ['1', '2']);
    assert.deepEqual(readClaudeLineTexts(p).length, 2);
  });

  it('grows the branch, lines and name on an append that continues the branch', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, '1')));
    const first = readSession(p);
    assert.equal(readClaudeLineTexts(p).length, 1);
    fs.appendFileSync(p, line(user('b', 'a', '2')) + line(entry('c', 'b', { type: 'session_info', name: 'Named' })));
    const next = readSession(p);
    assert.notEqual(next.lines, first.lines);
    assert.deepEqual(text(first.lines), ['1']);
    assert.deepEqual(next.branch.map((e) => e.id), ['a', 'b', 'c']);
    assert.equal(next.name, 'Named');
    assert.deepEqual(readClaudeLineTexts(p).map((t) => JSON.parse(t).uuid), ['a', 'b', 'c']);
  });

  it('derives the branch again when an append switches branches', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, '1')) + line(user('b', 'a', '2')));
    assert.deepEqual(text(readClaudeLines(p)), ['1', '2']);
    fs.appendFileSync(p, line(user('c', 'a', '3')));
    assert.deepEqual(text(readClaudeLines(p)), ['1', '3']);
  });

  it('reads a file with retain false without caching it, and keeps a cached one fresh', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, '1')));
    const once = readClaudeLines(p, { retain: false });
    assert.notEqual(readClaudeLines(p, { retain: false }), once);
    const kept = readClaudeLines(p);
    assert.equal(readClaudeLines(p, { retain: false }), kept);
    fs.appendFileSync(p, line(user('b', 'a', '2')));
    assert.deepEqual(text(readClaudeLines(p, { retain: false })), ['1', '2']);
    assert.equal(readClaudeLines(p), readClaudeLines(p, { retain: false }));
  });

  it('waits for a partial last line to complete', () => {
    const b = line(user('b', 'a', '2'));
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, '1')) + b.slice(0, 20));
    assert.deepEqual(text(readClaudeLines(p)), ['1']);
    fs.appendFileSync(p, b.slice(20));
    assert.deepEqual(text(readClaudeLines(p)), ['1', '2']);
  });

  it('reads a complete last line that has no newline yet', () => {
    fs.writeFileSync(p, line(HEADER) + JSON.stringify(user('a', null, '1')));
    assert.deepEqual(text(readClaudeLines(p)), ['1']);
  });

  it('reads a shrunk file again from the start', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, 'long one')) + line(user('b', 'a', '2')));
    assert.equal(readClaudeLines(p).length, 2);
    fs.writeFileSync(p, line(HEADER) + line(user('x', null, 'new')));
    assert.deepEqual(text(readClaudeLines(p)), ['new']);
  });

  it('reads a file rewritten with the same size again', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, 'one')));
    assert.deepEqual(text(readClaudeLines(p)), ['one']);
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, 'two')));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(p, later, later);
    assert.deepEqual(text(readClaudeLines(p)), ['two']);
  });

  it('reads a replaced file again', () => {
    fs.writeFileSync(p, line(HEADER) + line(user('a', null, '1')));
    readClaudeLines(p);
    const next = `${p}.new`;
    fs.writeFileSync(next, line({ ...HEADER, id: 's2' }) + line(user('a', null, '1')) + line(user('b', 'a', '2')));
    fs.rmSync(p);
    fs.renameSync(next, p);
    const s = readSession(p);
    assert.equal(s.header.id, 's2');
    assert.deepEqual(text(s.lines), ['1', '2']);
  });

  it('gives nothing for a file without a pi header, or a missing file', () => {
    fs.writeFileSync(p, line({ type: 'user', message: { role: 'user', content: 'claude' } }));
    assert.equal(readSession(p), null);
    assert.equal(readSession(path.join(dir, 'missing.jsonl')), null);
    assert.deepEqual(readClaudeLines(p), []);
    assert.deepEqual(readClaudeLineTexts(path.join(dir, 'missing.jsonl')), []);
  });

  it('skips broken lines and a second header', () => {
    fs.writeFileSync(p, line(HEADER) + 'not json\n' + line(user('a', null, '1')) + line({ ...HEADER, id: 's9' }) + line(user('b', 'a', '2')));
    const s = readSession(p);
    assert.equal(s.header.id, 's1');
    assert.deepEqual(text(s.lines), ['1', '2']);
  });
});
