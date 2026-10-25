// Fake pi data for the static demo: sessions in three projects, written with the lib modules the
// pi extension uses, so the board reads them as it reads real ones. Names and values are fictional.
//
// The task store reads the agent dir when it loads, so PI_CODING_AGENT_DIR and PI_KANBAN_TMPDIR
// must be set before seedFiles runs.

const fs = require('node:fs');
const path = require('node:path');
const { reportText } = require('../lib/dispatch-reports');

const ID = (n) => `01a30000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const IDS = {
  limiter: ID(1),
  tokens: ID(2),
  checkout: ID(3),
  loadTest: ID(4),
  gettingStarted: ID(5),
  links: ID(6),
};
const SHOW_IDS = { bench: ID(101), knobs: ID(102), ask: ID(103) };
const TERMINALS = { limiter: '7e1a0000-0000-4000-8000-000000000001', checkout: '7e1a0000-0000-4000-8000-000000000003' };
const LIVE_START_MIN = 95;

const minutesAgo = (now) => (min) => new Date(now - min * 60_000).toISOString();
const callId = (sessionId, at, i) => `call_${sessionId.slice(-2)}_${at}_${i}`;

const MODELS = {
  sonnet: { provider: 'anthropic', modelId: 'claude-sonnet-5-5', api: 'anthropic-messages', contextWindow: 200000 },
  gpt: { provider: 'openai', modelId: 'gpt-5.1', api: 'openai-responses', contextWindow: 400000 },
  gemini: { provider: 'google', modelId: 'gemini-2.5-pro', api: 'google-generative-ai', contextWindow: 1048576 },
  haiku: { provider: 'anthropic', modelId: 'claude-haiku-5-5', api: 'anthropic-messages', contextWindow: 200000 },
};
const modelRef = (m) => `${m.provider}/${m.modelId}`;

const KNOBS_TABLE = '| Knob | Default | Notes |\n|---|---|---|\n| `RATE_WINDOW_MS` | 60000 | Window length |\n| `RATE_LIMIT` | 600 | Requests per key per window |\n| `RATE_BURST` | 50 | Extra requests in a burst |\n| `RATE_KEY_PREFIX` | `rl:` | Redis key prefix |\n';
const SCOUT = {
  at: 86,
  args: { agent: 'scout', task: 'List every public route in src/ and say which ones take an API key.' },
  result: 'Found 14 public routes; 11 take an API key. /health and /webhooks/* do not.',
};
const REVIEW = { at: 6, args: { agent: 'reviewer', task: 'Review the rate limiter diff for races and missing tests.' } };

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function projectFiles(code) {
  const api = path.join(code, 'acme-api');
  const web = path.join(code, 'acme-web');
  const docs = path.join(code, 'docs-site');
  write(path.join(api, 'README.md'), '# acme-api\n\nOrders and billing API for the Acme store. Express 5, Postgres, Redis.\n\n## Run\n\n```sh\nnpm install\nnpm run dev\n```\n');
  write(
    path.join(api, '_plans', 'rate-limiter.md'),
    '# Plan: Redis rate limiter\n\n## Goal\n\nLimit each API key to a fixed number of requests per window, shared across all API nodes.\n\n## Steps\n\n1. Spike a token bucket on Redis (`INCR` + `PEXPIRE` in one `MULTI`).\n2. Add `rateLimit()` middleware with a per-route override.\n3. Integration tests against a real Redis in CI.\n4. Document the tuning knobs.\n\n## Risks\n\n- Clock drift between nodes: the window lives in Redis, not on the node.\n- Redis down: fail open and log, so checkout keeps working.\n',
  );
  write(
    path.join(api, 'docs', 'tuning.md'),
    `# Rate limiter tuning\n\n${KNOBS_TABLE}`,
  );
  write(
    path.join(api, 'src', 'middleware', 'rate-limit.ts'),
    "import type { RequestHandler } from 'express';\nimport { redis } from '../redis';\n\nexport function rateLimit({ limit = 600, windowMs = 60_000 } = {}): RequestHandler {\n  return async (req, res, next) => {\n    const key = `rl:${req.get('x-api-key') ?? req.ip}`;\n    const [count] = await redis.multi().incr(key).pexpire(key, windowMs, 'NX').exec();\n    if (Number(count) > limit) return res.status(429).json({ error: 'rate limited' });\n    next();\n  };\n}\n",
  );
  write(path.join(web, 'README.md'), '# acme-web\n\nStorefront for Acme. React 19, Vite.\n');
  write(path.join(web, 'src', 'checkout', 'Review.tsx'), "export function Review({ order }: { order: Order }) {\n  return <section aria-labelledby=\"review\">{/* totals and edit links */}</section>;\n}\n");
  write(path.join(docs, 'README.md'), '# docs-site\n\nThe Acme developer docs.\n');
  write(
    path.join(docs, 'docs', 'getting-started.md'),
    '# Getting started\n\n1. Create an API key in the dashboard.\n2. Send it in the `x-api-key` header.\n3. Each key can make 600 requests a minute. A `429` means wait and retry.\n',
  );
  return { api, web, docs };
}

