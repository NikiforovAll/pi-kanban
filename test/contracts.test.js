const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } = require('fs');
const path = require('path');
const os = require('os');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const {
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  parseTaskNotification,
  parseAgentMessage,
  getSystemMessageLabel,
  readSessionInfoFromJsonl,
  readRecentMessages,
  readMessagesPage,
  buildAgentProgressMap,
  findTerminatedTeammates,
  extractPromptFromTranscript,
  extractModelFromTranscript,
  extractAgentResultFromTranscript,
  readScratchpadCreations,
  modelDisplayName
} = require('../lib/parsers');
const { readClaudeLines } = require('../lib/pi-transcript');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const SCHEMAS_DIR = path.join(__dirname, 'schemas');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadSchema(name) {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, name), 'utf8'));
}

function loadFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

function loadFixtureJson(name) {
  return JSON.parse(loadFixture(name));
}

const PI_PROJECT = path.join(FIXTURES_DIR, 'pi', 'agent', 'sessions', '--C--work-demo--');
const PI_FLAT = path.join(FIXTURES_DIR, 'pi', 'flat');
const piFile = (dir, n) => path.join(dir, readdirSync(dir).find((f) => f.endsWith(`-${String(n).padStart(12, '0')}.jsonl`)));
const PI = {
  chat: piFile(PI_PROJECT, 1),
  tools: piFile(PI_PROJECT, 2),
  compact: piFile(PI_PROJECT, 3),
  branch: piFile(PI_PROJECT, 4),
  fork: piFile(PI_FLAT, 5),
  posix: piFile(PI_FLAT, 6),
};
const CLAUDE_TRANSCRIPT = path.join(FIXTURES_DIR, 'session.jsonl');

// Entries get ids e1, e2, ... chained by parentId unless they bring their own.
function piSession(entries, header = {}) {
  const out = [{ type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd: 'C:\\proj', ...header }];
  let parentId = null;
  entries.forEach((e, i) => {
    const id = e.id || `e${i + 1}`;
    out.push({ timestamp: '2026-01-01T00:00:00.000Z', parentId, ...e, id });
    parentId = id;
  });
  return out.map((l) => `${JSON.stringify(l)}\n`).join('');
}
const piLine = (entry) => `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ...entry })}\n`;
const piUser = (content, extra) => ({ type: 'message', ...extra, message: { role: 'user', content } });
const piReply = (content, { model = 'gpt-6-luna', usage = { input: 1, output: 2, cacheRead: 100, cacheWrite: 0 }, stopReason = 'stop', ...extra } = {}) => ({
  type: 'message', ...extra, message: { role: 'assistant', content, model, provider: 'codemie', usage, stopReason },
});
const piText = (text) => [{ type: 'text', text }];
const piCall = (id, name, args, extra) => piReply([{ type: 'toolCall', id, name, arguments: args }], { stopReason: 'toolUse', ...extra });
const piResult = (toolCallId, toolName, text, extra) => ({
  type: 'message', message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false, ...extra },
});

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pk-test-'));
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    const out = fn(dir);
    if (out && typeof out.then === 'function') return out.finally(done);
    done();
    return out;
  } catch (err) {
    done();
    throw err;
  }
}
const writeTmp = (dir, text, name = 's.jsonl') => {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  return p;
};

// --- Schema validation tests ---

describe('Schema: Task JSON', () => {
  const validate = ajv.compile(loadSchema('task.schema.json'));

  it('validates completed task', () => {
    assert.ok(validate(loadFixtureJson('task-completed.json')), JSON.stringify(validate.errors));
  });

  it('validates in-progress task', () => {
    assert.ok(validate(loadFixtureJson('task-in-progress.json')), JSON.stringify(validate.errors));
  });

  it('validates pending task', () => {
    assert.ok(validate(loadFixtureJson('task-pending.json')), JSON.stringify(validate.errors));
  });

  it('validates internal task', () => {
    assert.ok(validate(loadFixtureJson('task-internal.json')), JSON.stringify(validate.errors));
  });

  it('rejects task with invalid status', () => {
    assert.ok(!validate({ id: '1', subject: 'test', status: 'unknown' }));
  });

  it('rejects task without required fields', () => {
    assert.ok(!validate({ subject: 'test' }));
  });
});

describe('Schema: Agent JSON', () => {
  const validate = ajv.compile(loadSchema('agent.schema.json'));

  it('validates active agent', () => {
    assert.ok(validate(loadFixtureJson('agent-active.json')), JSON.stringify(validate.errors));
  });

  it('validates stopped agent', () => {
    assert.ok(validate(loadFixtureJson('agent-stopped.json')), JSON.stringify(validate.errors));
  });

  it('rejects agent with invalid status', () => {
    assert.ok(!validate({ agentId: 'x', status: 'running', startedAt: '2026-01-01T00:00:00Z' }));
  });

  it('rejects agent without agentId', () => {
    assert.ok(!validate({ status: 'active', startedAt: '2026-01-01T00:00:00Z' }));
  });
});

describe('Schema: Waiting JSON', () => {
  const validate = ajv.compile(loadSchema('waiting.schema.json'));

  it('validates waiting-for-permission', () => {
    assert.ok(validate(loadFixtureJson('waiting-permission.json')), JSON.stringify(validate.errors));
  });

  it('rejects without timestamp', () => {
    assert.ok(!validate({ status: 'waiting' }));
  });

  it('accepts the cleared marker', () => {
    assert.ok(validate({ status: 'cleared' }));
  });
});

