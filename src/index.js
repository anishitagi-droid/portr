#!/usr/bin/env node

import { program } from 'commander';
import { createRequire } from 'module';
import { listCommand }  from './commands/list.js';
import { killCommand }  from './commands/kill.js';
import { checkCommand } from './commands/check.js';
import { waitCommand }  from './commands/wait.js';
import { watchCommand } from './commands/watch.js';

const req = createRequire(import.meta.url);
const pkg = req('../package.json');

program
  .name('portr')
  .description('Kill whatever is on your port')
  .version(pkg.version, '-v, --version')
  .addHelpText('after', `
Examples:
  portr                          List all listening ports
  portr list                     Same as above
  portr list --udp               Include UDP ports
  portr list --grep node         Filter by process name
  portr kill 3000                Kill whatever is on port 3000
  portr kill 3000 5000 8080      Kill multiple ports at once
  portr kill 3000 --force        Send SIGKILL instead of SIGTERM
  portr kill --all               Kill every non-system port (asks to confirm)
  portr kill --all --dry-run     Preview what --all would kill
  portr kill --all -y            Skip the confirmation prompt
  portr check 3000               Exit 0 if free, 1 if occupied
  portr check 3000 && npm start  Conditional start
  portr wait 3000                Block until port 3000 is free
  portr wait 3000 --timeout 60   Wait up to 60 seconds
  portr watch                    Live-updating port table
`);

// list (default)
program
  .command('list', { isDefault: true })
  .description('List all listening ports')
  .option('--udp',          'Include UDP ports')
  .option('--grep <name>',  'Filter by process name')
  .option('--min <port>',   'Only show ports >= this number')
  .option('--max <port>',   'Only show ports <= this number')
  .option('--json',         'Output as JSON')
  .action(listCommand);

// kill
program
  .command('kill [ports...]')
  .description('Kill the process(es) on the given port(s), or all with --all')
  .option('--force',            'Send SIGKILL instead of SIGTERM')
  .option('--no-verify',        'Skip post-kill verification')
  .option('--all',              'Kill every listening port (excludes system ports < 1024 by default)')
  .option('--include-system',   'With --all, also include system ports below 1024')
  .option('--except <ports>',   'With --all, comma-separated ports to exclude, e.g. 5432,6379')
  .option('--dry-run',          'With --all, show what would be killed without killing it')
  .option('-y, --yes',          'With --all, skip the confirmation prompt')
  .addHelpText('after', `
--all safety notes:
  - System ports below 1024 are excluded unless --include-system is passed
  - PID 1 is never targeted, regardless of flags (killing init crashes containers)
  - A confirmation prompt is always shown unless --yes is passed
  - In non-interactive shells (CI, piped input) --all requires --yes explicitly
`)
  .action(killCommand);

// check
program
  .command('check <port>')
  .description('Check if a port is free — exits 0 if free, 1 if occupied')
  .option('-q, --quiet',    'No output, just the exit code')
  .option('--json',         'Output as JSON')
  .action(checkCommand);

// wait
program
  .command('wait <port>')
  .description('Block until the port is free')
  .option('--timeout <s>',   'Give up after this many seconds (default: 30)')
  .option('--interval <ms>', 'How often to check in ms (default: 500)')
  .option('-q, --quiet',     'No output')
  .action(waitCommand);

// watch
program
  .command('watch')
  .description('Live-updating table of listening ports')
  .option('--udp',           'Include UDP ports')
  .option('--interval <ms>', 'Refresh interval in ms (default: 1500)')
  .action(watchCommand);

program.parseAsync(process.argv);
