const fs = require('node:fs');
const { readFileSync, existsSync, readdirSync, statSync } = fs;
const path = require('node:path');
const os = require('node:os');
const { readSession, readClaudeLines, readClaudeLineTexts, contentText } = require('./pi-transcript');
const { agentIdFor } = require('./pi-agents');

// The active branch of a pi session as Claude Code transcript lines (JSON text), so the
// line scanners below read pi sessions unchanged. Rejects for a missing file.
async function* readLines(file) {
  await fs.promises.access(file);
  yield* readClaudeLineTexts(file);
}

function parseTask(raw) {
  const task = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    id: task.id,
    subject: task.subject,
    description: task.description || null,
    status: task.status,
    blocks: task.blocks || [],
    blockedBy: task.blockedBy || [],
    isInternal: !!task.metadata?._internal,
    raw: task
  };
}

function parseAgent(raw) {
  const agent = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    agentId: agent.agentId,
    type: agent.type || null,
    status: agent.status,
    startedAt: agent.startedAt,
    stoppedAt: agent.stoppedAt || null,
    updatedAt: agent.updatedAt || null,
    lastMessage: agent.lastMessage || null,
    prompt: agent.prompt || null,
    raw: agent
  };
}

function parseWaiting(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    status: data.status,
    kind: data.kind || null,
    toolName: data.toolName || null,
    toolInput: data.toolInput || null,
    timestamp: data.timestamp,
    raw: data
  };
}

function parseTeamConfig(raw) {
  const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    name: config.name,
    description: config.description || null,
    leadAgentId: config.leadAgentId,
    leadSessionId: config.leadSessionId || null,
    members: (config.members || []).map(m => ({
      agentId: m.agentId,
      name: m.name,
      agentType: m.agentType || null,
      model: m.model || null,
      cwd: m.cwd || null,
      color: m.color || null
    })),
    raw: config
  };
}

function parseSessionsIndex(raw) {
  const index = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    version: index.version || null,
    entries: (index.entries || []).map(e => ({
      sessionId: e.sessionId,
      description: e.description || null,
      gitBranch: e.gitBranch || null,
      created: e.created || null,
      projectPath: e.projectPath || null,
      isSidechain: e.isSidechain || false
    })),
    raw: index
  };
}

function parseJsonlLine(line) {
  const obj = typeof line === 'string' ? JSON.parse(line) : line;
  const base = {
    type: obj.type,
    timestamp: obj.timestamp || null,
    sessionId: obj.sessionId || null,
    uuid: obj.uuid || null
  };

  if (obj.type === 'assistant' && obj.message?.content && Array.isArray(obj.message.content)) {
    const blocks = obj.message.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'tool_use') return { type: 'tool_use', name: block.name, input: block.input || null };
      if (block.type === 'thinking') return { type: 'thinking' };
      return { type: block.type };
    });
    return { ...base, role: 'assistant', model: obj.message.model || null, blocks };
  }

  if (obj.type === 'user' && obj.message?.role === 'user') {
    return {
      ...base,
      role: 'user',
      isMeta: !!obj.isMeta,
      content: typeof obj.message.content === 'string' ? obj.message.content : null
    };
  }

  if (obj.type === 'queue-operation' && obj.operation === 'enqueue') {
    return {
      ...base,
      role: 'user',
      queued: true,
      content: typeof obj.content === 'string' ? obj.content : null
    };
  }

  if (obj.type === 'progress') {
    return { ...base, cwd: obj.cwd || null, version: obj.version || null, slug: obj.slug || null };
  }

  return base;
}

const TOOL_RESULT_MAX = 1500;
const USER_TEXT_MAX = 500;
const INTERRUPT_MARKER = '[Request interrupted by user]';