describe('Schema: Team Config', () => {
  const validate = ajv.compile(loadSchema('team-config.schema.json'));

  it('validates team config', () => {
    assert.ok(validate(loadFixtureJson('team-config.json')), JSON.stringify(validate.errors));
  });

  it('rejects without members', () => {
    assert.ok(!validate({ name: 'test', leadAgentId: 'x' }));
  });
});

describe('Schema: Sessions Index', () => {
  const validate = ajv.compile(loadSchema('sessions-index.schema.json'));

  it('validates sessions index', () => {
    assert.ok(validate(loadFixtureJson('sessions-index.json')), JSON.stringify(validate.errors));
  });

  it('rejects without entries', () => {
    assert.ok(!validate({ version: 1 }));
  });
});

describe('Schema: pi session entries', () => {
  const validate = ajv.compile(loadSchema('pi-session-entry.schema.json'));

  it('validates every line of every pi fixture', () => {
    for (const file of Object.values(PI)) {
      for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
        const obj = JSON.parse(line);
        assert.ok(validate(obj), `${path.basename(file)} type="${obj.type}" failed: ${JSON.stringify(validate.errors)}`);
      }
    }
  });

  it('rejects an entry without a parentId', () => {
    assert.ok(!validate({ type: 'model_change', id: 'x', timestamp: 't', provider: 'p', modelId: 'm' }));
  });
});

describe('Schema: Session JSONL Lines', () => {
  const validate = ajv.compile(loadSchema('session-jsonl-line.schema.json'));

  it('validates every line the pi fixtures map to', () => {
    const types = new Set();
    for (const file of Object.values(PI)) {
      for (const obj of readClaudeLines(file)) {
        types.add(obj.subtype ? `${obj.type}:${obj.subtype}` : obj.type);
        assert.ok(validate(obj), `${path.basename(file)} type="${obj.type}" failed: ${JSON.stringify(validate.errors)}`);
      }
    }
    assert.deepEqual([...types].sort(), [
      'assistant', 'custom-title', 'system:compact_boundary', 'system:model_change', 'system:thinking_level_change', 'user',
    ]);
  });
});

// --- Parser unit tests ---

describe('Parser: parseTask', () => {
  it('parses completed task', () => {
    const task = parseTask(loadFixture('task-completed.json'));
    assert.equal(task.id, '1');
    assert.equal(task.status, 'completed');
    assert.equal(task.isInternal, false);
  });

  it('detects internal tasks', () => {
    const task = parseTask(loadFixture('task-internal.json'));
    assert.equal(task.isInternal, true);
  });

  it('handles missing optional fields', () => {
    const task = parseTask('{"id":"1","subject":"test","status":"pending"}');
    assert.equal(task.description, null);
    assert.deepEqual(task.blocks, []);
    assert.deepEqual(task.blockedBy, []);
  });
});

describe('Parser: parseAgent', () => {
  it('parses active agent', () => {
    const agent = parseAgent(loadFixture('agent-active.json'));
    assert.equal(agent.agentId, 'abc123def456');
    assert.equal(agent.status, 'active');
    assert.equal(agent.stoppedAt, null);
  });

  it('parses stopped agent', () => {
    const agent = parseAgent(loadFixture('agent-stopped.json'));
    assert.equal(agent.status, 'stopped');
    assert.ok(agent.stoppedAt);
  });
});

describe('Parser: parseWaiting', () => {
  it('parses permission waiting', () => {
    const w = parseWaiting(loadFixture('waiting-permission.json'));
    assert.equal(w.status, 'waiting');
    assert.equal(w.kind, 'permission');
    assert.equal(w.toolName, 'Bash');
  });
});

describe('Parser: parseTeamConfig', () => {
  it('parses team config with members', () => {
    const config = parseTeamConfig(loadFixture('team-config.json'));
    assert.equal(config.name, 'test-team-alpha');
    assert.equal(config.members.length, 2);
    assert.equal(config.members[0].agentType, 'team-lead');
    assert.equal(config.leadSessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('parses member color field', () => {
    const config = parseTeamConfig(loadFixture('team-config.json'));
    assert.equal(config.members[0].color, 'red');
    assert.equal(config.members[1].color, 'blue');
  });

  it('defaults color to null when missing', () => {
    const config = parseTeamConfig(JSON.stringify({
      name: 'no-color-team',
      leadAgentId: 'lead',
      members: [{ agentId: 'a1', name: 'worker' }]
    }));
    assert.equal(config.members[0].color, null);
  });
});

describe('Parser: parseSessionsIndex', () => {
  it('parses sessions index', () => {
    const index = parseSessionsIndex(loadFixture('sessions-index.json'));
    assert.equal(index.entries.length, 2);
    assert.equal(index.entries[0].gitBranch, 'feat/logging');
    assert.equal(index.entries[1].description, 'Quick fix session');
  });
});

describe('Parser: parseJsonlLine', () => {
  const chat = readClaudeLines(PI.chat);
  const tools = readClaudeLines(PI.tools);

  it('parses a mapped system line to its base fields', () => {
    const parsed = parseJsonlLine(chat[0]);
    assert.deepEqual(parsed, { type: 'system', timestamp: '2026-10-24T10:00:00.100Z', sessionId: '01a20000-0000-7000-8000-000000000001', uuid: 'a0000001' });
  });

  it('parses user message', () => {
    const parsed = parseJsonlLine(chat.find((l) => l.message?.content === 'And in French?'));
    assert.equal(parsed.role, 'user');
    assert.equal(parsed.content, 'And in French?');
    assert.equal(parsed.isMeta, false);
  });

  it('parses assistant text message', () => {
    const parsed = parseJsonlLine(chat.find((l) => l.type === 'assistant'));
    assert.equal(parsed.role, 'assistant');
    assert.equal(parsed.model, 'gpt-6-luna');
    assert.deepEqual(parsed.blocks.map((b) => b.type), ['thinking', 'text']);
  });

  it('parses assistant tool_use message', () => {
    const parsed = parseJsonlLine(tools.find((l) => l.type === 'assistant'));
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].type, 'tool_use');
    assert.equal(parsed.blocks[0].name, 'Read');
    assert.equal(parsed.blocks[0].input.file_path, 'C:\\work\\demo\\README.md');
  });

  it('parses queued message (queue-operation enqueue)', () => {
    const parsed = parseJsonlLine(JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-06-06T16:00:44.682Z',
      sessionId: 'abc',
      content: 'can we use gold for user message'
    }));
    assert.equal(parsed.role, 'user');
    assert.equal(parsed.queued, true);
    assert.equal(parsed.content, 'can we use gold for user message');
  });
});

