const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createTerminalService, shellArgs, oneShotArgs, piCommand, readTerminalConfig, clientConfigFor, resolveShell, piArgsFor, withTuiMode, windowsPtyFor, parseNewSpec, findPickProcess, ptyEnv } = require('../lib/terminal');

let WebSocket = null;
let ptyAvailable = false;
try {
  WebSocket = require('ws');
  require('@lydell/node-pty');
  ptyAvailable = true;
} catch { /* backend not installed on this platform */ }

const TOKEN = 'a'.repeat(64);
const SESSION = '11111111-2222-3333-4444-555555555555';
const SHELL = process.platform === 'win32' ? 'cmd.exe' : 'sh';

function startServer(extraArgs) {
  // os.tmpdir() can be an 8.3 short path, and libuv's Windows watcher asserts on an event
  // under one (fs-event.c), which kills the server the first time it writes to .pi-kanban.
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'pk-term-')));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), ...extraArgs], {
    env: { ...process.env, PORT: '0', PI_CODING_AGENT_DIR: dir, PK_TERMINAL_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/running at http:\/\/localhost:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, dir, port };
}

function stopServer(s) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(s.child.pid), '/f', '/t'], { stdio: 'ignore' });
  else s.child.kill();
  // A child that outlives the kill must not keep the test process alive through its pipes.
  s.child.stdout.destroy();
  s.child.stderr.destroy();
  s.child.unref();
  try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* locked by the dying child */ }
}

// Windows loopback sometimes fails a connect with ETIMEDOUT under load, before any byte reaches the server.
const CONNECT_ERRORS = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);

// The failures come in bursts that can last seconds, so the waits grow.
const CONNECT_RETRY_MS = [250, 500, 1000, 2000];

async function retryConnect(attempt) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i === CONNECT_RETRY_MS.length || !CONNECT_ERRORS.has(e.code)) throw e;
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS[i]));
    }
  }
}

// A fresh connection per call: a pooled keep-alive socket can be closed by the server just as it is reused.
function api(port, method, pathname, headers = {}) {
  return retryConnect(() => apiOnce(port, method, pathname, headers));
}

function apiOnce(port, method, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    });
    req.setTimeout(15000, () => req.destroy(new Error(`timeout: ${method} ${pathname}`)));
    req.on('error', reject);
    req.end();
  });
}

// Resolves with the first truthy result of `test(data, isBinary)` for a message on `ws`.
function waitFor(ws, test, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), 15000);
    ws.on('message', (d, bin) => {
      const hit = test(d, bin);
      if (hit) { clearTimeout(timer); resolve(hit); }
    });
  });
}

function handshakeStatus(port, headers) {
  const once = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers, handshakeTimeout: 15000 });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', reject);
  });
  return retryConnect(once).catch((e) => `${e.code || ''} ${e.message}`);
}

// Collects JSON control messages and decoded output until `until` returns true.
function session(port, hello, until) {
  return retryConnect(() => sessionOnce(port, hello, until));
}

function sessionOnce(port, hello, until) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`, { headers: { origin: `http://localhost:${port}` } });
    const got = { control: [], out: '', closeCode: null, ws };
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`timeout: ${JSON.stringify(got.control)} ${got.out}`)); }, 15000);
    const check = () => { if (until(got)) { clearTimeout(timer); resolve(got); } };
    let opened = false;
    ws.on('error', (e) => {
      clearTimeout(timer);
      // Only a failure before the handshake may be retried; after it the hello has reached the server.
      reject(opened ? new Error(e.message) : e);
    });
    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ t: 'hello', token: TOKEN, cols: 80, rows: 24, ...hello }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) got.out += data.toString('utf8');
      else got.control.push(JSON.parse(data.toString()));
      check();
    });
    ws.on('close', (code) => { got.closeCode = code; check(); });
  });
}

describe('shellArgs', () => {
  it('keeps pwsh open after pi exits', () => {
    assert.deepEqual(shellArgs('C:/x/pwsh.exe', ['--session', SESSION]), ['-NoLogo', '-NoExit', '-Command', `pi --session ${SESSION}`]);
  });
  it('execs the same POSIX shell after pi exits', () => {
    assert.deepEqual(shellArgs('/bin/zsh', ['--session', SESSION]), ['-c', `pi --session ${SESSION}; exec "$0"`, '/bin/zsh']);
  });
  it('starts a bare shell in shell mode', () => {
    assert.deepEqual(shellArgs('cmd.exe', null), []);
  });
  it('starts Git Bash as a login shell, before and after pi', () => {
    const bash = 'C:/Program Files/Git/bin/bash.exe';
    assert.deepEqual(shellArgs(bash, null), ['--login', '-i']);
    assert.deepEqual(shellArgs(bash, ['--session', SESSION]), ['--login', '-i', '-c', `pi --session ${SESSION}; exec bash --login -i`]);
  });
  it('quotes an argument with a space for each shell family', () => {
    const args = ['--name', 'Fix login'];
    assert.equal(shellArgs('pwsh.exe', args)[3], "pi --name 'Fix login'");
    assert.equal(shellArgs('cmd.exe', args)[1], 'pi --name "Fix login"');
  });
});

describe('oneShotArgs', () => {
  const install = ['install', 'npm:pi-subagents'];
  it('runs pi once and lets the shell exit with it', () => {
    assert.deepEqual(oneShotArgs('pwsh.exe', install), ['-NoLogo', '-Command', "pi install 'npm:pi-subagents'"]);
    assert.deepEqual(oneShotArgs('cmd.exe', install), ['/c', 'pi install "npm:pi-subagents"']);
    assert.deepEqual(oneShotArgs('C:/Program Files/Git/bin/bash.exe', install), ['--login', '-c', "pi install 'npm:pi-subagents'"]);
    assert.deepEqual(oneShotArgs('/bin/zsh', install), ['-c', "pi install 'npm:pi-subagents'"]);
  });
});

