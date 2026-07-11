import { getPort } from '../core/ports.js';
import { reportCheck, reportError } from '../output/reporter.js';
import { assertSupported } from '../core/platform.js';
import { startTimer } from '../utils/timer.js';
import { parsePort } from '../utils/validate-port.js';

export function checkCommand(port, opts) {
  try { assertSupported(); } catch (e) { reportError(e.message); process.exit(1); }

  const n = parsePort(port);
  if (n === null) {
    reportError(`Invalid port: ${port}`, 'Ports must be whole numbers between 1 and 65535.');
    process.exit(1);
  }

  const timer = startTimer();
  let entry;
  try {
    entry = getPort(n);
  } catch (e) {
    reportError(e.message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ port: n, free: !entry, entry: entry || null }, null, 2));
    process.exit(entry ? 1 : 0);
  }

  if (!opts.quiet) {
    reportCheck(n, entry, { elapsed: timer.stop() });
  }

  // Exit 0 = free, Exit 1 = in use  — makes it scriptable:
  // portr check 3000 && echo "starting server..." || echo "port taken"
  process.exit(entry ? 1 : 0);
}
