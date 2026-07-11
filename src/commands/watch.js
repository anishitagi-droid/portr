import { getListeningPorts } from '../core/ports.js';
import { renderWatchFrame, reportError, isCI } from '../output/reporter.js';
import { assertSupported } from '../core/platform.js';

const DEFAULT_INTERVAL = 1500; // ms

export function watchCommand(opts) {
  try { assertSupported(); } catch (e) { reportError(e.message); process.exit(1); }

  if (isCI) {
    reportError('Watch mode requires an interactive terminal.');
    process.exit(1);
  }

  const interval = opts.interval ? parseInt(opts.interval, 10) : DEFAULT_INTERVAL;
  const udp      = opts.udp || false;
  const startedAt = Date.now();

  let prev = [];

  const render = () => {
    let entries;
    try {
      entries = getListeningPorts({ udp });
    } catch (e) {
      // Transient failure (e.g. tool momentarily unavailable) — keep showing
      // the last known state rather than crashing the whole watch session.
      renderWatchFrame(prev, { prevEntries: prev, startedAt });
      return;
    }
    renderWatchFrame(entries, { prevEntries: prev, startedAt });
    prev = entries;
  };

  render();
  const timer = setInterval(render, interval);

  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('');
    process.exit(0);
  });
}
