const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { schemaValidator } = require('./schema-validator');
const { foldAgentLines, sanitizeAgentId, appendAgentLines, promptMarker, writeWaiting, clearWaiting, markStopped, clearStopped } = require('../lib/agent-log');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-activity-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const tempDir = () => path.join(fs.mkdtempSync(path.join(ROOT, 'run-')), 'session');

test('appended lines fold into one agent per file', async () => {
  const dir = tempDir();
  await appendAgentLines(dir, [
    { agentId: 'tc_x_0', type: 'scout', event: 'start', status: 'active', startedAt: '2026-10-24T16:19:30.000Z' },
    { agentId: 'tc_x_1', type: 'worker', event: 'start', status: 'active', startedAt: '2026-10-24T16:19:30.000Z' },
    { agentId: 'tc_x_0', event: 'stop', status: 'stopped', stoppedAt: '2026-10-24T16:19:40.000Z', model: 'codemie/gpt-6-luna' },
  ]);
  await appendAgentLines(dir, []);
  const validate = schemaValidator('agent.schema.json');
  const [scout, worker] = ['tc_x_0', 'tc_x_1'].map((id) => foldAgentLines(fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8')));
  for (const agent of [scout, worker]) assert.ok(validate(agent), JSON.stringify(validate.errors));
  assert.deepEqual([scout.type, scout.status, scout.model], ['scout', 'stopped', 'codemie/gpt-6-luna']);
  assert.deepEqual([worker.type, worker.status], ['worker', 'active']);
});

test('an agent id keeps only file-name characters', () => {
  assert.equal(sanitizeAgentId('call_A|fc.9'), 'call_Afc9');
  assert.equal(sanitizeAgentId('../../etc/passwd'), 'passwd');
});

test('a prompt marker names the newest running tool, or the prompt', () => {
  const tool = { toolName: 'bash', args: { command: 'rm x' } };
  assert.deepEqual(promptMarker({ kind: 'confirm', title: 'Run?' }, tool, 'C:\\sandbox', 'T'), {
    kind: 'permission',
    toolName: 'bash',
    toolInput: '{"command":"rm x"}',
    cwd: 'C:\\sandbox',
    timestamp: 'T',
  });
  const bare = promptMarker({ kind: 'select', title: 'Pick one' }, undefined, 'C:\\sandbox', 'T');
  assert.deepEqual([bare.kind, bare.toolName, bare.toolInput], ['question', 'Pick one', '{"title":"Pick one"}']);
});

test('waiting marker matches the schema and clears', async () => {
  const dir = tempDir();
  const file = path.join(dir, '_waiting.json');
  await writeWaiting(dir, { kind: 'permission', toolName: 'bash', toolInput: '{"command":"rm x"}', cwd: 'C:\\sandbox', timestamp: '2026-10-24T16:19:30.000Z' });
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validate = schemaValidator('waiting.schema.json');
  assert.ok(validate(marker), JSON.stringify(validate.errors));
  assert.equal(marker.status, 'waiting');
  assert.equal(marker.id, undefined);
  await clearWaiting(dir);
  await clearWaiting(dir);
  assert.equal(fs.existsSync(file), false);
});

test('stop marker is an empty file', async () => {
  const dir = tempDir();
  const file = path.join(dir, '_stop.json');
  await clearStopped(dir);
  await markStopped(dir);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  await clearStopped(dir);
  assert.equal(fs.existsSync(file), false);
});

const jsonl = (...objs) => `${objs.map((o) => JSON.stringify(o)).join('\n')}\n`;

test('later lines win within a run', () => {
  const agent = foldAgentLines(
    jsonl(
      { agentId: 'a1', type: 'general-purpose', event: 'start', status: 'active', startedAt: 't1' },
      { agentId: 'a1', event: 'stop', status: 'stopped', stoppedAt: 't2', lastMessage: 'done' },
    ),
  );
  assert.deepEqual(agent, {
    agentId: 'a1',
    type: 'general-purpose',
    event: 'stop',
    status: 'stopped',
    startedAt: 't1',
    stoppedAt: 't2',
    lastMessage: 'done',
  });
});

test('a start line drops the run before it', () => {
  const agent = foldAgentLines(
    jsonl(
      { agentId: 'a1', type: 'general-purpose', event: 'start', status: 'active', prompt: 'first', startedAt: 't1' },
      { agentId: 'a1', event: 'stop', status: 'stopped', stoppedAt: 't2' },
      { agentId: 'a1', event: 'server-update', lastMessage: 'first answer', resultUnavailable: 1, modelUnavailable: 1 },
      { agentId: 'a1', type: 'general-purpose', event: 'start', status: 'active', prompt: 'second', startedAt: 't3' },
    ),
  );
  assert.deepEqual(agent, {
    agentId: 'a1',
    type: 'general-purpose',
    event: 'start',
    status: 'active',
    prompt: 'second',
    startedAt: 't3',
  });
});

test('a malformed line is skipped', () => {
  assert.deepEqual(foldAgentLines('{"agentId":"a1"}\nnot json\r\n{"status":"active"}\n'), {
    agentId: 'a1',
    status: 'active',
  });
});