// One pi session file: a header, then entries chained by parentId, as pi writes them.
function transcript({ id, cwd, model, thinking = 'medium', name, pad, startMin, steps }, at) {
  const lines = [];
  let parent = null;
  let n = 0;
  const push = (entry, min) => {
    const e = { ...entry, id: `${id.slice(-4)}${String(++n).padStart(4, '0')}`, parentId: parent, timestamp: at(min) };
    parent = e.id;
    lines.push(e);
  };
  lines.push({ type: 'session', version: 3, id, timestamp: at(startMin), cwd });
  push({ type: 'model_change', provider: model.provider, modelId: model.modelId }, startMin);
  push({ type: 'thinking_level_change', thinkingLevel: thinking }, startMin);
  if (pad) push({ type: 'custom', customType: 'pi-kanban.scratchpad', data: { dir: pad } }, startMin);
  let context = 9000;
  for (const s of steps) {
    const ms = Date.parse(at(s.at));
    if (s.user) {
      push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: s.user }], timestamp: ms } }, s.at);
      continue;
    }
    const tools = s.tools || [];
    const content = [];
    if (s.thinking) content.push({ type: 'thinking', thinking: s.thinking });
    if (s.text) content.push({ type: 'text', text: s.text });
    tools.forEach((t, i) => content.push({ type: 'toolCall', id: callId(id, s.at, i), name: t.name, arguments: t.args }));
    const output = 120 + (s.text?.length || 0) / 3;
    context += 1400 + tools.length * 900;
    push(
      {
        type: 'message',
        message: {
          role: 'assistant',
          content,
          api: model.api,
          provider: model.provider,
          model: model.modelId,
          usage: { input: 40, output: Math.round(output), cacheRead: context, cacheWrite: 1200, reasoning: 0, totalTokens: context + 1240 + Math.round(output), cost: { input: 0.0001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.0091 } },
          stopReason: tools.length ? 'toolUse' : 'stop',
          timestamp: ms,
        },
      },
      s.at,
    );
    tools.forEach((t, i) => {
      if (t.result == null) return;
      const message = {
        role: 'toolResult',
        toolCallId: callId(id, s.at, i),
        toolName: t.name,
        content: [{ type: 'text', text: t.result }],
        isError: !!t.isError,
        timestamp: ms + 1500,
      };
      if (t.details) message.details = t.details;
      push({ type: 'message', message }, s.at - 0.02);
    });
  }
  if (name) push({ type: 'session_info', name }, steps.at(-1).at);
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const TODO_LIMITER = [
  { id: 1, subject: 'Spike a Redis token bucket', status: 'completed', activeForm: 'Spiking the token bucket' },
  { id: 2, subject: 'Add rateLimit() middleware with per-route override', status: 'completed', activeForm: 'Adding the middleware', blockedBy: [1] },
  { id: 3, subject: 'Integration tests against a real Redis', status: 'in_progress', activeForm: 'Writing integration tests', blockedBy: [2] },
  { id: 4, subject: 'Document the tuning knobs', status: 'pending', activeForm: 'Documenting the knobs', blockedBy: [3] },
];
const TODO_TOKENS = [
  { id: 1, subject: 'Audit where refresh tokens are read and written', status: 'completed' },
  { id: 2, subject: 'Rotate the refresh token on every refresh', status: 'completed', blockedBy: [1] },
  { id: 3, subject: 'Revoke the token family on reuse', status: 'completed', blockedBy: [2] },
];
const TODO_CHECKOUT = [
  { id: 1, subject: 'Extract <CheckoutAddress />', status: 'completed' },
  { id: 2, subject: 'Put the payment step behind checkout.payment-v2', status: 'completed' },
  { id: 3, subject: 'Add the review-and-confirm step', status: 'in_progress', activeForm: 'Building the review step' },
  { id: 4, subject: 'Pick the step indicator layout', status: 'pending', blockedBy: [3] },
  { id: 5, subject: 'Accessibility pass', status: 'pending', blockedBy: [3] },
];
const TODO_LOAD = [
  { id: 1, subject: 'Write the k6 script', status: 'completed' },
  { id: 2, subject: 'Run it against staging', status: 'completed', blockedBy: [1] },
  { id: 3, subject: 'Report p95 and the 429 rate', status: 'completed', blockedBy: [2] },
];