describe('Parser: readRecentMessages', () => {
  const tools = () => readRecentMessages(PI.tools, 100);

  it('reads user and assistant messages', () => {
    assert.deepEqual(readRecentMessages(PI.chat, 30).map((m) => [m.type, m.text]), [
      ['user', 'Say hello in one word.'],
      ['assistant', 'Hello.'],
      ['user', 'And in French?'],
      ['assistant', 'Bonjour.'],
    ]);
  });

  it('maps pi tool names to the Claude tool names', () => {
    assert.deepEqual(tools().filter((m) => m.type === 'tool_use').map((m) => m.tool), ['Read', 'Bash', 'Edit', 'TodoWrite', 'Agent', 'Agent', 'Agent']);
  });

  it('extracts the file and command details', () => {
    const read = tools().find((m) => m.tool === 'Read');
    assert.equal(read.detail, 'README.md');
    assert.equal(read.fullDetail, 'C:\\work\\demo\\README.md');
    assert.equal(tools().find((m) => m.tool === 'Bash').detail, 'npm test');
  });

  it('attaches tool results, an error result included', () => {
    const msgs = tools();
    assert.equal(msgs.find((m) => m.tool === 'Read').toolResult, '# Demo\n\nTeh demo app.');
    assert.ok(msgs.find((m) => m.tool === 'Bash').toolResult.includes('Missing script'));
  });

  it('gives an Edit its old and new strings', () => {
    const edit = tools().find((m) => m.tool === 'Edit');
    assert.deepEqual(edit.params, { file_path: 'C:\\work\\demo\\README.md', old_string: 'Teh demo', new_string: 'The demo' });
  });

  it('keeps every edit of a multi-edit call', () => withTmp((dir) => {
    const p = writeTmp(dir, piSession([piCall('c1', 'edit', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] })]));
    const edit = readRecentMessages(p, 10).find((m) => m.tool === 'Edit');
    assert.deepEqual(edit.params.edits, [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }]);
  }));

  it('extracts the subagent fields', () => {
    const agent = tools().find((m) => m.tool === 'Agent');
    assert.equal(agent.toolUseId, 'call_s1|fc_s1');
    assert.equal(agent.agentType, 'scout');
    assert.equal(agent.agentPrompt, 'List the files in the current directory and reply with just the count.');
  });

  it('shows a failed reply, a shell command and no hidden extension message', () => {
    const msgs = tools();
    assert.ok(msgs.some((m) => m.type === 'assistant' && m.text === 'Error: 529 overloaded'));
    const shell = msgs.find((m) => m.systemLabel === 'Shell command');
    assert.equal(shell.text, '$ git status --short\n M README.md');
    assert.ok(!msgs.some((m) => m.text?.includes('Background task completed')));
  });

  it('renders a compaction as a chip with its summary', () => {
    const chip = readRecentMessages(PI.compact, 30).find((m) => m.systemLabel === 'Compacted');
    assert.equal(chip.compactSummary, '## Goal\nPlan the release.\n\n## Progress\nSteps 1 and 2 drafted.');
  });

  it('shows only the active branch, with the branch summary', () => {
    const msgs = readRecentMessages(PI.branch, 30);
    assert.deepEqual(msgs.map((m) => m.text), ['Pick a name for the CLI.', 'How about demo?', 'Tried a longer name; the user went back.', 'Make it shorter.', 'dm']);
    assert.equal(msgs[2].systemLabel, 'Branch summary');
  });

  it('respects limit', () => {
    assert.deepEqual(readRecentMessages(PI.chat, 2).map((m) => m.text), ['And in French?', 'Bonjour.']);
  });

  it('returns empty for a missing file and for a file without a pi header', () => {
    assert.deepEqual(readRecentMessages('/nonexistent/path.jsonl', 10), []);
    assert.deepEqual(readRecentMessages(CLAUDE_TRANSCRIPT, 10), []);
  });

  it('shows entries appended to a growing session', () => withTmp((dir) => {
    const p = writeTmp(dir, piSession([piUser('hi'), piReply(piText('hello'))]));
    assert.equal(readRecentMessages(p, 10).length, 2);
    appendFileSync(p, piLine(piUser('more', { id: 'e3', parentId: 'e2' })));
    assert.deepEqual(readRecentMessages(p, 10).map((m) => m.text), ['hi', 'hello', 'more']);
  }));
});

