const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const gitBranchModule = require('./git-branch');
const taskStore = require('./task-store');

// Optional callback (cwd, branch) -> void, set by server.js to push SSE updates when branches resolve.
let onBranchResolved = null;
function setOnBranchResolved(fn) { onBranchResolved = typeof fn === 'function' ? fn : null; }

const PI_DIR = process.env.PI_DIR || path.join(os.homedir(), '.pi');
const SESSIONS_DIR = path.join(PI_DIR, 'agent', 'sessions');

function getPiDir() {
  return PI_DIR;
}

function getSessionsDir() {
  return SESSIONS_DIR;
}

// "--C--Users-nikiforovall-dev-pi--" -> "C:\Users\nikiforovall\dev\pi"
function decodeProjectDir(name) {
  let s = name;
  if (s.startsWith('--')) s = s.slice(2);
  if (s.endsWith('--')) s = s.slice(0, -2);
  // First "C" (or any single letter) at start represents drive letter, then dashes are path separators.
  // The convention is: drive letter + "-" then path with "/" replaced by "-".
  // e.g. "C--Users-nikiforovall-dev-pi" -> "C:\Users\nikiforovall\dev\pi"
  const m = s.match(/^([A-Za-z])--(.+)$/);
  if (m) {
    return `${m[1]}:\\${m[2].replace(/-/g, '\\')}`;
  }
  return s.replace(/-/g, path.sep);
}

function listSessionFiles() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out = [];
  for (const projDir of fs.readdirSync(SESSIONS_DIR)) {
    const projPath = path.join(SESSIONS_DIR, projDir);
    let stat;
    try { stat = fs.statSync(projPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(projPath)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(projPath, f);
      let s;
      try { s = fs.statSync(full); } catch { continue; }
      if (!s.isFile()) continue;
      out.push({
        file: full,
        projectDir: projDir,
        cwd: decodeProjectDir(projDir),
        mtime: s.mtime,
        size: s.size,
      });
    }
  }
  return out;
}

async function readJsonlLines(file) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (l) => { if (l.trim()) lines.push(l); });
    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
  });
}

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

async function readSessionEntries(file) {
  const lines = await readJsonlLines(file);
  const entries = [];
  for (const l of lines) {
    const e = parseLine(l);
    if (e) entries.push(e);
  }
  return entries;
}

// Extract concrete agent spawns from a `subagent` toolCall arguments.
// Returns [] for management calls (action:"list" etc) so they don't pollute the agent list.
// Single spawn: {agent, task} -> [{agent, task}]
// Chain: {chain: [step, ...]} where each step is either {agent, task} or {parallel: [{agent, task}, ...]}
function expandSubagentSpawns(args) {
  if (!args || typeof args !== 'object') return [];
  if (args.task && typeof args.task === 'string') {
    return [{ agent: args.agent || null, task: args.task }];
  }
  if (Array.isArray(args.chain)) {
    const out = [];
    for (const step of args.chain) {
      if (!step || typeof step !== 'object') continue;
      if (Array.isArray(step.parallel)) {
        for (const item of step.parallel) {
          if (item && item.task) out.push({ agent: item.agent || null, task: item.task });
        }
      } else if (step.task) {
        out.push({ agent: step.agent || null, task: step.task });
      }
    }
    return out;
  }
  return [];
}