// Newer Claude Code no longer inlines pasted images as base64 blocks. It writes
// them to ~/.claude/image-cache/<sessionId>/<N>.<ext> and leaves only a text marker
// in the message — an inline "[Image #N]" placeholder and/or a standalone
// "[Image: source: ...\N.ext]" line. Pull out the N references (so the UI can serve
// the cached file) and strip the verbose source lines from the displayed text — the
// rendered preview replaces them; the short "[Image #N]" placeholders stay.
// Runs on the per-message scan hot path, so it skips the regexes entirely unless a
// marker is present. Returns { refs: [{ kind: 'cache', n }], text }.
function parseImageMarkers(text) {
  const raw = text || '';
  if (!raw.includes('[Image')) return { refs: [], text: raw.trim() };
  const ns = new Set();
  for (const m of raw.matchAll(/\[Image #(\d+)\]/g)) ns.add(Number(m[1]));
  for (const m of raw.matchAll(/\[Image: source:[^\]]*?(\d+)\.[a-z0-9]+\]/gi)) ns.add(Number(m[1]));
  const refs = [...ns].sort((a, b) => a - b).map((n) => ({ kind: 'cache', n }));
  const cleaned = raw.replace(/\[Image: source:[^\]]*\]/gi, '').trim();
  return { refs, text: cleaned };
}

// Compact usage suffix for a task-notification chip: " · 22.3k tok · 6 tools · 119s".
function formatTaskUsage(usage) {
  if (!usage) return '';
  const parts = [];
  if (usage.subagentTokens != null) {
    const t = usage.subagentTokens;
    const tok = t >= 1000 ? `${(t / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(t);
    parts.push(`${tok} tok`);
  }
  if (usage.toolUses != null) parts.push(usage.toolUses + (usage.toolUses === 1 ? ' tool' : ' tools'));
  if (usage.durationMs != null) parts.push(`${Math.round(usage.durationMs / 1000)}s`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

// Raw per-agent cost for the agent modal's chips plus the formatted one-liner for
// the inline message row. Null when the source carried no numbers.
function agentUsageEntry(subagentTokens, toolUses, durationMs) {
  const usage = {};
  if (subagentTokens != null) usage.tokens = subagentTokens;
  if (toolUses != null) usage.tools = toolUses;
  if (durationMs != null) usage.durationMs = durationMs;
  if (!Object.keys(usage).length) return null;
  return { usage, usageText: formatTaskUsage({ subagentTokens, toolUses, durationMs }) };
}

function pushUserMessage(messages, text, timestamp, sysLabel, extras) {
  if (sysLabel === '__skip__') return;
  let safeText = text || '';
  let label = sysLabel;
  // Background-task completion notifications are harness events, not user input.
  // Whichever path delivered them (normal type:'user' or a queued enqueue), show
  // a rich summary+usage chip and surface the agent's actual result as the body —
  // never the raw <task-notification> envelope under a person icon.
  const notif = parseTaskNotification(safeText);
  if (notif) {
    const base = notif.summary || (notif.status ? `Background task ${notif.status}` : 'Background task notification');
    label = base + formatTaskUsage(notif.usage);
    safeText = notif.result || base;
  }
  // A subagent, teammate or peer session handing work back through SendMessage is
  // also model output, not user input. Callers on the `origin` path pass the parts
  // ready-made; the text paths (type:'user', queued enqueue) parse the envelope.
  const agentMsg = extras?.agent || (notif ? null : parseAgentMessage(safeText));
  if (agentMsg) {
    label = agentMsg.label;
    safeText = agentMsg.body;
  }
  const truncated = safeText.length > USER_TEXT_MAX;
  const msg = {
    type: 'user',
    text: truncated ? `${safeText.slice(0, USER_TEXT_MAX)}...` : safeText,
    fullText: truncated ? safeText : null,
    timestamp,
    ...(label && { systemLabel: label })
  };
  // Tag task-notifications so the client can group the duplicate enqueue+delivered
  // pair (same taskId) and join the agent type from the agents list.
  if (notif) {
    msg.taskNotification = true;
    if (notif.taskId) msg.taskId = notif.taskId;
    if (notif.status) msg.taskStatus = notif.status;
  }
  if (agentMsg) {
    msg.agentMessage = true;
    if (agentMsg.from) msg.agentFrom = agentMsg.from;
  }
  if (extras) {
    if (extras.uuid) msg.uuid = extras.uuid;
    if (extras.images?.length) msg.images = extras.images;
    if (extras.toolResultRefs?.length) msg.toolResultRefs = extras.toolResultRefs;
    if (extras.queued) msg.queued = true;
  }
  // One agent message reaches the log twice: the queued enqueue record and the
  // delivered one right after it. Keep the first and drop the twin here, so no
  // renderer has to know about the double write.
  if (agentMsg) {
    const prev = messages[messages.length - 1];
    if (prev?.agentMessage && (prev.agentFrom || null) === (msg.agentFrom || null) && prev.text === msg.text) {
      if (!msg.queued) delete prev.queued;
      return;
    }
  }
  messages.push(msg);
}

let sessionCacheDirty = false;

// Entry keys: jsonlPath. Values carry ino/mtimeMs/scannedUpTo so lib/session-cache.js can
// persist them; `v` drops entries an older build wrote in another shape.
const sessionInfoCache = new Map();
const SESSION_INFO_CACHE_MAX = 2000;
const SESSION_INFO_VERSION = 'pi-3';

const isMainReply = (data) =>
  data.type === 'assistant' && !data.isSidechain && data.message?.usage && data.message.model !== '<synthetic>';

// Copy of displayName in the plugin's hooks/context.ts; Node cannot import the mod.
function modelDisplayName(model) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model || '');
  if (!m) return model || null;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
}

const isMainUser = (data) => data.type === 'user' && !data.isSidechain && data.timestamp;

// `at` is when the request went out: the reply's own lines land seconds to tens of seconds later,
// which would make the cache countdown run long.
const replyOf = (data, requestTs) => {
  const u = data.message.usage;
  return {
    at: Date.parse(requestTs || data.timestamp) || null,
    model: data.message.model || null,
    usage: {
      input_tokens: u.input_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      output_tokens: u.output_tokens || 0,
    },
  };
};
// After a compaction the old usage overstates what the next request writes.
const withoutUsage = (reply) => reply && { ...reply, usage: null };

const FIRST_PROMPT_MAX = 500;

// The first thing the user typed: a tool result, a labeled line (shell command, extension
// message) or a compaction summary does not count.
function firstUserText(lines) {
  for (const l of lines) {
    if (l.type !== 'user' || l.systemLabel || l.isCompactSummary) continue;
    const text = contentText(l.message?.content);
    if (text.trim()) return text;
  }
  return null;
}

const INFO_FIELDS = ['slug', 'projectPath', 'cwd', 'gitBranch', 'customTitle', 'agentName', 'logicalParentUuid', 'compactBoundaryUuid', 'permissionMode', 'cacheTtl', 'lastReply', 'scratchpadDir', 'sessionId', 'firstPrompt', 'parentSessionPath', 'createdAt'];
const infoOf = (entry) => Object.fromEntries(INFO_FIELDS.map((k) => [k, entry?.[k] ?? null]));

// slug, gitBranch, agentName, logicalParentUuid, compactBoundaryUuid, permissionMode,
// cacheTtl and scratchpadDir have no pi source and stay null. pi has no mid-session cd,
// so cwd is the header cwd. A fork names its source file in parentSessionPath.
function sessionInfoOf(session) {
  const { header, lines, name } = session;
  let lastUserTs = null;
  let lastReply = null;
  for (const data of lines) {
    if (isMainUser(data)) lastUserTs = data.timestamp;
    else if (isMainReply(data)) lastReply = replyOf(data, lastUserTs);
    if (data.subtype === 'compact_boundary') lastReply = withoutUsage(lastReply);
  }
  return {
    ...infoOf(null),
    projectPath: header.cwd || null,
    cwd: header.cwd || null,
    customTitle: name,
    lastReply,
    sessionId: header.id,
    firstPrompt: firstUserText(lines)?.trim().slice(0, FIRST_PROMPT_MAX) ?? null,
    parentSessionPath: header.parentSession || null,
    createdAt: header.timestamp || null,
  };
}

function readSessionInfoFromJsonl(jsonlPath) {
  let stat;
  try {
    stat = statSync(jsonlPath);
  } catch (_) {
    return infoOf(null);
  }
  const cached = sessionInfoCache.get(jsonlPath);
  if (cached?.v === SESSION_INFO_VERSION && cached.ino === stat.ino && cached.scannedUpTo === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return infoOf(cached);
  }
  const session = readSession(jsonlPath, { retain: false });
  const info = session ? sessionInfoOf(session) : infoOf(null);
  sessionInfoCache.delete(jsonlPath);
  sessionInfoCache.set(jsonlPath, {
    v: SESSION_INFO_VERSION,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    scannedUpTo: stat.size,
    ...info,
  });
  if (sessionInfoCache.size > SESSION_INFO_CACHE_MAX) sessionInfoCache.delete(sessionInfoCache.keys().next().value);
  sessionCacheDirty = true;
  return info;
}

// Cache: jsonlPath -> { ino, size, mtimeMs }, the transcript as it last grew.
// Claude Code, `claude --resume` and backup tools set a transcript's mtime without writing
// to it (#50), so only a file that grew, shrank or was replaced counts as activity.
// When a session exits, Claude Code appends bookkeeping lines (cost-state, last-prompt,
// mode, ai-title ...) with no `timestamp`; a write of only such lines is not activity either.
const logActivityCache = new Map();
const BOOKKEEPING_APPEND_MAX = 64 * 1024;

function isBookkeepingAppend(jsonlPath, from, to) {
  if (to - from > BOOKKEEPING_APPEND_MAX || from < 1) return false;
  // Reads from one byte early, so the append is known to start on a line boundary.
  const buf = Buffer.allocUnsafe(to - from + 1);
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, from - 1); } finally { fs.closeSync(fd); }
  } catch { return false; }
  const text = buf.toString('utf8');
  if (text[0] !== '\n' || !text.endsWith('\n') || text.includes('"timestamp":')) return false;
  return text.slice(1, -1).split('\n').every((line) => {
    if (!line) return true;
    try {
      const obj = JSON.parse(line);
      return obj !== null && typeof obj === 'object';
    } catch { return false; }
  });
}

function transcriptActivityMs(jsonlPath, stat) {
  const prev = logActivityCache.get(jsonlPath);
  const sameFile = prev && prev.ino === stat.ino;
  if (sameFile && prev.size === stat.size) return prev.mtimeMs;
  const quiet = sameFile && stat.size > prev.size && isBookkeepingAppend(jsonlPath, prev.size, stat.size);
  const mtimeMs = quiet ? prev.mtimeMs : stat.mtimeMs;
  logActivityCache.delete(jsonlPath);
  logActivityCache.set(jsonlPath, { ino: stat.ino, size: stat.size, mtimeMs });
  if (logActivityCache.size > SESSION_INFO_CACHE_MAX) logActivityCache.delete(logActivityCache.keys().next().value);
  sessionCacheDirty = true;
  return mtimeMs;
}

const sessionCachesDirty = () => sessionCacheDirty;

// Snapshot of the per-transcript caches for lib/session-cache.js. Entries of deleted
// transcripts are left out, so the snapshot never holds more than the live set.
function exportSessionCaches() {
  sessionCacheDirty = false;
  const livePaths = new Set([...sessionInfoCache.keys(), ...logActivityCache.keys()]);
  for (const p of livePaths) if (!fs.existsSync(p)) livePaths.delete(p);
  const live = (map) => [...map].filter(([p]) => livePaths.has(p));
  return { info: live(sessionInfoCache), activity: live(logActivityCache) };
}

function importSessionCaches(snapshot) {
  const num = (v) => typeof v === 'number';
  const scanned = (e) => num(e.ino) && num(e.scannedUpTo) && num(e.mtimeMs);
  const grown = (e) => num(e.ino) && num(e.size) && num(e.mtimeMs);
  const load = (map, entries, valid) => {
    if (!Array.isArray(entries)) return;
    for (const pair of entries) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !pair[1] || typeof pair[1] !== 'object' || !valid(pair[1])) continue;
      map.set(pair[0], pair[1]);
    }
  };
  load(sessionInfoCache, snapshot?.info?.slice(-SESSION_INFO_CACHE_MAX), scanned);
  load(logActivityCache, snapshot?.activity?.slice(-SESSION_INFO_CACHE_MAX), grown);
}

// Background-task completion records arrive as a user message whose content is a
// <task-notification> envelope. Rendering the raw text leaks the tag values as a
// run-on line (task-id + tool-use-id + output-file path) plus the <usage> numbers
// mashed together (subagent_tokens|tool_uses|duration_ms with tags stripped).
// Parse the envelope into structured fields so the UI can show just the agent's
// result and a clean metadata line instead of the raw wrapper. Returns null when
// the text is not a task-notification.
function parseTaskNotification(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  // Metadata fields are machine-generated single-line values that appear before
  // the free-form <result>, so first-match non-greedy is safe for them.
  const pick = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };
  // <result> and <usage> carry UNescaped agent text that can itself contain
  // literal "</result>" / "<usage>" (e.g. an agent describing this very format).
  // The real closing tags are always the LAST occurrence, so match greedily and
  // take the last <usage> block to avoid truncating on embedded markers.
  const lastBlock = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*)<\\/${tag}>`));
    return m ? m[1] : null;
  };
  let usage = null;
  const usageRaw = lastBlock('usage');
  if (usageRaw != null) {
    const uNum = (tag) => {
      // Take the LAST match: the real <usage> wins over any example block an agent
      // embedded in its result.
      const last = [...usageRaw.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g'))].at(-1);
      if (!last) return null;
      const n = Number(last[1]);
      return Number.isFinite(n) ? n : null;
    };
    usage = {
      subagentTokens: uNum('subagent_tokens'),
      toolUses: uNum('tool_uses'),
      durationMs: uNum('duration_ms')
    };
  }
  const resultRaw = lastBlock('result');
  return {
    taskId: pick('task-id'),
    toolUseId: pick('tool-use-id'),
    outputFile: pick('output-file'),
    status: pick('status'),
    summary: pick('summary'),
    result: resultRaw != null ? resultRaw.trim() : null,
    usage
  };
}