describe('Parser: findTerminatedTeammates', () => {
  it('returns an empty map for a missing file and for a pi session', async () => {
    assert.deepEqual(await findTerminatedTeammates('/nonexistent/path.jsonl'), new Map());
    assert.deepEqual(await findTerminatedTeammates(PI.tools), new Map());
  });
});

describe('Parser: buildAgentProgressMap', () => {
  it('maps a sync subagent call to its agent id, prompt and usage', async () => {
    const map = await buildAgentProgressMap(PI.tools);
    assert.deepEqual(map['call_s1|fc_s1'], {
      agentId: 'tc_call_s1fc_s1_0',
      prompt: 'List the files in the current directory and reply with just the count.',
      usage: { tokens: 39, tools: 1, durationMs: 9193 },
      usageText: ' · 39 tok · 1 tool · 9s',
    });
  });

  it('maps an async launch without usage and skips a status call', async () => {
    const map = await buildAgentProgressMap(PI.tools);
    assert.deepEqual(map['call_s2|fc_s2'], { agentId: 'tc_call_s2fc_s2_0', prompt: 'Summarize README.md in one line.', usage: null, usageText: null });
    assert.deepEqual(Object.keys(map).sort(), ['call_s1|fc_s1', 'call_s2|fc_s2']);
  });

  it('returns empty map for non-existent file', async () => {
    assert.deepEqual(await buildAgentProgressMap('/nonexistent/path.jsonl'), {});
  });
});