describe('new session options', () => {
  it('builds the pi flags', () => {
    const spec = parseNewSpec({ cwd: '/p', name: ' Fix login ', model: 'codemie/gpt-6-luna:high', thinking: 'xhigh' });
    assert.deepEqual(piArgsFor('new', SESSION, spec),
      ['--session-id', SESSION, '--name', 'Fix login', '--model', 'codemie/gpt-6-luna:high', '--thinking', 'xhigh']);
    assert.deepEqual(piArgsFor('new', SESSION, parseNewSpec({ cwd: '/p' })), ['--session-id', SESSION]);
  });
  it('runs pi in regular TUI mode on Windows, unless the args name a mode', () => {
    const args = ['--session', SESSION];
    assert.deepEqual(withTuiMode(args, 'win32'), ['--session', SESSION, '--tui-mode', 'regular']);
    assert.deepEqual(withTuiMode(args, 'linux'), args);
    assert.deepEqual(withTuiMode(['--tui-mode=fullscreen'], 'win32'), ['--tui-mode=fullscreen']);
    assert.equal(withTuiMode(null, 'win32'), null);
  });
  it('tells xterm about ConPTY on Windows only', () => {
    assert.deepEqual(windowsPtyFor('win32', '10.0.26300'), { backend: 'conpty', buildNumber: 26300 });
    assert.deepEqual(windowsPtyFor('linux', '6.8.0'), {});
  });
  it('resumes a transcript under its own id', () => {
    const OLD = 'cccccccc-0000-0000-0000-000000000003';
    assert.deepEqual(piArgsFor('new', SESSION, parseNewSpec({ cwd: '/p', resume: OLD })), ['--session', OLD]);
    assert.deepEqual(piArgsFor('resume', SESSION), ['--session', SESSION]);
  });
  it('forks under its own id', () => {
    const PARENT = 'bbbbbbbb-0000-0000-0000-000000000002';
    const spec = parseNewSpec({ forkOf: PARENT });
    assert.equal(spec.cwd, null);
    assert.deepEqual(piArgsFor('new', SESSION, spec), ['--fork', PARENT, '--session-id', SESSION]);
    assert.equal(parseNewSpec({ forkOf: 'x; rm -rf ~' }), 'session to fork');
  });
  it('names the field that fails its charset', () => {
    assert.equal(parseNewSpec({}), 'folder');
    assert.equal(parseNewSpec({ cwd: '/p', name: "x'; rm -rf ~" }), 'name');
    assert.equal(parseNewSpec({ cwd: '/p', name: '-x' }), 'name');
    assert.equal(parseNewSpec({ cwd: '/p', model: 'opus; x' }), 'model');
    assert.equal(parseNewSpec({ cwd: '/p', model: '-x' }), 'model');
    assert.equal(parseNewSpec({ cwd: '/p', model: 42 }), 'model');
    assert.equal(parseNewSpec({ cwd: '/p', thinking: 'ultra' }), 'thinking level');
  });
  it('refuses an extra arg that sets a flag pi-kanban owns', () => {
    for (const flag of ['--session', '--fork', '--session-id=x', '--thinking', '--mode', '-p']) {
      assert.match(parseNewSpec({ cwd: '/p', extraArgs: [flag] }), /pi-kanban sets/);
    }
    assert.deepEqual(parseNewSpec({ cwd: '/p', extraArgs: ['--offline'] }).extraArgs, ['--offline']);
  });
  it('takes edit only as true, and strips control characters from its prompt', () => {
    assert.equal(parseNewSpec({ cwd: '/p', edit: true }).edit, true);
    assert.equal(parseNewSpec({ cwd: '/p', edit: 'yes' }).edit, false);
    assert.equal(parseNewSpec({ cwd: '/p', edit: true, prompt: 'a\x03b\x15c\n\td' }).prompt, 'abc\n\td');
    assert.equal(parseNewSpec({ cwd: '/p', prompt: 'a\x03b' }).prompt, 'a\x03b');
  });
  it('builds the command line an edit terminal types', () => {
    const args = piArgsFor('new', SESSION, parseNewSpec({ cwd: '/p', name: 'Fix login', model: 'codemie/luna' }));
    assert.equal(piCommand('pwsh.exe', args), `pi --session-id ${SESSION} --name 'Fix login' --model 'codemie/luna'`);
    assert.equal(piCommand('cmd.exe', args), `pi --session-id ${SESSION} --name "Fix login" --model "codemie/luna"`);
  });
  it('puts the prompt last, after --, and quotes it for each shell family', () => {
    const args = ['--session-id', SESSION];
    const text = "-it's $HOME `x` ’q’ \"d\"\nnext";
    assert.equal(piCommand('pwsh.exe', args, text), `pi --session-id ${SESSION} -- '-it''s $HOME \`x\` ’’q’’ "d"\nnext'`);
    assert.equal(piCommand('/bin/zsh', args, text), `pi --session-id ${SESSION} -- '-it'\\''s $HOME \`x\` ’q’ "d"\nnext'`);
  });
});

