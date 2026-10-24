const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { foldAgentLines } = require('../lib/agent-log');
const { agentIdFor, spawnsFromArgs, startLines, endLines, modelLines, asyncCompleteLines } = require('../lib/pi-agents');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateAgent = ajv.compile(JSON.parse(fs.readFileSync(path.join(__dirname, 'schemas', 'agent.schema.json'), 'utf8')));

const fold = (lines) => foldAgentLines(lines.map((l) => JSON.stringify(l)).join('\n'));

// Trimmed from a ~/.pi-dev session that ran one async scout.
const TOOL_CALL_ID = 'call_A2O0NpUTAyF06iujQklPvo6m|fc_03d24acb25306174016adcda91d09c8195988698d6e2ccebd9';
const RUN_ID = 'fca74d3f-6dfe-4ff5-ac27-b19624e504f0';
const ASYNC_DIR = `C:\\Temp\\pi-subagents\\async-subagent-runs\\${RUN_ID}`;
const SESSION_FILE = `C:\\Users\\u\\.pi-dev\\agent\\sessions\\--C--sandbox--\\s\\${RUN_ID}\\run-0\\session.jsonl`;
const ARGS = { agent: 'scout', task: 'List the files in the current directory and reply with just the count.' };
const ASYNC_LAUNCH = {
  content: [{ type: 'text', text: 'Async: scout' }],
  details: { mode: 'single', runId: RUN_ID, toolCallId: TOOL_CALL_ID, results: [], asyncId: RUN_ID, asyncDir: ASYNC_DIR },
};
const STATUS = {
  runId: RUN_ID,
  toolCallId: TOOL_CALL_ID,
  state: 'complete',
  steps: [{ agent: 'scout', status: 'complete', sessionFile: SESSION_FILE, model: 'codemie/gpt-6-luna', startedAt: 1792858771592, endedAt: 1792858781564, exitCode: 0, toolCount: 3 }],
};
const COMPLETE = { id: RUN_ID, toolCallId: TOOL_CALL_ID, agent: 'scout', mode: 'single', success: true, state: 'complete', summary: '0', results: [] };

const T0 = '2026-10-24T16:19:30.000Z';
const T1 = '2026-10-24T16:19:31.000Z';

describe('agentIdFor', () => {
  it('keeps only the characters the server allows', () => {
    assert.equal(agentIdFor(TOOL_CALL_ID, 2), 'tc_call_A2O0NpUTAyF06iujQklPvo6mfc_03d24acb25306174016adcda91d09c8195988698d6e2ccebd9_2');
  });
});

describe('spawnsFromArgs', () => {
  it('reads a single task, tasks and a chain with a parallel step', () => {
    assert.deepEqual(spawnsFromArgs(ARGS), [{ agent: 'scout', task: ARGS.task }]);
    assert.equal(spawnsFromArgs({ tasks: [{ agent: 'a', task: 'x' }, { agent: 'b', task: 'y' }] }).length, 2);
    const chain = { chain: [{ agent: 'a', task: 'x' }, { parallel: [{ agent: 'b', task: 'y' }, { agent: 'c', task: 'z' }] }] };
    assert.deepEqual(spawnsFromArgs(chain).map((s) => s.agent), ['a', 'b', 'c']);
  });

  it('spawns nothing for a management call', () => {
    assert.deepEqual(spawnsFromArgs({ action: 'status', id: RUN_ID }), []);
    assert.deepEqual(spawnsFromArgs(null), []);
  });
});