describe('Parser: readSessionInfoFromJsonl', () => {
  const CLAUDE_ONLY = ['gitBranch', 'agentName', 'logicalParentUuid', 'compactBoundaryUuid', 'permissionMode', 'cacheTtl'];

  it('reads the header, the name and the first prompt', () => {
    const info = readSessionInfoFromJsonl(PI.chat);
    assert.equal(info.projectPath, 'C:\\work\\demo');
    assert.equal(info.cwd, 'C:\\work\\demo');
    assert.equal(info.sessionId, '01a20000-0000-7000-8000-000000000001');
    assert.equal(info.customTitle, 'Greeting');
    assert.equal(info.firstPrompt, 'Say hello in one word.');
    assert.equal(info.parentSessionPath, null);
  });

  it('leaves the fields pi does not write null', () => {
    const info = readSessionInfoFromJsonl(PI.tools);
    for (const k of CLAUDE_ONLY) assert.equal(info[k], null, k);
  });

  it('reads the parent session path of a fork', () => {
    assert.equal(readSessionInfoFromJsonl(PI.fork).parentSessionPath, 'C:\\pi\\agent\\sessions\\--C--work-demo--\\2026-10-24T12-00-00-000Z_01a20000-0000-7000-8000-000000000004.jsonl');
  });

  it('skips a shell command when it looks for the first prompt', () => withTmp((dir) => {
    const p = writeTmp(dir, piSession([
      { type: 'message', message: { role: 'bashExecution', command: 'ls', output: 'a', exitCode: 0 } },
      piUser('real prompt'),
    ]));
    assert.equal(readSessionInfoFromJsonl(p).firstPrompt, 'real prompt');
  }));

  it('titles the session by the first line of the first prompt, cut short', () => withTmp((dir) => {
    const short = writeTmp(dir, piSession([piUser('  Fix the build\r\nthen run tests')]));
    assert.equal(readSessionInfoFromJsonl(short).title, 'Fix the build');
    const long = writeTmp(dir, piSession([piUser('x'.repeat(80))]));
    assert.equal(readSessionInfoFromJsonl(long).title, `${'x'.repeat(59)}…`);
  }));

  it('takes the scratchpad dir from the last entry the kanban extension recorded', () => withTmp((dir) => {
    const pad = (d) => ({ type: 'custom', customType: 'pi-kanban.scratchpad', data: { dir: d } });
    const p = writeTmp(dir, piSession([pad('C:\\t\\one'), piUser('hi'), { type: 'custom', customType: 'other', data: { dir: 'x' } }, pad('C:\\t\\two')]));
    assert.equal(readSessionInfoFromJsonl(p).scratchpadDir, 'C:\\t\\two');
    assert.equal(readSessionInfoFromJsonl(PI.tools).scratchpadDir, null);
  }));

  it('returns null fields for a missing file and for a file without a pi header', () => {
    for (const p of ['/nonexistent/path.jsonl', CLAUDE_TRANSCRIPT]) {
      const info = readSessionInfoFromJsonl(p);
      for (const k of ['projectPath', 'customTitle', 'sessionId', 'firstPrompt', 'title', 'lastReply', 'scratchpadDir', ...CLAUDE_ONLY]) assert.equal(info[k], null, `${p} ${k}`);
    }
  });

  it('takes the latest session name as the file grows, and an empty name clears it', () => withTmp((dir) => {
    const p = writeTmp(dir, piSession([piUser('hi'), { type: 'session_info', name: 'One' }]));
    assert.equal(readSessionInfoFromJsonl(p).customTitle, 'One');
    appendFileSync(p, piLine({ type: 'session_info', id: 'e3', parentId: 'e2', name: 'Two' }));
    assert.equal(readSessionInfoFromJsonl(p).customTitle, 'Two');
    appendFileSync(p, piLine({ type: 'session_info', id: 'e4', parentId: 'e3', name: ' ' }));
    assert.equal(readSessionInfoFromJsonl(p).customTitle, null);
  }));

  describe('lastReply', () => {
    const T = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;
    const user = (s, extra) => piUser('hi', { timestamp: T(s), ...extra });
    const reply = (s, opts) => piReply(piText('ok'), { timestamp: T(s), ...opts });
    const usage = (read, write) => ({ input_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 2 });
    let dir;
    let p;
    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'pk-reply-'));
      p = path.join(dir, 's.jsonl');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('takes the last reply, timed by the request before it, as the file grows', () => {
      writeFileSync(p, piSession([user(1), reply(5, { usage: { input: 1, output: 2, cacheRead: 100, cacheWrite: 300 } })]));
      assert.deepEqual(readSessionInfoFromJsonl(p).lastReply, { at: Date.parse(T(1)), model: 'gpt-6-luna', usage: usage(100, 300) });
      appendFileSync(p, piLine(user(10, { id: 'e3', parentId: 'e2' })) + piLine(reply(14, { id: 'e4', parentId: 'e3', model: 'claude-fable-5-1' })));
      assert.deepEqual(readSessionInfoFromJsonl(p).lastReply, { at: Date.parse(T(10)), model: 'claude-fable-5-1', usage: usage(100, 0) });
    });

    it('ignores a reply on an abandoned branch', () => {
      writeFileSync(p, piSession([user(1), reply(5), user(10), reply(12, { model: 'claude-fable-5-1' }), user(20, { id: 'e5', parentId: 'e2' })]));
      assert.deepEqual(readSessionInfoFromJsonl(p).lastReply, { at: Date.parse(T(1)), model: 'gpt-6-luna', usage: usage(100, 0) });
    });

    it('a compaction after the reply clears its usage', () => {
      writeFileSync(p, piSession([user(1), reply(5), { type: 'compaction', summary: 's', firstKeptEntryId: 'e1', tokensBefore: 10, timestamp: T(50) }]));
      assert.deepEqual(readSessionInfoFromJsonl(p).lastReply, { at: Date.parse(T(1)), model: 'gpt-6-luna', usage: null });
    });

    it('skips a reply that stopped on a provider error', () => {
      const failed = reply(12, { model: 'claude-fable-5-1', stopReason: 'error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      writeFileSync(p, piSession([user(1), reply(5), user(10), failed]));
      assert.deepEqual(readSessionInfoFromJsonl(p).lastReply, { at: Date.parse(T(1)), model: 'gpt-6-luna', usage: usage(100, 0) });
    });
  });

  it('modelDisplayName matches the plugin mod', () => {
    assert.equal(modelDisplayName('claude-opus-5-5'), 'Opus 5.5');
    assert.equal(modelDisplayName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
    assert.equal(modelDisplayName('claude-fable-5-1[1m]'), 'Fable 5.1');
    assert.equal(modelDisplayName('claude-opus-4-20250514'), 'Opus 4');
    assert.equal(modelDisplayName('gpt-x'), 'gpt-x');
  });
});

describe('Session cache across restarts', () => {
  const { execFileSync } = require('child_process');
  const { utimesSync } = require('fs');
  const lines = (prompt, title) => piSession([piUser(prompt), { type: 'session_info', name: title }]);
  // Each call is a fresh process, so the in-memory caches start empty and only the file carries state.
  const run = (op, cacheFile, jsonl) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const { loadSessionCache, saveSessionCache } = require(${JSON.stringify(path.join(__dirname, '../lib/session-cache'))});
    const { readSessionInfoFromJsonl } = require(${JSON.stringify(path.join(__dirname, '../lib/parsers'))});
    const [op, cacheFile, jsonl] = process.argv.slice(1);
    const loaded = loadSessionCache(cacheFile);
    const info = readSessionInfoFromJsonl(jsonl);
    if (op === 'save') saveSessionCache((data) => require('fs').writeFileSync(cacheFile, JSON.stringify(data)));
    console.log(JSON.stringify({ loaded, prompt: info.firstPrompt, title: info.customTitle }));
  `, op, cacheFile, jsonl], { encoding: 'utf8' }));

  let dir, cacheFile, jsonl;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pk-cache-'));
    cacheFile = path.join(dir, 'session-cache.json');
    jsonl = path.join(dir, 's1.jsonl');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  // Whole seconds, because utimes cannot set the sub-millisecond part a real write leaves.
  const T0 = new Date('2026-01-01T00:00:00Z');
  const writeAt = (prompt, title, t = T0) => {
    writeFileSync(jsonl, lines(prompt, title));
    utimesSync(jsonl, t, t);
  };

  it('reuses entries of an unchanged file from the last run', () => {
    writeAt('one', 'Alpha');
    assert.deepEqual(run('save', cacheFile, jsonl), { loaded: false, prompt: 'one', title: 'Alpha' });
    writeAt('two', 'Brava');
    assert.deepEqual(run('read', cacheFile, jsonl), { loaded: true, prompt: 'one', title: 'Alpha' });
  });

  it('rescans a file rewritten in place with the same size', () => {
    writeAt('one', 'Alpha');
    run('save', cacheFile, jsonl);
    writeAt('two', 'Brava', new Date(T0.getTime() + 5000));
    assert.deepEqual(run('read', cacheFile, jsonl), { loaded: true, prompt: 'two', title: 'Brava' });
  });

  it('reads a file that grew again from the start', () => {
    writeAt('one', 'Alpha');
    run('save', cacheFile, jsonl);
    writeAt('two', 'Brava');
    writeFileSync(jsonl, piLine({ type: 'session_info', id: 'e3', parentId: 'e2', name: 'Gamma' }), { flag: 'a' });
    assert.deepEqual(run('read', cacheFile, jsonl), { loaded: true, prompt: 'two', title: 'Gamma' });
  });

  it('ignores a cache file of another version', () => {
    writeAt('one', 'Alpha');
    run('save', cacheFile, jsonl);
    const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
    writeFileSync(cacheFile, JSON.stringify({ ...data, version: data.version + 1 }));
    writeAt('two', 'Brava');
    assert.deepEqual(run('read', cacheFile, jsonl), { loaded: false, prompt: 'two', title: 'Brava' });
  });

  it('drops entries of deleted transcripts on save', () => {
    const gone = path.join(dir, 'gone.jsonl');
    writeFileSync(gone, lines('gone', 'Gone'));
    run('save', cacheFile, gone);
    rmSync(gone);
    writeFileSync(jsonl, lines('one', 'Alpha'));
    run('save', cacheFile, jsonl);
    const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.deepEqual(data.info.map(([p]) => p), [jsonl]);
  });
});

describe('Parser: readMessagesPage', () => {
  it('returns messages array and hasMore flag', () => {
    const result = readMessagesPage(PI.tools, 100);
    assert.equal(result.messages.length, 12);
    assert.equal(result.hasMore, false);
    for (const msg of result.messages) {
      assert.ok('type' in msg, 'message should have type');
      assert.ok('timestamp' in msg, 'message should have timestamp');
    }
  });

  it('respects limit and reports more', () => {
    const result = readMessagesPage(PI.tools, 3);
    assert.equal(result.messages.length, 3);
    assert.equal(result.hasMore, true);
  });

  it('filters by beforeTimestamp', () => {
    const all = readMessagesPage(PI.tools, 1000);
    const cutoff = all.messages[all.messages.length - 1].timestamp;
    const filtered = readMessagesPage(PI.tools, 1000, cutoff);
    assert.equal(filtered.messages.length, all.messages.length - 1);
    for (const msg of filtered.messages) {
      assert.ok(msg.timestamp < cutoff, `message timestamp ${msg.timestamp} should be < ${cutoff}`);
    }
  });

  it('returns empty messages for non-existent file', () => {
    const result = readMessagesPage('/nonexistent/path.jsonl', 10);
    assert.deepEqual(result.messages, []);
    assert.equal(result.hasMore, false);
  });
});

describe('Parser: extractPromptFromTranscript', () => {
  it('takes the text of the first user message with content blocks', () => {
    assert.equal(extractPromptFromTranscript(PI.chat), 'Say hello in one word.');
  });

  it('takes a string prompt', () => withTmp((dir) => {
    assert.equal(extractPromptFromTranscript(writeTmp(dir, piSession([piUser('Please fix the authentication bug')]))), 'Please fix the authentication bug');
  }));

  it('returns null without a user message', () => withTmp((dir) => {
    assert.equal(extractPromptFromTranscript(writeTmp(dir, piSession([piReply(piText('x'))]))), null);
  }));

  it('throws for non-existent file', () => {
    assert.throws(() => extractPromptFromTranscript('/nonexistent/path.jsonl'));
  });

  it('returns long content in full (no truncation)', () => withTmp((dir) => {
    const longText = 'x'.repeat(600);
    assert.equal(extractPromptFromTranscript(writeTmp(dir, piSession([piUser(longText)]))), longText);
  }));
});

describe('Parser: extractModelFromTranscript', () => {
  it('takes the model of the first reply', () => {
    assert.equal(extractModelFromTranscript(PI.chat), 'gpt-6-luna');
    assert.equal(extractModelFromTranscript(PI.compact), 'gpt-6-luna');
  });

  it('takes a model change before any reply', () => withTmp((dir) => {
    const p = writeTmp(dir, piSession([{ type: 'model_change', provider: 'anthropic', modelId: 'claude-opus-5-5' }, piUser('hi')]));
    assert.equal(extractModelFromTranscript(p), 'claude-opus-5-5');
  }));

  it('finds the model after a long first prompt', () => withTmp((dir) => {
    const p = writeTmp(dir, piSession([piUser('x'.repeat(150000)), piReply(piText('a'), { model: 'claude-opus-5-5' })]));
    assert.equal(extractModelFromTranscript(p), 'claude-opus-5-5');
  }));

  it('returns null when no line has a model', () => withTmp((dir) => {
    assert.equal(extractModelFromTranscript(writeTmp(dir, piSession([piUser('hi')]))), null);
  }));

  it('throws for non-existent file', () => {
    assert.throws(() => extractModelFromTranscript('/nonexistent/path.jsonl'));
  });
});

describe('Parser: readScratchpadCreations', () => {
  const call = (command, id = 'call_1') => piCall(id, 'bash', { command }, { timestamp: '2026-03-05T10:00:00.344Z' });
  const result = (text, id = 'call_1') => ({ ...piResult(id, 'bash', text), timestamp: '2026-03-05T10:00:01.000Z' });
  const run = (entries) => withTmp((dir) => readScratchpadCreations(writeTmp(dir, piSession(entries))));

  it('takes the printed manifest path as the answer', async () => {
    const out = 'pad dir   : C:\\p\\notes\\demo\n  manifest  : C:\\p\\notes\\demo\\scratchpad.json';
    const rows = await run([call('scratch new "demo" --dir notes'), result(out)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, 'C:\\p\\notes\\demo\\scratchpad.json');
  });

  it('reads the pad name out of the command when the output was piped away', async () => {
    const rows = await run([call('scratch new "in-app-feedback" --dir _plans 2>&1 | tail -3'), result('not ignored')]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, null);
    assert.equal(rows[0].name, 'in-app-feedback');
    assert.equal(rows[0].ts, Date.parse('2026-03-05T10:00:00.344Z'));
  });

  it('reads single-quoted and bare names, and survives a leading cd', async () => {
    assert.equal((await run([call("cd '/repo'; scratch new 'vid promo' --dir x")]))[0].name, 'vid promo');
    assert.equal((await run([call('scratch new notes')]))[0].name, 'notes');
  });

  it('does not mistake a flag for the name', async () => {
    assert.equal((await run([call('scratch new --dir _plans')]))[0].name, null);
  });

  it('ignores a transcript with no scratch new call', async () => {
    assert.deepEqual(await run([call('ls -la')]), []);
  });
});

describe('Compaction chips', () => {
  it('gives each chip on an older page its own summary', () => withTmp((dir) => {
    const user = (text, timestamp) => piUser(text, { timestamp });
    const compact = (summary, timestamp) => ({ type: 'compaction', summary, firstKeptEntryId: 'e1', tokensBefore: 10, timestamp });
    const p = writeTmp(dir, piSession([
      user('start', '2026-03-05T10:00:00.000Z'),
      compact('Summary one', '2026-03-05T10:10:00.000Z'),
      user('after one', '2026-03-05T10:15:00.000Z'),
      compact('Summary two', '2026-03-05T10:20:00.000Z'),
      user('after two', '2026-03-05T10:25:00.000Z'),
      compact('Summary three', '2026-03-05T10:30:00.000Z'),
      user('after three', '2026-03-05T10:35:00.000Z'),
    ]));
    const chips = readMessagesPage(p, 4, '2026-03-05T10:40:00.000Z').messages.filter((m) => m.systemLabel === 'Compacted');
    assert.deepEqual(chips.map((c) => [c.timestamp, c.compactSummary]), [
      ['2026-03-05T10:20:00.000Z', 'Summary two'],
      ['2026-03-05T10:30:00.000Z', 'Summary three'],
    ]);
  }));
});

// --- Background task-notification parsing ---
// Locks how a <task-notification> envelope (injected as a user message when a
// background agent finishes) is parsed. Without this, the raw text renders as
// jibberish: the task-id/tool-use-id/output-file collapse into one run-on line
// and <usage> becomes the concatenated number "223166118942".

describe('parseTaskNotification', () => {
  const raw = loadFixture('task-notification.txt');

  it('extracts the envelope metadata fields', () => {
    const n = parseTaskNotification(raw);
    assert.equal(n.taskId, 'ae80b022c427830bd');
    assert.equal(n.toolUseId, 'toolu_01ADyr5ZhrBszz2DR2SuDfmm');
    assert.equal(
      n.outputFile,
      'C:\\Users\\NIKIFO~1\\AppData\\Local\\Temp\\claude\\C--Users-nikiforovall-dev-claude-code-hub\\854e2df3-1604-474e-9e7a-6e8f1a4bf09c\\tasks\\ae80b022c427830bd.output'
    );
    assert.equal(n.status, 'completed');
    assert.equal(n.summary, 'Agent "Emulate work A" completed');
  });

  it('keeps the agent result intact and excludes the wrapper', () => {
    const n = parseTaskNotification(raw);
    assert.ok(n.result.startsWith('test agent A done'));
    assert.ok(n.result.includes('Total active time ~90s via spaced waits.'));
    assert.ok(!n.result.includes('<task-notification>'));
    assert.ok(!n.result.includes('<usage>'));
  });

  it('parses <usage> into structured numbers (the "223166118942" run-on)', () => {
    const { usage } = parseTaskNotification(raw);
    assert.deepEqual(usage, { subagentTokens: 22316, toolUses: 6, durationMs: 118942 });
  });

  it('returns null for non-notification text', () => {
    assert.equal(parseTaskNotification('just a normal message'), null);
    assert.equal(parseTaskNotification(null), null);
    assert.equal(parseTaskNotification(undefined), null);
  });

  it('getSystemMessageLabel uses the summary as the chip label', () => {
    assert.equal(getSystemMessageLabel(raw), 'Agent "Emulate work A" completed');
  });

  // <result>/<usage> carry unescaped agent text. When an agent describes this very
  // format, its reply contains literal </result> and a fake <usage> block. The real
  // closing tags are always last, so parsing must NOT truncate on the embedded ones.
  it('does not truncate when the result embeds literal </result> and <usage>', () => {
    const adv = parseTaskNotification(loadFixture('task-notification-adversarial.txt'));
    assert.equal(adv.taskId, 'deadbeef1234');
    assert.equal(adv.summary, 'Agent "format explainer" completed');
    // Full result kept, including the embedded markers it describes.
    assert.ok(adv.result.includes('<result>...</result>'));
    assert.ok(adv.result.includes('those numbers above are an EXAMPLE'));
    assert.ok(adv.result.endsWith('not the real ones.'));
    // The REAL usage (last block) wins over the example embedded in the result.
    assert.deepEqual(adv.usage, { subagentTokens: 22316, toolUses: 6, durationMs: 118942 });
  });
});

// A subagent handing its report back through SendMessage arrives wrapped in an
// <agent-message> envelope with harness security notes around it. Unparsed, the
// whole frame renders under a person icon as if the user had typed it.
describe('parseAgentMessage', () => {
  const raw = loadFixture('agent-handback.txt');

  it('labels the hand-back with the sender and keeps only the report', () => {
    const a = parseAgentMessage(raw);
    assert.equal(a.from, 'abd86c3f28b1c29ad');
    assert.equal(a.label, 'Subagent hand-back · abd86c3f');
    assert.ok(a.body.startsWith('Wrote `scratchpad/specdev-permissions.md`.'));
    assert.ok(a.body.includes('**Counts:** 39 findings total'));
    assert.ok(a.body.endsWith('appear verbatim in the corpus.'));
  });

  it('drops the envelope, the frame and the trailing authority note', () => {
    const { body } = parseAgentMessage(raw);
    assert.ok(!body.includes('<agent-message'));
    assert.ok(!body.includes('[Subagent hand-back]'));
    assert.ok(!body.includes('carry no user authority'));
    assert.ok(!body.includes('Another Claude session sent a message'));
  });

  it('labels a plain agent message (no hand-back frame)', () => {
    const a = parseAgentMessage('<agent-message from="af63655dfcad86551">\nboard moved task #4\n</agent-message>');
    assert.equal(a.label, 'Agent message · af63655d');
    assert.equal(a.body, 'board moved task #4');
  });

  // A named sender ("code-review") is not a hex agent id — truncating it to eight
  // characters renders "code-rev".
  it('shows a named sender whole and truncates only a hex agent id', () => {
    const named = parseAgentMessage('<agent-message from="code-review">\nlooks fine\n</agent-message>');
    assert.equal(named.label, 'Agent message · code-review');
  });

  // The envelope must OPEN the message. A user prompt (or an agent report) that
  // quotes the tag while describing the format must stay a user message.
  it('ignores prose that merely quotes the envelope', () => {
    assert.equal(
      parseAgentMessage('Here is the shape to parse: <agent-message from="ID">body</agent-message> — got it?'),
      null
    );
  });

  it('accepts the harness preamble before the envelope', () => {
    const a = parseAgentMessage(
      'Another Claude session sent a message while you were working:\n<agent-message from="deadbeef12345678">\nhi\n</agent-message>'
    );
    assert.equal(a.body, 'hi');
  });

  it('takes the LAST closing tag, so a body quoting the envelope is not truncated', () => {
    const a = parseAgentMessage(
      '<agent-message from="deadbeef12345678">\nthe frame ends with </agent-message> like so\n</agent-message>'
    );
    assert.ok(a.body.includes('</agent-message> like so'));
  });

  it('returns null for non-agent text', () => {
    assert.equal(parseAgentMessage('just a normal message'), null);
    assert.equal(parseAgentMessage(null), null);
    assert.equal(parseAgentMessage(undefined), null);
  });
});

describe('Parser: extractAgentResultFromTranscript', () => {
  const toolUse = (name, input) => piCall(`call_${name}`, name, input);
  const text = (t) => piReply(piText(t));
  const extract = (entries) => withTmp((dir) => extractAgentResultFromTranscript(writeTmp(dir, piSession(entries))));

  it('takes the message of a SubagentHandback call', () => {
    assert.equal(extract([text('working'), toolUse('SubagentHandback', { message: 'I found 7 findings.' })]), 'I found 7 findings.');
  });

  it('formats a StructuredOutput call', () => {
    assert.equal(extract([toolUse('StructuredOutput', { summary: 'ok', items: [1] })]), '### summary\n\nok\n\n### items\n\n```json\n[\n  1\n]\n```');
  });

  it('takes the last result call when there are several', () => {
    const entries = [toolUse('SubagentHandback', { message: 'first' }), toolUse('StructuredOutput', { summary: 'last' })];
    assert.equal(extract(entries), '### summary\n\nlast');
  });

  it('falls back to the last assistant text without a result call', () => {
    assert.equal(extract([text('working'), text('done')]), 'done');
    assert.equal(extract([toolUse('SubagentHandback', { message: '' }), text('done')]), 'done');
  });

  it('prefers a result call over a later text', () => {
    assert.equal(extract([toolUse('SubagentHandback', { message: 'found 7' }), text('bye')]), 'found 7');
  });

  it('returns null with no text and no result call', () => {
    assert.equal(extract([toolUse('read', { path: 'x' })]), null);
    assert.equal(extract([toolUse('SubagentHandback', { message: '' })]), null);
  });

  it('throws for non-existent file', () => {
    assert.throws(() => extractAgentResultFromTranscript('/nonexistent/path.jsonl'));
  });
});