const BENCH_HTML = `<style>
  .bar { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .bar span:first-child { width: 120px; }
  .fill { height: 18px; border-radius: 4px; background: var(--color-accent); }
  small { color: var(--color-text-muted); }
</style>
<h3>p95 latency with the limiter on</h3>
<div class="bar"><span>no limiter</span><div class="fill" style="width:180px"></div><span>18 ms</span></div>
<div class="bar"><span>Redis bucket</span><div class="fill" style="width:210px"></div><span>21 ms</span></div>
<div class="bar"><span>in-memory</span><div class="fill" style="width:190px"></div><span>19 ms</span></div>
<small>k6, 200 VUs, 5 min, staging. The Redis bucket adds 3 ms at p95.</small>
`;
const ASK_HTML = `<style>
  label { display: block; margin: 8px 0; padding: 10px; border: 1px solid var(--color-border); border-radius: 6px; }
</style>
<h3>Where should the step indicator go?</h3>
<form id="f">
  <label><input type="radio" name="layout" value="top" checked> Top bar: 1 Address, 2 Payment, 3 Review</label>
  <label><input type="radio" name="layout" value="rail"> Left rail, with the order summary under it</label>
  <button type="submit">Send</button>
</form>
<script>
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    pk.send({ layout: new FormData(e.target).get('layout') });
  };
</script>
`;
const LOAD_SPEC = 'Write a k6 load test for the rate limiter, run it against staging for 5 minutes at 200 VUs, and report p95 latency and the 429 rate.';
const SHOWN_NOTE = 'The user sees the rendered card and you do not: in your reply, say what the card shows, and take the render as given.';
const REPORT = 'Load test done. k6, 200 VUs for 5 min against staging: p95 21 ms (18 ms without the limiter), 429 rate 0.4%, all from the two keys over 600 req/min. Script: load/rate-limit.k6.js. No errors.';

