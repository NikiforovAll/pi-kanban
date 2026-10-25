const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { getAgentDir, longPath } = require('./agent-dir');

const DEFAULT_PI_AGENT_DIR = longPath(path.join(os.homedir(), '.pi', 'agent'));

// --name <value> | --name=<value>; null when absent.
function getArgValue(name) {
  const argv = process.argv;
  const idx = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const arg = argv[idx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return argv[idx + 1] || null;
}

function expandHome(dir) {
  return dir.replace(/^~/, os.homedir());
}

// --dir | PI_DIR/agent | PI_CODING_AGENT_DIR | ~/.pi/agent
function resolvePiAgentDir() {
  const dir = getArgValue('dir');
  return dir ? longPath(expandHome(dir)) : getAgentDir();
}

function boardDir(dir) {
  return path.join(dir, 'kanban');
}

function isDefaultPiAgentDir(dir) {
  return longPath(dir) === DEFAULT_PI_AGENT_DIR;
}

// localStorage is per browser origin, so every config dir served from the same port would
// otherwise share last view, collapsed groups and sidebar layout. The default dir keeps the
// bare keys; any other dir gets a prefix derived from its resolved path.
function storageNamespace(dir) {
  if (isDefaultPiAgentDir(dir)) return null;
  return `cfg-${crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 8)}`;
}

// Home-relative, forward-slash form for messages and shell commands.
function displayPath(p) {
  const home = os.homedir();
  const rel = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  return rel.split(path.sep).join('/');
}

// The harness spells a project path into a temp/log dir name by replacing every
// non-alphanumeric character with a dash, drive colon and separators included.
function encodeProjectDirName(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

// pi puts no session id in the environment, so the extension sets this for the commands a session runs.
const SESSION_ID_ENV = 'PI_KANBAN_SESSION_ID';

module.exports = { getArgValue, resolvePiAgentDir, boardDir,isDefaultPiAgentDir, displayPath, storageNamespace, encodeProjectDirName, SESSION_ID_ENV };
