# Changelog

## Unreleased

### Audited for dead code and unnecessary abstraction (no behavior change)
- Deleted `src/utils/errors.js` entirely — a custom `PortrError`/`PermissionError`
  class hierarchy that was never imported by anything. Every command actually
  handles errors via plain `Error` objects and `reportError()` calls; this file
  was written and never wired in.
- Un-exported `hasBin` (`platform.js`), `isCI` (`reporter.js`), and `PLATFORM`
  (`platform.js`) — each was only ever used internally within its own file,
  with zero external importers. `PLATFORM` in particular had one importer
  (`ports.js`) that turned out to import it and never actually reference it —
  a dead import on top of an unnecessary export.
- `watch.js` had its own inline copy of the exact CI/TTY detection check that
  `reporter.js` already exports as `isCI`. Now imports and uses the shared one.
- `ports.js` had `killPort` and `forceKillPort` as two separate functions
  differing only by a hardcoded signal string. Collapsed into one
  `killPort(port, { force })`.
- `reporter.js`'s `reportKillAllPreview` recomputed port/PID column widths
  inline instead of reusing the already-extracted `portTableWidths()` helper —
  a smaller-scale repeat of the exact duplication that helper was built to
  eliminate. Now reuses it.
- The "system ports excluded" message was hardcoded as the literal `1024` in
  two places in `reporter.js`, completely disconnected from the actual
  `SYSTEM_PORT_CEILING` constant in `ports.js`. If that ceiling ever changed,
  both messages would silently start lying. Now imports and uses the constant.
- `kill.js` and `wait.js` each had an identical one-line `sleep()` helper,
  copy-pasted rather than shared. Moved to `utils/timer.js` (already home to
  the other time-related utility) and imported in both places.
- `wait.js`'s "port already free" case was the one raw inline `console.log`
  in a file where every other message goes through `reporter.js` — the same
  inconsistency previously fixed in `kill.js`'s `killAll`. Added a proper
  `reportAlreadyFree()` (distinct from `reportWaitDone`, which assumes a
  waiting-in-progress line to break out of that this path never creates).
- `checkCommand`, `listCommand`, and `watchCommand` were all marked `async`
  with zero `await` anywhere in their bodies — a false signal that they do
  asynchronous work. Removed; `kill.js`'s `killCommand`/`killAll` and
  `wait.js`'s `waitCommand` genuinely await something and stayed `async`.
- Removed `parsePortDetailed` (`utils/validate-port.js`) and its 7 dedicated
  tests — a "reason code" variant of the port validator that was built,
  tested, and never once called by any real command.

### Refined (no behavior change — verified with the full test suite plus live re-checks of every safety-critical path: PID-1 protection, permission-restricted `--all`, normal kill, `--force`/SIGKILL, and cancellation)
- Removed `parsePortDetailed` — an unused "reason code" variant of the port
  validator that had its own dedicated tests but no actual caller anywhere in
  the codebase. Deleted along with its 7 tests; the real validator (`parsePort`)
  and its coverage are untouched.
- Collapsed `killPort`/`forceKillPort` — two functions in `ports.js` that were
  identical except for one hardcoded signal string — into a single
  `killPort(port, { force })`, matching the `{ force }` option style already
  used by `killEntries`.
- `reporter.js`: extracted `portTableWidths()`/`portTableHeader()` to
  eliminate an exact-duplicate column-width calculation and header-row
  construction that existed independently in both `reportList` and
  `renderWatchFrame`. A future change to how the PORT/PID/PROCESS/ADDRESS
  table looks now happens in one place instead of two that had to be
  hand-kept in sync.
