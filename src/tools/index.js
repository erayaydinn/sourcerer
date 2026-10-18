import { read_file, write_file } from './files.js';
import { find_symbol, search_code, search_docs } from './search.js';
import { run_command } from './command.js';
import { web_fetch } from './web.js';
import { truncate } from './sandbox.js';

// web_search has no implementation for API agents yet; it is skipped here.
const TOOLS = { read_file, write_file, run_command, search_code, find_symbol, search_docs, web_fetch };

export function toolSpecs(names) {
  return names
    .filter((name) => TOOLS[name])
    .map((name) => ({ name, description: TOOLS[name].description, parameters: TOOLS[name].parameters }));
}

// Never throws: errors are returned to the model as text.
export async function runTool(name, args, ctx) {
  try {
    if (!ctx.allowedTools.includes(name) || !TOOLS[name]) throw new Error(`tool not allowed: ${name}`);
    return truncate(String(await TOOLS[name].run(args, ctx)), ctx.toolConfig.maxOutputChars);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
