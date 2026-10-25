const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempAgentDir, startServer, stopServer } = require('./server-harness');

const ID = '01a20000-0000-7000-8000-0000000000b1';

describe('/api/sessions git branch', () => {
  let srv;
  let port;

  before(async () => {
    const dir = tempAgentDir('pk-branch-');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/pi\n');
    const sessions = path.join(dir, 'sessions', '--repo--');
    fs.mkdirSync(sessions, { recursive: true });
    const lines = [
      { type: 'session', version: 3, id: ID, timestamp: '2026-10-24T10:00:00.000Z', cwd: repo },
      { type: 'message', id: 'a1', parentId: null, timestamp: '2026-10-24T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ];
    fs.writeFileSync(path.join(sessions, `2026-10-24T10-00-00-000Z_${ID}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    srv = startServer(['--no-terminal'], { dir, env: { PI_CODING_AGENT_SESSION_DIR: undefined } });
    port = await srv.port;
  });

  after(() => stopServer(srv));

  it('reads HEAD for a pi session in an ordinary checkout', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=all`);
    const session = (await res.json()).find((s) => s.id === ID);
    assert.equal(session?.gitBranch, 'feat/pi');
  });
});