// A message another agent sent into this session (a subagent hand-back, a teammate
// or a peer session using SendMessage) is model output, not user input. Turn the
// sender and the raw body into the chip label plus the body alone, so it never
// renders under a person icon.
function agentMessageParts(from, rawBody, handback) {
  let body = (rawBody || '').trimEnd();
  // A hand-back frames the report with the harness note that it carries no user
  // authority, and indents every line of the report by two spaces so a forged
  // frame at column zero is impossible. Strip the frame and that indent.
  const framed = body.match(/^\[Subagent hand-back\][\s\S]*?report follows:\n([\s\S]*)$/);
  if (framed) body = framed[1].replace(/^ {2}/gm, '').trim();
  const handBack = !!framed || !!handback;
  const kind = handBack ? 'Subagent hand-back' : 'Agent message';
  // Harness agent ids are long hex; a named sender ("code-review") is shown whole.
  const short = from && /^[0-9a-f]{12,}$/i.test(from) ? from.slice(0, 8) : from;
  return { from: from || null, handBack, label: short ? `${kind} · ${short}` : kind, body };
}

// The text delivery paths carry the body inside an <agent-message from="..."> envelope,
// with the harness notes outside it. The envelope must open the message (after the
// harness preamble, if any): prose that merely quotes the tag is a user message.
// The body is unescaped agent text that can quote the envelope it describes, so the
// real closing tag is the last one.
function parseAgentMessage(text) {
  if (typeof text !== 'string' || !text.includes('<agent-message')) return null;
  const start = text.indexOf('<agent-message');
  const preamble = text.slice(0, start).trim();
  if (preamble && !/^Another Claude session sent a message[^\n]*:$/.test(preamble)) return null;
  const gt = text.indexOf('>', start);
  const end = text.lastIndexOf('</agent-message>');
  if (gt === -1 || end < gt) return null;
  const from = (text.slice(start, gt).match(/from="([^"]*)"/) || [])[1] || null;
  let bodyStart = gt + 1;
  while (text[bodyStart] === '\n') bodyStart++;
  return agentMessageParts(from, text.slice(bodyStart, end));
}

function getSystemMessageLabel(text) {
  const taskMatch = text.match(/<summary>([^<]+)<\/summary>/);
  if (taskMatch) return taskMatch[1].trim();
  if (text.includes('<task-notification>')) {
    const statusMatch = text.match(/<status>([^<]+)<\/status>/);
    return statusMatch ? `Background task ${statusMatch[1]}` : 'Background task notification';
  }
  // The "Compacted (ctrl+o…)" stdout echo is redundant with the isCompactSummary
  // chip (modern Claude Code stores the summary inline). Skipping it lets the one
  // summary-bearing chip stand alone instead of trailing a bare marker that the
  // resume prompt sorts away from, preventing collapse.
  if (text.includes('<local-command-stdout>') && text.includes('Compacted')) return '__skip__';
  if (text.includes('<local-command-stdout>')) return 'Command output';
  if (text.includes('<local-command-caveat>')) return 'System notification';
  if (text.includes('.output completed') && text.includes('Background command')) return 'Background task completed';
  if (text.startsWith('This session is being continued from a previous conversation')) return '__skip__';
  if (text.includes('<command-name>/clear</command-name>')) return '__skip__';
  // The /compact trigger record is redundant: the boundary stdout + isCompactSummary
  // record already render as one expandable "Compacted" chip. Skip it so the chip
  // collapses cleanly instead of leaving a separate marker where the user typed it.
  if (text.includes('<command-name>/compact</command-name>')) return '__skip__';
  return null;
}

// Built once per parse of the session (the lines array is replaced when the file changes);
// callers get shallow copies because some of them add fields to the messages.
const recentMessagesMemo = new WeakMap();

function readRecentMessages(jsonlPath, limit = 10) {
  try {
    const lines = readClaudeLines(jsonlPath);
    let all = recentMessagesMemo.get(lines);
    if (!all) {
      all = buildMessages(lines);
      recentMessagesMemo.set(lines, all);
    }
    return all.slice(-limit).map((m) => ({ ...m }));
  } catch {
    return [];
  }
}

