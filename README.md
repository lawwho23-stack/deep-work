# Deep Work

A local focus timer. **90 minutes of work, then a 5-minute break your screen enforces** — the
display goes black, shows only the countdown, and stays on top of everything until the break is
over. Then the next 90-minute block starts on its own.

No database, no accounts, no network, no settings file. It remembers nothing between runs.

## Run it

```bash
deep focus
```

From any directory, any terminal. Press **Start**, then minimise the window and work — the break
arrives by itself.

`deep` is a small script in `bin/deep`, linked into `~/.local/bin` (already on your PATH). It
hardcodes this folder's location, so if you move `deep-work/` somewhere else, edit `APP_DIR` at the
top of `bin/deep`.

First time only, or after pulling changes: `cd deep-work && npm install`.

## Stopping it

**`Ctrl+C` in the terminal you started it from.** Works in both phases, including mid-break, and
leaves nothing behind — verified through a real terminal.

Electron itself ignores `SIGINT`, so the `deep` script traps `Ctrl+C` in the shell and kills the app
outright. That is why you should start it with `deep focus` and not `npm start`: `npm start` stacks
two processes in front of the app, and `Ctrl+C` there can leave the real one running invisibly,
still blacking your screen every 90 minutes.

If you ever lose the terminal, from any other one:

```bash
deep stop
```

Closing the terminal window (`SIGHUP`) also takes the app with it.

## The break

When the break begins, a black window covers every display at the macOS `screen-saver` window
level. Measured with the window server: it sits at **layer 1001**, above app windows (0), the
Dock (20), the menu bar (24), Control Center (25) and Notification Center (25). **Notification
banners do not punch through it.**

**What it does not do:** it *covers* the screen, it does not *lock the keyboard*. Cmd+Tab still
switches apps underneath — you just cannot see or click them, so anything you type goes into an
invisible window. This is a discipline tool, not a kiosk lock.

There is **no normal way to end a break early.** That is the point.

## The two emergency exits

For a bug, or a real emergency. Both live in the main process, so they still work if the black
screen's page has crashed.

| Exit | What it does |
|---|---|
| **Hold `Esc` for 5 seconds** | Quits the whole app. A quick tap does nothing — verified. A thin bar fills along the bottom while you hold, so you can see it working. |
| **`Cmd` + `Ctrl` + `Option` + `Q`** | Quits immediately. A global shortcut that needs no window at all — the dead-man switch if everything else is broken. |
| **`Ctrl+C`** in the terminal | Quits immediately, break or no break. Needs you to reach the terminal, which you cannot see during a break — but it works typed blind. |

An ordinary **Cmd+Q does not work during a break** (it does during work). This is done by removing
the Quit item from the menu bar for the duration of the break, not by blocking the quit itself —
blocking it also swallowed `Ctrl+C`, since Electron routes both down the same path.

## Settings

There is no settings screen. Change the durations with environment variables:

```bash
DEEPWORK_WORK_MS=3000000 deep focus     # 50-minute blocks instead of 90
DEEPWORK_BREAK_MS=600000 deep focus     # 10-minute breaks
```

| Variable | Default |
|---|---|
| `DEEPWORK_WORK_MS` | `5400000` (90 min) |
| `DEEPWORK_BREAK_MS` | `300000` (5 min) |
| `DEEPWORK_ESC_HOLD_MS` | `5000` (5 s) |
| `DEEPWORK_AUTOSTART` | `1` skips the Start click |

## Files

| File | What it is |
|---|---|
| `main.js` | Everything that matters: the clock, the phase, the black windows, the emergency exits |
| `preload.js` | The only bridge to the pages |
| `work.html` | The small work-phase window |
| `break.html` | The black screen |
| `verify.js` | Test scenarios, loaded only when `DEEPWORK_VERIFY` is set |
| `bin/deep` | The `deep focus` / `deep stop` launcher; traps `Ctrl+C` |

**The main process owns the clock and the teardown; the HTML pages only draw.** That split is the
whole safety story. If the "break is over" decision lived in the page and the page crashed, a black
window at screen-saver level would stay up forever and the Mac would be unusable behind it. A
watchdog also tears everything down and quits if the black screen's renderer dies or wedges.

Time is always `target - now` against an absolute timestamp, never an accumulated counter — a
counter stalls while the Mac sleeps, which would turn a 90-minute block into "however long the lid
was open". If the work target passed while asleep, waking goes straight to the break.

## Testing it without waiting 90 minutes

```bash
DEEPWORK_AUTOSTART=1 DEEPWORK_WORK_MS=4000 DEEPWORK_BREAK_MS=4000 deep focus
```

`DEEPWORK_VERIFY` drives the safety-critical paths that a script cannot press by hand:

```bash
DEEPWORK_VERIFY=shot:/tmp/x.png   # save what the break screen renders
DEEPWORK_VERIFY=esc-hold          # hold Escape and never release  -> must quit
DEEPWORK_VERIFY=esc-cancel        # tap Escape and release early   -> must NOT quit
DEEPWORK_VERIFY=crash             # kill the break screen's page   -> watchdog must quit
```

## What was verified, and what wasn't

Measured on macOS 26.0.1, single 1470×956 display, Electron 40.

Verified:

- The full loop runs unattended — 6+ consecutive work→break→work cycles.
- The break window sits at **layer 1001**, above every app window, the Dock, the menu bar,
  Control Center and Notification Center. **A posted notification stayed underneath it.**
- It covers an app running in **native fullscreen on its own Space** — the case a browser page or
  a Tkinter window cannot handle, and the reason this is an Electron app.
- It covers the full display including the menu bar strip (`1470x956@0,0`).
- **Hold Escape → quits. Tap Escape → does not.** Six consecutive breaks each survived a brief tap
  and ran to completion.
- Killing the break screen's renderer makes the watchdog tear everything down and quit.
- **`Ctrl+C` quits from a real terminal in both phases**, mid-break included, leaving zero processes
  behind. Tested through a pty, so the signal took the same path a keypress does.
- **Cmd+Q is genuinely disabled during a break**: the menu carries no Quit item while the break runs
  (`hasQuit=false`) and gets it back the moment work resumes.
- Freezing the app past its work target (a stand-in for the Mac sleeping) sends it **straight to
  the break** on resume, not into a stale countdown.

Not verified, and why:

- **A physically held Escape key and the real `Cmd+Ctrl+Opt+Q` chord.** macOS blocks scripted
  keystrokes without Accessibility permission, so both were driven through the real handlers with a
  synthetic key source instead. Everything downstream of the keypress is proven; press them once by
  hand to confirm the last inch.
- **Multi-display.** Only one display was attached. The code makes one window per display, but that
  path has not run against two.
- **A real `pmset` sleep**, as opposed to the freeze that stands in for it.
