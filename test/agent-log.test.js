const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { foldAgentLines, appendAgentLine, writeWaiting, clearWaiting, markStopped, clearStopped } = require('../lib/agent-log');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schema = (name) => ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas', name), 'utf8')));
const tempDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-activity-')), 'session');

test('appended lines fold into one agent', async () => {
  const dir = tempDir();
  await appendAgentLine(dir, { agentId: 'tc_x_0', type: 'scout', event: 'start', status: 'active', startedAt: '2026-10-24T16:19:30.000Z' });
  await appendAgentLine(dir, { agentId: 'tc_x_0', event: 'stop', status: 'stopped', stoppedAt: '2026-10-24T16:19:40.000Z', model: 'codemie/gpt-6-luna' });
  const agent = foldAgentLines(fs.readFileSync(path.join(dir, 'tc_x_0.jsonl'), 'utf8'));
  const validate = schema('agent.schema.json');
  assert.ok(validate(agent), JSON.stringify(validate.errors));
  assert.deepEqual([agent.type, agent.status, agent.model], ['scout', 'stopped', 'codemie/gpt-6-luna']);
});

test('waiting marker matches the schema and clears', async () => {
  const dir = tempDir();
  const file = path.join(dir, '_waiting.json');
  await writeWaiting(dir, { kind: 'permission', toolName: 'bash', toolInput: '{"command":"rm x"}', cwd: 'C:\\sandbox', timestamp: '2026-10-24T16:19:30.000Z' });
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validate = schema('waiting.schema.json');
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
