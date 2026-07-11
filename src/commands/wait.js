import { getPort } from '../core/ports.js';
import { reportWaitStart, reportWaitTick, reportWaitDone, reportWaitTimeout, reportAlreadyFree, reportError } from '../output/reporter.js';
import { assertSupported } from '../core/platform.js';
import { startTimer, sleep } from '../utils/timer.js';
import { parsePort } from '../utils/validate-port.js';

const DEFAULT_TIMEOUT  = 30;   // seconds
const DEFAULT_INTERVAL = 500;  // ms between checks
const MIN_INTERVAL     = 50;   // ms — below this, polling starts hammering the OS port-list
                                // tool (ss/lsof) with a real subprocess spawn per check, which
                                // is a genuine resource cost, not just a cosmetic concern.

export async function waitCommand(port, opts) {
  try { assertSupported(); } catch (e) { reportError(e.message); process.exit(1); }

  const n = parsePort(port);
  if (n === null) {
    reportError(`Invalid port: ${port}`, 'Ports must be whole numbers between 1 and 65535.');
    process.exit(1);
  }

  // --timeout and --interval get the same treatment as port numbers: reject
  // malformed input with a clear error instead of silently producing NaN
  // (which previously caused "Timed out after NaNs" and a wait loop that
  // never actually ran) or a busy-loop (an --interval that parses to NaN or
  // near-zero causes setTimeout to fire near-instantly, hammering getPort()
  // — which shells out to a real subprocess — hundreds of times per second
  // for the whole duration of the wait).
  let timeout = DEFAULT_TIMEOUT;
  if (opts.timeout !== undefined) {
    const t = parseFloat(opts.timeout);
    if (isNaN(t) || t <= 0 || !/^\d+(\.\d+)?$/.test(String(opts.timeout).trim())) {
      reportError(`Invalid --timeout: ${opts.timeout}`, 'Must be a positive number of seconds.');
      process.exit(1);
    }
    timeout = t;
  }

  let interval = DEFAULT_INTERVAL;
  if (opts.interval !== undefined) {
    const i = parseInt(opts.interval, 10);
    if (isNaN(i) || i < MIN_INTERVAL || !/^\d+$/.test(String(opts.interval).trim())) {
      reportError(`Invalid --interval: ${opts.interval}`, `Must be a whole number of milliseconds, at least ${MIN_INTERVAL}.`);
      process.exit(1);
    }
    interval = i;
  }

  // Check immediately
  let entry;
  try { entry = getPort(n); } catch (e) { reportError(e.message); process.exit(1); }

  if (!entry) {
    if (!opts.quiet) reportAlreadyFree(n);
    process.exit(0);
  }

  if (!opts.quiet) reportWaitStart(n, entry);

  const timer    = startTimer();
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);

    let current;
    try { current = getPort(n); } catch { continue; }

    if (!current) {
      if (!opts.quiet) reportWaitDone(n, { elapsed: timer.stop() });
      process.exit(0);
    }

    if (!opts.quiet) reportWaitTick();
  }

  // Timed out
  if (!opts.quiet) reportWaitTimeout(n, timeout);
  process.exit(1);
}
