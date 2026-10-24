const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { piArgsFor, piCommand, parseNewSpec } = require('../lib/terminal');

describe('pi args pass-through', () => {
  const spec = (extraArgs) => parseNewSpec({ cwd: '/a', name: 'x', model: 'sonnet', extraArgs });

  it('puts the extra args after the session id', () => {
    const s = spec(['--tools', 'read,grep', '--offline']);
    assert.deepEqual(piArgsFor('new', 'id-1', s), [
      '--session-id', 'id-1', '--tools', 'read,grep', '--offline',
      '--name', 'x', '--model', 'sonnet',
    ]);
  });

  it('resumes in place of a new session id', () => {
    const id = '0b6a3c3e-2f9e-4c55-9a3e-6c1f0d2b7a11';
    const s = parseNewSpec({ cwd: '/a', resume: id, extraArgs: ['--offline'] });
    assert.deepEqual(piArgsFor('new', 'pty-1', s), ['--session', id, '--offline']);
    assert.equal(parseNewSpec({ cwd: '/a', resume: 'nope' }), 'session to resume');
    assert.equal(parseNewSpec({ resume: id, forkOf: id }), 'session to resume');
  });

  it('accepts no extra args', () => {
    assert.deepEqual(spec(undefined).extraArgs, []);
  });

  it('refuses flags pi-kanban sets, in both spellings', () => {
    for (const flag of ['--session-id', '-n', '--name=y', '--model', '--thinking', '--resume', '-c', '--fork', '--session-dir', '--no-session', '-p', '--print', '--mode']) {
      assert.match(spec([flag]), /pi-kanban sets/, flag);
    }
  });

  it('refuses values that could leave the quotes', () => {
    for (const bad of ['a"b', '%PATH%', 'a\nb', '\x1b[2J']) assert.match(spec([bad]), /no double quotes/, JSON.stringify(bad));
  });

  it("keeps a ' inside its argument in every shell", () => {
    const arg = "C:\\Users\\O'Brien\\.pi";
    assert.deepEqual(spec([arg]).extraArgs, [arg]);
    assert.equal(piCommand('bash', [arg]), "pi 'C:\\Users\\O'\\''Brien\\.pi'");
    assert.equal(piCommand('pwsh', [arg]), "pi 'C:\\Users\\O''Brien\\.pi'");
    assert.equal(piCommand('cmd.exe', [arg]), `pi "${arg}"`);
  });

  it('refuses a non-list or too many args', () => {
    assert.match(spec('--verbose'), /pi args/);
    assert.match(spec(Array(65).fill('-v')), /pi args/);
    assert.match(spec([7]), /no double quotes/);
  });
});