function sessions({ api, web, docs }, pads) {
  return [
    {
      id: IDS.limiter,
      cwd: api,
      model: MODELS.sonnet,
      name: 'redis-rate-limiter',
      pad: pads.limiter,
      startMin: LIVE_START_MIN,
      steps: [
        { at: LIVE_START_MIN, user: 'Add a Redis-backed rate limiter to the API. Plan it first and open the plan in a pane, then build it with tests.' },
        {
          at: 94,
          thinking: 'Look at how middleware is wired before planning.',
          tools: [
            { name: 'read', args: { path: path.join(api, 'README.md') }, result: 'Orders and billing API for the Acme store. Express 5, Postgres, Redis.' },
            { name: 'bash', args: { command: 'rg -n "app.use" src' }, result: 'src/app.ts:14:app.use(express.json());\nsrc/app.ts:15:app.use(auth());\nsrc/app.ts:16:app.use("/orders", orders);' },
          ],
        },
        {
          at: 92,
          text: 'The plan is in `_plans/rate-limiter.md`. It is open in a pane on the board.',
          tools: [
            { name: 'write', args: { path: path.join(api, '_plans', 'rate-limiter.md'), content: '# Plan: Redis rate limiter' }, result: 'Wrote 812 bytes.' },
            { name: 'bash', args: { command: 'pi-kanban pane add _plans/rate-limiter.md' }, result: 'p1  rate-limiter.md' },
          ],
        },
        { at: 90, tools: [{ name: 'todo', args: { action: 'create', tasks: TODO_LIMITER.map((t) => t.subject) }, result: '4 tasks', details: { tasks: TODO_LIMITER.map((t) => ({ ...t, status: 'pending' })) } }] },
        { at: SCOUT.at, text: 'A scout is listing the routes that need a limit.', tools: [{ name: 'subagent', args: SCOUT.args, result: SCOUT.result }] },
        {
          at: 72,
          tools: [
            { name: 'edit', args: { path: path.join(api, 'src', 'middleware', 'rate-limit.ts'), edits: [{ oldText: 'export {}', newText: 'export function rateLimit(...)' }] }, result: 'Applied 1 edit.' },
            { name: 'bash', args: { command: 'npm test -- rate-limit' }, result: ' PASS  test/rate-limit.test.ts\n  rateLimit\n    ✓ allows 600 requests per window (41 ms)\n    ✓ returns 429 after the limit (12 ms)\n    ✓ fails open when Redis is down (8 ms)\n\nTests: 3 passed, 3 total' },
            { name: 'todo', args: { action: 'update', id: 2, status: 'completed' }, result: 'Task 2 completed', details: { tasks: TODO_LIMITER.map((t) => (t.id <= 2 ? t : { ...t, status: 'pending' })) } },
          ],
        },
        {
          at: 62,
          text: 'The benchmark is on the board as a card.',
          tools: [{ name: 'bash', args: { command: 'pi-kanban show "$PI_SCRATCHPAD_DIR/bench.html" --title "Limiter benchmark" --key bench' }, result: `Shown "Limiter benchmark" (bench, 1/1). ${SHOWN_NOTE}` }],
        },
        {
          at: 58,
          text: 'I dispatched the load test to its own session, so this one can keep going.',
          tools: [
            { name: 'bash', args: { command: `pi-kanban dispatch start --cwd . --name rate-limit-load-test --spec "${LOAD_SPEC}"` }, result: `Started session ${IDS.loadTest} in ${api}` },
          ],
        },
        { at: 30, tools: [{ name: 'bash', args: { command: `pi-kanban dispatch wait ${IDS.loadTest}` }, result: reportText(IDS.loadTest, { status: 'reported', text: REPORT }) }] },
        { at: 25, user: 'Show me the tuning knobs as a table, and open the tuning doc next to it.' },
        {
          at: 24,
          tools: [
            { name: 'bash', args: { command: 'pi-kanban show "$PI_SCRATCHPAD_DIR/knobs.md" --title "Tuning knobs" --key knobs' }, result: `Shown "Tuning knobs" (knobs, 2/2). ${SHOWN_NOTE}` },
            { name: 'bash', args: { command: 'pi-kanban pane add docs/tuning.md' }, result: 'p2  tuning.md' },
          ],
        },
        {
          at: REVIEW.at,
          text: 'Integration tests are next. A reviewer is checking the diff in the meantime.',
          tools: [
            { name: 'todo', args: { action: 'update', id: 3, status: 'in_progress' }, result: 'Task 3 in progress', details: { tasks: TODO_LIMITER } },
            { name: 'subagent', args: REVIEW.args },
          ],
        },
      ],
    },
    {
      id: IDS.tokens,
      cwd: api,
      model: MODELS.gpt,
      name: 'rotate-refresh-tokens',
      startMin: 1500,
      steps: [
        { at: 1500, user: 'Rotate refresh tokens on every refresh and revoke the whole family on reuse.' },
        { at: 1498, tools: [{ name: 'todo', args: { action: 'create' }, result: '3 tasks', details: { tasks: TODO_TOKENS } }] },
        { at: 1470, tools: [{ name: 'bash', args: { command: 'npm test -- auth' }, result: 'Tests: 18 passed, 18 total' }] },
        { at: 1465, text: 'Done. Each refresh issues a new token and marks the old one used. A reused token revokes its family and logs `auth.token_reuse`.' },
      ],
    },
    {
      id: IDS.checkout,
      cwd: web,
      model: MODELS.gemini,
      name: 'checkout-steps',
      pad: pads.checkout,
      startMin: 240,
      steps: [
        { at: 240, user: 'Split checkout into address, payment and review steps. Ask me before you pick a layout.' },
        { at: 238, tools: [{ name: 'todo', args: { action: 'create' }, result: '5 tasks', details: { tasks: TODO_CHECKOUT } }] },
        { at: 200, tools: [{ name: 'edit', args: { path: path.join(web, 'src', 'checkout', 'Review.tsx'), edits: [{ oldText: '', newText: 'export function Review' }] }, result: 'Applied 1 edit.' }] },
        { at: 12, text: 'The review step works. I need your pick for the step indicator.', tools: [{ name: 'ask', args: { title: 'Step indicator layout', file: path.join(pads.checkout, 'step-layout.html') } }] },
      ],
    },
    {
      id: IDS.loadTest,
      cwd: api,
      model: MODELS.sonnet,
      thinking: 'low',
      name: 'rate-limit-load-test',
      startMin: 57,
      steps: [
        { at: 57, user: LOAD_SPEC },
        { at: 56, tools: [{ name: 'todo', args: { action: 'create' }, result: '3 tasks', details: { tasks: TODO_LOAD } }] },
        { at: 50, tools: [{ name: 'write', args: { path: path.join(api, 'load', 'rate-limit.k6.js'), content: "import http from 'k6/http';" }, result: 'Wrote 640 bytes.' }] },
        { at: 40, tools: [{ name: 'bash', args: { command: 'k6 run --vus 200 --duration 5m load/rate-limit.k6.js' }, result: 'http_req_duration..: avg=11ms p(95)=21ms\nhttp_reqs..........: 412800\nchecks.............: 99.6% (429: 0.4%)' }] },
        { at: 32, tools: [{ name: 'dispatch_report', args: { text: REPORT }, result: 'Report sent.' }], text: 'Report sent to the session that started me.' },
      ],
    },
    {
      id: IDS.gettingStarted,
      cwd: docs,
      model: MODELS.sonnet,
      name: 'getting-started-page',
      pad: pads.gettingStarted,
      startMin: 52,
      steps: [
        { at: 52, user: 'Write a getting-started page for API keys and limits. Link it to this session.' },
        { at: 47, tools: [{ name: 'write', args: { path: path.join(docs, 'docs', 'getting-started.md'), content: '# Getting started' }, result: 'Wrote 230 bytes.' }, { name: 'bash', args: { command: 'pi-kanban doc link docs/getting-started.md' }, result: `Document linked to session ${IDS.gettingStarted.slice(0, 8)}: ${path.join(docs, 'docs', 'getting-started.md')}` }] },
        { at: 44, text: 'The page is linked to this session; open it from the session card.' },
      ],
    },
    {
      id: IDS.links,
      cwd: docs,
      model: MODELS.gpt,
      name: 'fix-broken-links',
      startMin: 4400,
      steps: [
        { at: 4400, user: 'Find and fix broken links in the docs.' },
        { at: 4396, tools: [{ name: 'bash', args: { command: 'npx linkinator docs --recurse' }, result: '3 broken links: /api/v1/keys, /limits, /status' }] },
        { at: 4390, text: 'Fixed 3 links. `/limits` now points at the getting-started page.' },
      ],
    },
  ];
}

