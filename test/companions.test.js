const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { companionStatus, installPlan, refreshLatest, packageName, newerVersion } = require('../lib/companions');

describe('newerVersion', () => {
  it('compares versions by number, not by text', () => {
    assert.equal(newerVersion('0.10.0', '0.9.0'), true);
    assert.equal(newerVersion('0.82.1', '0.81.0'), true);
    assert.equal(newerVersion('2.15.0', '2.15.0'), false);
    assert.equal(newerVersion('2.15.0', '2.15.1'), false);
  });
});

describe('packageName', () => {
  it('reads the name from npm and git sources', () => {
    assert.equal(packageName('npm:pi-subagents', '/'), 'pi-subagents');
    assert.equal(packageName('npm:pi-cost@0.1.1', '/'), 'pi-cost');
    assert.equal(packageName('npm:@juicesharp/rpiv-todo', '/'), '@juicesharp/rpiv-todo');
    assert.equal(packageName('npm:@juicesharp/rpiv-todo@1.2.0', '/'), '@juicesharp/rpiv-todo');
    assert.equal(packageName('git:github.com/user/pi-inspect@v1', '/'), 'pi-inspect');
    assert.equal(packageName('https://github.com/user/pi-inspect.git', '/'), 'pi-inspect');
  });
});

describe('companionStatus', () => {
  let root;
  let agentDir;
  let cwd;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-companions-'));
    agentDir = path.join(root, 'agent');
    cwd = path.join(root, 'project');
    const local = path.join(root, 'checkout');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: 'pi-kanban' }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
      packages: [path.relative(agentDir, local), 'npm:pi-subagents', { source: 'npm:@juicesharp/rpiv-todo' }, 'npm:pi-inspect@0.5.0', 42],
    }));
    fs.writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ packages: ['npm:pi-cost'] }));
    const installed = (root, pkg, version) => {
      fs.mkdirSync(path.join(root, 'node_modules', pkg), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version }));
    };
    installed(path.join(agentDir, 'npm'), 'pi-subagents', '0.9.0');
    installed(path.join(agentDir, 'npm'), '@juicesharp/rpiv-todo', '2.0.0');
    installed(path.join(cwd, '.pi', 'npm'), 'pi-cost', '0.1.0');
    installed(path.join(agentDir, 'npm'), 'pi-inspect', '0.5.0');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const scopes = (rows) => Object.fromEntries(rows.map((c) => [c.id, c.scope]));

  it('finds packages in the global and the project settings', () => {
    assert.deepEqual(scopes(companionStatus({ agentDir, cwd })), {
      'pi-kanban': 'global', 'pi-subagents': 'global', 'rpiv-todo': 'global', 'pi-cost': 'project', 'pi-inspect': 'global',
    });
  });

  it('reads only the global settings without an absolute cwd', () => {
    assert.equal(scopes(companionStatus({ agentDir, cwd: null }))['pi-cost'], null);
    assert.equal(scopes(companionStatus({ agentDir, cwd: 'project' }))['pi-cost'], null);
  });

  it('installs a missing package globally and updates one where it is listed', () => {
    const other = path.join(root, 'other');
    assert.deepEqual(installPlan('pi-cost', { agentDir, cwd: other }), { piArgs: ['install', 'npm:pi-cost'], cwd: null });
    assert.deepEqual(installPlan('pi-cost', { agentDir, cwd }), { piArgs: ['update', 'npm:pi-cost'], cwd });
    assert.deepEqual(installPlan('pi-subagents', { agentDir, cwd }), { piArgs: ['update', 'npm:pi-subagents'], cwd: null });
    assert.equal(installPlan('nope', { agentDir, cwd }), null);
  });

  it('checks unpinned npm packages for updates once, in the background', async () => {
    const asked = [];
    const view = async (_cmd, pkg) => {
      asked.push(pkg);
      return { 'pi-subagents': '0.10.0', 'pi-cost': '0.1.0', '@juicesharp/rpiv-todo': '2.0.0', 'pi-inspect': '0.6.0' }[pkg] ?? null;
    };
    const before = companionStatus({ agentDir, cwd });
    assert.equal(before.find((c) => c.id === 'pi-subagents').update, false);
    assert.equal(await refreshLatest(before, { agentDir, view }), true);
    assert.deepEqual(asked.sort(), ['@juicesharp/rpiv-todo', 'pi-cost', 'pi-subagents']);

    const rows = Object.fromEntries(companionStatus({ agentDir, cwd }).map((c) => [c.id, c]));
    assert.deepEqual([rows['pi-subagents'].version, rows['pi-subagents'].latest, rows['pi-subagents'].update], ['0.9.0', '0.10.0', true]);
    assert.equal(rows['pi-cost'].update, false);
    assert.deepEqual([rows['rpiv-todo'].version, rows['rpiv-todo'].latest, rows['rpiv-todo'].update], ['2.0.0', '2.0.0', false]);
    assert.deepEqual([rows['pi-inspect'].version, rows['pi-inspect'].latest], ['0.5.0', null]);
    assert.equal(rows['pi-kanban'].version, null);

    assert.equal(await refreshLatest(Object.values(rows), { agentDir, view }), false);
    assert.equal(asked.length, 3);
  });

  it('expands a leading ~ in a local path the way pi does', () => {
    const home = path.join(root, 'home');
    const checkout = path.join(home, 'dev', 'pi-cost');
    const tildeAgent = path.join(root, 'tilde-agent');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(tildeAgent, { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'pi-cost', version: '0.2.0' }));
    fs.writeFileSync(path.join(tildeAgent, 'settings.json'), JSON.stringify({ packages: [' ~/dev/pi-cost'] }));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const cost = companionStatus({ agentDir: tildeAgent, cwd: null }).find((c) => c.id === 'pi-cost');
      assert.deepEqual([cost.scope, cost.dir], ['global', checkout]);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });

  it('treats a missing settings file as no packages', () => {
    const rows = companionStatus({ agentDir: path.join(root, 'none'), cwd: null });
    assert.ok(rows.every((c) => c.scope === null));
    assert.equal(rows.find((c) => c.id === 'pi-subagents').source, 'npm:pi-subagents');
  });
});