function summarize(entries) {
  let sessionEntry = null;
  let firstModel = null;
  let lastTimestamp = null;
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let messageCount = 0;
  let provider = null;
  let model = null;
  let customTitle = null;
  let lastAssistantUsage = null;
  let lastTodoTasks = null;
  const subagents = [];
  // toolCallId -> array of pending recs (chain mode produces one rec per child)
  const subagentByToolCallId = new Map();

  for (const e of entries) {
    if (e.type === 'session') sessionEntry = e;
    else if (e.type === 'session_info') {
      if (typeof e.name === 'string' && e.name.trim()) customTitle = e.name.trim();
    }
    else if (e.type === 'model_change') {
      if (!firstModel) firstModel = e;
      provider = e.provider;
      model = e.modelId;
    } else if (e.type === 'message') {
      messageCount++;
      lastTimestamp = e.timestamp || lastTimestamp;
      const m = e.message || {};
      if (m.role === 'user') userCount++;
      else if (m.role === 'assistant') {
        assistantCount++;
        const u = m.usage;
        if (u) {
          totalInput += u.input || 0;
          totalOutput += u.output || 0;
          totalCacheRead += u.cacheRead || 0;
          totalCacheWrite += u.cacheWrite || 0;
          totalCost += (u.cost && u.cost.total) || 0;
          if ((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0) > 0) {
            lastAssistantUsage = u;
          }
        }
        if (m.provider) provider = m.provider;
        if (m.model) model = m.model;
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c && c.type === 'toolCall') {
              toolCalls++;
              if (c.name === 'subagent') {
                const items = expandSubagentSpawns(c.arguments);
                if (items.length) {
                  const recs = items.map((it, i) => ({
                    toolCallId: c.id || null,
                    agent: it.agent || null,
                    prompt: it.task || null,
                    startedAt: e.timestamp || null,
                    runId: null,
                    exitCode: null,
                    durationMs: null,
                    usage: null,
                    progressSummary: null,
                    sessionFile: null,
                    artifactPaths: null,
                    stoppedAt: null,
                    runIndex: i,
                  }));
                  for (const rec of recs) subagents.push(rec);
                  if (c.id) subagentByToolCallId.set(c.id, recs);
                }
              }
            }
          }
        }
      } else if (m.role === 'toolResult') {
        toolResults++;
        if (m.toolName === 'todo' && m.details && Array.isArray(m.details.tasks)) {
          lastTodoTasks = m.details.tasks;
        } else if (m.toolName === 'subagent' && m.details && Array.isArray(m.details.results)) {
          const pendingArr = m.toolCallId ? subagentByToolCallId.get(m.toolCallId) : null;
          m.details.results.forEach((r, idx) => {
            let target = pendingArr && pendingArr[idx];
            if (!target) {
              const base = pendingArr && pendingArr[0];
              target = base ? { ...base, runIndex: idx } : {
                toolCallId: m.toolCallId || null,
                agent: null,
                prompt: null,
                startedAt: null,
                runIndex: idx,
              };
              subagents.push(target);
            }
            target.runId = m.details.runId || target.runId;
            target.runIndex = idx;
            target.agent = r.agent || target.agent;
            target.prompt = target.prompt || r.task || null;
            target.exitCode = r.exitCode ?? null;
            target.durationMs = r.durationMs ?? null;
            target.usage = r.usage || null;
            target.progressSummary = r.progressSummary || null;
            target.sessionFile = r.sessionFile || null;
            target.artifactPaths = r.artifactPaths || null;
            target.stoppedAt = e.timestamp || null;
          });
        }
      }
    }
  }

  return {
    sessionEntry,
    firstModel,
    lastTimestamp,
    totalCost,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalTokens: totalInput + totalOutput,
    userCount,
    assistantCount,
    toolCalls,
    toolResults,
    messageCount,
    provider,
    model,
    customTitle,
    lastAssistantUsage,
    lastTodoTasks,
    subagents,
  };
}

function agentIdFor(rec) {
  if (rec.toolCallId) return `tc_${rec.toolCallId}_${rec.runIndex ?? 0}`;
  if (rec.runId && rec.agent) return `${rec.runId}_${rec.agent}_${rec.runIndex ?? 0}`;
  if (rec.runId) return rec.runId;
  return `pending_${Math.random().toString(36).slice(2, 10)}`;
}

