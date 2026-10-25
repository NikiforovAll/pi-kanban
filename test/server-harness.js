const { spawn } = require('node:child_process');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempAgentDir(prefix = 'pk-term-') {
  // os.tmpdir() can be an 8.3 short path, and libuv's Windows watcher asserts on an event
  // under one (fs-event.c), which kills the server the first time it writes to .pi-kanban.
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// An `env` value of undefined drops that variable from the inherited environment.
function startServer(extraArgs, { dir = tempAgentDir(), env: extra = {} } = {}) {
  const env = { ...process.env, PORT: '0', PI_CODING_AGENT_DIR: dir, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), ...extraArgs], {
    env,
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

function stopServer(s, { keepDir = false } = {}) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(s.child.pid), '/f', '/t'], { stdio: 'ignore' });
  else s.child.kill();
  // A child that outlives the kill must not keep the test process alive through its pipes.
  s.child.stdout.destroy();
  s.child.stderr.destroy();
  s.child.unref();
  if (keepDir) return;
  try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* locked by the dying child */ }
}

module.exports = { tempAgentDir, startServer, stopServer };