function buildMessages(lines) {
  const messages = [];
  const toolResults = new Map();
  const toolResultExtras = new Map();
  const toolResultImageCounts = new Map();
  for (const obj of lines) {
    try {
      if (obj.type === 'assistant' && obj.message?.content && Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            const truncated = block.text.length > 500;
            messages.push({
              type: 'assistant',
              text: truncated ? `${block.text.slice(0, 500)}...` : block.text,
              fullText: truncated ? block.text : null,
              timestamp: obj.timestamp,
              model: obj.message.model || null
            });
          } else if (block.type === 'tool_use') {
            let detail = null;
            let fullDetail = null;
            let inp = null;
            if (block.input) {
              inp = typeof block.input === 'string' ? (() => { try { return JSON.parse(block.input); } catch(_) { return {}; } })() : block.input;
              if (inp.file_path) { detail = inp.file_path.replace(/^.*[/\\]/, ''); fullDetail = inp.file_path; }
              else if (inp.command) { detail = inp.command.length > 80 ? `${inp.command.slice(0, 80)}...` : inp.command; fullDetail = inp.command; }
              else if (inp.pattern) { detail = inp.pattern; fullDetail = inp.pattern; }
              else if (inp.query) { detail = inp.query; fullDetail = inp.query; }
              else if (inp.url) { detail = inp.url.length > 80 ? `${inp.url.slice(0, 80)}...` : inp.url; fullDetail = inp.url; }
              else if (inp.skill) { const s = inp.skill + (typeof inp.args === 'string' ? ` ${inp.args}` : ''); detail = s.length > 80 ? `${s.slice(0, 80)}...` : s; fullDetail = s; }
              else if (inp.questions && Array.isArray(inp.questions)) {
                const parts = inp.questions.map(q => (q.header ? `${q.header}: ` : '') + q.question);
                const s = parts.join(' | ');
                detail = s.length > 80 ? `${s.slice(0, 80)}...` : s;
                fullDetail = inp.questions.map(q => {
                  let text = (q.header ? `[${q.header}] ` : '') + q.question;
                  if (q.options) text += `\n\n${q.options.map((o, j) => `  ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`;
                  return text;
                }).join('\n\n');
              }
              else if (inp.to) {
                const proto = inp.message && typeof inp.message === 'object' ? inp.message : null;
                if (proto?.type === 'shutdown_request') {
                  detail = `→ ${inp.to}: shutdown request${proto.reason ? ` (${proto.reason})` : ''}`;
                } else if (proto?.type === 'shutdown_response') {
                  detail = `→ ${inp.to}: ${proto.approve ? 'shutdown approved' : 'shutdown rejected'}`;
                } else if (proto?.type === 'plan_approval_response') {
                  detail = `→ ${inp.to}: ${proto.approve ? 'plan approved' : 'plan rejected'}`;
                } else {
                  detail = `→ ${inp.to}${inp.summary ? `: ${inp.summary}` : ''}`;
                }
                if (detail.length > 80) detail = `${detail.slice(0, 80)}...`;
                fullDetail = typeof inp.message === 'string' ? inp.message : JSON.stringify(inp.message);
              }
              else if (inp.plan) {
                const titleMatch = inp.plan.match(/^#\s+(.+)/m);
                detail = titleMatch ? titleMatch[1] : 'Plan';
                fullDetail = detail;
              }
              else if (inp.description) { detail = inp.description; fullDetail = inp.description; }
            }
            const params = {};
            if (inp) {
              if (block.name === 'Edit') {
                if (inp.file_path) params.file_path = inp.file_path;
                if (inp.old_string) params.old_string = inp.old_string;
                if (inp.new_string) params.new_string = inp.new_string;
                if (Array.isArray(inp.edits)) params.edits = inp.edits;
                if (inp.replace_all) params.replace_all = true;
              } else if (block.name === 'Write') {
                if (inp.file_path) params.file_path = inp.file_path;
                if (inp.content) {
                  if (inp.content.length > TOOL_RESULT_MAX) {
                    params.content = `${inp.content.slice(0, TOOL_RESULT_MAX)}\n... (truncated)`;
                    params.contentFull = inp.content;
                  } else {
                    params.content = inp.content;
                  }
                }
              } else if (block.name === 'Grep') {
                if (inp.path) params.path = inp.path;
                if (inp.glob) params.glob = inp.glob;
                if (inp.type) params.type = inp.type;
                if (inp.output_mode) params.output_mode = inp.output_mode;
                if (inp['-i']) params.case_insensitive = true;
                if (inp['-A']) params.after = inp['-A'];
                if (inp['-B']) params.before = inp['-B'];
                if (inp['-C'] || inp.context) params.context = inp['-C'] || inp.context;
                if (inp.multiline) params.multiline = true;
                if (inp.head_limit) params.head_limit = inp.head_limit;
              } else if (block.name === 'Glob') {
                if (inp.path) params.path = inp.path;
              } else if (block.name === 'Bash') {
                if (inp.timeout) params.timeout = inp.timeout;
                if (inp.run_in_background) params.background = true;
              } else if (block.name === 'Read') {
                if (inp.offset) params.offset = inp.offset;
                if (inp.limit) params.limit = inp.limit;
                if (inp.pages) params.pages = inp.pages;
              } else if (block.name === 'WebFetch') {
                if (inp.prompt) params.prompt = inp.prompt;
              } else if (block.name === 'WebSearch') {
                if (inp.max_results) params.max_results = inp.max_results;
                if (inp.allowed_domains) params.allowed_domains = inp.allowed_domains.join(', ');
                if (inp.blocked_domains) params.blocked_domains = inp.blocked_domains.join(', ');
              } else if (block.name === 'LSP') {
                if (inp.operation) params.operation = inp.operation;
                if (inp.filePath) params.filePath = inp.filePath;
                if (inp.line != null) params.line = inp.line;
                if (inp.character != null) params.character = inp.character;
              } else if (block.name === 'ToolSearch') {
                if (inp.max_results) params.max_results = inp.max_results;
              } else if (block.name === 'TaskCreate') {
                if (inp.subject) params.subject = inp.subject;
              } else if (block.name === 'TaskUpdate') {
                if (inp.taskId) params.taskId = `#${inp.taskId}`;
                if (inp.status) params.status = inp.status;
              } else if (block.name === 'NotebookEdit') {
                if (inp.command) params.command = inp.command;
                if (inp.cell_type) params.cell_type = inp.cell_type;
              } else if (block.name === 'Agent') {
                if (inp.mode) params.mode = inp.mode;
                if (inp.model) params.model = inp.model;
                if (inp.run_in_background) params.background = true;
                if (inp.isolation) params.isolation = inp.isolation;
              } else if (block.name === 'ExitPlanMode') {
                if (inp.plan) params.plan = inp.plan;
                if (inp.planFilePath) params.planFilePath = inp.planFilePath;
              } else if (block.name === 'SendMessage') {
                if (inp.to) params.to = inp.to;
                if (inp.summary) params.summary = inp.summary;
                if (inp.message && typeof inp.message === 'object') {
                  params.protocol = inp.message;
                }
              } else {
                // Passthrough for unknown tools (e.g. MCP `mcp__...`) so the detail panel
                // can render args instead of "No details". Truncate large strings to bound
                // wire/cache size, matching the Write `content` cap above.
                for (const [k, v] of Object.entries(inp)) {
                  if (k === 'description' || v == null) continue;
                  if (typeof v === 'string' && v.length > TOOL_RESULT_MAX) {
                    params[k] = `${v.slice(0, TOOL_RESULT_MAX)}\n... (truncated)`;
                    params[`${k}Full`] = v;
                  } else {
                    params[k] = v;
                  }
                }
              }
            }
            const msg = {
              type: 'tool_use',
              tool: block.name,
              detail,
              fullDetail: fullDetail !== detail ? fullDetail : null,
              description: inp?.description || null,
              params: Object.keys(params).length > 0 ? params : null,
              timestamp: obj.timestamp
            };
            if (block.id) msg.toolUseId = block.id;
            if (block.name === 'Agent') {
              if (inp) {
                msg.agentType = inp.subagent_type || null;
                if (inp.prompt) msg.agentPrompt = inp.prompt;
              }
            }
            messages.push(msg);
          }
        }
      } else if (obj.type === 'user' && obj.origin?.kind === 'peer') {
        // Claude Code >= 2.1 files the delivered copy as isMeta (dropped by the
        // branch below) and repeats the envelope's fields on `origin`. That
        // record is always written; the queued enqueue is not, so read it from
        // here and let pushUserMessage drop whichever twin arrives second.
        pushUserMessage(messages, '', obj.timestamp, null, {
          uuid: obj.uuid,
          agent: agentMessageParts(obj.origin.from, obj.origin.body, obj.origin.handback)
        });
      } else if (obj.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
        if (obj.isCompactSummary) {
          // Surface the compaction summary as a single expandable "Compacted"
          // chip (compactSummary), never a raw bubble. The boundary marker plus
          // the /compact command/stdout records collapse into this one entry below.
          const raw = typeof obj.message.content === 'string'
            ? obj.message.content
            : Array.isArray(obj.message.content)
              ? obj.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
              : '';
          const summary = raw
            .replace(/^This session is being continued[^\n]*\n+(The summary below[^\n]*\n+)?/i, '')
            .trim();
          messages.push({
            type: 'user',
            systemLabel: 'Compacted',
            compactSummary: summary || null,
            timestamp: obj.timestamp
          });
          continue;
        }
        if (typeof obj.message.content === 'string') {
          const t = obj.message.content;
          const tmMatch = t.match(/<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/);
          if (tmMatch) {
            const attrs = tmMatch[1];
            const body = tmMatch[2].trim();
            const getAttr = (name) => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || null;
            const tid = getAttr('teammate_id');
            const color = getAttr('color');
            const summary = getAttr('summary');
            let protocol = null;
            try {
              const j = JSON.parse(body);
              if (j.type) protocol = j;
            } catch (_) {}
            const isIdle = protocol?.type === 'idle_notification';
            const isProtocol = !!protocol;
            let protocolLabel = null;
            if (protocol) {
              switch (protocol.type) {
                case 'idle_notification': protocolLabel = protocol.idleReason || 'idle'; break;
                case 'task_assignment': protocolLabel = `assigned #${protocol.taskId}: ${protocol.subject || ''}`; break;
                case 'shutdown_request': protocolLabel = `shutdown: ${protocol.reason || 'requested'}`; break;
                case 'shutdown_response': protocolLabel = protocol.approve ? 'shutdown approved' : `shutdown rejected: ${protocol.reason || ''}`; break;
                case 'plan_approval_request': protocolLabel = 'plan approval requested'; break;
                case 'plan_approval_response': protocolLabel = protocol.approve ? 'plan approved' : `plan rejected: ${protocol.feedback || ''}`; break;
                case 'teammate_terminated': protocolLabel = protocol.message || 'shut down'; break;
                default: protocolLabel = protocol.type.replace(/_/g, ' '); break;
              }
            }
            const truncated = !isProtocol && body.length > 500;
            messages.push({
              type: 'teammate',
              teammateId: tid,
              color,
              summary,
              isIdle,
              isProtocol,
              protocolType: protocol?.type || null,
              protocolLabel,
              protocolData: protocol || null,
              text: isProtocol ? null : (truncated ? `${body.slice(0, 500)}...` : body),
              fullText: isProtocol ? null : (truncated ? body : null),
              timestamp: obj.timestamp
            });
            continue;
          }
          pushUserMessage(messages, t, obj.timestamp, obj.systemLabel || getSystemMessageLabel(t));
        } else if (Array.isArray(obj.message.content)) {
          const texts = [];
          const images = [];
          const toolResultRefs = [];
          obj.message.content.forEach((block, idx) => {
            if (block.type === 'text' && typeof block.text === 'string' && block.text) {
              texts.push(block.text);
            } else if (block.type === 'image' && block.source && block.source.type === 'base64') {
              images.push({
                kind: 'base64',
                blockIndex: idx,
                mediaType: block.source.media_type || 'image/png',
                dataLen: typeof block.source.data === 'string' ? block.source.data.length : 0
              });
            } else if (block.type === 'tool_result' && block.tool_use_id) {
              let resultText = '';
              if (typeof block.content === 'string') {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                resultText = block.content
                  .filter(c => c.type === 'text' && c.text)
                  .map(c => c.text)
                  .join('\n');
                // A Read on an image file (e.g. .png) returns the image as a
                // base64 block inside the tool_result. Count them so the
                // renderer can request each by index and show what the agent
                // saw; the bytes are fetched lazily per image via the endpoint.
                let imgCount = 0;
                for (const c of block.content) {
                  if (c && c.type === 'image' && c.source && c.source.type === 'base64') imgCount++;
                }
                if (imgCount) toolResultImageCounts.set(block.tool_use_id, imgCount);
              }
              if (resultText) {
                toolResults.set(block.tool_use_id, resultText);
              }
              // AskUserQuestion (and similar) stash the structured
              // {questions, answers} payload at the line-level
              // obj.toolUseResult — the block.content string is just a
              // short confirmation. Capture it so the renderer can show
              // the actual answers + option descriptions.
              const tur = obj.toolUseResult;
              let answerPayload = null;
              if (tur && typeof tur === 'object' && !Array.isArray(tur)
                  && tur.answers && typeof tur.answers === 'object') {
                answerPayload = {
                  answers: tur.answers,
                  questions: Array.isArray(tur.questions) ? tur.questions : null,
                };
                toolResultExtras.set(block.tool_use_id, { answerPayload });
              }
              toolResultRefs.push({
                toolUseId: block.tool_use_id,
                preview: resultText ? resultText.slice(0, 200) : '',
                answerPayload,
              });
            }
          });
          const joined = texts.join('\n').trim();
          // Prefer inline base64 blocks when present; otherwise fall back to
          // file-cache references parsed from the text markers.
          const { refs, text: displayText } = parseImageMarkers(joined);
          const allImages = images.length ? images : refs;
          const hasText = displayText && displayText !== INTERRUPT_MARKER;
          const hasImages = allImages.length > 0;
          if (hasText || hasImages) {
            pushUserMessage(
              messages,
              displayText,
              obj.timestamp,
              obj.systemLabel || getSystemMessageLabel(displayText),
              { uuid: obj.uuid, images: allImages, toolResultRefs: hasText ? toolResultRefs : [] }
            );
          }
        }
      } else if (obj.type === 'queue-operation' && obj.operation === 'enqueue') {
        // Queued messages are stored as top-level `content`, not under
        // message.content, and never re-emitted as a type:'user' line.
        // Surface them so the Session Log reflects what the user sent.
        const qt = typeof obj.content === 'string' ? obj.content : '';
        if (qt) {
          const { refs, text } = parseImageMarkers(qt);
          pushUserMessage(messages, text, obj.timestamp, null, { queued: true, images: refs });
        }
      }
    } catch { /* malformed entry */ }
  }

  // Attach tool results to their corresponding tool_use messages.
  // When truncated, ship the full text inline as toolResultFull so the
  // modal expand toggle is instant. The lazy fetch at
  // /api/sessions/:id/tool-result/:toolUseId remains a fallback for older
  // cached payloads that may lack toolResultFull.
  for (const msg of messages) {
    if (msg.type === 'tool_use' && msg.toolUseId && toolResults.has(msg.toolUseId)) {
      const full = toolResults.get(msg.toolUseId);
      const truncated = full.length > TOOL_RESULT_MAX;
      if (truncated) {
        msg.toolResult = `${full.slice(0, TOOL_RESULT_MAX)}\n... (truncated)`;
        msg.toolResultFull = full;
      } else {
        msg.toolResult = full;
      }
      msg.toolResultTruncated = truncated;
    }
    if (msg.type === 'tool_use' && msg.toolUseId && toolResultImageCounts.has(msg.toolUseId)) {
      msg.toolResultImageCount = toolResultImageCounts.get(msg.toolUseId);
    }
    if (msg.type === 'tool_use' && msg.tool === 'AskUserQuestion'
        && msg.toolUseId && toolResultExtras.has(msg.toolUseId)) {
      const extra = toolResultExtras.get(msg.toolUseId);
      if (extra.answerPayload) msg.answerPayload = extra.answerPayload;
    }
  }

  messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].systemLabel === 'Compacted' && messages[i - 1].systemLabel === 'Compacted') {
      // Carry the summary body onto the surviving chip so collapsing the
      // boundary + /compact command + stdout + isCompactSummary records into
      // one entry never drops the expandable summary.
      if (messages[i].compactSummary && !messages[i - 1].compactSummary) {
        messages[i - 1].compactSummary = messages[i].compactSummary;
      }
      messages.splice(i, 1);
    }
  }
  return messages;
}

