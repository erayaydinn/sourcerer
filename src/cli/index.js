#!/usr/bin/env node
// Checked before anything else is loaded: older Node versions fail inside dependencies
// (ink 8 needs Node 22) or print warnings such as "Importing JSON modules is an experimental feature".
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`sourcerer needs Node.js 22 or newer; this is ${process.versions.node} (${process.execPath}).`);
  console.error('Switch with `nvm use 22` (or open a new terminal if 22 is your nvm default), then run sourcerer again.');
  process.exit(1);
}

const { main } = await import('./main.js');
process.exit(await main());
