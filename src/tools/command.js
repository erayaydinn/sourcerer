import { execa } from 'execa';
import { gitDirOf, sandboxed } from '../core/sandbox.js';
import { commandAllowed } from '../core/security.js';

export const run_command = {
  description: 'Run an allowed command (no shell) in the workspace. Returns exit code and output.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['command'],
  },
  run: async ({ command, args = [] }, { cwd, readDirs = [], toolConfig, signal, security }) => {
    const { allow, timeoutSec } = toolConfig.runCommand;
    if (!allow.includes(command)) throw new Error(`command not allowed: ${command} (allowed: ${allow.join(', ')})`);
    const line = [command, ...args].join(' ');
    if (security?.commandAllowlist && !commandAllowed(line, security.allowCommands)) {
      throw new Error(`command not allowed: ${line} (allowed: ${security.allowCommands.join(', ')}; add more under security.extraCommands)`);
    }
    const [bin, binArgs] = sandboxed(command, args, { security, write: [cwd, gitDirOf(cwd)].filter(Boolean), read: readDirs });
    const result = await execa(bin, binArgs, { cwd, reject: false, all: true, timeout: timeoutSec * 1000, cancelSignal: signal });
    if (result.timedOut) return `timed out after ${timeoutSec}s\n${result.all}`;
    return `exit ${result.exitCode}\n${result.all}`;
  },
};