- `kill.js`: `killAll()` was a single ~95-line function mixing input
  validation, safety filtering, raw `console.log`/chalk rendering, the
  confirmation gate, and execution all in one block — the only command in
  the codebase that rendered output directly instead of delegating to
  `reporter.js`. Split into:
  - `parseExceptList()` (`utils/validate-port.js`) — the `--except` parsing
    and fail-closed validation, now a pure, independently-tested function
  - `reportKillAllPreview()` (`output/reporter.js`) — the unresolvable-PID
    warning, kill preview table, and dry-run notice, now living alongside
    every other command's rendering instead of being the one exception
  - `killAll()` itself is now ~35 lines that read top-to-bottom as a single
    sequence: validate → look up killable ports → show preview → handle
    empty/dry-run → confirm → execute → report.

### Fixed (input validation — found by manually running the CLI with malformed input)
- **Every port argument was silently truncated instead of rejected.**
  `parseInt("3000.5", 10)` and `parseInt("3000abc", 10)` both return `3000` —
  parseInt stops at the first non-numeric character rather than failing. For
  a tool whose entire job is killing processes, this meant a typo or a bad
  string-interpolation bug in whatever script called `portr kill $PORT`
  would silently kill a real port instead of erroring out. Fixed with a new
  shared `parsePort()` validator (`src/utils/validate-port.js`) that requires
  the entire (trimmed) input to be digits, applied consistently across
  `check`, `kill`, and `wait` — all three had independently copy-pasted the
  same broken validation.
- **`kill --all --except` had the same bug, but worse: it's a safety
  exclusion list, not a target list.** A typo like `--except 54332` (meaning
  to protect port `5432`, a database) would previously either silently
  truncate or silently drop the malformed entry — either way, the port the
  user meant to protect would not actually be excluded. Fixed to fail closed:
  any unparseable entry in `--except` now aborts the entire `--all` operation
  with an error, before anything is touched, rather than proceeding with a
  partially-broken exclusion list.
- **`list --min`/`--max` with non-numeric input silently filtered out every
  listening port and reported "No listening ports found"** — a lie, since
  ports genuinely were listening. `parseInt('abc', 10)` is `NaN`, and
  `port >= NaN` is always `false`, so every entry failed the filter with zero
  indication the filter itself was malformed. Fixed with the same
  fail-loud validation, plus a new check that `--min` can't be greater than
  `--max` (an impossible range that would silently return nothing).
- **`wait --timeout`/`--interval` had no validation at all**, not even a NaN
  check. A garbage `--timeout` produced a wait loop whose exit condition
  (`Date.now() < deadline`) evaluated `Date.now() < NaN`, which is always
  `false` — so the loop body never ran even once, and the tool immediately
  reported the nonsensical "Timed out after NaNs" without ever actually
  checking the port. Separately, a garbage or near-zero `--interval` caused
  `setTimeout` to fire near-instantly, hammering `getPort()` — which spawns a
  real subprocess (`ss`/`lsof`) per call — hundreds of times per second for
  the whole wait duration. Fixed with explicit validation: `--timeout` must
  be a positive number, `--interval` must be a whole number of milliseconds
  with a 50ms floor to prevent the busy-loop.
- Removed a piece of dead code in `wait.js`: a redundant
  `await import('../utils/timer.js')` inside the "port already free" branch
  that shadowed the already-imported `startTimer` and was never used for
  anything.

### Added
- `portr kill --all` — kill every non-system listening port in one command
  - `--include-system` to also allow ports below 1024
  - `--except <ports>` to manually exclude specific ports (comma-separated)
  - `--dry-run` to preview without killing anything
  - `-y, --yes` to skip the confirmation prompt
  - Hard-coded safety rails that cannot be disabled by any flag: PID 1 is never
    targeted, and system ports (<1024) require an explicit opt-in
  - Refuses to act in non-interactive shells (CI, piped input) unless `-y` is
    passed explicitly — a script that silently kills every dev port on a shared
    runner is a worse failure mode than a script that errors out loudly
  - Output distinguishes 4 outcomes per port: killed, already gone (process had
    already exited — not treated as an error), failed (usually a permissions
    issue), and skipped (no PID could be resolved)

