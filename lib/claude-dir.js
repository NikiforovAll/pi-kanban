const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { getAgentDir } = require('./agent-dir');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.pi', 'agent');

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
function getClaudeDir() {
  const dir = getArgValue('dir');
  return dir ? expandHome(dir) : getAgentDir();
}

function boardDir(dir) {
  return path.join(dir, 'kanban');
}

function isDefaultClaudeDir(dir) {
  return path.resolve(dir) === path.resolve(DEFAULT_CLAUDE_DIR);
}

// localStorage is per browser origin, so every config dir served from the same port would
// otherwise share last view, collapsed groups and sidebar layout. The default dir keeps the
// bare keys; any other dir gets a prefix derived from its resolved path.
function storageNamespace(dir) {
  if (isDefaultClaudeDir(dir)) return null;
  return `cfg-${crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 8)}`;
}

// Env for spawning the claude CLI. Claude Code keeps .claude.json beside ~/.claude when
// CLAUDE_CONFIG_DIR is unset but inside the dir when it is set, so the default dir must
// stay unset rather than be spelled out.
function claudeCliEnv(dir) {
  return isDefaultClaudeDir(dir) ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: dir };
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

module.exports = { getArgValue, getClaudeDir, boardDir,claudeCliEnv, isDefaultClaudeDir, displayPath, storageNamespace, encodeProjectDirName };
