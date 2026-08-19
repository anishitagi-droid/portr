# portr

**Kill whatever is on your port.**

[![CI](https://github.com/anishitagi-droid/portr/actions/workflows/ci.yml/badge.svg)](https://github.com/anishitagi-droid/portr/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

You hit `EADDRINUSE`. You open a new terminal. You type `lsof -t -i:3000 | xargs kill -9` and get it wrong. Again.

`portr` fixes that.

```
$ portr

  │  PORT    PID     PROCESS     ADDRESS
  │  ─────────────────────────────────────
  │  3000    18291   node        0.0.0.0
  │  5173    19402   node        127.0.0.1
  │  6379    801     redis       127.0.0.1
  │  8080    22103   python      0.0.0.0

  4 ports listening  12ms
```

---

## Install

Not published to npm yet — the name `portr` is already taken by an
unrelated package, so publishing needs a different name first. For now,
run it from a local clone:

```bash
git clone https://github.com/anishitagi-droid/portr.git
cd portr
npm install
npm link          # puts `portr` on your PATH, pointing at this clone
```

Or run it directly without linking:

```bash
node src/index.js kill 3000
```

---

## Commands

| Command | Description |
|---|---|
| `portr list` | List all listening ports *(default)* |
| `portr kill <port...>` | Kill the process on a port |
| `portr check <port>` | Exit 0 if free, 1 if occupied |
| `portr wait <port>` | Block until the port is free |
| `portr watch` | Live-updating port table |

---

## `portr list`

```bash
portr                        # list all listening ports (default)
portr list                   # same
portr list --udp             # include UDP ports
portr list --grep node       # filter by process name
portr list --min 3000        # only ports >= 3000
portr list --max 9000        # only ports <= 9000
portr list --json            # JSON output
```

---

## `portr kill`

```bash
portr kill 3000              # kill whatever is on port 3000
portr kill 3000 5000 8080    # kill multiple ports at once
portr kill 3000 --force      # send SIGKILL instead of SIGTERM
```

`kill` sends SIGTERM by default, waits briefly, then tells you if the port is still occupied. Use `--force` for processes that ignore SIGTERM.

### `portr kill --all`

Kills every listening port on the machine in one shot. This is destructive and has real footguns, so it's built with several hard-coded safety rails that **cannot be disabled by any flag combination**:

```bash
portr kill --all                        # asks for confirmation first
portr kill --all --dry-run              # preview only, kills nothing
portr kill --all -y                     # skip the confirmation prompt
portr kill --all --include-system       # also allow ports below 1024
portr kill --all --except 5432,6379     # exclude specific ports (e.g. your DB)
portr kill --all --force -y             # SIGKILL everything, no prompt
```

**What `--all` will never touch, regardless of flags:**
- **PID 1** — killing init crashes containers and can panic some init systems. This is not hypothetical; it's the single most common way people would misuse this feature in Docker.
- **Ports below 1024** unless you explicitly pass `--include-system`. These are usually `sshd`, reverse proxies, or things a root process bound intentionally.

**What always happens unless you opt out:**
- A confirmation prompt listing every port that will die, before it dies.
- In a non-interactive shell (CI, a piped command, a script) the prompt can't be answered, so `--all` refuses to act unless `-y` is explicit. This is intentional — a script that silently kills every dev port on a shared CI runner is a worse outcome than a script that fails loudly.

**Output distinguishes four outcomes**, because "didn't kill it" means different things:
- `killed` — signal sent, process was actually running
- `already gone` — the process had already exited by the time we tried (not an error)
- `failed` — permission denied, usually needs `sudo`
- `skipped` — no PID could be resolved for that port at all

---

## `portr check`

Exits `0` if the port is free, `1` if occupied. Designed for scripts:

```bash

portr check 3000 && npm start        # only start if port is free
portr check 3000 || portr kill 3000  # kill if occupied
```

```bash
portr check 3000 --quiet   # no output, just the exit code
portr check 3000 --json    # structured output
```

---

## `portr wait`

Blocks the terminal until a port is free. Useful in startup scripts when you need to wait for a service to stop before starting another:

```bash
portr wait 3000                  # wait up to 30s (default)
portr wait 3000 --timeout 60     # wait up to 60s
portr wait 3000 --interval 250   # check every 250ms instead of 500ms
```

Exits `0` when the port becomes free, `1` if it times out.

---

## `portr watch`

Live-updating table. Refreshes every 1.5 seconds by default.

```bash
portr watch
portr watch --udp
portr watch --interval 500   # refresh every 500ms
```

- New ports appear with a `←new` marker for one frame.
- Closed ports show struck-through for 3 seconds before disappearing, so a port that flaps open/closed quickly is still visible.
- The header shows how long `watch` itself has been running.
- Redraws in place (moves the cursor up and clears) rather than doing a full screen clear, so your terminal's scrollback isn't wiped every frame.
- Requires a real interactive terminal — refuses to run under CI or when output is piped, since the redraw logic assumes a TTY.

---

## Scriptable exit codes

Every command has consistent, predictable exit codes:

| Command | Exit 0 | Exit 1 | Exit 2 |
|---|---|---|---|
| `list` | found ports | no ports | error |
| `kill <port>` | killed / not in use | kill failed | error |
| `kill --all` | all confirmed ports killed | cancelled, or at least one failed | error |
| `check` | port is **free** | port is **occupied** | error |
| `wait` | port became free | timed out | error |

---

## Platform support

| Platform | Tool used | Notes |
|---|---|---|
| macOS | `lsof` | Never tested against a real macOS machine — only Linux has actually been exercised. The `lsof` parser is unit-tested against fixtures shaped like documented `lsof` output, same caveat as Windows below, just less severe since the format is simpler and better understood. |
| Linux | `ss` (preferred) | Tested. Requires `iproute2` (present on most distros by default). |
| Linux fallback | `/proc/net/tcp` | Tested, including PID resolution. Zero dependencies. As with `ss`/`lsof`, PID resolution still depends on process ownership — see the note below. |
| Windows | — | **Not supported.** `assertSupported()` refuses to run on `win32`. There's a draft `netstat -ano` parser in `src/core/windows.js` that has never been run on a real Windows machine — see that file's header for exactly what would need verifying before it should be trusted. Use Task Manager or `netstat -ano` directly for now. |

### A real limitation worth knowing about, on any platform

Whether you can see a process's PID depends on whether you own that process (or are root). Run `portr list` as a regular user against a port owned by another user or by root, and that row will show a blank PID and process name — not because portr failed, but because the underlying OS tool (`ss`, `lsof`) won't tell an unprivileged caller who owns someone else's socket. `portr kill` on a PID-less port will correctly refuse ("no PID found, cannot kill") and `portr kill --all` will list it separately as unresolvable rather than silently skipping it or (worse) claiming it would be killed. If you hit this, the fix is `sudo`, not a portr bug report — though if the message doesn't make that clear, that itself would be a legitimate bug report.

---

## vs. the alternatives

| | portr | `kill-port` | `fkill-cli` | `lsof` directly |
|---|---|---|---|---|
| List all ports | ✓ | ✗ | ✗ | with flags |
| Kill by port | ✓ | ✓ | by name | manual |
| Kill multiple | ✓ | ✓ | ✓ | manual |
| Check if free | ✓ | ✗ | ✗ | manual |
| Wait for free | ✓ | ✗ | ✗ | script |
| Live watch | ✓ | ✗ | ✗ | ✗ |
| JSON output | ✓ | ✗ | ✗ | partial |
| macOS + Linux | ✓ | ✓ | ✓ | ✓ |
| Maintained | ✓ | ✗ | ✗ | built-in |

---

## License

MIT — see [LICENSE](LICENSE).
