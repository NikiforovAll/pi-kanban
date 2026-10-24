const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ENV_SESSION_DIR,
  sessionRoots,
  getSessionsRoot,
  encodeProjectDir,
  decodeProjectDir,
  listSessionFiles,
  readSessionHeader,
  describeSessionFile,
  listSessions,
  findSessionFile,
  projectKey,
  scanSessionIds,
} = require('../lib/pi-sessions');

const PI_DIR = path.join(__dirname, 'fixtures', 'pi');
const AGENT_DIR = path.join(PI_DIR, 'agent');
const NESTED = path.join(AGENT_DIR, 'sessions');
const PROJECT = path.join(NESTED, '--C--work-demo--');
const FLAT = path.join(PI_DIR, 'flat');
const id = (n) => `01a20000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const BOTH = { agentDir: AGENT_DIR, env: { [ENV_SESSION_DIR]: FLAT } };
const NESTED_ONLY = { agentDir: AGENT_DIR, env: {} };

const header = (sessionId, extra) => `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: 'C:\\x', ...extra })}\n`;

describe('pi-sessions: roots', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-roots-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const settings = (sessionDir) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ sessionDir }));

  it('scans only the nested dir by default', () => {
    assert.deepEqual(sessionRoots(NESTED_ONLY), [{ dir: NESTED, flat: false }]);
    assert.equal(getSessionsRoot(NESTED_ONLY), NESTED);
  });

  it('puts the env dir first and keeps the nested dir', () => {
    assert.deepEqual(sessionRoots(BOTH), [{ dir: FLAT, flat: true }, { dir: NESTED, flat: false }]);
    assert.equal(getSessionsRoot(BOTH), FLAT);
  });

  it('reads sessionDir from settings.json, with ~ expanded', () => {
    settings('~/pi-sessions');
    assert.deepEqual(sessionRoots({ agentDir: dir, env: {} })[0], { dir: path.join(os.homedir(), 'pi-sessions'), flat: true });
  });

  it('prefers the env dir over settings.json', () => {
    settings('~/pi-sessions');
    assert.equal(getSessionsRoot({ agentDir: dir, env: { [ENV_SESSION_DIR]: FLAT } }), FLAT);
  });

  it('treats a configured dir equal to the nested dir as nested', () => {
    settings(path.join(dir, 'sessions'));
    assert.deepEqual(sessionRoots({ agentDir: dir, env: {} }), [{ dir: path.join(dir, 'sessions'), flat: false }]);
  });

  it('ignores a blank or broken settings.json', () => {
    settings('  ');
    assert.equal(sessionRoots({ agentDir: dir, env: {} }).length, 1);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{');
    assert.equal(sessionRoots({ agentDir: dir, env: {} }).length, 1);
  });
});

describe('pi-sessions: project dir names', () => {
  it('encodes a Windows and a POSIX cwd the way pi does', () => {
    assert.equal(encodeProjectDir('C:\\work\\demo'), '--C--work-demo--');
    assert.equal(encodeProjectDir('/home/dev/app'), '--home-dev-app--');
  });

  it('decodes them back', () => {
    assert.equal(decodeProjectDir('--C--work-demo--'), 'C:\\work\\demo');
    assert.equal(decodeProjectDir('--home-dev-app--'), '/home/dev/app');
  });
});

describe('pi-sessions: discovery', () => {
  it('lists nested and flat session files', () => {
    const names = listSessionFiles(BOTH).map((f) => path.basename(f).slice(-17, -6)).sort();
    assert.deepEqual(names, [1, 2, 3, 4, 5, 6].map((n) => id(n).slice(-11)));
    assert.equal(listSessionFiles(NESTED_ONLY).length, 4);
  });

  it('reads the header of a session file and null for anything else', () => {
    assert.equal(readSessionHeader(path.join(FLAT, fs.readdirSync(FLAT)[0])).type, 'session');
    assert.equal(readSessionHeader(path.join(__dirname, 'fixtures', 'session.jsonl')), null);
    assert.equal(readSessionHeader(path.join(FLAT, 'missing.jsonl')), null);
  });

  it('describes a nested session from its header', () => {
    const file = findSessionFile(id(1), BOTH);
    const d = describeSessionFile(file);
    assert.deepEqual({ ...d, mtimeMs: typeof d.mtimeMs }, {
      sessionId: id(1),
      cwd: 'C:\\work\\demo',
      projectKey: 'C:\\work\\demo',
      projectDir: PROJECT,
      filePath: file,
      mtimeMs: 'number',
      createdAt: '2026-10-24T10:00:00.000Z',
      parentSession: null,
    });
  });

  it('describes a flat fork with its parent session and POSIX cwd', () => {
    const fork = describeSessionFile(findSessionFile(id(5), BOTH));
    assert.equal(fork.projectDir, FLAT);
    assert.match(fork.parentSession, /_01a20000-0000-7000-8000-000000000004\.jsonl$/);
    assert.equal(describeSessionFile(findSessionFile(id(6), BOTH)).projectKey, '/home/dev/app');
  });

  it('returns null for a file that is not a pi session', () => {
    assert.equal(describeSessionFile(path.join(__dirname, 'fixtures', 'session.jsonl')), null);
    assert.equal(describeSessionFile(path.join(FLAT, 'missing.jsonl')), null);
  });

  it('lists every session once', () => {
    assert.deepEqual(listSessions(BOTH).map((s) => s.sessionId).sort(), [1, 2, 3, 4, 5, 6].map(id));
  });

  it('finds a session file by id, and null for an unknown or flat id without the env dir', () => {
    assert.equal(path.dirname(findSessionFile(id(2), BOTH)), PROJECT);
    assert.equal(path.dirname(findSessionFile(id(6), BOTH)), FLAT);
    assert.equal(findSessionFile(id(6), NESTED_ONLY), null);
    assert.equal(findSessionFile('nope', BOTH), null);
    assert.equal(findSessionFile('', BOTH), null);
  });

  it('gives the project key from the header, or from the folder name', () => {
    assert.equal(projectKey(findSessionFile(id(6), BOTH)), '/home/dev/app');
    assert.equal(projectKey(PROJECT), 'C:\\work\\demo');
  });

  it('scans session ids and their folders', () => {
    const { ids, dirs } = scanSessionIds(BOTH);
    assert.deepEqual([...ids].sort(), [1, 2, 3, 4, 5, 6].map(id));
    assert.deepEqual([...dirs].sort(), ['--C--work-demo--', 'flat']);
  });

  it('returns null from a scan with no sessions', () => {
    assert.equal(scanSessionIds({ agentDir: path.join(os.tmpdir(), 'pk-no-agent-dir'), env: {} }), null);
  });
});

describe('pi-sessions: layout edge cases', () => {
  let agentDir;
  let project;
  before(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-layout-'));
    project = path.join(agentDir, 'sessions', '--C--x--');
    const parent = '2026-01-01T00-00-00-000Z_p1';
    const run = path.join(project, parent, 'run-1', 'run-0');
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(path.join(project, 'subagent-artifacts'));
    fs.writeFileSync(path.join(project, `${parent}.jsonl`), header('p1'));
    fs.writeFileSync(path.join(run, 'session.jsonl'), header('c1', { parentSession: path.join(project, `${parent}.jsonl`) }));
    fs.writeFileSync(path.join(project, 'subagent-artifacts', 'out.jsonl'), header('a1'));
    fs.writeFileSync(path.join(project, 'renamed.jsonl'), header('r1'));
    fs.writeFileSync(path.join(agentDir, 'sessions', 'stray.jsonl'), header('s1'));
  });
  after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

  const opts = () => ({ agentDir, env: {} });

  it('skips subagent child sessions, artifacts and files outside a project folder', () => {
    assert.deepEqual(listSessions(opts()).map((s) => s.sessionId).sort(), ['p1', 'r1']);
  });

  it('finds a session whose file name does not carry its id', () => {
    assert.equal(findSessionFile('r1', opts()), path.join(project, 'renamed.jsonl'));
  });
});