function subagentToApi(rec, lastMessage) {
  const stopped = !!rec.stoppedAt;
  let desc = rec.progressSummary
    ? `${rec.progressSummary.toolCount ?? 0} tools · ${rec.progressSummary.tokens ?? 0} tokens`
    : null;
  if (rec._error) desc = `error · ${String(rec._error).split('\n')[0].slice(0, 80)}`;
  return {
    agentId: agentIdFor(rec),
    type: rec.agent || null,
    agentName: rec.agent || null,
    status: stopped ? 'stopped' : 'active',
    startedAt: rec.startedAt || null,
    stoppedAt: rec.stoppedAt || null,
    updatedAt: rec.stoppedAt || rec.startedAt || null,
    prompt: rec.prompt || null,
    description: desc,
    model: null,
    color: null,
    lastMessage: lastMessage || null,
    _sessionFile: rec.sessionFile || null,
    _exitCode: rec.exitCode ?? null,
    _durationMs: rec.durationMs ?? null,
    _usage: rec.usage || null,
  };
}

async function readSubagentOutput(rec) {
  if (!rec || !rec.artifactPaths || !rec.artifactPaths.outputPath) return null;
  try { return await fs.promises.readFile(rec.artifactPaths.outputPath, 'utf8'); } catch { return null; }
}

async function enrichPendingSubagents(meta, subagents) {
  const pending = subagents.filter((r) => !r.runId);
  if (pending.length === 0) return;
  const artifactsDir = path.join(path.dirname(meta.file), 'subagent-artifacts');
  let files;
  try { files = await fs.promises.readdir(artifactsDir); } catch { return; }
  const knownRunIds = new Set(subagents.map((r) => r.runId).filter(Boolean));
  const metaFiles = files.filter((f) => f.endsWith('_meta.json'));
  const metas = [];
  for (const f of metaFiles) {
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(artifactsDir, f), 'utf8'));
      if (data && data.runId && !knownRunIds.has(data.runId)) metas.push({ ...data, _file: f });
    } catch {}
  }
  if (metas.length === 0) return;
  metas.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const used = new Set();
  for (const rec of pending) {
    const startMs = rec.startedAt ? new Date(rec.startedAt).getTime() : 0;
    const idx = metas.findIndex((m, i) => {
      if (used.has(i)) return false;
      if (m.agent !== rec.agent) return false;
      if (rec.prompt && m.task && !m.task.includes(rec.prompt.slice(0, 40))) return false;
      if (startMs && m.timestamp && m.timestamp < startMs - 1000) return false;
      return true;
    });
    if (idx < 0) continue;
    used.add(idx);
    const m = metas[idx];
    const base = m._file.replace(/_meta\.json$/, '');
    rec.runId = m.runId;
    rec.runIndex = 0;
    rec.exitCode = m.exitCode;
    rec.durationMs = m.durationMs;
    rec.usage = m.usage;
    rec.stoppedAt = m.timestamp ? new Date(m.timestamp).toISOString() : (rec.startedAt || null);
    rec.artifactPaths = {
      inputPath: path.join(artifactsDir, `${base}_input.md`),
      outputPath: path.join(artifactsDir, `${base}_output.md`),
      jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
      metadataPath: path.join(artifactsDir, m._file),
    };
    rec.sessionFile = rec.artifactPaths.jsonlPath;
    rec._error = m.error || null;
    if (m.toolCount != null) rec.progressSummary = { toolCount: m.toolCount, tokens: (m.usage?.input || 0) + (m.usage?.output || 0) };
  }
}

async function listAgentsForSession(meta) {
  const entries = await readSessionEntries(meta.file);
  const s = summarize(entries);
  const recs = s.subagents || [];
  await enrichPendingSubagents(meta, recs);
  const out = [];
  for (const rec of recs) {
    let lm = await readSubagentOutput(rec);
    if ((!lm || !lm.trim()) && rec._error) lm = `**Error:**\n\n\`\`\`\n${rec._error}\n\`\`\``;
    out.push(subagentToApi(rec, lm));
  }
  return out;
}

async function findAgentRecord(meta, agentId) {
  const list = await listAgentsForSession(meta);
  return list.find((a) => a.agentId === agentId) || null;
}

function tallyTasks(tasks) {
  let pending = 0, inProgress = 0, completed = 0;
  for (const t of tasks) {
    if (t.status === 'completed') completed++;
    else if (t.status === 'in_progress') inProgress++;
    else pending++;
  }
  return { taskCount: tasks.length, pending, inProgress, completed };
}

