const os = require('node:os');
const path = require('node:path');
const { realpathDeepest } = require('./contain');

// libuv aborts the process when a watched Windows path holds an 8.3 short name (NIKIFO~1),
// because the events come back with the long name, so every dir the board watches gets its long form.
const longPath = (dir) => realpathDeepest(path.resolve(dir));

// Mirrors getAgentDir() in @earendil-works/pi-coding-agent. PI_DIR is pi-kanban's own
// override (demo, tests) and points at the parent of the agent dir.
function rawAgentDir() {
  if (process.env.PI_DIR) return path.join(process.env.PI_DIR, 'agent');
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.join(os.homedir(), '.pi', 'agent');
}

const getAgentDir = () => longPath(rawAgentDir());

module.exports = { getAgentDir, longPath };
