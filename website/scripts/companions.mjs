// Runs pi-cost and pi-inspect on fake data for the Companions shots. Both come from sibling
// checkouts (PI_COST_DIR / PI_INSPECT_DIR override), since the board's embed contract may not be on npm yet.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const seed = require('../../demo/seed.js');
const SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url));
const FAKE_HOME = '/home/dev';
const API = `${FAKE_HOME}/code/acme-api`;
const PKG = `${FAKE_HOME}/.pi/agent/npm/node_modules`;

const pkgInfo = (pkg, file = 'extensions/index.ts') => ({ path: `${PKG}/${pkg}/${file}`, source: `npm:${pkg}`, scope: 'user', origin: 'package', baseDir: `${PKG}/${pkg}` });
const pkgTool = (pkg, name, description) => ({ name, description, sourceInfo: pkgInfo(pkg) });
const kanbanSkill = (name, description) => ({ name: `skill:${name}`, description, source: 'skill', sourceInfo: pkgInfo('pi-kanban', `skills/${name}/SKILL.md`) });
const builtin = (name, description) => ({ name, description });

const TOOLS = [
  builtin('read', 'Read the contents of a file. Supports text files and images.'),
  builtin('bash', 'Execute a bash command in the current working directory.'),
  builtin('edit', 'Edit a file by replacing exact text.'),
  builtin('write', 'Write content to a file. Creates the file if it does not exist.'),
  builtin('grep', 'Search file contents for a pattern.'),
  builtin('find', 'Find files by glob pattern.'),
  pkgTool('pi-kanban', 'ask', 'Ask the user a question on an HTML card in a pi-kanban modal and wait for the answer.'),
  pkgTool('pi-subagents', 'subagent', 'Run a task in a subagent with its own context and tools.'),
  pkgTool('@juicesharp/rpiv-todo', 'todo', 'Keep a todo list for the current task.'),
];

const COMMANDS = [
  { name: 'kanban', description: 'Open the pi-kanban board, or act on this session on it', source: 'extension', sourceInfo: pkgInfo('pi-kanban') },
  { name: 'cost', description: 'Show what this session costs', source: 'extension', sourceInfo: pkgInfo('pi-cost', 'extensions/cost.ts') },
  ...fs.readdirSync(SKILLS_DIR).map((name) => kanbanSkill(name, /^description:\s*(.*)$/m.exec(fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'))[1])),
  { name: 'review', description: 'Review the current diff', source: 'prompt', sourceInfo: { path: `${API}/.pi/prompts/review.md`, scope: 'project', origin: 'top-level' } },
];

const SYSTEM_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- read, bash, edit, write, grep, find
- ask (pi-kanban)
- subagent (pi-subagents), todo (rpiv-todo)

Guidelines:
- Read a file before you edit it.
- Keep changes small and run the tests after each one.

# Project Context

## ${API}/AGENTS.md

# acme-api

Express API with a Redis-backed rate limiter.

- Run \`npm test\` before you commit.
- Middleware lives in src/middleware; each one has a test in test/.

Current working directory: ${API}`;

function writeSnapshot(agentDir, sessionId) {
  const dir = path.join(agentDir, 'inspect', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const snap = {
    sessionId,
    sessionName: 'redis-rate-limiter',
    cwd: API,
    model: seed.modelRef(seed.MODELS.sonnet),
    systemPrompt: SYSTEM_PROMPT,
    commands: COMMANDS,
    tools: TOOLS,
    activeTools: TOOLS.filter((t) => t.name !== 'find').map((t) => t.name),
    disabledItems: [],
    pendingItems: [],
    capturedAt,
  };
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(snap));
  const sessions = [{ id: sessionId, cwd: API, name: snap.sessionName, model: snap.model, capturedAt }];
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ sessions }));
}

// The seed writes real temp paths into the transcripts; the shots show the demo's fake home instead.
function hideTempPaths(agentDir, tmp) {
  const sessions = path.join(agentDir, 'sessions');
  const forms = [JSON.stringify(tmp).slice(1, -1), tmp.replace(/\\/g, '/'), tmp];
  for (const dir of fs.readdirSync(sessions)) {
    for (const name of fs.readdirSync(path.join(sessions, dir))) {
      const file = path.join(sessions, dir, name);
      let text = fs.readFileSync(file, 'utf8');
      for (const f of forms) text = text.split(f).join(FAKE_HOME);
      text = text.replace(/\/home\/dev[^"]*/g, (p) => p.replace(/\\\\/g, '/'));
      fs.writeFileSync(file, text);
    }
  }
}

function start(name, dir, env) {
  const child = spawn(process.execPath, [path.join(dir, 'server.js'), '--port', '0', '--host', '127.0.0.1', '--no-open'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not start:\n${log}`)), 20000);
    child.stderr.on('data', (d) => (log += d));
    child.stdout.on('data', (d) => {
      log += d;
      const m = new RegExp(`${name} listening on http://localhost:(\\d+)`).exec(log);
      if (!m) return;
      clearTimeout(timer);
      resolve({ child, port: Number(m[1]) });
    });
    child.on('exit', (code) => reject(new Error(`${name} exited with ${code}:\n${log}`)));
  });
}

// Returns null when a checkout is missing, so the caller can skip the companion views.
export async function startCompanions({ repoRoot, sessionId }) {
  const dirs = {
    'pi-cost': process.env.PI_COST_DIR || path.resolve(repoRoot, '..', 'pi-cost'),
    'pi-inspect': process.env.PI_INSPECT_DIR || path.resolve(repoRoot, '..', 'pi-inspect'),
  };
  const missing = Object.entries(dirs).filter(([, d]) => !fs.existsSync(path.join(d, 'server.js')));
  if (missing.length) {
    console.warn(`skipping companion shots, no checkout at: ${missing.map(([, d]) => d).join(', ')}`);
    return null;
  }
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-shots-')));
  const env = { PI_CODING_AGENT_DIR: path.join(tmp, '.pi', 'agent'), PI_KANBAN_TMPDIR: path.join(tmp, 'tmp') };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    await seed.seedFiles({ root: tmp, now: Date.now() });
  } finally {
    for (const k of Object.keys(env)) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
  hideTempPaths(env.PI_CODING_AGENT_DIR, tmp);
  writeSnapshot(env.PI_CODING_AGENT_DIR, sessionId);

  const children = [];
  const stop = () => {
    for (const c of children) c.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const urls = {};
    for (const [name, dir] of Object.entries(dirs)) {
      const { child, port } = await start(name, dir, { ...env, PI_COST_OFFLINE: '1' });
      children.push(child);
      const { session } = await (await fetch(`http://127.0.0.1:${port}/api/companion`)).json();
      urls[name] = `http://127.0.0.1:${port}${session.replace('{id}', encodeURIComponent(sessionId))}`;
    }
    return { urls, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