const MODEL_CONTEXT_WINDOWS = [
  [/claude/i, 200000],
  [/kimi/i, 256000],
  [/glm-?4\.[67]/i, 128000],
  [/gpt-?5/i, 400000],
  [/gpt-?4/i, 128000],
  [/gemini/i, 1000000],
  [/deepseek/i, 128000],
];
function modelContextWindow(model) {
  if (!model) return 200000;
  const m = String(model);
  for (const [re, cap] of MODEL_CONTEXT_WINDOWS) if (re.test(m)) return cap;
  return 200000;
}

function shortIdFromUuid(uuid) {
  if (!uuid) return '';
  return uuid.split('-')[0];
}

function basenameWithoutExt(file) {
  return path.basename(file, '.jsonl');
}

// Build a slug like "<short-uuid>" from filename.
function slugFromFile(file) {
  const base = basenameWithoutExt(file);
  // 2026-05-07T08-49-06-833Z_019e01a0-5b0d-7139-9740-bc883238364d
  const idx = base.indexOf('_');
  if (idx >= 0) return base.slice(idx + 1);
  return base;
}

const RECENT_MS = 5 * 60 * 1000;

async function buildSessionSummary(meta) {
  const entries = await readSessionEntries(meta.file);
  const s = summarize(entries);
  const id = (s.sessionEntry && s.sessionEntry.id) || slugFromFile(meta.file);
  const cwd = (s.sessionEntry && s.sessionEntry.cwd) || meta.cwd;
  const projectName = path.basename(cwd) || cwd;
  const ageMs = Date.now() - meta.mtime.getTime();
  const isRecent = ageMs <= RECENT_MS;
  return {
    id,
    name: s.customTitle || shortIdFromUuid(id),
    slug: shortIdFromUuid(id),
    project: cwd,
    cwd,
    description: null,
    gitBranch: gitBranchModule.getBranch(cwd, (branch) => {
      if (onBranchResolved) onBranchResolved(cwd, branch);
    }),
    customTitle: s.customTitle || null,
    ...tallyTasks(taskStore.listTasks(id)),
    createdAt: s.sessionEntry && s.sessionEntry.timestamp,
    modifiedAt: meta.mtime.toISOString(),
    isTeam: false,
    memberCount: 0,
    hasMessages: s.messageCount > 0,
    hasActiveAgents: false,
    hasRunningAgents: false,
    hasWaitingForUser: false,
    hasRecentLog: isRecent,
    jsonlPath: meta.file,
    tasksDir: null,
    projectDir: meta.projectDir,
    contextStatus: {
      session_id: id,
      transcript_path: meta.file,
      cwd,
      session_name: projectName,
      model: { id: s.model || 'unknown', display_name: s.model || 'unknown' },
      provider: s.provider,
      workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [cwd] },
      version: s.sessionEntry && s.sessionEntry.version,
      cost: {
        total_cost_usd: s.totalCost,
        total_duration_ms: 0,
        total_api_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      context_window: (() => {
        const lu = s.lastAssistantUsage || {};
        const cap = modelContextWindow(s.model);
        const curIn = (lu.input || 0) + (lu.cacheRead || 0) + (lu.cacheWrite || 0);
        const curOut = lu.output || 0;
        const used = Math.min(100, Math.round((curIn / cap) * 100));
        return {
          total_input_tokens: s.totalInput,
          total_output_tokens: s.totalOutput,
          context_window_size: cap,
          current_usage: {
            input_tokens: curIn,
            output_tokens: curOut,
            cache_creation_input_tokens: lu.cacheWrite || 0,
            cache_read_input_tokens: lu.cacheRead || 0,
          },
          used_percentage: used,
          remaining_percentage: Math.max(0, 100 - used),
        };
      })(),
      _stats: {
        userCount: s.userCount,
        assistantCount: s.assistantCount,
        toolCalls: s.toolCalls,
        toolResults: s.toolResults,
        messageCount: s.messageCount,
      },
      _updatedAt: meta.mtime.getTime(),
    },
    hasPlan: false,
    planTitle: null,
    planPath: null,
  };
}