async function readFullToolResult(jsonlPath, toolUseId) {
  if (!toolUseId || !jsonlPath || !existsSync(jsonlPath)) return null;
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line || line.indexOf(toolUseId) === -1) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.message?.content && Array.isArray(obj.message.content)) {
          for (const block of obj.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
              if (typeof block.content === 'string') return block.content;
              if (Array.isArray(block.content)) {
                return block.content
                  .filter((c) => c.type === 'text' && c.text)
                  .map((c) => c.text)
                  .join('\n');
              }
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

async function readUserImage(jsonlPath, msgUuid, blockIndex) {
  if (!msgUuid || !jsonlPath) return null;
  const idx = Number(blockIndex);
  if (!Number.isInteger(idx) || idx < 0) return null;
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line || line.indexOf(msgUuid) === -1) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.uuid !== msgUuid) continue;
        if (!Array.isArray(obj?.message?.content)) continue;
        const block = obj.message.content[idx];
        if (!block || block.type !== 'image' || !block.source || block.source.type !== 'base64') return null;
        return {
          mediaType: block.source.media_type || 'image/png',
          data: block.source.data
        };
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// Read the Nth base64 image embedded in a tool_result block (e.g. the output of
// a Read on an image file). Scans for the tool_result matching toolUseId.
async function readToolResultImage(jsonlPath, toolUseId, n) {
  if (!toolUseId || !jsonlPath) return null;
  const idx = Number(n);
  if (!Number.isInteger(idx) || idx < 0) return null;
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line || line.indexOf(toolUseId) === -1) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue;
        if (!Array.isArray(block.content)) continue;
        const images = block.content.filter(
          (c) => c && c.type === 'image' && c.source && c.source.type === 'base64',
        );
        const img = images[idx];
        if (!img) return null;
        return { mediaType: img.source.media_type || 'image/png', data: img.source.data };
      }
    }
  } catch (_) {}
  return null;
}