describe('edit before run', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';

  function service(live = [], shell = 'bash', resolveCwd = () => null) {
    const pty = fakePty();
    const t = createTerminalService({
      config: { enabled: true, restore: false, shell, maxSessions: 30, scrollback: 100 },
      net: { EXPOSED: false },
      pty,
      token: TOKEN,
      piAgentDir: os.tmpdir(),
      which: (n) => n,
      isLiveElsewhere: () => false,
      resolveCwd,
      isAllowedFolder: () => true,
      liveSessions: () => live,
      isPidAlive: () => true,
      exitPollMs: 20,
    });
    return { t, pty };
  }

  it('starts a plain shell and types the command without Enter once the shell settles', async () => {
    const { t, pty } = service();
    const r = await t.startNew({ id: A, cwd: os.tmpdir(), name: 'Fix login', prompt: 'line one\nline two', edit: true });
    assert.equal(r.id, A);
    const [p] = pty.spawned;
    assert.deepEqual(p.args, shellArgs('bash', null));
    p.emit('prompt> ');
    await until(() => p.written.length > 0);
    await wait(150);
    const tui = process.platform === 'win32' ? ' --tui-mode regular' : '';
    assert.deepEqual(p.written, [`\x1b[200~pi --session-id ${A} --name 'Fix login'${tui} -- 'line one\rline two'\x1b[201~`]);
    assert.equal(t.list()[0].edit, true);
    t.shutdown();
  });

  it('refuses a prompt when the shell is cmd, and takes the same session without one', async () => {
    const { t, pty } = service([], 'cmd.exe');
    const r = await t.startNew({ id: A, cwd: os.tmpdir(), prompt: 'hi', edit: true });
    assert.equal(r.status, 400);
    assert.match(r.error, /cmd/);
    assert.equal(pty.spawned.length, 0);
    assert.equal((await t.startNew({ id: A, cwd: os.tmpdir(), edit: true })).id, A);
    t.shutdown();
  });

  it('refuses a paste until the typed command runs pi', async () => {
    const live = [];
    const { t, pty } = service(live);
    await t.startNew({ id: A, cwd: os.tmpdir(), edit: true });
    pty.spawned[0].emit('prompt> ');
    await until(() => pty.spawned[0].written.length > 0);
    assert.equal(t.paste(A, 'hi'), false);
    live.push({ sessionId: A, pid: 4242, startedAt: Date.now() });
    let pasted = false;
    await until(() => (pasted = t.paste(A, 'hi')));
    assert.equal(pasted, true);
    t.shutdown();
  });

  it('starts a fork in its parent session folder, not the folder the caller names', async () => {
    const PARENT = 'bbbbbbbb-0000-0000-0000-000000000002';
    const { t, pty } = service([], 'bash', (id) => (id === PARENT ? os.tmpdir() : null));
    const r = await t.startNew({ id: A, forkOf: PARENT, cwd: '/elsewhere' });
    assert.equal(r.cwd, os.tmpdir());
    assert.ok(pty.spawned[0].args.join(' ').includes(`--fork ${PARENT} --session-id ${A}`));
    assert.equal(t.list()[0].forkOf, PARENT);
    const missing = await t.startNew({ id: SESSION, forkOf: 'cccccccc-0000-0000-0000-000000000003' });
    assert.equal(missing.status, 404);
    t.shutdown();
  });

  it('leaves a normal new session as it was', async () => {
    const { t, pty } = service();
    await t.startNew({ id: A, cwd: os.tmpdir(), name: 'Fix login' });
    assert.ok(pty.spawned[0].args.join(' ').includes(`--session-id ${A}`));
    assert.equal(t.list()[0].edit, false);
    t.shutdown();
  });
});

async function startWithPrompt(id, overrides, spec) {
  const pty = fakePty();
  const t = createTerminalService({
    config: { enabled: true, restore: false, shell: 'bash', maxSessions: 30, scrollback: 100 },
    net: { EXPOSED: false },
    pty,
    token: TOKEN,
    piAgentDir: os.tmpdir(),
    which: (n) => n,
    isLiveElsewhere: () => false,
    resolveCwd: () => null,
    isAllowedFolder: () => true,
    liveSessions: () => [],
    isPidAlive: () => true,
    exitPollMs: 20,
    ...overrides,
  });
  await t.startNew({ id, cwd: os.tmpdir(), prompt: 'do the task', ...spec });
  return { t, p: pty.spawned[0] };
}

describe('folder trust dialog', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const DIALOG = '\x1b[?2004hTrust project folder?\r\n→ Trust\r\n  Do not trust\r\n';
  const INPUT_BOX = '\x1b[2J\x1b[H\x1b[?2004h> ';

  async function started() {
    let changes = 0;
    const { t, p } = await startWithPrompt(A, { onChange: () => { changes++; } });
    return { t, p, changes: () => changes };
  }

  const awaiting = (t) => t.list()[0].awaitingTrust;

  it('flags the dialog, holds the prompt, then sends it and clears the flag once the dialog is answered', async () => {
    const { t, p } = await started();
    p.emit(DIALOG);
    await until(() => awaiting(t));
    assert.equal(awaiting(t), true);
    assert.deepEqual(p.written, []);
    p.emit(INPUT_BOX);
    await until(() => p.written.length > 0);
    assert.equal(awaiting(t), false);
    assert.equal(p.written[0], '\x1b[200~do the task\x1b[201~');
    t.shutdown();
  });

  it('holds the prompt while pi redraws its screen with paste mode off after the answer', async () => {
    const { t, p } = await started();
    p.emit(DIALOG);
    await until(() => awaiting(t));
    p.emit('\x1b[2J\x1b[H\x1b[?2031l\x1b[?2004l\x1b[?1016l\r\n');
    await wait(800);
    assert.deepEqual(p.written, []);
    p.emit(INPUT_BOX);
    await until(() => p.written.length > 0);
    assert.equal(p.written[0], '\x1b[200~do the task\x1b[201~');
    t.shutdown();
  });

  it('sends the prompt when only the folder or session name says trust', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'trust-'));
    const { t, p } = await startWithPrompt(A, {}, { cwd, name: 'trust-check' });
    p.emit(`\x1b[?2004h~\\${path.basename(cwd)}\r\ntrust-check\r\n> `);
    await until(() => p.written.length > 0);
    assert.equal(p.written[0], '\x1b[200~do the task\x1b[201~');
    t.shutdown();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does not flag a screen that only says trust', async () => {
    const { t, p } = await started();
    p.emit('\x1b[?2004hI trust the plan\r\n');
    await wait(600);
    assert.equal(awaiting(t), false);
    t.shutdown();
  });

  it('never flags the dialog text after the prompt is sent', async () => {
    const { t, p, changes } = await started();
    p.emit(INPUT_BOX);
    await until(() => p.written.length > 0);
    const before = changes();
    p.emit(DIALOG);
    await wait(600);
    assert.equal(awaiting(t), false);
    assert.equal(changes(), before);
    t.shutdown();
  });
});

