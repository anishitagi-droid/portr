import { getListeningPorts } from '../core/ports.js';
import { reportList, reportError } from '../output/reporter.js';
import { assertSupported } from '../core/platform.js';
import { startTimer } from '../utils/timer.js';
import { parsePort } from '../utils/validate-port.js';

/**
 * Pure validation logic for --min/--max, extracted so it can be unit
 * tested directly rather than only through the full CLI command (which
 * calls process.exit() and can't easily be exercised in a test).
 *
 * @returns {{ valid: true, minPort: number|null, maxPort: number|null } | { valid: false, error: string, hint: string }}
 */
export function validatePortRange(minRaw, maxRaw) {
  let minPort = null, maxPort = null;

  if (minRaw !== undefined) {
    minPort = parsePort(minRaw);
    if (minPort === null) {
      return { valid: false, error: `Invalid --min: ${minRaw}`, hint: 'Must be a whole number between 1 and 65535.' };
    }
  }
  if (maxRaw !== undefined) {
    maxPort = parsePort(maxRaw);
    if (maxPort === null) {
      return { valid: false, error: `Invalid --max: ${maxRaw}`, hint: 'Must be a whole number between 1 and 65535.' };
    }
  }
  if (minPort !== null && maxPort !== null && minPort > maxPort) {
    return { valid: false, error: `--min (${minPort}) is greater than --max (${maxPort})`, hint: 'This range can never match anything.' };
  }

  return { valid: true, minPort, maxPort };
}

export function listCommand(opts) {
  try { assertSupported(); } catch (e) { reportError(e.message); process.exit(1); }

  // Validate --min/--max BEFORE fetching ports. A malformed value here
  // (e.g. --min abc) used to silently NaN-compare every entry to false,
  // producing "No listening ports found" even when ports genuinely were
  // listening — a filter typo made the machine look empty, with no
  // indication the filter itself was the problem.
  const range = validatePortRange(opts.min, opts.max);
  if (!range.valid) {
    reportError(range.error, range.hint);
    process.exit(1);
  }
  const { minPort, maxPort } = range;

  const timer = startTimer();
  let entries;

  try {
    entries = getListeningPorts({ udp: opts.udp || false });
  } catch (e) {
    reportError(e.message, 'Make sure lsof or ss is installed.');
    process.exit(1);
  }

  // Filter by process name if --grep given
  if (opts.grep) {
    const q = opts.grep.toLowerCase();
    entries = entries.filter(e => (e.name || '').toLowerCase().includes(q));
  }

  // Filter by port range
  if (minPort !== null) entries = entries.filter(e => e.port >= minPort);
  if (maxPort !== null) entries = entries.filter(e => e.port <= maxPort);

  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  reportList(entries, { elapsed: timer.stop(), udp: opts.udp });
}


