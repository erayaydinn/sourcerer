import { createInterface } from 'node:readline';
import { createSession } from '../ui/session.js';

// Plain-text REPL over the shared session (used when not on a TTY, or with --plain).
export function startRepl({ rootFlag, input = process.stdin, output = process.stdout, run } = {}) {
  const rl = createInterface({ input, output, prompt: 'sourcerer> ' });
  const print = (line) => output.write(`${line}\n`);
  let running = false;
  const session = createSession({
    rootFlag, print, run,
    hooks: {
      change: (snap) => {
        const finished = running && !snap.task;
        running = Boolean(snap.task);
        if (finished || snap.question) rl.prompt();
      },
    },
  });

  rl.on('line', async (line) => {
    if ((await session.handle(line)) === 'exit') return rl.close();
    if (!running) rl.prompt();
  });

  rl.on('SIGINT', () => {
    const result = session.interrupt();
    if (result === 'exit') process.exit(130);
    if (result === 'hint') {
      print('\n(Ctrl+C again to exit, or /exit)');
      rl.prompt();
    }
  });

  print('sourcerer: type a task, or /help');
  rl.prompt();
  return new Promise((resolve) => rl.on('close', resolve));
}