describe('prompt submit', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000002';

  async function started(reg) {
    const { t, p } = await startWithPrompt(A, {
      liveSessions: () => [{ sessionId: A, pid: 7, startedAt: Date.now(), ...reg }],
      submitPollMs: 10,
    });
    p.emit('\x1b[?2004h> ');
    return { t, enters: () => p.written.filter((d) => d === '\r').length };
  }

  async function entersAfter(reg, change) {
    const { t, enters } = await started(reg);
    await until(() => enters() === 1);
    change?.();
    await wait(200);
    t.shutdown();
    return enters();
  }

  it('presses Enter again while the entry stays idle and older than the Enter, then gives up', async () => {
    assert.equal(await entersAfter({ status: 'idle', statusUpdatedAt: 1 }), 3);
  });

  it('presses Enter once when the turn starts', async () => {
    const reg = { status: 'idle', statusUpdatedAt: 1 };
    assert.equal(await entersAfter(reg, () => Object.assign(reg, { status: 'busy', statusUpdatedAt: Date.now() })), 1);
  });

  it('presses Enter once when the entry is not idle, as with a dialog in a running turn', async () => {
    assert.equal(await entersAfter({ status: 'busy', statusUpdatedAt: 1 }), 1);
  });

  it('presses Enter once when the registry has no status time', async () => {
    assert.equal(await entersAfter({ status: 'idle' }), 1);
  });
});

describe('resume picker', () => {
  it('opens pi\'s own picker', () => {
    assert.deepEqual(piArgsFor('pick', SESSION), ['--resume']);
  });
  it('finds the pi the PTY started by folder and start time, skipping claimed ones', () => {
    const cwd = __dirname;
    const pty = { cwd, startedAt: 10_000 };
    const live = [
      { pid: 1, cwd, startedAt: 1_000 },
      { pid: 2, cwd: os.tmpdir(), startedAt: 11_000 },
      { pid: 3, cwd: `${cwd}${path.sep}.`, startedAt: 11_000 },
      { pid: 4, cwd, startedAt: 12_000 },
    ];
    assert.equal(findPickProcess(live, pty, new Set()), 3);
    assert.equal(findPickProcess(live, pty, new Set([3])), 4);
    assert.equal(findPickProcess(live, pty, new Set([3, 4])), undefined);
  });
});

describe('resolveShell', () => {
  const which = (tools) => (cmd) => tools[cmd] || null;
  it('infers pwsh on Windows and $SHELL elsewhere', () => {
    assert.equal(resolveShell(null, which({ pwsh: 'C:/pwsh.exe' }), 'win32', {}), 'C:/pwsh.exe');
    assert.equal(resolveShell(null, which({ powershell: 'C:/ps.exe' }), 'win32', {}), 'C:/ps.exe');
    assert.equal(resolveShell(null, which({}), 'linux', { SHELL: '/bin/zsh' }), '/bin/zsh');
  });
  it('finds Git Bash beside git on PATH', () => {
    const git = path.join(__dirname, 'no-such-git', 'cmd', 'git.exe');
    assert.throws(() => resolveShell('gitbash', which({ git }), 'win32', {}), /"gitbash" not found/);
  });
  it('looks a name up on PATH and fails loudly when it is missing', () => {
    assert.equal(resolveShell('zsh', which({ zsh: '/usr/bin/zsh' }), 'linux', {}), '/usr/bin/zsh');
    assert.throws(() => resolveShell('fish', which({}), 'linux', {}), /"fish" not found/);
  });
});

describe('ptyEnv', () => {
  function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('pins the session to this board with PK_URL and to the board agent dir', () => {
    const env = ptyEnv({ piAgentDir: '/c', pkUrl: 'http://127.0.0.1:4795' });
    assert.equal(env.PK_URL, 'http://127.0.0.1:4795');
    assert.equal(env.PI_CODING_AGENT_DIR, '/c');
    assert.equal(env.PORT, undefined);
  });

  it('sets TERM_PROGRAM to the board, replacing an inherited one', () => {
    withEnv({ TERM_PROGRAM: 'vscode' }, () => {
      assert.equal(ptyEnv({ piAgentDir: '/c' }).TERM_PROGRAM, 'pi-kanban');
    });
  });

  it('names the terminal with PK_TERMINAL_ID and drops an inherited one', () => {
    const TID = 'dddddddd-0000-0000-0000-000000000001';
    assert.equal(ptyEnv({ piAgentDir: '/c', pkUrl: 'http://127.0.0.1:1', terminalId: TID }).PK_TERMINAL_ID, TID);
    withEnv({ PK_TERMINAL_ID: TID }, () => {
      assert.equal(ptyEnv({ piAgentDir: '/c' }).PK_TERMINAL_ID, undefined);
    });
  });

  it('drops an inherited PK_URL when the port is not known yet', () => {
    withEnv({ PK_URL: 'http://127.0.0.1:1' }, () => {
      assert.equal(ptyEnv({ piAgentDir: '/c' }).PK_URL, undefined);
    });
  });

  it('drops the subagent marker of a parent pi', () => {
    withEnv({ PI_SUBAGENT_CHILD: '1' }, () => {
      assert.equal(ptyEnv({ piAgentDir: '/c' }).PI_SUBAGENT_CHILD, undefined);
    });
  });
});