async function listSessions() {
  const files = listSessionFiles();
  files.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const f of files) {
    try {
      out.push(await buildSessionSummary(f));
    } catch (err) {
      // skip corrupt files
    }
  }
  return out;
}

async function findSessionFileById(id) {
  const files = listSessionFiles();
  // First try filename match (faster)
  for (const f of files) {
    if (f.file.includes(id)) return f;
  }
  // Then read header to match session id
  for (const f of files) {
    try {
      const entries = await readSessionEntries(f.file);
      const sess = entries.find((e) => e.type === 'session');
      if (sess && sess.id === id) return f;
    } catch {}
  }
  return null;
}

function flattenContentToText(content, opts = {}) {
  const { includeThinking = false } = opts;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (!c) return '';
      if (c.type === 'text') return c.text || '';
      if (includeThinking && c.type === 'thinking') return c.thinking || '';
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// Map pi tool name -> display name (matches cck conventions).
const TOOL_NAME_MAP = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  todo: 'TodoWrite',
  subagent: 'Agent',
  ask_user: 'AskUser',
  ask_user_question: 'AskUserQuestion',
  web_search: 'WebSearch',
  code_search: 'Grep',
  ast_grep_search: 'AstGrep',
  lsp: 'LSP',
  lsp_navigation: 'LSP',
  interactive_shell: 'Shell',
  mark_step_done: 'MarkStepDone',
};

function computeToolDetail(name, params) {
  if (!params || typeof params !== 'object') {
    const s = String(params ?? '');
    return { detail: s.slice(0, 80), fullDetail: s.length > 80 ? s : null };
  }
  let detail = null;
  let full = null;
  if (params.file_path) { detail = path.basename(params.file_path); full = params.file_path; }
  else if (params.path) { detail = path.basename(params.path); full = params.path; }
  else if (params.command) { full = params.command; detail = full.length > 80 ? full.slice(0, 80) + '...' : full; }
  else if (params.pattern) { full = params.pattern; detail = full; }
  else if (params.query) { full = params.query; detail = full; }
  else if (params.queries) { full = Array.isArray(params.queries) ? params.queries.join(' | ') : String(params.queries); detail = full.length > 80 ? full.slice(0, 80) + '...' : full; }
  else if (params.url) { full = params.url; detail = full.length > 80 ? full.slice(0, 80) + '...' : full; }
  else if (params.task) { full = params.task; detail = full.length > 80 ? full.slice(0, 80) + '...' : full; }
  else if (params.subject) { full = params.subject; detail = full; }
  else if (params.description) { full = params.description; detail = full.length > 80 ? full.slice(0, 80) + '...' : full; }
  else if (params.question) { full = params.question; detail = full.length > 80 ? full.slice(0, 80) + '...' : full; }
  else if (params.action) { detail = params.action; full = detail; }
  else if (params.operation) { detail = params.operation; full = detail; }
  else {
    try { full = JSON.stringify(params); } catch { full = ''; }
    detail = full.length > 80 ? full.slice(0, 80) + '...' : full;
  }
  return { detail: detail || '', fullDetail: full && full !== detail ? full : null };
}

function normalizeToolCall(name, args) {
  const display = TOOL_NAME_MAP[name] || name;
  if (!args || typeof args !== 'object') return { name: display, params: args };
  const p = { ...args };
  if (p.path && !p.file_path) {
    p.file_path = p.path;
    delete p.path;
  }
  if (Array.isArray(p.edits)) {
    if (p.edits.length === 1) {
      const e = p.edits[0];
      if (e && (e.oldText || e.newText)) {
        p.old_string = e.oldText || '';
        p.new_string = e.newText || '';
        delete p.edits;
      }
    } else {
      p.edits = p.edits.map((e) => ({
        old_string: e.oldText ?? e.old_string ?? '',
        new_string: e.newText ?? e.new_string ?? '',
      }));
    }
  }
  return { name: display, params: p };
}