### Fixed
- `kill --all` could report a preview that overstated what it would actually
  do. When a port's PID can't be resolved by the OS — which happens whenever
  portr runs without enough privilege to see another user's (or root's)
  process — the port was not being excluded from the "killable" count. A
  dry-run would say "Would kill 3 ports" and include ports that could never
  actually be signaled, because there was no PID to send a signal to. Found
  by creating an actual unprivileged Linux user and running `kill --all`
  against a port owned by root; the dry-run preview was lying about what
  would happen. `getKillableEntries` now returns `{ killable, unresolvable }`
  and the unresolvable set is surfaced as an explicit warning ("no PID could
  be resolved — try sudo") before the kill count, rather than being silently
  folded into it.

### Experimental (unverified, not enabled)
- Added `src/core/windows.js` — a `netstat -ano` + `tasklist`-based parser
  intended as a starting point for real Windows support. **This has never
  been executed against a real Windows machine, a real `netstat` binary, or
  a real Windows process.** It is not wired into `assertSupported()`, which
  continues to refuse `win32` unconditionally. The accompanying tests in
  `test/unit/windows-draft.test.js` run against hand-typed fixtures based on
  Microsoft's documentation, not captured real output — they verify the code
  is internally consistent with what the format is believed to be, nothing
  more. Also worth knowing before anyone builds on this: Windows has no
  POSIX signals, so `SIGTERM` vs `SIGKILL` (portr's whole soft-kill/hard-kill
  model) doesn't mean anything there — Node's docs say both forcibly
  terminate on Windows. See the file header in `windows.js` for the full
  list of things that need real hardware to verify before this should be
  trusted.

### Changed
- `watch` no longer does a full-screen clear (`\x1b[2J`) between frames, which
  was wiping terminal scrollback on every refresh. It now moves the cursor up
  and clears only the previously-rendered block.
- `watch` now shows a running-time counter in the header and keeps closed ports
  visible with a strikethrough for 3 seconds before removing them, so a port
  that flaps open/closed between polling intervals doesn't just vanish.
- `kill --all`, when the user declines the confirmation prompt, now exits `1`
  instead of `0`. A declined action should not let `&&`-chained follow-up
  commands run as if the kill had succeeded.

### Fixed
- `kill --no-verify` was silently broken — commander maps `--no-verify` to
  `opts.verify` (defaulting `true`, becoming `false` when passed), not
  `opts.noVerify`. The old code checked a property that was always `undefined`,
  so the post-kill verification step never actually got skipped.
- The lsof output parser mis-split the `NAME` column. A line ending in
  `*:3000 (LISTEN)` was treated as a single last token (`(LISTEN)`) instead of
  the two tokens lsof actually emits, silently dropping every entry that had a
  state suffix. Fixed to reconstruct the NAME column from the last two tokens
  when a `(STATE)` suffix is present.
- `kill --all` used to report a process that had already exited (ESRCH) as
  "no resolvable PID — skipped," which is a different and more concerning
  failure mode than what actually happened. These are now reported separately
  as "already gone" and are not counted toward the failure exit code.
- An empty `Killed (0)` section header (with a dangling blank line under it)
  would render even when nothing was actually killed. Section headers are now
  only shown when they have at least one row to display.

## 1.0.0

### Added
- `portr list` — table of all listening ports with PID and process name. Filters: `--udp`, `--grep`, `--min`, `--max`, `--json`
- `portr kill <port...>` — kill one or more ports. Flags: `--force` (SIGKILL), `--no-verify`
- `portr check <port>` — exit 0 if free, 1 if occupied. Flags: `--quiet`, `--json`
- `portr wait <port>` — block until port is free. Flags: `--timeout`, `--interval`, `--quiet`
- `portr watch` — live-updating port table with change detection. Flags: `--udp`, `--interval`
- Cross-platform: macOS (`lsof`), Linux (`ss` preferred, `/proc/net/tcp` fallback)
- 19 parser unit tests