const CACHED_IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

// Serve pasted image N from <piAgentDir>/image-cache/<sessionId>/. The cached file may
// be any image format, so resolve it by index rather than assuming .png. sessionId
// is validated to a bare id to prevent path traversal.
function readCachedImage(sessionId, n, piAgentDir) {
  const idx = Number(n);
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  if (!Number.isInteger(idx) || idx < 0) return null;
  const baseDir = piAgentDir || path.join(os.homedir(), '.claude');
  const dir = path.join(baseDir, 'image-cache', sessionId);
  try {
    const match = readdirSync(dir).find((f) => {
      const dot = f.lastIndexOf('.');
      return dot > 0 && f.slice(0, dot) === String(idx) && CACHED_IMAGE_MIME[f.slice(dot + 1).toLowerCase()];
    });
    if (!match) return null;
    const ext = match.slice(match.lastIndexOf('.') + 1).toLowerCase();
    return { mediaType: CACHED_IMAGE_MIME[ext], buffer: readFileSync(path.join(dir, match)) };
  } catch (_) {
    return null;
  }
}

function readMessagesPage(jsonlPath, limit = 10, beforeTimestamp = null) {
  const fetchLimit = limit + 1;
  const applyFilter = beforeTimestamp
    ? (msgs) => msgs.filter((m) => m.timestamp && m.timestamp < beforeTimestamp)
    : (msgs) => msgs;
  let readLimit = Math.max(fetchLimit * 5, 200);
  let allMessages = readRecentMessages(jsonlPath, readLimit);
  let filtered = applyFilter(allMessages);

  while (filtered.length < fetchLimit && allMessages.length === readLimit && readLimit < 10000) {
    readLimit *= 4;
    allMessages = readRecentMessages(jsonlPath, readLimit);
    filtered = applyFilter(allMessages);
  }

  const page = filtered.slice(-fetchLimit);
  const hasMore = page.length > limit;
  return {
    messages: hasMore ? page.slice(1) : page,
    hasMore
  };
}

// A finished pi subagent call reports its runs in the tool result's details.results
// (pi-subagents SingleResult). An async launch has no results; its usage never reaches
// the session file. results[].task is redacted, so the prompt comes from the call.
function piSubagentUsage(obj) {
  const results = obj?.toolUseResult?.results;
  const block = Array.isArray(obj?.message?.content) ? obj.message.content.find((b) => b?.type === 'tool_result') : null;
  if (!Array.isArray(results) || !results.length || !block?.tool_use_id) return null;
  const r = results[0] || {};
  const u = r.usage || {};
  const tokens = typeof u.input === 'number' || typeof u.output === 'number' ? (u.input || 0) + (u.output || 0) : null;
  const num = (v) => (typeof v === 'number' ? v : null);
  const entry = agentUsageEntry(tokens, num(r.progressSummary?.toolCount), num(r.durationMs) ?? num(r.progressSummary?.durationMs));
  return entry ? { toolUseId: block.tool_use_id, ...entry } : null;
}