// Convert pi entries -> cck-style messages array.
async function readFileSafe(p) {
  if (!p) return null;
  try { return await fs.promises.readFile(p, 'utf8'); } catch { return null; }
}

async function buildMessages(file, limit = 50) {
  const entries = await readSessionEntries(file);
  const toolResultByCallId = new Map();
  const subagentInfoByCallId = new Map();
  for (const e of entries) {
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m && m.role === 'toolResult' && m.toolCallId) {
      toolResultByCallId.set(m.toolCallId, m);
      if (m.toolName === 'subagent' && m.details && Array.isArray(m.details.results) && m.details.results[0]) {
        const r = m.details.results[0];
        subagentInfoByCallId.set(m.toolCallId, {
          runId: m.details.runId || null,
          agent: r.agent || null,
          runIndex: 0,
          outputPath: r.artifactPaths && r.artifactPaths.outputPath ? r.artifactPaths.outputPath : null,
          inputPath: r.artifactPaths && r.artifactPaths.inputPath ? r.artifactPaths.inputPath : null,
        });
      }
    }
  }

  const messages = [];
  for (const e of entries) {
    if (e.type === 'compaction') {
      messages.push({
        type: 'user',
        role: 'user',
        systemLabel: 'compact-summary',
        compactSummary: e.summary || '',
        text: e.summary || '',
        timestamp: e.timestamp,
      });
      continue;
    }
    if (e.type !== 'message') continue;
    const m = e.message || {};
    const ts = e.timestamp;

    if (m.role === 'user') {
      const text = flattenContentToText(m.content);
      messages.push({ type: 'user', role: 'user', text, timestamp: ts });
    } else if (m.role === 'assistant') {
      const text = flattenContentToText(m.content);
      if (text && text.trim()) {
        messages.push({
          type: 'assistant',
          role: 'assistant',
          text,
          timestamp: ts,
          model: m.model,
          provider: m.provider,
          usage: m.usage,
        });
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === 'toolCall') {
            const { name: toolName, params } = normalizeToolCall(c.name, c.arguments);
            const { detail, fullDetail } = computeToolDetail(toolName, params);
            const tr = toolResultByCallId.get(c.id);
            const trText = tr ? flattenContentToText(tr.content) : null;
            const msg = {
              type: 'tool_use',
              tool: toolName,
              detail,
              fullDetail,
              description: null,
              params,
              timestamp: ts,
              toolUseId: c.id,
              toolResult: trText ? trText.slice(0, 1500) : null,
              toolResultTruncated: trText ? trText.length > 1500 : false,
            };
            if (c.name === 'subagent') {
              const info = subagentInfoByCallId.get(c.id);
              const agent = (c.arguments && c.arguments.agent) || (info && info.agent) || null;
              const runId = info && info.runId ? info.runId : null;
              const isSpawn = !!(c.arguments && c.arguments.task);
              if (isSpawn) {
                msg.tool = 'Agent';
                msg.agentId = c.id ? `tc_${c.id}_${(info && info.runIndex) || 0}` : (runId && agent ? `${runId}_${agent}_${(info && info.runIndex) || 0}` : `pending_${Math.random().toString(36).slice(2, 10)}`);
                msg.agentType = agent;
                msg.agentName = agent;
                msg.agentPrompt = c.arguments.task || null;
                msg.agentLastMessage = info && info.outputPath ? await readFileSafe(info.outputPath) : null;
                if (!msg.agentLastMessage && trText) msg.agentLastMessage = trText;
              }
            }
            messages.push(msg);
          }
        }
      }
    }
    // toolResult handled via map above.
  }

  const total = messages.length;
  const sliced = limit && limit < total ? messages.slice(-limit) : messages;
  return { messages: sliced, hasMore: sliced.length < total, sessionId: null };
}

module.exports = {
  getPiDir,
  getSessionsDir,
  decodeProjectDir,
  listSessionFiles,
  listSessions,
  findSessionFileById,
  buildSessionSummary,
  buildMessages,
  readSessionEntries,
  summarize,
  listAgentsForSession,
  findAgentRecord,
  slugFromFile,
  setOnBranchResolved,
};