describe('readTerminalConfig', () => {
  it('is on by default and turns off from the flag', () => {
    assert.equal(readTerminalConfig({ argv: [], env: {} }).enabled, true);
    assert.equal(readTerminalConfig({ argv: [], env: {} }).maxSessions, 30);
    assert.equal(readTerminalConfig({ argv: ['--enable-terminal'], env: {} }).enabled, true);
    assert.equal(readTerminalConfig({ argv: ['--no-terminal'], env: {} }).enabled, false);
  });
  it('takes the shell from the flag, then the env var', () => {
    const env = { PK_TERMINAL_SHELL: 'gitbash' };
    assert.equal(readTerminalConfig({ argv: [], env }).shell, 'gitbash');
    assert.equal(readTerminalConfig({ argv: [], env, getArgValue: () => 'cmd' }).shell, 'cmd');
    assert.equal(readTerminalConfig({ argv: [], env: {} }).shell, null);
  });
  it('tells the board only that the terminal is off', () => {
    const config = readTerminalConfig({ argv: [], env: {} });
    assert.deepEqual(clientConfigFor(config, false), { available: false });
    assert.equal(clientConfigFor(config, true).fontSize, 13);
  });
});

describe('terminal endpoint', { skip: !ptyAvailable }, () => {
  let srv;
  let port;
  before(async () => {
    srv = startServer(['--terminal-shell', SHELL]);
    port = await srv.port;
  });
  after(() => stopServer(srv));

  it('writes its token in a file named by its port', () => {
    const file = path.join(srv.dir, 'kanban', 'terminal-tokens', `${port}.json`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, TOKEN);
  });

  it('refuses a cross-origin handshake', async () => {
    assert.equal(await handshakeStatus(port, { origin: 'http://evil.com' }), 403);
  });
  it('refuses a handshake with no Origin', async () => {
    assert.equal(await handshakeStatus(port, {}), 403);
  });
  it('refuses a rebinding Host', async () => {
    assert.equal(await handshakeStatus(port, { host: `evil.com:${port}`, origin: `http://evil.com:${port}` }), 403);
  });
  it('closes on a wrong token', async () => {
    const got = await session(port, { token: 'nope', id: SESSION, mode: 'shell' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4001);
  });
  it('closes on a non-UUID id', async () => {
    const got = await session(port, { id: '../../x', mode: 'shell' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4002);
  });
  it('refuses to resume an unknown session', async () => {
    const got = await session(port, { id: SESSION, mode: 'resume' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4004);
  });
  it('lists the companion packages', async () => {
    const res = await api(port, 'GET', '/api/companions');
    assert.equal(res.status, 200);
    assert.ok(res.json.companions.some((c) => c.id === 'pi-subagents'));
  });
  it('refuses a package install without the token', async () => {
    const res = await api(port, 'POST', '/api/companions/install', { origin: `http://localhost:${port}`, 'x-terminal-token': 'nope' });
    assert.equal(res.status, 401);
  });
  it('refuses an install of a package it does not know', async () => {
    const res = await api(port, 'POST', '/api/companions/install', { origin: `http://localhost:${port}`, 'x-terminal-token': TOKEN });
    assert.equal(res.status, 400);
  });
  const missingDir = path.join(os.tmpdir(), 'pk-no-such-folder');
  it('refuses a new session in a folder that does not exist', async () => {
    const got = await session(port, { id: SESSION, mode: 'new', cwd: missingDir }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4004);
  });
  it('refuses a resume picker in a folder that does not exist', async () => {
    const got = await session(port, { id: SESSION, mode: 'pick', cwd: missingDir }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4004);
  });
  it('refuses a new session with a bad name', async () => {
    const got = await session(port, { id: SESSION, mode: 'new', cwd: os.tmpdir(), name: 'a"b' }, (g) => g.closeCode !== null);
    assert.equal(got.closeCode, 4002);
  });
  it('opens the folder dialog only with the token', async () => {
    const res = await api(port, 'POST', '/api/terminal/pick-folder', { origin: `http://localhost:${port}`, 'x-terminal-token': 'nope' });
    assert.equal(res.status, 401);
  });

  it('round-trips input, survives a reconnect, and ends on kill', async () => {
    const first = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    assert.equal(first.control[0].attached, false);
    first.ws.send(JSON.stringify({ t: 'in', d: 'echo pk-round-trip\r' }));
    await waitFor(first.ws, (d, bin) => bin && (first.out += d.toString()).includes('pk-round-trip'), 'echo');
    first.ws.close();

    const list = (await api(port, 'GET', '/api/terminals')).json;
    assert.equal(list.sessions.length, 1);

    const second = await session(port, { id: SESSION, mode: 'auto' }, (g) => g.out.includes('pk-round-trip'));
    assert.equal(second.control[0].t, 'ready');
    assert.equal(second.control[0].attached, true);

    const exited = waitFor(second.ws, (d, bin) => !bin && JSON.parse(d.toString()).t === 'exit', 'exit');
    second.ws.send(JSON.stringify({ t: 'kill' }));
    await exited;
    const after = (await api(port, 'GET', '/api/terminals')).json;
    assert.equal(after.sessions.length, 0);
  });

  it('hands the shell this board as PK_URL', async () => {
    const got = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    const ref = process.platform === 'win32' ? '%PK_URL%' : '$PK_URL';
    const want = `pk-url=http://127.0.0.1:${port}`;
    got.ws.send(JSON.stringify({ t: 'in', d: `echo pk-url=${ref}\r` }));
    await waitFor(got.ws, (d, bin) => bin && (got.out += d.toString()).includes(want), 'PK_URL');
    const del = await api(port, 'DELETE', `/api/terminals/${SESSION}`, { origin: `http://localhost:${port}`, 'x-terminal-token': TOKEN });
    assert.equal(del.status, 204);
  });

  it('ends a terminal over HTTP only with the token', async () => {
    const got = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    const exited = waitFor(got.ws, (d, bin) => { const m = !bin && JSON.parse(d.toString()); return m.t === 'exit' && m; }, 'exit');
    const del = (id, token) =>
      api(port, 'DELETE', `/api/terminals/${id}`, { origin: `http://localhost:${port}`, 'x-terminal-token': token });
    assert.equal((await del(SESSION, 'nope')).status, 401);
    assert.equal((await del('00000000-0000-4000-8000-000000000000', TOKEN)).status, 404);
    assert.equal((await del(SESSION, TOKEN)).status, 204);
    const after = (await api(port, 'GET', '/api/terminals')).json;
    assert.equal(after.sessions.length, 0);
    assert.equal((await exited).ended, true);
  });

  it('raises the terminal host, its console host and an attached shell, and restores the shell on detach', { skip: process.platform !== 'win32' }, async () => {
    const { PRIORITY_NORMAL, PRIORITY_ABOVE_NORMAL } = os.constants.priority;
    const until = async (test, what) => {
      for (let i = 0; i < 100; i++) {
        if (test()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`timeout: ${what}`);
    };
    const children = (parent, name) => {
      const q = `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='${name}'").ProcessId`;
      return require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', q]).toString().split(/\s+/).filter(Boolean).map(Number);
    };
    const [host] = children(srv.child.pid, 'node.exe');
    assert.ok(host, 'terminal host');
    const hosts = () => children(host, 'conhost.exe');
    assert.equal(os.getPriority(host), PRIORITY_ABOVE_NORMAL);
    assert.equal(os.getPriority(srv.child.pid), PRIORITY_NORMAL);

    const got = await session(port, { id: SESSION, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
    let pid = 0;
    // ConPTY reports the shell's pid only once its output pipe connects.
    for (let i = 0; i < 100 && !pid; i++) {
      [{ pid }] = (await api(port, 'GET', '/api/terminals')).json.sessions;
      if (!pid) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(pid, 'shell pid');
    await until(() => os.getPriority(pid) === PRIORITY_ABOVE_NORMAL, 'shell raised');
    await until(() => { const h = hosts(); return h.length > 0 && h.every((p) => os.getPriority(p) === PRIORITY_ABOVE_NORMAL); }, 'console host raised');

    got.ws.close();
    await until(() => os.getPriority(pid) === PRIORITY_NORMAL, 'shell restored');
    const del = await api(port, 'DELETE', `/api/terminals/${SESSION}`, { origin: `http://localhost:${port}`, 'x-terminal-token': TOKEN });
    assert.equal(del.status, 204);
  });
});

function fakePty({ holdExit = false } = {}) {
  const spawned = [];
  return {
    spawned,
    spawn(_file, args, opts) {
      let onExit = () => {};
      const p = {
        pid: 100000 + spawned.length, args, env: opts?.env, written: [], resizes: [], emit: () => {},
        onData(cb) { p.emit = cb; }, onExit(cb) { onExit = cb; }, write(d) { p.written.push(d); },
        resize(cols, rows) { p.resizes.push([cols, rows]); }, pause() {}, resume() {},
        exit() { onExit({ exitCode: 0 }); },
        kill() { if (!holdExit) setImmediate(() => onExit({ exitCode: 0 })); },
      };
      spawned.push(p);
      return p;
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await wait(10);
}

describe('package install', () => {
  function service(config = {}) {
    const pty = fakePty();
    const agentDir = path.join(os.tmpdir(), 'pk-install-agent');
    const t = createTerminalService({
      config: { enabled: true, shell: SHELL, maxSessions: 30, scrollback: 100, ...config },
      net: { EXPOSED: false },
      pty,
      token: TOKEN,
      piAgentDir: agentDir,
      which: (n) => n,
      resolveCwd: () => null,
      isAllowedFolder: () => true,
    });
    return { t, pty, agentDir };
  }

  it('runs pi install in a one-shot shell and reports its output and exit', async () => {
    const { t, pty, agentDir } = service();
    const { id } = t.startInstall(['install', 'npm:pi-subagents']);
    assert.ok(id);
    const p = pty.spawned[0];
    assert.match(p.args.join(' '), /pi install .npm:pi-subagents./);
    assert.equal(p.env.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(t.startInstall(['update', 'npm:pi-cost']).status, 409);

    p.emit('Installed npm:pi-subagents\r\n');
    p.exit();
    // The exit waits for xterm's timer-driven write queue, which a loaded test run can hold up.
    await until(() => t.installStatus(id)?.exited, 5000);
    const status = t.installStatus(id);
    assert.equal(status.command, 'pi install npm:pi-subagents');
    assert.equal(status.code, 0);
    assert.match(status.output, /Installed npm:pi-subagents/);
    assert.equal(t.installStatus('other'), null);
    assert.ok(t.startInstall(['update', 'npm:pi-cost']).id);
    assert.match(pty.spawned[1].args.join(' '), /pi update .npm:pi-cost./);
    t.shutdown();
  });

  it('refuses when the terminal is off', () => {
    const { t, pty } = service({ enabled: false });
    assert.equal(t.startInstall(['install', 'npm:pi-subagents']).status, 403);
    assert.equal(pty.spawned.length, 0);
    t.shutdown();
  });
});

describe('terminal restore', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'aaaaaaaa-0000-0000-0000-000000000002';
  const ELSEWHERE = 'aaaaaaaa-0000-0000-0000-000000000003';
  const UNKNOWN = 'aaaaaaaa-0000-0000-0000-000000000004';
  const GAP_MS = 60;
  const SAVE_MS = 20;

  function service(restore, initial, { live = [], dead = new Set(), rekeys = [] } = {}) {
    const store = { data: initial, loads: 0, saves: 0 };
    const pty = fakePty();
    const t = createTerminalService({
      config: { enabled: true, restore, shell: SHELL, maxSessions: 30, scrollback: 100 },
      net: { EXPOSED: false },
      pty,
      token: TOKEN,
      load: () => { store.loads++; return store.data; },
      save: (data) => { store.saves++; store.data = data; },
      restoreGapMs: GAP_MS,
      saveDelayMs: SAVE_MS,
      piAgentDir: os.tmpdir(),
      which: (n) => n,
      isLiveElsewhere: (id) => id === ELSEWHERE,
      resolveCwd: (id) => ([A, B, ELSEWHERE].includes(id) ? os.tmpdir() : null),
      isAllowedFolder: () => true,
      liveSessions: () => live,
      isPidAlive: (pid) => !dead.has(pid),
      exitPollMs: SAVE_MS,
      onRekey: (from, to) => rekeys.push([from, to]),
    });
    return { t, pty, store };
  }

  it('resumes the saved terminals one at a time and keeps the list in step', async () => {
    const { t, pty, store } = service(true, { sessions: [A, ELSEWHERE, UNKNOWN, 'not-a-uuid', B] });
    t.restore();
    await until(() => t.list().length === 1);
    assert.deepEqual(t.list().map((s) => s.id), [A]);
    await until(() => t.list().length === 2 && store.data.sessions.length === 2);
    assert.deepEqual(t.list().map((s) => s.id).sort(), [A, B]);
    assert.ok(pty.spawned.every((p) => p.args.join(' ').includes('--session ')));
    assert.deepEqual(store.data.sessions.sort(), [A, B]);

    const saves = store.saves;
    assert.equal(t.end(A, TOKEN), null);
    await until(() => store.saves > saves);
    assert.deepEqual(store.data.sessions, [B]);
    assert.equal(store.saves, saves + 1);

    t.shutdown();
    await wait(SAVE_MS * 3);
    assert.deepEqual(store.data.sessions, [B]);
  });

  it('does not save a terminal started with restore off', async () => {
    const { t, store } = service(true, null);
    const FRESH = 'aaaaaaaa-0000-0000-0000-000000000005';
    assert.equal((await t.startNew({ id: UNKNOWN, cwd: os.tmpdir(), restore: false })).id, UNKNOWN);
    assert.equal((await t.startNew({ id: FRESH, cwd: os.tmpdir() })).id, FRESH);
    await until(() => store.data?.sessions?.length === 1);
    assert.deepEqual(store.data.sessions, [FRESH]);
    t.shutdown();
  });

  it('finds a resumed pi by the transcript id and marks the terminal when pi exits', async () => {
    const FRESH = 'aaaaaaaa-0000-0000-0000-000000000006';
    const live = [{ pid: 4242, sessionId: B, startedAt: Date.now() + 1000 }];
    const { t } = service(false, null, { live });
    assert.equal((await t.startNew({ id: FRESH, cwd: os.tmpdir(), resume: B })).id, FRESH);
    await until(() => t.piPids()[FRESH] === 4242, 'pi pid');
    assert.equal(t.list()[0].piExited, false);
    live.length = 0;
    await until(() => t.list()[0].piExited, 'pi exit');
    t.shutdown();
  });

  it('follows /clear to the new session id and keeps the terminal id', async () => {
    const FRESH = 'aaaaaaaa-0000-0000-0000-000000000007';
    const live = [{ pid: 4242, sessionId: FRESH, startedAt: Date.now() + 1000 }];
    const rekeys = [];
    const { t, store } = service(true, null, { live, rekeys });
    assert.equal((await t.startNew({ id: FRESH, cwd: os.tmpdir() })).id, FRESH);
    await until(() => t.piPids()[FRESH] === 4242);
    assert.equal(t.piPids()[FRESH], 4242);
    const tid = t.list()[0].terminalId;
    live[0] = { ...live[0], sessionId: UNKNOWN };
    await wait(SAVE_MS * 4);
    assert.deepEqual(t.list().map((s) => s.id), [FRESH], 'no transcript yet, so the terminal waits');
    live[0] = { ...live[0], sessionId: B };
    await until(() => t.list()[0].id === B);
    assert.equal(t.list()[0].id, B);
    assert.equal(t.list()[0].terminalId, tid);
    assert.equal(t.list()[0].piExited, false);
    assert.deepEqual(rekeys, [[FRESH, B]]);
    await until(() => store.data?.sessions?.[0] === B);
    assert.deepEqual(store.data.sessions, [B]);
    t.shutdown();
  });

  it('refuses to resume a session running in another terminal', async () => {
    const { t, pty } = service(false, null);
    const r = await t.startNew({ cwd: os.tmpdir(), resume: ELSEWHERE });
    assert.equal(r.status, 409);
    assert.equal(pty.spawned.length, 0);
    t.shutdown();
  });

  it('gives each terminal an id in its env and its list entry, and keeps it across a restore', async () => {
    const TID = 'dddddddd-0000-0000-0000-000000000001';
    const { t, pty, store } = service(true, { sessions: [A], terminalIds: { [A]: TID, [UNKNOWN]: TID } });
    t.restore();
    await until(() => t.list().length === 1);
    assert.equal(t.list()[0].terminalId, TID);
    assert.equal(pty.spawned[0].env.PK_TERMINAL_ID, TID);

    const r = await t.startNew({ id: UNKNOWN, cwd: os.tmpdir() });
    assert.equal(r.id, UNKNOWN);
    const fresh = t.list().find((s) => s.id === UNKNOWN).terminalId;
    assert.match(fresh, /^[0-9a-f-]{36}$/);
    assert.notEqual(fresh, TID);
    assert.equal(pty.spawned[1].env.PK_TERMINAL_ID, fresh);
    await until(() => store.data.sessions.length === 2);
    assert.deepEqual(store.data.terminalIds, { [A]: TID, [UNKNOWN]: fresh });
    t.shutdown();
  });

  it('stops restoring a terminal whose pi exited to its shell, and resumes when pi is back', async () => {
    const live = [];
    const { t, store } = service(true, { sessions: [A] }, { live });
    t.restore();
    await until(() => t.list().length === 1);
    live.push({ sessionId: A, pid: 4242, startedAt: Date.now() });
    await until(() => t.piPids()[A] === 4242);
    assert.equal(t.paste(A, 'hi'), true);

    live.length = 0;
    await until(() => store.data.sessions.length === 0);
    assert.deepEqual(t.piPids(), {});
    assert.equal(t.paste(A, 'hi'), false);
    assert.deepEqual(t.list().map((s) => s.id), [A]);

    live.push({ sessionId: A, pid: 4343, startedAt: Date.now() });
    await until(() => store.data.sessions.length === 1);
    assert.deepEqual(store.data.sessions, [A]);
    assert.equal(t.piPids()[A], 4343);
    t.shutdown();
  });

  it('counts a crashed pi as gone, and a pi with no entry yet as starting', async () => {
    const live = [];
    const dead = new Set();
    const { t, store } = service(true, { sessions: [A, B] }, { live, dead });
    t.restore();
    await until(() => t.list().length === 2);
    live.push({ sessionId: B, pid: 5000, startedAt: Date.now() });
    await until(() => t.piPids()[B] === 5000);

    dead.add(5000);
    await until(() => store.data.sessions.length === 1);
    assert.deepEqual(store.data.sessions, [A]);
    t.shutdown();
  });

  it('keeps a /clear, which moves the entry to a new session id under the same pid', async () => {
    const live = [{ sessionId: A, pid: 6000, startedAt: Date.now() }];
    const { t, store } = service(true, { sessions: [A] }, { live });
    t.restore();
    await until(() => t.piPids()[A] === 6000);
    live[0] = { ...live[0], sessionId: B };
    await wait(SAVE_MS * 4);
    assert.deepEqual(store.data.sessions, [B]);
    assert.equal(t.piPids()[B], 6000);
    t.shutdown();
  });

  it('neither reads the list nor starts anything when restore is off', async () => {
    const { t, pty, store } = service(false, { sessions: [A] });
    t.restore();
    await wait(SAVE_MS * 3);
    assert.equal(store.loads, 0);
    assert.equal(pty.spawned.length, 0);
    assert.deepEqual(store.data.sessions, [A]);
    t.shutdown();
  });
});

describe('terminal sockets', { skip: !WebSocket }, () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';

  function service(pty) {
    return createTerminalService({
      config: { enabled: true, restore: false, shell: SHELL, maxSessions: 30, scrollback: 100 },
      net: { EXPOSED: false, upgradeVerdict: () => null },
      pty,
      token: TOKEN,
      piAgentDir: os.tmpdir(),
      which: (n) => n,
      isLiveElsewhere: () => false,
      resolveCwd: () => null,
      liveSessions: () => [],
    });
  }

  async function serve(pty) {
    const t = service(pty);
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => t.handleUpgrade(req, socket, head));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { t, server, port: server.address().port };
  }

  it('starts a new PTY for an id whose ended PTY has not exited yet', async () => {
    const pty = fakePty({ holdExit: true });
    const { t, server, port } = await serve(pty);
    const sockets = [];
    const ready = async () => {
      const got = await session(port, { id: A, mode: 'shell' }, (g) => g.control.some((m) => m.t === 'ready'));
      sockets.push(got.ws);
      return got;
    };
    try {
      const first = await ready();
      assert.equal(first.control[0].attached, false);
      assert.equal(t.end(A, TOKEN), null);

      const second = await ready();
      assert.equal(second.control[0].attached, false);
      assert.equal(pty.spawned.length, 2);

      pty.spawned[0].exit();
      assert.deepEqual(t.list().map((s) => s.id), [A]);
    } finally {
      for (const ws of sockets) ws.terminate();
      t.shutdown();
      server.close();
    }
  });

  it('replays a hidden cursor to a viewer that attaches later', async () => {
    const pty = fakePty();
    const { t, server, port } = await serve(pty);
    const ready = (g) => g.control.some((m) => m.t === 'ready');
    const first = await session(port, { id: A, mode: 'shell' }, ready);
    const later = [];
    try {
      const [p] = pty.spawned;
      const replay = async (data) => {
        p.emit(data);
        await wait(50);
        const got = await session(port, { id: A, mode: 'shell' }, (g) => ready(g) && g.out.includes('prompt'));
        later.push(got.ws);
        return got.out;
      };
      assert.ok((await replay('\x1b[?25lprompt')).endsWith('\x1b[?25l'));
      assert.ok(!(await replay('\x1b[?25h')).includes('\x1b[?25l'));
    } finally {
      for (const ws of [first.ws, ...later]) ws.terminate();
      t.shutdown();
      server.close();
    }
  });

  it('sizes a shared PTY to the viewer that last attached, focused or typed', async () => {
    const pty = fakePty();
    const { t, server, port } = await serve(pty);
    const ready = (g) => g.control.some((m) => m.t === 'ready');
    const big = await session(port, { id: A, mode: 'shell' }, ready);
    const small = await session(port, { id: A, mode: 'shell' }, ready);
    try {
      const [p] = pty.spawned;
      const step = async (ws, msg) => {
        ws.send(JSON.stringify(msg));
        await wait(50);
      };
      await step(big.ws, { t: 'resize', cols: 200, rows: 60, claim: true });
      await step(small.ws, { t: 'resize', cols: 100, rows: 30, claim: true });
      await step(big.ws, { t: 'resize', cols: 210, rows: 60 });
      assert.equal(p.resizes.length, 2, 'a layout change of a viewer that does not own the PTY');
      await step(big.ws, { t: 'in', d: '/' });
      await step(small.ws, { t: 'resize', cols: 90, rows: 30 });
      await step(small.ws, { t: 'in', d: 'x' });
      await step(small.ws, { t: 'in', d: 'y' });
      small.ws.close();
      await until(() => p.resizes.length === 5);
      assert.deepEqual(p.resizes, [[200, 60], [100, 30], [210, 60], [90, 30], [210, 60]]);
      assert.deepEqual(p.written, ['/', 'x', 'y']);
    } finally {
      big.ws.terminate();
      small.ws.terminate();
      t.shutdown();
      server.close();
    }
  });
});

describe('terminal endpoint when disabled', { skip: !ptyAvailable }, () => {
  let srv;
  let port;
  before(async () => {
    srv = startServer(['--no-terminal']);
    port = await srv.port;
  });
  after(() => stopServer(srv));

  it('refuses the handshake', async () => {
    assert.equal(await handshakeStatus(port, { origin: `http://localhost:${port}` }), 403);
  });
});