describe('async run', () => {
  const start = startLines(TOOL_CALL_ID, ARGS, T0);
  const launched = endLines(TOOL_CALL_ID, start.length, ASYNC_LAUNCH, false, T0);
  const done = asyncCompleteLines(COMPLETE, STATUS, T1);

  it('starts an active agent with its type and prompt', () => {
    assert.equal(start.length, 1);
    const agent = fold(start);
    assert.ok(validateAgent(agent), JSON.stringify(validateAgent.errors));
    assert.equal(agent.status, 'active');
    assert.equal(agent.type, 'scout');
    assert.equal(agent.prompt, ARGS.task);
  });

  it('stays active after the launch returns', () => {
    assert.deepEqual(launched, [{ agentId: start[0].agentId, event: 'async', runId: RUN_ID, asyncDir: ASYNC_DIR, updatedAt: T0 }]);
    assert.equal(fold([...start, ...launched]).status, 'active');
  });

  it('stops with the model, session file and output from the status file', () => {
    const agent = fold([...start, ...launched, ...done]);
    assert.ok(validateAgent(agent), JSON.stringify(validateAgent.errors));
    assert.equal(agent.status, 'stopped');
    assert.equal(agent.type, 'scout');
    assert.equal(agent.model, 'codemie/gpt-6-luna');
    assert.equal(agent.sessionFile, SESSION_FILE);
    assert.equal(agent.lastMessage, '0');
    assert.equal(agent.runId, RUN_ID);
    assert.equal(agent.stoppedAt, new Date(1792858781564).toISOString());
    assert.equal(agent.stopReason, undefined);
  });

  it('skips a step that still runs', () => {
    const running = { ...STATUS, steps: [{ ...STATUS.steps[0], status: 'running' }] };
    assert.deepEqual(asyncCompleteLines(COMPLETE, running, T1), []);
  });

  it('marks a failed step', () => {
    const failed = { ...STATUS, steps: [{ ...STATUS.steps[0], status: 'failed', exitCode: 1 }] };
    const [line] = asyncCompleteLines({ ...COMPLETE, success: false, summary: 'boom' }, failed, T1);
    assert.equal(line.stopReason, 'error');
    assert.equal(line.error, 'boom');
    const [silent] = asyncCompleteLines({ ...COMPLETE, success: false, summary: undefined }, failed, T1);
    assert.equal(silent.stopReason, 'failed');
  });

  it('needs a tool call id', () => {
    assert.deepEqual(asyncCompleteLines({ id: RUN_ID }, null, T1), []);
  });
});

describe('foreground run', () => {
  const args = { tasks: [{ agent: 'scout', task: 'a' }, { agent: 'worker', task: 'b' }] };

  it('stops each child from its result', () => {
    const start = startLines('tc1', args, T0);
    const result = {
      details: {
        results: [
          { agent: 'scout', model: 'codemie/gpt-6-luna', finalOutput: 'found 3', exitCode: 0, sessionFile: 's0.jsonl' },
          { agent: 'worker', model: 'codemie/gpt-6-luna', output: 'partial', exitCode: 2 },
        ],
      },
    };
    const end = endLines('tc1', start.length, result, false, T1);
    const [scout, worker] = [0, 1].map((i) => fold([start[i], end[i]]));
    for (const agent of [scout, worker]) assert.ok(validateAgent(agent), JSON.stringify(validateAgent.errors));
    assert.deepEqual([scout.type, scout.status, scout.lastMessage, scout.sessionFile], ['scout', 'stopped', 'found 3', 's0.jsonl']);
    assert.equal(scout.stopReason, undefined);
    assert.deepEqual([worker.type, worker.lastMessage, worker.stopReason], ['worker', 'partial', 'failed']);
  });

  it('stops every child with the error when the call fails before a result', () => {
    const end = endLines('tc2', 2, { content: [{ type: 'text', text: 'Unknown agent: nope\nmore' }] }, true, T1);
    assert.deepEqual(end.map((l) => [l.agentId, l.error, l.stopReason]), [
      ['tc_tc2_0', 'Unknown agent: nope', 'error'],
      ['tc_tc2_1', 'Unknown agent: nope', 'error'],
    ]);
  });
});

describe('modelLines', () => {
  it('writes a model once per child', () => {
    const known = new Map();
    const partial = { details: { results: [{ model: 'codemie/gpt-6-luna' }, {}] } };
    assert.deepEqual(modelLines('tc3', partial, known, T0), [{ agentId: 'tc_tc3_0', event: 'update', model: 'codemie/gpt-6-luna', updatedAt: T0 }]);
    assert.deepEqual(modelLines('tc3', partial, known, T1), []);
    assert.deepEqual(modelLines('tc3', {}, known, T1), []);
  });
});