function writeShowPosts(pad, sessionId, at) {
  const bench = path.join(pad, 'bench.html');
  const knobs = path.join(pad, 'knobs.md');
  const posts = [
    { id: SHOW_IDS.bench, title: 'Limiter benchmark', key: 'bench', kind: 'html', file: bench, base: null, updatedAt: at(62) },
    { id: SHOW_IDS.knobs, title: 'Tuning knobs', key: 'knobs', kind: 'markdown', file: knobs, base: null, updatedAt: at(24) },
  ];
  write(bench, BENCH_HTML);
  write(knobs, KNOBS_TABLE);
  write(path.join(pad, '.pi-kanban', 'show', 'index.json'), JSON.stringify({ sessionId, posts }, null, 2));
}

// The lib modules write to the agent dir and scratchpad root the env names, so a missing env
// var would put fake sessions into the user's real ~/.pi/agent.
function assertSeedDirs(root) {
  const os = require('node:os');
  const { getAgentDir, longPath } = require('../lib/agent-dir');
  const { defaultScratchpadRoot } = require('../lib/scratchpad-dir');
  const base = longPath(root);
  const inside = (dir) => {
    const rel = path.relative(base, longPath(dir));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const agentDir = getAgentDir();
  if (path.relative(agentDir, longPath(path.join(os.homedir(), '.pi', 'agent'))) === '') {
    throw new Error(`seedFiles refuses the default agent dir ${agentDir}; set PI_CODING_AGENT_DIR under ${root}`);
  }
  for (const [name, dir] of [['PI_CODING_AGENT_DIR', agentDir], ['PI_KANBAN_TMPDIR', defaultScratchpadRoot()]]) {
    if (!inside(dir)) throw new Error(`seedFiles writes only under ${root}, but ${name} resolves to ${dir}`);
  }
}

// Everything the board reads from disk. Returns the paths the HTTP seeding needs.
async function seedFiles({ root, now = Date.now() }) {
  assertSeedDirs(root);
  const { getAgentDir } = require('../lib/agent-dir');
  const { defaultScratchpadRoot, scratchpadPath } = require('../lib/scratchpad-dir');
  const { encodeProjectDirName } = require('../lib/board-dir');
  const taskStore = require('../lib/task-store');
  const { appendAgentLines } = require('../lib/agent-log');
  const { startLines, endLines } = require('../lib/pi-agents');
  const { createDispatchedStore } = require('../lib/retention');
  const { MODEL_WINDOWS_FILE, recordModelWindows } = require('../lib/model-windows');
  const { COMPANIONS } = require('../lib/companions');

  const at = minutesAgo(now);
  const agentDir = getAgentDir();
  const kanban = path.join(agentDir, 'kanban');
  write(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: COMPANIONS.map((c) => c.source) }, null, 2));
  const projects = projectFiles(path.join(root, 'code'));
  const padRoot = defaultScratchpadRoot();
  const pads = {
    limiter: scratchpadPath(padRoot, projects.api, IDS.limiter),
    checkout: scratchpadPath(padRoot, projects.web, IDS.checkout),
    gettingStarted: scratchpadPath(padRoot, projects.docs, IDS.gettingStarted),
  };

  // The board dates a session by its file times, so each one is set to the session's last step.
  const lastWrite = {};
  const age = (file, when) => fs.utimesSync(file, when, when);
  for (const s of sessions(projects, pads)) {
    const stamp = at(s.startMin).replace(/[:.]/g, '-');
    const file = path.join(agentDir, 'sessions', `--${encodeProjectDirName(s.cwd)}--`, `${stamp}_${s.id}.jsonl`);
    write(file, transcript(s, at));
    lastWrite[s.id] = new Date(at(Math.min(...s.steps.map((x) => x.at))));
    age(file, lastWrite[s.id]);
  }
  await recordModelWindows(path.join(kanban, MODEL_WINDOWS_FILE), Object.values(MODELS).map((m) => ({ provider: m.provider, id: m.modelId, contextWindow: m.contextWindow })));

  for (const [id, tasks] of [[IDS.limiter, TODO_LIMITER], [IDS.tokens, TODO_TOKENS], [IDS.checkout, TODO_CHECKOUT], [IDS.loadTest, TODO_LOAD]]) {
    await taskStore.reconcileFromSnapshot(id, tasks);
    const dir = path.join(kanban, 'tasks', id);
    for (const f of fs.readdirSync(dir)) age(path.join(dir, f), lastWrite[id]);
    age(dir, lastWrite[id]);
  }

  const activity = path.join(kanban, 'agent-activity', IDS.limiter);
  const scoutCall = callId(IDS.limiter, SCOUT.at, 0);
  const scoutResult = { details: { results: [{ agent: 'scout', model: modelRef(MODELS.haiku), finalOutput: SCOUT.result, exitCode: 0 }] } };
  const reviewStart = startLines(callId(IDS.limiter, REVIEW.at, 1), REVIEW.args, at(REVIEW.at));
  await appendAgentLines(activity, [
    ...startLines(scoutCall, SCOUT.args, at(SCOUT.at)),
    ...endLines(scoutCall, 1, scoutResult, false, at(SCOUT.at - 2)),
    ...reviewStart,
    { agentId: reviewStart[0].agentId, event: 'update', model: modelRef(MODELS.sonnet), updatedAt: at(REVIEW.at - 1) },
  ]);

  write(path.join(pads.limiter, 'bench.txt'), 'scenario        p50   p95   p99\nno limiter      9ms   18ms  31ms\nredis bucket   11ms   21ms  35ms\nin-memory      10ms   19ms  33ms\n');
  write(path.join(pads.limiter, 'notes.md'), '# Notes\n\n- `PEXPIRE ... NX` keeps the first request of a window as its start.\n- Fail open when Redis is down; alert on `ratelimit.redis_error`.\n');
  write(path.join(pads.limiter, 'logs', 'npm-test.log'), 'Tests: 3 passed, 3 total\n');
  writeShowPosts(pads.limiter, IDS.limiter, at);
  write(path.join(kanban, 'terminals.json'), JSON.stringify({ showSessions: { [TERMINALS.limiter]: IDS.limiter } }, null, 2));
  write(path.join(pads.checkout, 'step-layout.html'), ASK_HTML);
  write(path.join(pads.gettingStarted, 'outline.md'), '# Outline\n\n1. Create a key\n2. Send the header\n3. Limits and 429\n');

  const dispatchedFile = path.join(kanban, 'dispatched.json');
  const dispatched = createDispatchedStore({
    load: () => null,
    save: (data) => write(dispatchedFile, JSON.stringify(data, null, 2)),
    now: () => now - 58 * 60_000,
  });
  dispatched.record(IDS.loadTest, { parent: IDS.limiter, cwd: projects.api, name: 'rate-limit-load-test', group: null });

  return { agentDir, projects, pads, report: REPORT };
}

