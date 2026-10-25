'use strict';

// The pi packages the board's features read from. pi loads a package listed under "packages" in
// <agentDir>/settings.json (global) or <cwd>/.pi/settings.json (project); see pi's docs/packages.md.

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { readSettings } = require('./claude-settings');

const COMPANIONS = [
  { id: 'pi-kanban', pkg: 'pi-kanban', feature: 'Board skills: show, ask, panes, dispatch' },
  { id: 'pi-subagents', pkg: 'pi-subagents', feature: 'Subagents' },
  { id: 'rpiv-todo', pkg: '@juicesharp/rpiv-todo', feature: 'Todos' },
  { id: 'pi-cost', pkg: 'pi-cost', feature: 'Cost pane', optional: true, verb: 'cost', shows: 'cost, tokens and models' },
  { id: 'pi-inspect', pkg: 'pi-inspect', feature: 'Inspect pane', optional: true, verb: 'inspect', shows: 'the system prompt, tools, extensions, skills and context pi loaded' },
].map((c) => ({ ...c, source: `npm:${c.pkg}` }));

// The companions that open as a session pane, by their verb in `pi-kanban session` and `/kanban`.
const PANE_COMPANIONS = COMPANIONS.filter((c) => c.verb);

const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
const NPM_VIEW_TIMEOUT_MS = 30000;
const GIT_SOURCE = /^(git:|https?:\/\/|ssh:\/\/|git@)/;

// Mirrors pi's resolvePathFromBase (utils/paths.js normalizePath): trim, expand a leading ~, resolve.
function localDir(source, baseDir) {
  const s = source.trim();
  const home = process.env.HOME || os.homedir();
  if (s === '~') return home;
  if (s.startsWith('~/') || (process.platform === 'win32' && s.startsWith('~\\'))) return path.join(home, s.slice(2));
  return path.resolve(baseDir, s);
}

// npm and git sources carry the name; a local path names the package in its package.json.
function packageName(source, baseDir) {
  if (source.startsWith('npm:')) return source.slice(4).replace(/(.)@.*$/, '$1');
  if (GIT_SOURCE.test(source)) {
    return path.posix.basename(source.replace(/@[^/@]*$/, '').replace(/\.git$/, '').replace(/\/+$/, ''));
  }
  const dir = localDir(source, baseDir);
  return readSettings(path.join(dir, 'package.json'))?.name || path.basename(dir);
}

function settingsPackages(file) {
  const list = readSettings(file)?.packages;
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => (typeof p === 'string' ? p : p?.source))
    .filter((s) => typeof s === 'string' && s)
    .map((source) => ({ source, base: path.dirname(file), name: packageName(source, path.dirname(file)) }));
}

// pi reads a local path in place. A git clone has no fixed folder the board can name.
function packageFolder(at, pkg) {
  if (at.source.startsWith('npm:')) return path.join(at.npmRoot, 'node_modules', pkg);
  return GIT_SOURCE.test(at.source) ? null : localDir(at.source, at.base);
}

const installedVersion = (dir) => readSettings(path.join(dir, 'package.json'))?.version || null;

function newerVersion(a, b) {
  const parts = (v) => v.split(/[.+-]/).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const latestVersions = new Map();

// pi installs npm packages under <agentDir>/npm (global) or <cwd>/.pi/npm (project), and checks
// an unpinned one for updates with `npm view <name> version` (DefaultPackageManager.checkForAvailableUpdates).
function companionStatus({ agentDir, cwd }) {
  const project = typeof cwd === 'string' && path.isAbsolute(cwd);
  const packages = [
    ...settingsPackages(path.join(agentDir, 'settings.json')).map((p) => ({ ...p, scope: 'global', npmRoot: path.join(agentDir, 'npm') })),
    ...(project ? settingsPackages(path.join(cwd, '.pi', 'settings.json')).map((p) => ({ ...p, scope: 'project', npmRoot: path.join(cwd, '.pi', 'npm') })) : []),
  ];
  return COMPANIONS.map((c) => {
    const at = packages.find((p) => p.name === c.pkg);
    if (!at) return { ...c, scope: null, dir: null, version: null, latest: null, update: false };
    const npm = at.source.startsWith('npm:');
    const tracked = npm && !at.source.slice(4).includes('@', 1);
    const dir = packageFolder(at, c.pkg);
    const version = npm ? installedVersion(dir) : null;
    const latest = (tracked && latestVersions.get(c.pkg)?.version) || null;
    return { ...c, scope: at.scope, dir, version, latest, update: !!(version && latest && newerVersion(latest, version)), tracked };
  });
}

// A missing package installs globally; an installed one updates where it is listed, and a project
// package updates from its project's folder, where pi reads .pi/settings.json.
function installPlan(id, { agentDir, cwd }) {
  const c = companionStatus({ agentDir, cwd }).find((r) => r.id === id);
  if (!c) return null;
  return { piArgs: [c.scope ? 'update' : 'install', c.source], cwd: c.scope === 'project' ? cwd : null };
}

function offline() {
  const v = process.env.PI_OFFLINE?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function npmView(npmCommand, pkg) {
  const [cmd, ...args] = Array.isArray(npmCommand) && npmCommand[0] ? npmCommand : ['npm'];
  return new Promise((resolve) => {
    // npm is npm.cmd on Windows, and Node runs a .cmd only through a shell. pkg is one of COMPANIONS.
    execFile(cmd, [...args, 'view', pkg, 'version', '--json'], { timeout: NPM_VIEW_TIMEOUT_MS, shell: process.platform === 'win32', windowsHide: true }, (err, stdout) => {
      try {
        const v = err ? null : JSON.parse(stdout);
        resolve(typeof v === 'string' ? v : null);
      } catch {
        resolve(null);
      }
    });
  });
}

// One npm call per package every LATEST_TTL_MS, run off the request. Resolves true when a latest
// version changed, so the caller can tell the board.
async function refreshLatest(rows, { agentDir, view = npmView, now = Date.now() }) {
  if (offline()) return false;
  const stale = rows.filter((r) => r.tracked && r.version && !(now - (latestVersions.get(r.pkg)?.at ?? -Infinity) < LATEST_TTL_MS));
  if (!stale.length) return false;
  for (const r of stale) latestVersions.set(r.pkg, { version: latestVersions.get(r.pkg)?.version ?? null, at: now });
  const npmCommand = readSettings(path.join(agentDir, 'settings.json'))?.npmCommand;
  const found = await Promise.all(stale.map(async (r) => {
    const version = await view(npmCommand, r.pkg);
    const before = latestVersions.get(r.pkg).version;
    latestVersions.set(r.pkg, { version, at: now });
    return version !== before;
  }));
  return found.some(Boolean);
}

module.exports = { COMPANIONS, PANE_COMPANIONS, companionStatus, installPlan, refreshLatest, packageName, newerVersion };
