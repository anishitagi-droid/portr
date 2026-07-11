import { getPort, killPort, getKillableEntries, killEntries } from '../core/ports.js';
import { reportKill, reportKillAll, reportKillAllPreview, reportError } from '../output/reporter.js';
import { assertSupported } from '../core/platform.js';
import { startTimer, sleep } from '../utils/timer.js';
import { parsePort, parseExceptList } from '../utils/validate-port.js';
import chalk from 'chalk';
import readline from 'readline';

export async function killCommand(ports, opts) {
  try { assertSupported(); } catch (e) { reportError(e.message); process.exit(1); }

  if (opts.all) {
    return killAll(opts);
  }

  if (!ports.length) {
    reportError('Specify at least one port, or use --all.', 'Usage: portr kill 3000  ·  portr kill --all');
    process.exit(1);
  }

  // Validate all ports are strictly-numeric before touching any of them
  const parsed = [];
  for (const p of ports) {
    const n = parsePort(p);
    if (n === null) {
      reportError(`Invalid port: ${p}`, 'Ports must be whole numbers between 1 and 65535.');
      process.exit(1);
    }
    parsed.push(n);
  }

  let anyError = false;

  for (const port of parsed) {
    const timer = startTimer();
    const entry = getPort(port);

    if (!entry) {
      reportKill(port, null, [], { elapsed: timer.stop() });
      continue;
    }

    try {
      const killed = killPort(port, { force: opts.force });
      reportKill(port, entry, killed, { elapsed: timer.stop(), force: opts.force });

      // Wait briefly and verify the port is actually free
      if (killed.length && opts.verify !== false) {
        await sleep(300);
        const stillUp = getPort(port);
        if (stillUp && !opts.force) {
          reportError(
            `Port ${port} still occupied after SIGTERM`,
            `Run: portr kill ${port} --force  to send SIGKILL`
          );
          anyError = true;
        }
      }
    } catch (e) {
      reportError(e.message);
      anyError = true;
    }
  }

  process.exit(anyError ? 1 : 0);
}

// ── portr kill --all ─────────────────────────────────────────────────────────
async function killAll(opts) {
  const timer = startTimer();

  const except = parseExceptList(opts.except);
  if (!except.valid) {
    reportError(
      `Invalid port in --except: "${except.badEntry}"`,
      'Fix the --except list before running --all — refusing to guess which ports you meant to protect.'
    );
    process.exit(1);
  }

  let killable, unresolvable;
  try {
    ({ killable, unresolvable } = getKillableEntries({
      includeSystem: opts.includeSystem || false,
      exceptPorts: except.ports,
    }));
  } catch (e) {
    reportError(e.message);
    process.exit(1);
  }

  reportKillAllPreview(killable, unresolvable, { includeSystem: opts.includeSystem, dryRun: opts.dryRun });

  if (!killable.length) process.exit(unresolvable.length ? 1 : 0);
  if (opts.dryRun) process.exit(0);

  if (!opts.yes) {
    const confirmed = await confirmPrompt(
      `  Kill ${killable.length} port${killable.length !== 1 ? 's' : ''}? This cannot be undone. [y/N] `
    );
    if (!confirmed) {
      console.log(chalk.dim('\n  Cancelled — no ports were killed.\n'));
      process.exit(1);
    }
  }

  const results = killEntries(killable, { force: opts.force || false });
  reportKillAll(results, { elapsed: timer.stop(), force: opts.force });

  const anyErrors = results.some(r => r.error && r.killed.length === 0);
  process.exit(anyErrors ? 1 : 0);
}

function confirmPrompt(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive shell (CI, piped input) — refuse to guess, require --yes
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