async function buildSessionDigest(jsonlPath) {
  const map = {};
  const terminated = new Map();
  const rejectedToolUseIds = new Set();
  const promptByToolUseId = {};
  const killedAgentIds = new Set();
  try {
    const re = /"type":"agent_progress"[^}]*"agentId":"([^"]+)"/;
    const parentRe = /"parentToolUseID":"([^"]+)"/;
    const promptRe = /"prompt":"((?:[^"\\]|\\.)*)"/;
    const bgToolIdRe = /"tool_use_id":"([^"]+)"/;
    const bgAgentIdRe = /agentId: ([a-zA-Z0-9_@-]+)/;
    const tmToolIdRe = /"tool_use_id":"([^"]+)"/;
    const tmAgentIdRe = /agent_id: ([a-zA-Z0-9_@-]+)/;
    const taskIdRe = /<task-id>([a-zA-Z0-9_-]+)<\/task-id>/;
    const nameByToolUseId = {};
    const descByToolUseId = {};
    const usageByToolUseId = {};
    for await (const line of readLines(jsonlPath)) {
      // Terminated-teammate detection: check first since cheap substring guards
      if (line.includes('teammate-message') &&
          (line.includes('teammate_terminated') || line.includes('shutdown_response'))) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user') {
            const text = typeof obj.message?.content === 'string' ? obj.message.content : null;
            if (text) {
              const ts = obj.timestamp || null;
              for (const tmMatch of text.matchAll(/<teammate-message\s+[^>]*teammate_id="([^"]+)"[^>]*>([\s\S]*?)<\/teammate-message>/g)) {
                try {
                  const tid = tmMatch[1];
                  const body = tmMatch[2].trim();
                  const protocol = JSON.parse(body);
                  if (protocol.type === 'teammate_terminated') {
                    const name = protocol.from || (protocol.message?.match(/^(\S+)\s/)?.[1]) || tid;
                    if (name !== 'system') terminated.set(name, ts);
                  } else if (protocol.type === 'shutdown_response' && protocol.approve) {
                    const name = protocol.from || tid;
                    if (name !== 'system') terminated.set(name, ts);
                  }
                } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }

      if (line.includes('"agent_progress"')) {
        const agentMatch = re.exec(line);
        const parentMatch = parentRe.exec(line);
        if (agentMatch && parentMatch) {
          const key = parentMatch[1];
          if (!map[key]) {
            let prompt = null;
            const promptMatch = promptRe.exec(line);
            if (promptMatch?.[1]) {
              try { prompt = JSON.parse(`"${promptMatch[1]}"`); } catch (_) { prompt = promptMatch[1]; }
            }
            map[key] = { agentId: agentMatch[1], prompt };
          }
        }
      } else if (line.includes('Async agent launched')) {
        const toolIdMatch = bgToolIdRe.exec(line);
        const bgAgentMatch = bgAgentIdRe.exec(line);
        if (toolIdMatch && bgAgentMatch && !map[toolIdMatch[1]]) {
          map[toolIdMatch[1]] = { agentId: bgAgentMatch[1], prompt: null };
        }
      } else if (line.includes('"teammate_spawned"')) {
        const toolIdMatch = tmToolIdRe.exec(line);
        const agentMatch = tmAgentIdRe.exec(line);
        if (toolIdMatch && agentMatch && !map[toolIdMatch[1]]) {
          map[toolIdMatch[1]] = { agentId: agentMatch[1], prompt: null };
        }
      } else if (line.includes('"toolUseResult"') && line.includes('"results"') && line.includes('"tool_result"')) {
        try {
          const found = piSubagentUsage(JSON.parse(line));
          if (found) usageByToolUseId[found.toolUseId] = { usage: found.usage, usageText: found.usageText };
        } catch (_) {}
      } else if (line.includes('"assistant"') && line.includes('"tool_use"') && line.includes('"Agent"')) {
        try {
          const obj = JSON.parse(line);
          const blocks = obj.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b.type === 'tool_use' && b.name === 'Agent' && b.id) {
                if (b.input?.name) nameByToolUseId[b.id] = b.input.name;
                if (b.input?.description) descByToolUseId[b.id] = b.input.description;
                if (b.input?.prompt) promptByToolUseId[b.id] = b.input.prompt;
                // A status or list call names no agent; only a launch spawns one. The first run
                // stands for the call.
                if (b.input?.subagent_type && !map[b.id]) {
                  map[b.id] = { agentId: agentIdFor(b.id, 0), prompt: b.input.prompt || null, usage: null, usageText: null };
                }
              }
            }
          }
        } catch (_) {}
      } else if (line.includes('User rejected tool use') && line.includes('"tool_use_id"')) {
        const m = tmToolIdRe.exec(line);
        if (m) rejectedToolUseIds.add(m[1]);
      } else if (line.includes('<task-notification>')) {
        // The envelope's tags survive JSON escaping, so read them off the raw line.
        // This covers every delivery shape (user message, queue-operation,
        // queued_command attachment) without enumerating them.
        if (line.includes('<status>killed</status>') || line.includes('<status>error</status>')) {
          const idMatch = taskIdRe.exec(line);
          if (idMatch) killedAgentIds.add(idMatch[1]);
        }
        if (line.includes('<subagent_tokens>')) {
          const notif = parseTaskNotification(line);
          const u = notif?.usage;
          const entry = u && notif.toolUseId ? agentUsageEntry(u.subagentTokens, u.toolUses, u.durationMs) : null;
          if (entry) usageByToolUseId[notif.toolUseId] = entry;
        }
      } else if (line.includes('"toolUseResult"') && line.includes('"agentId"') && line.includes('"tool_result"')) {
        try {
          const obj = JSON.parse(line);
          const tur = obj.toolUseResult;
          if (tur?.agentId) {
            // Foreground agents report their cost on the completion toolUseResult;
            // background agents report the same numbers in their <task-notification>.
            const { usage, usageText } = agentUsageEntry(tur.totalTokens, tur.totalToolUseCount, tur.totalDurationMs)
              || { usage: null, usageText: null };
            const blocks = obj.message?.content;
            if (Array.isArray(blocks)) {
              for (const b of blocks) {
                if (b.type === 'tool_result' && b.tool_use_id && !map[b.tool_use_id]) {
                  map[b.tool_use_id] = { agentId: tur.agentId, prompt: tur.prompt || null, usage, usageText };
                }
              }
            }
          }
        } catch (_) {}
      }
    }
    for (const [key, entry] of Object.entries(map)) {
      if (!entry.usage && usageByToolUseId[key]) Object.assign(entry, usageByToolUseId[key]);
      if (nameByToolUseId[key]) entry.name = nameByToolUseId[key];
      if (descByToolUseId[key]) entry.description = descByToolUseId[key];
      // Prefer the full prompt from the assistant's tool_use input — Claude Code's
      // agent_progress system messages embed a truncated prompt that ends mid-sentence.
      // Only override when entry already had a prompt (i.e. agent_progress path);
      // bg/teammate paths intentionally keep prompt null per existing contract.
      if (entry.prompt && promptByToolUseId[key] && promptByToolUseId[key].length > entry.prompt.length) {
        entry.prompt = promptByToolUseId[key];
      }
    }
  } catch (_) {}
  const rejectedAgentIds = new Set();
  const rejectedPrompts = new Set();
  for (const toolUseId of rejectedToolUseIds) {
    const entry = map[toolUseId];
    if (entry?.agentId) rejectedAgentIds.add(entry.agentId);
    const prompt = entry?.prompt || promptByToolUseId[toolUseId];
    if (prompt) rejectedPrompts.add(prompt);
  }
  return { progressMap: map, terminated, rejectedAgentIds, rejectedPrompts, killedAgentIds };
}

async function buildAgentProgressMap(jsonlPath) {
  return (await buildSessionDigest(jsonlPath)).progressMap;
}

