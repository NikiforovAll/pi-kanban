const os = require('node:os');
const path = require('node:path');

// Mirrors getAgentDir() in @earendil-works/pi-coding-agent. PI_DIR is pi-kanban's own
// override (demo, tests) and points at the parent of the agent dir.
function getAgentDir() {
  if (process.env.PI_DIR) return path.join(process.env.PI_DIR, 'agent');
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return envDir.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.join(os.homedir(), '.pi', 'agent');
}

module.exports = { getAgentDir };
