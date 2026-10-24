'use strict';

// Embedded terminal: one PTY per session id, reached over a WebSocket.
//
// A PTY endpoint turns any gap in the network boundary into code execution as the
// user, so the upgrade passes three independent gates: Host + strict Origin
// (net-guard upgradeVerdict), refusal when the server is exposed, and a per-launch
// token sent in the first message. The token is the only one that stops a
// non-browser local process.
//
// The service runs in its own process (lib/terminal-host.js): pi-kanban checks the first two
// gates and hands the upgraded socket over, so no keystroke or output byte waits on
// pi-kanban's main thread.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isContained } = require('./contain');
const { isPidAlive } = require('./live-sessions');
const { THINKING_LEVELS } = require('./pi-agents');
const priority = require('./priority');

const WS_PATH = '/api/terminal/ws';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = new Set(['auto', 'resume', 'shell', 'new', 'pick']);
const PICK_POLL_MS = 1000;
// How long before the PTY a registry entry may claim to have started (clock skew between the two).
const PICK_START_SLACK_MS = 2000;
// A new session's name and model reach a shell command line, so they are held to a
// charset that needs no escaping beyond plain quotes. The first character is never '-'.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
// pi's --model pattern: provider/id, globs, and an optional :<thinking> suffix.
const MODEL_RE = /^[\w.][\w./:*-]{0,119}$/;
// Extra pi args reach the command line inside plain quotes (quoteArg), so a character
// that ends or expands those quotes in any of the shells is refused.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refuses control characters on purpose
const EXTRA_ARG_RE = /^[^\x00-\x1f\x7f"%]*$/;
const MAX_EXTRA_ARGS = 64;
const MAX_EXTRA_ARG = 4096;
// pi-kanban sets these itself, or they would start something other than a new session.
const OWNED_FLAGS = new Set([
  '--session-id', '--session', '--fork', '--no-session', '--session-dir', '-n', '--name', '--model', '--thinking',
  '-r', '--resume', '-c', '--continue', '-p', '--print', '--mode',
]);
const MAX_PROMPT = 32 * 1024;
const PROMPT_QUIET_MS = 400;
const SUBMIT_POLL_MS = 1000;
const SUBMIT_CHECKS = 5;
const SUBMIT_RETRIES = 2;
// The title of pi's project-trust question (core/project-trust.js). It tells the board the question
// is up; the looser onTrustScreen only holds the prompt back, where a miss is worse.
const TRUST_DIALOG = /Trust project folder\?/;
// Watermarks from https://xtermjs.org/docs/guides/flowcontrol/ — pause the PTY while a
// client lags, so a runaway process cannot grow the socket buffer without bound.
const HIGH_WATER = 128 * 1024;
const LOW_WATER = 16 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const BOOST_TRIES = 30;
const MAX_PAYLOAD = 1024 * 1024;
// Each restored terminal is a full pi process, so they start one at a time.
const RESTORE_GAP_MS = 2000;
// A tree kill (`taskkill /f /t`) can deliver the PTY exits to pi-kanban a moment before
// pi-kanban itself dies. The delay keeps that teardown out of the saved list.
const SAVE_DELAY_MS = 1000;
const RESTORABLE_MODES = new Set(['resume', 'new']);
// Quitting pi drops the PTY to its shell, so the PTY's exit cannot tell pi-kanban that pi is gone.
const PI_EXIT_POLL_MS = 5000;
// The size of a PTY no browser has attached to yet; the first attach resizes it.
const HEADLESS_COLS = 120;
const HEADLESS_ROWS = 32;
// pi-kanban's own settings; a dev server started in the terminal must not bind pi-kanban's port.
const STRIP_ENV = [
  'PORT', 'HOST', 'ALLOWED_HOSTS',
  'PK_TERMINAL_TOKEN', 'PK_TERMINAL_SHELL',
  // A pi-kanban started from a pi subagent carries this; a pi that inherits it writes no live-session
  // registry entry, which the board reads to find the terminal's pi process.
  'PI_SUBAGENT_CHILD',
  // A pi-kanban started inside tmux passes these on, and a session started here would then claim a tmux pane it is not in.
  'TMUX', 'TMUX_PANE',
];

function readTerminalConfig({ argv = process.argv, env = process.env, getArgValue } = {}) {
  return {
    enabled: !argv.includes('--no-terminal'),
    shell: getArgValue?.('terminal-shell') || env.PK_TERMINAL_SHELL || null,
    maxSessions: 30,
    fontSize: 13,
    scrollback: 5000,
    restore: true,
  };
}

// Git for Windows ships two bash.exe files; bin\ is the launcher that sets up the MSYS environment.
const GIT_BASH_RE = /[\\/]Git[\\/](usr[\\/])?bin[\\/]bash\.exe$/i;

function shellFamily(shell) {
  if (GIT_BASH_RE.test(shell)) return 'gitbash';
  const base = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'pwsh';
  if (base === 'cmd') return 'cmd';
  return 'posix';
}

function findGitBash(which, env) {
  const git = which('git');
  const candidates = [
    git && path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// `value` is `gitbash`, a program name looked up on PATH (pwsh, cmd, zsh), or a path.
// Unset means the platform default. Throws when the named shell cannot be found.
function resolveShell(value, which, platform = process.platform, env = process.env) {
  if (!value) {
    if (platform === 'win32') return which('pwsh') || which('powershell') || 'powershell.exe';
    return env.SHELL || '/bin/sh';
  }
  // which() appends PATHEXT itself, so a bare `cmd.exe` would never match.
  const name = /[\\/]/.test(value) ? value : value.replace(/\.exe$/i, '');
  const found = name.toLowerCase() === 'gitbash' ? findGitBash(which, env) : which(name);
  if (!found) throw new Error(`terminal shell "${value}" not found`);
  return found;
}

// piArgs is null for a plain shell. Its items are fixed flags, a validated UUID, or
// values that passed NAME_RE / MODEL_RE / EXTRA_ARG_RE. Those hold no " or %, so cmd's
// double quotes hold them, and quotePrompt escapes the ' a path such as O'Brien can carry.
function quoteArg(arg, family) {
  if (/^[A-Za-z0-9._-]+$/.test(arg)) return arg;
  return family === 'cmd' ? `"${arg}"` : quotePrompt(arg, family);
}

// Free text, unlike quoteArg's input. Inside single quotes pwsh only reads a quote mark (it
// counts the typographic ones too) and POSIX shells read nothing, so doubling or closing
// around the quote is enough. cmd has no quoting that holds % and ", so start() refuses it.
function quotePrompt(text, family) {
  if (family === 'pwsh') return `'${text.replace(/['‘’‚‛]/g, '$&$&')}'`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// `--` ends pi's flags, so a prompt that starts with '-' stays a message.
function piCommand(shell, piArgs, prompt) {
  const family = shellFamily(shell);
  const args = piArgs.map((a) => quoteArg(a, family));
  return ['pi', ...args, ...(prompt ? ['--', quotePrompt(prompt, family)] : [])].join(' ');
}

function shellArgs(shell, piArgs) {
  const family = shellFamily(shell);
  if (!piArgs) return family === 'pwsh' ? ['-NoLogo'] : family === 'gitbash' ? ['--login', '-i'] : [];
  const cmd = piCommand(shell, piArgs);
  if (family === 'pwsh') return ['-NoLogo', '-NoExit', '-Command', cmd];
  if (family === 'cmd') return ['/k', cmd];
  if (family === 'gitbash') return ['--login', '-i', '-c', `${cmd}; exec bash --login -i`];
  // $0 is the shell itself (the argument after the script), so exiting pi
  // lands in an interactive shell of the same kind.
  return ['-c', `${cmd}; exec "$0"`, shell];
}

function piArgsFor(mode, id, spec) {
  if (mode === 'shell') return null;
  if (mode === 'pick') return ['--resume'];
  if (mode === 'new') {
    // A fork takes the PTY's id through --session-id. A plain resume keeps the transcript's
    // id, and pi refuses --session-id beside --session.
    const own = spec.resume ? ['--session', spec.resume] : ['--session-id', id];
    const args = [...(spec.forkOf ? ['--fork', spec.forkOf] : []), ...own, ...(spec.extraArgs || [])];
    if (spec.name) args.push('--name', spec.name);
    if (spec.model) args.push('--model', spec.model);
    if (spec.thinking) args.push('--thinking', spec.thinking);
    return args;
  }
  return ['--session', id];
}

// pi's fullscreen mode turns on the alt screen and mouse tracking, and ConPTY passes the alt screen
// through but drops the mouse modes, so xterm turns the wheel into arrow keys that scroll pi's prompt
// history. Regular mode keeps pi in the normal buffer, which xterm scrolls itself.
function withTuiMode(args, platform = process.platform) {
  if (!args || platform !== 'win32' || args.some((a) => a.split('=')[0] === '--tui-mode')) return args;
  return [...args, '--tui-mode', 'regular'];
}

function extraArgsError(args) {
  if (!Array.isArray(args) || args.length > MAX_EXTRA_ARGS) return `pi args (at most ${MAX_EXTRA_ARGS})`;
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_EXTRA_ARG || !EXTRA_ARG_RE.test(a)) return 'pi arg: no double quotes, % or control characters';
    const flag = a.split('=')[0];
    if (OWNED_FLAGS.has(flag)) return `pi arg: pi-kanban sets ${flag}`;
  }
  return null;
}

// Returns the new-session options from a hello, or a string naming the bad field.
function parseNewSpec(msg) {
  const forkOf = msg.forkOf ?? null;
  if (forkOf !== null && (typeof forkOf !== 'string' || !UUID_RE.test(forkOf))) return 'session to fork';
  const resume = msg.resume ?? null;
  if (resume !== null && (typeof resume !== 'string' || !UUID_RE.test(resume) || forkOf)) return 'session to resume';
  if (!forkOf && (typeof msg.cwd !== 'string' || !msg.cwd)) return 'folder';
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  if (name && !NAME_RE.test(name)) return 'name';
  const model = msg.model || null;
  if (model && !(typeof model === 'string' && MODEL_RE.test(model))) return 'model';
  const thinking = msg.thinking || null;
  if (thinking && !THINKING_LEVELS.has(thinking)) return 'thinking level';
  const edit = msg.edit === true;
  // ESC so a prompt cannot carry terminal sequences; on a shell line (edit) every control
  // character but tab and line breaks, since it could act as a key (Ctrl+C, Ctrl+U) instead of text.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters on purpose
  const strip = edit ? /[\x00-\x08\x0b-\x1f\x7f]/g : /\x1b/g;
  const prompt = typeof msg.prompt === 'string' ? msg.prompt.replace(strip, '').trim() : '';
  if (prompt.length > MAX_PROMPT) return 'prompt';
  const extraArgs = msg.extraArgs ?? [];
  const bad = extraArgsError(extraArgs);
  if (bad) return bad;
  const restore = msg.restore !== false;
  return { cwd: forkOf ? null : msg.cwd, forkOf, resume, name: name || null, model, thinking, prompt: prompt || null, extraArgs, edit, restore };
}

function samePath(a, b) {
  return isContained(a, b) && isContained(b, a);
}

// The registry entry of the pi a pick PTY started: same folder, started no earlier than the PTY.
function findPickProcess(live, pty, claimed) {
  return live.find(
    (l) => l.pid && !claimed.has(l.pid) && l.startedAt >= pty.startedAt - PICK_START_SLACK_MS && samePath(l.cwd, pty.cwd),
  )?.pid;
}

function screenText(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

// The pi in the terminal reads and writes the agent dir this board watches.
// PK_URL pins the CLI and the pi tools to this board: two boards on one agent dir share
// one server.json, and the last one started owns it. PK_TERMINAL_ID names the terminal the
// show tool posts to.
function ptyEnv({ piAgentDir, pkUrl, terminalId }) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  env.TERM_PROGRAM = 'pi-kanban';
  delete env.TERM_PROGRAM_VERSION;
  env.PI_CODING_AGENT_DIR = piAgentDir;
  if (pkUrl) env.PK_URL = pkUrl;
  else delete env.PK_URL;
  if (terminalId) env.PK_TERMINAL_ID = terminalId;
  else delete env.PK_TERMINAL_ID;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function clampDim(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(500, Math.max(2, n)) : fallback;
}

// Destroying right after write can reset the connection before the response is sent (seen on Windows).
function refuse(socket, status, reason) {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}\n`);
}

function localUnavailableReason(config, net) {
  if (!config.enabled) return 'disabled';
  if (net.EXPOSED) return 'refused while listening on a non-loopback address';
  return null;
}

function refuseUpgrade(req, socket, reasonFor) {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = ''; }
  if (pathname !== WS_PATH) {
    refuse(socket, '404 Not Found', 'no such endpoint');
    return true;
  }
  const reason = reasonFor();
  if (reason) refuse(socket, '403 Forbidden', reason);
  return !!reason;
}

// xterm's ConPTY mode. When the pane grows, xterm then adds rows at the bottom as conhost does,
// instead of pulling scrollback lines down, so the rows pi draws to stay where ConPTY puts them.
function windowsPtyFor(platform = process.platform, release = os.release()) {
  return platform === 'win32' ? { backend: 'conpty', buildNumber: Number(release.split('.')[2]) || undefined } : {};
}

const WINDOWS_PTY = windowsPtyFor();

function clientConfigFor(config, available) {
  return {
    available,
    fontSize: config.fontSize,
    scrollback: config.scrollback,
    maxSessions: config.maxSessions,
    windowsPty: WINDOWS_PTY,
  };
}

/**
 * @param {object} o
 * @param {ReturnType<typeof readTerminalConfig>} o.config
 * @param {{EXPOSED: boolean, upgradeVerdict: (req: any) => string|null}} o.net
 * @param {string} o.piAgentDir
 * @param {(id: string) => string|null|Promise<string|null>} o.resolveCwd  null = unknown session
 * @param {(id: string, exceptPid?: number) => boolean} o.isLiveElsewhere
 * @param {(dir: string) => boolean|Promise<boolean>} o.isAllowedFolder  where a new session may start
 * @param {() => {pid: number|null, sessionId: string, cwd: string|null, startedAt: number}[]} o.liveSessions
 *   the live-session registry the pi extension writes, read fresh
 * @param {(cmd: string) => string|null} o.which
 * @param {string} [o.token]
 * @param {() => void} [o.onChange]  a terminal started, ended or moved to another session id
 * @param {(from: string, to: string) => void} [o.onRekey]  a terminal moved to another session id
 * @param {() => {sessions?: string[], terminalIds?: Object<string, string>}|null} [o.load]  the saved list, read when config.restore is on
 * @param {(data: {sessions: string[], terminalIds?: Object<string, string>}) => void} [o.save]  the session ids to resume on the next start, and the terminal id of each
 * @param {object} [o.pty]  stands in for @lydell/node-pty in tests
 */
function createTerminalService(o) {
  const { config, net } = o;
  if (config.enabled) priority.raise();
  const token = o.token || crypto.randomBytes(32).toString('hex');
  const sessions = new Map();
  let pty = null;
  let loadError = null;
  let wss = null;
  let Headless = null;
  let Serialize = null;
  let shell = null;
  let shuttingDown = false;
  let saveTimer = null;
  let lastSaved = null;
  const saveDelayMs = o.saveDelayMs ?? SAVE_DELAY_MS;
  const restoreGapMs = o.restoreGapMs ?? RESTORE_GAP_MS;
  const exitPollMs = o.exitPollMs ?? PI_EXIT_POLL_MS;
  const submitPollMs = o.submitPollMs ?? SUBMIT_POLL_MS;
  const pidAlive = o.isPidAlive || isPidAlive;
  const exitTimer = setInterval(checkExits, exitPollMs);
  exitTimer.unref();
  // Read before any terminal starts, so the first save keeps the ids still waiting to restore.
  const savedState = config.restore ? o.load?.() : null;
  const saved = savedState?.sessions;
  const restoreQueue = Array.isArray(saved) ? saved.filter((id) => typeof id === 'string' && UUID_RE.test(id)) : [];
  // A resumed terminal keeps its id, so its show card keeps its posts.
  const savedTerminalIds = {};
  for (const [id, terminalId] of Object.entries(savedState?.terminalIds || {})) {
    if (restoreQueue.includes(id) && typeof terminalId === 'string' && UUID_RE.test(terminalId)) savedTerminalIds[id] = terminalId;
  }

  // Lazy and optional: a missing prebuilt or shell must hide the feature, not crash pi-kanban.
  function load() {
    if (pty || loadError) return !!pty;
    try {
      shell = resolveShell(config.shell, o.which);
    } catch (e) {
      loadError = e.message;
      return false;
    }
    try {
      pty = o.pty || require('@lydell/node-pty');
      ({ Terminal: Headless } = require('@xterm/headless'));
      ({ SerializeAddon: Serialize } = require('@xterm/addon-serialize'));
      const { WebSocketServer } = require('ws');
      wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    } catch (e) {
      pty = null;
      loadError = `terminal backend failed to load: ${e.message}`;
    }
    return !!pty;
  }

  function unavailableReason() {
    return localUnavailableReason(config, net) || (load() ? null : loadError);
  }

  function changed() {
    scheduleSave();
    o.onChange?.();
  }

  function scheduleSave() {
    if (!o.save || shuttingDown || saveTimer) return;
    saveTimer = setTimeout(saveState, saveDelayMs);
    saveTimer.unref();
  }

  function saveState() {
    saveTimer = null;
    const ids = new Set(restoreQueue);
    const terminalIds = {};
    for (const id of restoreQueue) {
      if (savedTerminalIds[id]) terminalIds[id] = savedTerminalIds[id];
    }
    for (const s of sessions.values()) {
      if (s.ended || s.piExitedAt || !RESTORABLE_MODES.has(s.mode) || !s.restore) continue;
      ids.add(s.id);
      terminalIds[s.id] = s.terminalId;
    }
    const data = {
      sessions: [...ids],
      ...(Object.keys(terminalIds).length && { terminalIds }),
    };
    const json = JSON.stringify(data);
    if (json === lastSaved) return;
    lastSaved = json;
    o.save(data);
  }

  // Starts `pi --session` for each terminal open when pi-kanban last stopped, headless like
  // startNew. A session that runs elsewhere or lost its transcript is dropped.
  function restore() {
    if (!restoreQueue.length || unavailableReason()) return;
    console.log(`Restoring ${restoreQueue.length} terminal(s)`);
    const next = async () => {
      while (restoreQueue.length && !shuttingDown) {
        const id = restoreQueue.shift();
        if (sessions.has(id) || o.isLiveElsewhere(id)) continue;
        const r = await start(id, 'resume', {}, HEADLESS_COLS, HEADLESS_ROWS);
        if (!r.error) break;
        console.log(`Could not restore terminal ${id}: ${r.error}`);
      }
      scheduleSave();
      if (restoreQueue.length && !shuttingDown) setTimeout(next, restoreGapMs).unref();
    };
    next();
  }

  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function sendOutput(ws, buf) {
    ws.unacked += buf.length;
    ws.send(buf);
  }

  function updateFlow(s) {
    let lagging = false;
    let drained = true;
    for (const ws of s.sockets) {
      if (ws.unacked > HIGH_WATER) lagging = true;
      if (ws.unacked > LOW_WATER) drained = false;
    }
    if (lagging && !s.paused) { s.paused = true; s.pty.pause(); }
    else if (drained && s.paused) { s.paused = false; s.pty.resume(); }
  }

  // Waits for pi to turn on bracketed paste (its TUI is live), then for the screen to
  // settle. A project-trust question also takes input, and Enter there would answer it,
  // so the prompt waits for as long as that question is on screen.
  function bracketed(text) {
    return `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`;
  }

  // The folder and session names show on pi's main screen, so a "trust" in them is not the question.
  function onTrustScreen(s) {
    let text = screenText(s.term);
    for (const own of [path.basename(s.cwd), s.name]) if (own) text = text.split(own).join('');
    return /\btrust\b/i.test(text);
  }

  // Checked only while the session's first prompt waits, so it ends for good once the prompt is sent.
  function setAwaitingTrust(s, on) {
    if (s.awaitingTrust === on) return;
    s.awaitingTrust = on;
    changed();
  }

  // `submit` is pi's prompt: wait for its input box, then press Enter. Without it the text
  // is the pi command typed at the shell prompt once the shell's startup output settles,
  // and Enter is left to the user; bracketed paste keeps a prompt's line breaks from running
  // the command early (checked in Git Bash and pwsh).
  function queueText(s, raw, submit) {
    let armed = !submit;
    let timer = null;
    const text = bracketed(raw);
    s.onOutput = (data) => {
      if (submit) {
        const on = data.lastIndexOf('\x1b[?2004h');
        const off = data.lastIndexOf('\x1b[?2004l');
        if (on !== off) armed = on > off;
      }
      clearTimeout(timer);
      if (!armed) return;
      timer = setTimeout(() => {
        if (s.exited) return;
        if (submit && onTrustScreen(s)) return setAwaitingTrust(s, TRUST_DIALOG.test(screenText(s.term)));
        setAwaitingTrust(s, false);
        s.onOutput = null;
        s.pty.write(text);
        if (submit) setTimeout(() => submitPrompt(s), 100);
      }, PROMPT_QUIET_MS);
    };
  }

  // A TUI can drop the Enter after the paste and leave the prompt typed but not sent. The pi
  // extension bumps statusUpdatedAt in the registry entry when a turn starts, so while the entry
  // stays idle and older than the Enter, Enter is pressed again. Only an idle entry gets it: a turn
  // that started can show a question, and Enter there would pick its default.
  function submitPrompt(s) {
    if (s.exited) return;
    let at = Date.now();
    let checks = 0;
    let retries = 0;
    s.pty.write('\r');
    s.submitTimer = setInterval(() => {
      const entry = ownEntry(o.liveSessions(), s, s.startedAt);
      const unsent = !s.exited && entry?.status === 'idle' && typeof entry.statusUpdatedAt === 'number' && entry.statusUpdatedAt < at;
      if (!unsent || (++checks === SUBMIT_CHECKS && retries === SUBMIT_RETRIES)) return clearInterval(s.submitTimer);
      if (checks < SUBMIT_CHECKS) return;
      checks = 0;
      retries++;
      at = Date.now();
      s.pty.write('\r');
    }, submitPollMs);
    s.submitTimer.unref();
  }

  // The process a viewer types into: pi, found through its registry entry, or the shell.
  function inputPid(s, registry) {
    if (s.mode === 'shell') return s.pty.pid;
    if (s.piExitedAt) return null;
    if (s.piPid || s.mode === 'pick') return s.piPid;
    const live = registry || o.liveSessions();
    s.piPid = ownEntry(live, s, s.startedAt)?.pid;
    return s.piPid;
  }

  // pi deletes its registry entry on exit, and a crash leaves one with a dead pid. A terminal
  // with no pid yet is still starting. Matching by pid keeps a /new, /resume or /fork, which
  // rewrite the entry's sessionId, from reading as an exit.
  function checkExits() {
    const watched = [...sessions.values()].filter((s) => !s.exited && !s.ended && s.mode !== 'shell');
    if (!watched.length) return;
    const live = o.liveSessions();
    let moved = false;
    for (const s of watched) {
      if (s.piExitedAt) {
        const back = ownEntry(live, s, s.piExitedAt);
        if (!back || !pidAlive(back.pid)) continue;
        s.piExitedAt = null;
        s.piPid = back.pid;
        moved = true;
        continue;
      }
      const had = s.piPid;
      const pid = inputPid(s, live);
      // An edit terminal starts pi whenever the user presses Enter, after syncBoost stopped looking.
      if (pid && pid !== had) syncBoost(s);
      if (!pid) continue;
      const entry = live.find((l) => l.pid === pid);
      if (entry && pidAlive(pid)) {
        if (entry.sessionId !== s.id && s.mode !== 'pick' && !s.resumeOf) followSession(s, entry.sessionId);
        continue;
      }
      s.piExitedAt = Date.now();
      s.piPid = null;
      moved = true;
    }
    if (moved) changed();
  }

  // A resumed transcript keeps its own id, which is not the PTY's.
  function ownEntry(live, s, since) {
    const sid = s.resumeOf || s.id;
    return live.find((l) => l.pid && l.sessionId === sid && l.startedAt >= since - PICK_START_SLACK_MS);
  }

  // pi writes its registry entry a moment after it starts, so the pid is polled for.
  function syncBoost(s) {
    const want = s.sockets.size > 0 && !s.exited;
    if (want && !s.boost) {
      if (s.boostTimer) return;
      let tries = 0;
      const tryBoost = () => {
        const pid = inputPid(s);
        if (!pid && ++tries < BOOST_TRIES) return;
        clearInterval(s.boostTimer);
        s.boostTimer = null;
        if (!pid) return;
        const before = priority.raise(pid);
        s.boost = { pid, before };
      };
      s.boostTimer = setInterval(tryBoost, PICK_POLL_MS);
      tryBoost();
    } else if (!want) {
      clearInterval(s.boostTimer);
      s.boostTimer = null;
      if (s.boost && s.boost.before !== null && !s.exited) priority.restore(s.boost.pid, s.boost.before);
      s.boost = null;
    }
  }

  function spawnSession(id, mode, cwdCandidate, cols, rows, spec, extraEnv) {
    const cwd = cwdCandidate && fs.existsSync(cwdCandidate) ? cwdCandidate : os.homedir();
    const terminalId = savedTerminalIds[id] || crypto.randomUUID();
    const env = { ...ptyEnv({ piAgentDir: o.piAgentDir, pkUrl: o.serverUrl?.(), terminalId }), ...extraEnv };
    // Git Bash's login profile cds to $HOME unless this is set.
    if (shellFamily(shell) === 'gitbash') env.CHERE_INVOKING = '1';
    const piArgs = withTuiMode(piArgsFor(mode, id, spec));
    const proc = pty.spawn(shell, shellArgs(shell, spec?.edit ? null : piArgs), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
    const term = new Headless({ cols, rows, scrollback: config.scrollback, allowProposedApi: true, windowsPty: WINDOWS_PTY });
    const serializer = new Serialize();
    term.loadAddon(serializer);
    const s = {
      id, terminalId, mode, cwd, pty: proc, term, serializer, sockets: new Set(), exited: false, ended: false, paused: false, startedAt: Date.now(),
      name: spec?.name || null, onOutput: null, awaitingTrust: false, edit: !!spec?.edit,
      forkOf: spec?.forkOf || null, resumeOf: spec?.resume || null, restore: spec?.restore !== false,
    };
    trackCursor(s);
    if (s.edit) queueText(s, piCommand(shell, piArgs, spec.prompt), false);
    else if (spec?.prompt) queueText(s, spec.prompt, true);
    if (mode === 'pick') watchPick(s);

    proc.onData((data) => {
      term.write(data);
      if (s.onOutput) s.onOutput(data);
      if (!s.sockets.size) return;
      const buf = Buffer.from(data, 'utf8');
      for (const ws of s.sockets) if (ws.readyState === 1) sendOutput(ws, buf);
      updateFlow(s);
    });
    proc.onExit(({ exitCode }) => {
      s.exited = true;
      clearInterval(s.pickTimer);
      clearInterval(s.boostTimer);
      clearInterval(s.submitTimer);
      if (sessions.get(s.id) === s) sessions.delete(s.id);
      o.onExit?.(s.id);
      if (!s.ended) changed();
      for (const ws of s.sockets) {
        send(ws, { t: 'exit', code: exitCode, ended: s.ended });
        ws.close(1000);
      }
      term.dispose();
    });
    sessions.set(id, s);
    priority.raiseConsoleHosts();
    changed();
    return s;
  }

  // `pi --resume` opens its own picker, so the session is unknown until the user picks.
  // pi writes its registry entry once the picked session starts; the entry is found by folder
  // and start time, and the pick shows as an id with a transcript behind it.
  function watchPick(s) {
    s.pickTimer = setInterval(async () => {
      if (s.resolving) return;
      const live = o.liveSessions();
      const entry = s.piPid && live.find((l) => l.pid === s.piPid);
      if (!entry) {
        // pi left without a pick, or quit, and the PTY fell back to its shell.
        if (s.piPid) return clearInterval(s.pickTimer);
        const claimed = new Set([...sessions.values()].map((x) => x.piPid).filter(Boolean));
        s.piPid = findPickProcess(live, s, claimed);
        return;
      }
      const picked = entry.sessionId;
      if (picked === s.id) return;
      if (!(await hasTranscript(s, picked)) || s.mode !== 'pick') return;
      clearInterval(s.pickTimer);
      // Two pi processes on one session write the same transcript. When pi-kanban already runs it,
      // the pick is ended and its viewers move to that terminal; the sockets leave first so no
      // exit reaches them.
      if (sessions.has(picked)) {
        const sockets = [...s.sockets];
        s.sockets.clear();
        kill(s);
        for (const ws of sockets) send(ws, { t: 'rekey', id: picked, duplicate: true });
        return;
      }
      rekey(s, picked);
    }, PICK_POLL_MS);
  }

  // /new, /resume and /fork swap the session id under the same pi process. The terminal follows
  // once the new id has a transcript, so the new session's card holds it and the old one can end.
  async function followSession(s, id) {
    if (s.resolving || sessions.has(id)) return;
    if (!(await hasTranscript(s, id)) || s.ended || sessions.has(id)) return;
    rekey(s, id);
  }

  async function hasTranscript(s, id) {
    s.resolving = true;
    const known = await o.resolveCwd(id);
    s.resolving = false;
    return known !== null && !s.exited;
  }

  function rekey(s, id) {
    const elsewhere = o.isLiveElsewhere(id, s.piPid);
    const from = s.id;
    sessions.delete(from);
    s.id = id;
    s.mode = 'resume';
    sessions.set(id, s);
    o.onRekey?.(from, id);
    changed();
    for (const ws of s.sockets) send(ws, { t: 'rekey', id, elsewhere });
  }

  // The serialize addon replays modes but not cursor visibility. Without it a viewer that attaches
  // after pi hid the cursor draws xterm's cursor where pi parked it, past the end of a line.
  function trackCursor(s) {
    const dectcem = (shown) => (params) => {
      if (params.includes(25)) s.cursorHidden = !shown;
      return false;
    };
    s.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, dectcem(true));
    s.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, dectcem(false));
    s.term.parser.registerEscHandler({ final: 'c' }, () => {
      s.cursorHidden = false;
      return false;
    });
  }

  // Viewers of one PTY can differ in size, and a viewer pi draws for at another size keeps stale
  // rows. The PTY takes the size of the viewer that last attached, focused or typed, as tmux's
  // window-size latest does; another viewer's layout changes do not take it back.
  function claim(s, ws) {
    s.owner = ws;
    if (!ws.size) return;
    const { cols, rows } = ws.size;
    if (cols === s.term.cols && rows === s.term.rows) return;
    s.pty.resize(cols, rows);
    s.term.resize(cols, rows);
  }

  function attach(ws, s, attached) {
    ws.unacked = 0;
    s.sockets.add(ws);
    syncBoost(s);
    // Before the snapshot, so it is serialized at the size the viewer writes it into.
    claim(s, ws);
    send(ws, { t: 'ready', attached });
    const snapshot = s.serializer.serialize() + (s.cursorHidden ? '\x1b[?25l' : '');
    if (snapshot) sendOutput(ws, Buffer.from(snapshot, 'utf8'));

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (s.exited) return;
      if (msg.t === 'in' && typeof msg.d === 'string') {
        if (s.owner !== ws) claim(s, ws);
        s.pty.write(msg.d);
      } else if (msg.t === 'resize') {
        ws.size = { cols: clampDim(msg.cols, s.term.cols), rows: clampDim(msg.rows, s.term.rows) };
        if (msg.claim || !s.owner || s.owner === ws) claim(s, ws);
      } else if (msg.t === 'ack' && Number.isFinite(msg.n)) {
        ws.unacked = Math.max(0, ws.unacked - msg.n);
        updateFlow(s);
      } else if (msg.t === 'kill') kill(s);
    });
    ws.on('close', () => {
      s.sockets.delete(ws);
      syncBoost(s);
      if (s.exited) return;
      updateFlow(s);
      if (s.owner !== ws) return;
      const next = [...s.sockets].at(-1);
      if (next) claim(s, next);
      else s.owner = null;
    });
  }

  async function onHello(ws, msg) {
    if (!msg || msg.t !== 'hello' || !tokenMatches(token, msg.token)) {
      send(ws, { t: 'error', msg: 'The terminal token is out of date. Reload the board.' });
      return ws.close(4001);
    }
    const id = msg.id;
    const mode = MODES.has(msg.mode) ? msg.mode : null;
    if (typeof id !== 'string' || !UUID_RE.test(id) || !mode) {
      send(ws, { t: 'error', msg: 'invalid session id or mode' });
      return ws.close(4002);
    }
    const cols = clampDim(msg.cols, 80);
    const rows = clampDim(msg.rows, 24);
    ws.size = { cols, rows };

    // An ended PTY stays in the map until its process exits; a hello for its id starts a new one.
    const existing = sessions.get(id);
    if (existing && !existing.ended) return attach(ws, existing, true);

    if (mode === 'auto' && o.isLiveElsewhere(id)) {
      send(ws, { t: 'live' });
      return ws.close(1000);
    }
    const r = await start(id, mode, msg, cols, rows);
    if (r.running) return attach(ws, r.running, true);
    if (r.error) {
      send(ws, { t: 'error', msg: r.error });
      return ws.close(r.code);
    }
    // The viewer left while the PTY started; it runs headless until the next attach.
    if (ws.readyState !== 1) return;
    attach(ws, r.session, false);
  }

  // The admission rules shared by the socket hello and startNew. A refusal carries both a
  // WebSocket close code and an HTTP status, so each caller maps it its own way.
  // resolveCwd and isAllowedFolder may answer later, so the limits are checked again after them.
  async function start(id, mode, msg, cols, rows, extraEnv) {
    const full = { code: 4003, status: 429, error: `${config.maxSessions} terminals are open; end one first` };
    if (sessions.size >= config.maxSessions) return full;
    let spec = null;
    if (mode === 'new') {
      spec = parseNewSpec(msg);
      if (typeof spec === 'string') return { code: 4002, status: 400, error: `invalid ${spec}` };
      if (spec.resume && o.isLiveElsewhere(spec.resume)) {
        return { code: 4006, status: 409, error: 'the session to resume is running in another terminal' };
      }
      if (spec.edit && spec.prompt && shellFamily(shell) === 'cmd') {
        return { code: 4002, status: 400, error: 'cmd cannot take a typed prompt; clear the prompt or set the terminal shell to pwsh or gitbash' };
      }
    }
    // A fork runs in its parent's folder, where `pi --fork` finds the parent first.
    const [known, forkCwd] = await Promise.all([o.resolveCwd(id), spec?.forkOf ? o.resolveCwd(spec.forkOf) : null]);
    let cwd = known;
    if (mode === 'new' || mode === 'pick') {
      if (known !== null) return { code: 4006, status: 409, error: 'session id already in use' };
      cwd = spec?.forkOf ? forkCwd : msg.cwd;
      if (spec?.forkOf && cwd === null) return { code: 4004, status: 404, error: 'unknown session to fork' };
      if (!spec?.forkOf && (typeof cwd !== 'string' || !(await o.isAllowedFolder(cwd)))) {
        return { code: 4004, status: 404, error: 'folder does not exist' };
      }
    } else if (mode !== 'shell' && known === null) {
      return { code: 4004, status: 404, error: 'unknown session' };
    }
    if (shuttingDown) return { code: 1001, status: 503, error: 'the terminal is shutting down' };
    const running = sessions.get(id);
    if (running && !running.ended) return { running, code: 4006, status: 409, error: 'session id already in use' };
    if (sessions.size >= config.maxSessions) return full;
    try {
      return { session: spawnSession(id, mode === 'auto' ? 'resume' : mode, cwd, cols, rows, spec, extraEnv) };
    } catch (e) {
      return { code: 4005, status: 500, error: `failed to start the shell: ${e.message}` };
    }
  }

  function handleUpgrade(req, socket, head) {
    if (refuseUpgrade(req, socket, () => unavailableReason() || net.upgradeVerdict(req))) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const timer = setTimeout(() => ws.close(4001), HELLO_TIMEOUT_MS);
      ws.once('message', (raw, isBinary) => {
        clearTimeout(timer);
        let msg = null;
        if (!isBinary) { try { msg = JSON.parse(raw.toString()); } catch { /* treated as bad hello */ } }
        onHello(ws, msg).catch((e) => {
          send(ws, { t: 'error', msg: `failed to start the terminal: ${e.message}` });
          ws.close(1011);
        });
      });
      ws.on('error', () => {});
    });
  }

  function clientConfig() {
    return clientConfigFor(config, !unavailableReason());
  }

  // kill() returns before the process is gone, so an ended session leaves list() at once.
  function kill(s) {
    s.ended = true;
    s.pty.kill();
    changed();
  }

  function list() {
    return [...sessions.values()].filter((s) => !s.ended).map((s) => ({
      id: s.id, terminalId: s.terminalId, mode: s.mode, cwd: s.cwd, pid: s.pty.pid, clients: s.sockets.size, startedAt: s.startedAt,
      name: s.name, edit: s.edit, forkOf: s.forkOf, piExited: !!s.piExitedAt, awaitingTrust: s.awaitingTrust,
    }));
  }

  function piPids() {
    const out = {};
    const live = sessions.size ? o.liveSessions() : [];
    for (const s of sessions.values()) {
      if (s.ended || s.exited || s.mode === 'shell') continue;
      const pid = inputPid(s, live);
      if (pid) out[s.id] = pid;
    }
    return out;
  }

  function isRunning(id) {
    const s = sessions.get(id);
    return !!s && !s.ended;
  }

  function authorized(providedToken) {
    return tokenMatches(token, providedToken);
  }

  // Same token as the WebSocket hello: ending a terminal kills a running pi process.
  function end(id, providedToken) {
    if (!authorized(providedToken)) return 'auth';
    const s = sessions.get(id);
    if (!s) return 'not-found';
    kill(s);
    return null;
  }

  // A 'new' session for a caller with no socket. The PTY runs headless until a browser
  // attaches, and a later attach resizes it.
  async function startNew(msg, extraEnv) {
    const reason = unavailableReason();
    if (reason) return { status: 403, error: reason };
    if (msg.id != null && !(typeof msg.id === 'string' && UUID_RE.test(msg.id))) return { status: 400, error: 'invalid session id' };
    const r = await start(msg.id || crypto.randomUUID(), 'new', msg, HEADLESS_COLS, HEADLESS_ROWS, extraEnv);
    return r.error ? r : { id: r.session.id, cwd: r.session.cwd };
  }

  // Pastes into pi's input box and stops there: Enter would also submit whatever the
  // user had half-typed, and over a permission dialog it would answer it. A pending queued
  // prompt owns the input box until it is sent.
  function paste(id, text) {
    const s = sessions.get(id);
    if (!s || s.ended || s.exited || s.piExitedAt || s.onOutput || s.mode === 'shell') return false;
    if (onTrustScreen(s)) return false;
    // Until the user runs the typed command, the input box is the shell's command line.
    if (s.edit && !s.piPid) return false;
    s.pty.write(bracketed(text));
    return true;
  }

  function shutdown() {
    shuttingDown = true;
    clearTimeout(saveTimer);
    clearInterval(exitTimer);
    // On Windows pty.kill() returns before the tree is gone, and the host exits right after
    // shutdown, so pi outlived it. One synchronous tree kill ends every session first.
    const pids = [...sessions.values()].map((s) => s.pty.pid).filter(Boolean);
    if (process.platform === 'win32' && pids.length) {
      spawnSync('taskkill', ['/f', '/t', ...pids.flatMap((pid) => ['/pid', String(pid)])], { windowsHide: true, stdio: 'ignore' });
    }
    for (const s of sessions.values()) {
      try { s.pty.kill(); } catch { /* already gone */ }
    }
    sessions.clear();
  }

  return { token, handleUpgrade, clientConfig, list, piPids, isRunning, end, authorized, startNew, paste, restore, shutdown, unavailableReason };
}

module.exports = { createTerminalService, readTerminalConfig, localUnavailableReason, refuseUpgrade, clientConfigFor, ptyEnv, shellArgs, piCommand, resolveShell, piArgsFor, withTuiMode, windowsPtyFor, parseNewSpec, findPickProcess, tokenMatches };