const ARTIFACT_URL_RE = /https:\/\/claude\.ai\/\S*artifact\/[A-Za-z0-9_-]+/;

// Two kinds of line record a published artifact: the `frame-link` entry the
// viewer writes, which carries the title, and the result of an Artifact publish,
// which is there even when the artifact was never opened in a frame. Keyed by URL,
// so the republishes of one page collapse into a single entry. A result counts
// only when its tool_use_id belongs to a publish call — an artifact URL quoted
// back by a grep or a file read would otherwise register another session's page as
// this session's own, and a `read` of someone else's artifact is not a publish.
async function readArtifactLinks(jsonlPath) {
  const byUrl = new Map();
  const publishedFileByToolUseId = new Map();
  const upsert = (url, ts) => {
    let a = byUrl.get(url);
    if (!a) {
      a = { url, title: null, path: null, firstSeen: ts || null };
      byUrl.set(url, a);
    }
    if (ts && (!a.firstSeen || ts < a.firstSeen)) a.firstSeen = ts;
    return a;
  };
  try {
    for await (const line of readLines(jsonlPath)) {
      if (!line.includes('"frame-link"') && !line.includes('"name":"Artifact"') && !line.includes('claude.ai'))
        continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.type === 'frame-link' && obj.frameUrl) {
        const a = upsert(obj.frameUrl, obj.timestamp);
        if (obj.title) a.title = obj.title;
        if (obj.path) a.path = obj.path;
        continue;
      }
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type === 'tool_use') {
          const input = b.name === 'Artifact' ? b.input || {} : null;
          // The publish action is the default one, so it is spelled by the file it
          // takes rather than by a name.
          if (b.id && input?.file_path && (!input.action || input.action === 'publish')) {
            publishedFileByToolUseId.set(b.id, input.file_path);
          }
          continue;
        }
        if (b?.type !== 'tool_result' || !publishedFileByToolUseId.has(b.tool_use_id)) continue;
        const m = contentText(b.content).match(ARTIFACT_URL_RE);
        if (!m) continue;
        const a = upsert(m[0], obj.timestamp);
        if (!a.path) a.path = publishedFileByToolUseId.get(b.tool_use_id);
      }
    }
  } catch (_) {}
  return [...byUrl.values()].sort((x, y) => (x.firstSeen < y.firstSeen ? -1 : x.firstSeen > y.firstSeen ? 1 : 0));
}

const SCRATCH_NEW_RE = /\bscratch new\b/;
// `scratch new` reports where it put the pad; the two spaces are the CLI's own column
// padding, which is what makes the prefilter below narrow enough to be worth having.
const SCRATCH_MANIFEST_RE = /^\s*manifest\s*:\s*(.+?)\s*$/m;
// The name must sit immediately after `new`, and the bare-word branch must refuse a
// leading `-`, so that a flag or a flag's value cannot be read as the name.
const SCRATCH_NAME_RE = /\bscratch\s+new\s+(?:"([^"]+)"|'([^']+)'|(?!-)(\S+))/;

// The `scratch new` calls in a transcript, `{ ts, path, name }` per call. `path` is null
// whenever the command piped the CLI's output away — the common case, not an edge one:
// the manifest is the 4th of ~13 printed lines, so any `| tail -N` cuts it off. `name`
// stands in because it is what the manifest stores as its own `name`; the path is not
// recovered from the command, which would mean tracking the `cd` and a relative `--dir`.
async function readScratchpadCreations(jsonlPath) {
  const calls = new Map();
  try {
    for await (const line of readLines(jsonlPath)) {
      // Substring reject before JSON.parse: transcripts reach tens of megabytes and
      // only a handful of lines can ever match.
      const isCall = line.includes('scratch new');
      if (!isCall && !line.includes('manifest  :')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const blocks = obj?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const ts = Date.parse(obj.timestamp);
      for (const b of blocks) {
        if (b?.type === 'tool_use' && b.name === 'Bash' && SCRATCH_NEW_RE.test(b.input?.command || '')) {
          if (b.id && Number.isFinite(ts)) {
            const named = SCRATCH_NAME_RE.exec(b.input.command);
            calls.set(b.id, { ts, path: null, name: named?.slice(1).find(Boolean) ?? null });
          }
        } else if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
          const m = SCRATCH_MANIFEST_RE.exec(contentText(b.content));
          if (m) calls.get(b.tool_use_id).path = m[1];
        }
      }
    }
  } catch (_) {}
  return [...calls.values()];
}

async function findTerminatedTeammates(jsonlPath) {
  return (await buildSessionDigest(jsonlPath)).terminated;
}

// The first prompt of the active branch. Throws for a missing path; callers rely on that.
function extractPromptFromTranscript(jsonlPath) {
  statSync(jsonlPath);
  return firstUserText(readClaudeLines(jsonlPath, { retain: false }));
}

// The model of the first reply, or of the first model_change before any reply.
// Throws for a missing path.
function extractModelFromTranscript(jsonlPath) {
  statSync(jsonlPath);
  for (const l of readClaudeLines(jsonlPath, { retain: false })) {
    const model = l.model || l.message?.model;
    if (model) return model;
  }
  return null;
}

// Render a StructuredOutput tool input (arbitrary schema object) as markdown:
// one section per field, prose kept verbatim, structured values as JSON blocks.
function formatStructuredResult(input) {
  const parts = [];
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === '') continue;
    parts.push(`### ${key}`);
    parts.push(typeof value === 'string' ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// Some subagents end their run on a tool call and never emit a text response, so
// their lastMessage is empty: workflow subagents given a schema call StructuredOutput,
// background subagents report through SubagentHandback. Tail-read the transcript and
// take the LAST such tool_use as the agent's result. Without one, take the last
// assistant text: the plugin's mod records no lastMessage, because Claude Code's
// turn.complete carries an empty answer for a subagent. Returns null when neither exists.
const RESULT_TOOLS = {
  StructuredOutput: formatStructuredResult,
  SubagentHandback: (input) => (typeof input.message === 'string' && input.message) || null,
};
function resultFromBlock(b) {
  if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') return null;
  return RESULT_TOOLS[b.name]?.(b.input) ?? null;
}

function extractAgentResultFromTranscript(jsonlPath) {
  statSync(jsonlPath);
  const replies = readClaudeLines(jsonlPath, { retain: false })
    .filter((l) => l.type === 'assistant' && Array.isArray(l.message?.content))
    .map((l) => l.message.content);
  const lastFound = (pick) => {
    for (let i = replies.length - 1; i >= 0; i--) {
      const found = pick(replies[i]);
      if (found) return found;
    }
    return null;
  };
  return lastFound((content) => content.map(resultFromBlock).findLast(Boolean))
    ?? lastFound((content) => contentText(content).trim());
}

module.exports = {
  modelDisplayName,
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  parseTaskNotification,
  parseAgentMessage,
  getSystemMessageLabel,
  readSessionInfoFromJsonl,
  exportSessionCaches,
  importSessionCaches,
  sessionCachesDirty,
  transcriptActivityMs,
  readRecentMessages,
  readMessagesPage,
  readFullToolResult,
  readUserImage,
  readToolResultImage,
  readCachedImage,
  buildAgentProgressMap,
  buildSessionDigest,
  readArtifactLinks,
  readScratchpadCreations,
  findTerminatedTeammates,
  extractPromptFromTranscript,
  extractModelFromTranscript,
  extractAgentResultFromTranscript,
  readLines
};
