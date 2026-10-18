import { execa } from 'execa';

export const run_command = {
  description: 'Run an allowed command (no shell) in the workspace. Returns exit code and output.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['command'],
  },
  run: async ({ command, args = [] }, { cwd, toolConfig, signal }) => {
    const { allow, timeoutSec } = toolConfig.runCommand;
    if (!allow.includes(command)) throw new Error(`command not allowed: ${command} (allowed: ${allow.join(', ')})`);
    const result = await execa(command, args, { cwd, reject: false, all: true, timeout: timeoutSec * 1000, cancelSignal: signal });
    if (result.timedOut) return `timed out after ${timeoutSec}s\n${result.all}`;
    return `exit ${result.exitCode}\n${result.all}`;
  },
};