// The live files the extension writes for a running pi. The board probes each pid, so the
// caller passes pids that stay alive while it records.
async function seedLive({ agentDir, projects, pids, now = Date.now() }) {
  const { writeLiveSession } = require('../lib/live-sessions');
  const { writeWaiting, promptMarker } = require('../lib/agent-log');
  const at = minutesAgo(now);
  const kanban = path.join(agentDir, 'kanban');
  const live = path.join(kanban, 'live');
  const started = now - LIVE_START_MIN * 60_000;
  await writeLiveSession(live, { sessionId: IDS.limiter, pid: pids[0], cwd: projects.api, startedAt: started, status: 'busy', statusUpdatedAt: now - 5 * 60_000, name: 'redis-rate-limiter' });
  await writeLiveSession(live, { sessionId: IDS.checkout, pid: pids[1], cwd: projects.web, startedAt: started, status: 'waiting', statusUpdatedAt: now - 12 * 60_000, name: 'checkout-steps' });
  const marker = promptMarker({ kind: 'input', title: 'Step indicator layout' }, { toolName: 'ask', args: { title: 'Step indicator layout' } }, at(12));
  await writeWaiting(path.join(kanban, 'agent-activity', IDS.checkout), marker);
}

// Board state that has a route: groups, pins, panes, linked docs and the dispatch report.
async function seedBoard({ post, projects, report }) {
  const { api, docs } = projects;
  for (const id of [IDS.limiter, IDS.loadTest, IDS.checkout]) await post(`/api/sessions/${id}/group`, { group: 'Release 2.4', create: true });
  await post(`/api/sessions/${IDS.gettingStarted}/group`, { group: 'Docs', create: true });
  await post('/api/session/pin', { ids: [IDS.tokens], state: 'pinned' });
  await post(`/api/panes/${IDS.limiter}`, { target: path.join(api, '_plans', 'rate-limiter.md') });
  await post(`/api/panes/${IDS.limiter}`, { target: path.join(api, 'docs', 'tuning.md') });
  await post(`/api/panes/${IDS.limiter}`, { target: path.join(api, 'src', 'middleware', 'rate-limit.ts') });
  await post('/api/document/link', { sessionId: IDS.gettingStarted, path: path.join(docs, 'docs', 'getting-started.md') });
  await post('/api/document/link', { sessionId: IDS.limiter, path: path.join(api, 'README.md') });
  await post(`/api/dispatch/${IDS.loadTest}/report`, { text: report });
}

module.exports = { IDS, SHOW_IDS, TERMINALS, LIVE_START_MIN, MODELS, modelRef, seedFiles, seedLive, seedBoard };
