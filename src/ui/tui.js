import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { createElement as h, useMemo, useRef, useState } from 'react';
import { defaultWorkspace } from '../cli/root.js';
import { COMMANDS, createSession } from './session.js';

const MAX_LINES = 5000;
const ICONS = { waiting: '·', running: '●', ok: '✓', failed: '✗' };
const append = (list, text) => [...list, ...String(text).split('\n')].slice(-MAX_LINES);
const AGENT_PANEL = 36;

// Splits long lines to the panel width so nothing is cut off (and the panel height stays right).
export function wrapLines(lines, width) {
  return lines.flatMap((line) => {
    if (line.length <= width) return [line];
    const parts = [];
    for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width));
    return parts;
  });
}

export function historyFile() {
  return join(defaultWorkspace(), 'history');
}

function loadHistory(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200);
  } catch {
    return [];
  }
}

function saveHistory(file, entries) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${entries.slice(-200).join('\n')}\n`);
  } catch {
    // history is a convenience; never fail the session over it
  }
}

// Full-screen-ish TUI over the shared session. Logic lives in session.js; this only draws and reads keys.
export function App({ rootFlag, run, history: historyPath = historyFile(), onExit = () => {} }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [lines, setLines] = useState(['sourcerer: type a task, or /help']);
  const [agents, setAgents] = useState({});
  const [agentLogs, setAgentLogs] = useState({});
  const [runInfo, setRunInfo] = useState({ round: 0, totalUsd: 0, totalTokens: 0, unknown: 0 });
  const [snap, setSnap] = useState({ task: null, question: null, hint: null, overrides: [] });
  const [input, setInputState] = useState('');
  const inputRef = useRef('');
  const setInput = (value) => {
    inputRef.current = typeof value === 'function' ? value(inputRef.current) : value;
    setInputState(inputRef.current);
  };
  const [view, setView] = useState('events');
  // Per view: the first shown line while scrolled up; no entry means follow the end.
  const [scroll, setScroll] = useState({});
  const history = useRef(existsSync(historyPath) ? loadHistory(historyPath) : []);
  const cursor = useRef(null);

  const print = (text) => setLines((list) => append(list, text));

  const session = useMemo(() => createSession({
    rootFlag, run, print,
    hooks: {
      change: setSnap,
      task: ({ agents: names, bus }) => {
        setAgents(Object.fromEntries(names.map((name) => [name, { status: 'waiting', costUsd: 0 }])));
        setAgentLogs({});
        setRunInfo({ round: 0, totalUsd: 0, totalTokens: 0, unknown: 0 });
        const update = (name, fields) => setAgents((all) => ({ ...all, [name]: { ...all[name], ...fields(all[name] ?? {}) } }));
        bus.on('agent.started', (e) => {
          update(e.agent, () => ({ status: 'running', round: e.round, llm: e.llm }));
          setRunInfo((info) => ({ ...info, round: Math.max(info.round, e.round) }));
        });
        bus.on('agent.finished', (e) => {
          update(e.agent, (a) => ({ status: e.status, costUsd: (a.costUsd ?? 0) + (e.costUsd ?? 0) }));
          if (e.costSource === 'unknown') setRunInfo((info) => ({ ...info, unknown: info.unknown + 1 }));
        });
        bus.on('agent.log', (e) => setAgentLogs((all) => ({ ...all, [e.agent]: append(all[e.agent] ?? [], e.line) })));
        bus.on('cost.updated', (e) => setRunInfo((info) => ({ ...info, totalUsd: e.totalUsd, totalTokens: e.totalTokens })));
      },
    },
  }), []); // one session per App

  const views = ['events', ...Object.keys(agents)];
  const leave = (code) => {
    saveHistory(historyPath, history.current);
    exit();
    onExit(code);
  };

  const submit = () => {
    const text = inputRef.current.trim();
    setInput('');
    cursor.current = null;
    if (!text) return snap.question ? session.handle('') : undefined; // Enter skips a planner question
    if (history.current.at(-1) !== text) history.current.push(text);
    print(`> ${text}`);
    session.handle(text).then((result) => {
      if (result === 'exit') leave(0);
    });
  };

  const browse = (step) => {
    const list = history.current;
    if (!list.length) return;
    const next = cursor.current === null ? (step < 0 ? list.length - 1 : null) : cursor.current + step;
    if (next === null || next >= list.length) {
      cursor.current = null;
      return setInput('');
    }
    cursor.current = Math.max(0, next);
    setInput(list[cursor.current]);
  };

  const tab = () => {
    const value = inputRef.current;
    if (value.startsWith('/') && !value.includes(' ')) {
      const matches = COMMANDS.filter((name) => name.startsWith(value.slice(1)));
      if (matches.length === 1) setInput(`/${matches[0]} `);
      else if (matches.length > 1) print(matches.map((m) => `/${m}`).join('  '));
      return;
    }
    setView(views[(views.indexOf(view) + 1) % views.length]);
  };

  const rows = stdout?.rows ?? 30;
  const textWidth = Math.max(20, (stdout?.columns ?? 100) - AGENT_PANEL - 4); // borders + padding
  const bodyHeight = Math.max(6, rows - 7 - (snap.question ? 1 : 0));
  const source = view === 'events' ? lines : agentLogs[view] ?? ['(no output yet)'];
  const wrapped = wrapLines(source, textWidth);
  const page = bodyHeight - 3;
  const lastTop = Math.max(0, wrapped.length - page);
  const top = scroll[view] === undefined ? lastTop : Math.min(scroll[view], lastTop);
  const shown = wrapped.slice(top, top + page);
  const below = wrapped.length - Math.min(wrapped.length, top + page);

  // Scrolling to the end (or past it) goes back to following new lines.
  const scrollTo = (next) => setScroll((all) => {
    const rest = { ...all };
    delete rest[view];
    return next >= lastTop ? rest : { ...rest, [view]: Math.max(0, next) };
  });

  useInput((text, key) => {
    if (key.ctrl && text === 'c') {
      const result = session.interrupt();
      if (result === 'exit') leave(snap.task ? 130 : 0);
      if (result === 'hint') print('(Ctrl+C again to exit, or /exit)');
      return;
    }
    if (key.return) return submit();
    if (key.upArrow) return browse(-1);
    if (key.downArrow) return browse(1);
    if (key.tab) return tab();
    if (key.pageUp) return scrollTo(top - Math.ceil(page / 2));
    if (key.pageDown) return scrollTo(top + Math.ceil(page / 2));
    if (key.home) return scrollTo(0);
    if (key.end) return scrollTo(lastTop);
    if (key.escape) return setInput('');
    if (key.backspace || key.delete) return setInput((value) => value.slice(0, -1));
    if (!text || key.ctrl || key.meta) return;
    // Pasted or fast input can arrive as one chunk ending in Enter: type the text, then submit.
    const [first, ...more] = text.split(/\r\n|\r|\n/);
    setInput((value) => value + first);
    if (more.length) submit();
  });

  const status = snap.task ? `running "${snap.task}" · round ${runInfo.round}` : 'idle';
  const unknown = runInfo.unknown ? ` (${runInfo.unknown} unknown)` : '';
  const overrides = snap.overrides.length ? ` · llm: ${snap.overrides.join(', ')}` : '';

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, ` sourcerer · ${status} · $${runInfo.totalUsd.toFixed(4)}${unknown} · ${runInfo.totalTokens.toLocaleString('en-US')} tok${overrides}`),
    h(Box, { height: bodyHeight },
      h(Box, { flexDirection: 'column', borderStyle: 'single', width: AGENT_PANEL, paddingX: 1 },
        h(Text, { dimColor: true }, 'agents'),
        ...Object.entries(agents).map(([name, a]) => h(Text, { key: name, inverse: view === name, wrap: 'truncate-end' },
          `${ICONS[a.status] ?? '?'} ${name.padEnd(15)} ${a.round === undefined ? '  ' : `r${a.round}`} ${a.costUsd ? `$${a.costUsd.toFixed(2)}` : ''}`)),
        Object.keys(agents).length ? null : h(Text, { dimColor: true }, '(no task yet)')),
      h(Box, { flexDirection: 'column', borderStyle: 'single', flexGrow: 1, paddingX: 1 },
        h(Text, { dimColor: true }, scroll[view] === undefined
          ? (view === 'events' ? 'events' : `${view} (live)`)
          : `${view} · ${below} newer line(s) below · End: live`),
        ...shown.map((line, i) => h(Text, { key: i }, line || ' ')))),
    snap.question ? h(Text, { color: 'yellow', wrap: 'wrap' }, ` ${snap.question} (${snap.hint})`) : null,
    h(Box, { borderStyle: 'round', paddingX: 1 }, h(Text, null, `> ${input}`), h(Text, { inverse: true }, ' ')),
    h(Text, { dimColor: true }, ' Enter run · ↑↓ history · Tab next view / complete /command · PgUp/PgDn scroll · Esc clear · /help · Ctrl+C stop, twice exit'));
}

export async function startTui({ rootFlag, run } = {}) {
  let code = 0;
  const app = render(h(App, { rootFlag, run, onExit: (c) => { code = c; } }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  return code;
}
