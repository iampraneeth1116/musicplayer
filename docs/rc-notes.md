# Talking to VLC: the `rc` interface

This player never controls audio with signals. It launches one VLC process and
sends it text commands, which is what makes pause, seek, volume and an accurate
progress bar possible at all.

This document records how that interface actually behaves. Everything here is
**observed output**, measured before the player was written and re-confirmed by
the finished app — not copied from documentation.

| | |
|---|---|
| Measured against | VLC **3.0.23 Vetinari** (Homebrew, Apple Silicon) |
| Date | 2026-09-07 |
| Launch line | `vlc -I rc --no-video --quiet` |

To reproduce any of it, run that launch line in a terminal and type the commands
by hand — you get the same prompt-and-response session the app drives
programmatically. Output *is* version-specific, so re-check it if VLC updates.

---

## 1. How the protocol works

VLC prints a two-line banner and then a `"> "` prompt. From there it is a
strict request/response loop:

```
> get_length
10
> get_time
3
> pause
> 
```

Three properties do all the work:

* **The prompt is the ready signal.** The first `"> "` means VLC has booted and
  is accepting commands. There is no need to guess with a startup timer.
* **The prompt is also the response terminator.** Every command is answered by
  zero or more `\r`-terminated lines, followed by `"> "`. Commands can therefore
  be queued and matched to their answers exactly, one at a time.
* **Success is often silent.** `pause`, `seek`, `stop`, `clear` and `volume N`
  return *no* lines at all — just the next prompt. Silence means success, not a
  lost response.

## 2. Command reference

| Command | Output | Notes |
|---|---|---|
| `add <path>` | *(none)* | Starts playing immediately. Unquoted paths **with spaces work** — rc takes the rest of the line as the path. |
| `get_time` | `3` | Whole seconds elapsed. Returns an **empty line** at end of track — see finding 3. |
| `get_length` | `10` | Whole seconds, total. |
| `is_playing` | `1` / `0` | Reports `1` while *paused* — see finding 2. |
| `status` | `( new input: file://… )`<br>`( audio volume: 0 )`<br>`( state playing )` | State is `playing` \| `paused` \| `stopped`. One call gives both state and volume. |
| `pause` | *(none)* | A **toggle**, not a set. |
| `seek +3` | *(none)* | Relative seek. Verified 2s → 5s. |
| `seek 30` | *(none)* | Absolute seek also works. |
| `volume` | `128` | Query form. Scale is **0–256**. |
| `volume 128` | *(none)* | Set form. |
| `stop` / `clear` | *(none)* | Both drop `is_playing` to `0`. |
| `quit` | `Shutting down.` | The child then exits with code 0. |

---

## 3. The three findings that shaped the design

Each of these changed how `lib/player.js` was written, and each has since been
confirmed by driving the finished app through a pseudo-terminal.

### Finding 1 — one VLC process is enough for the entire session

VLC boots happily with **no file** (`is_playing` → `0`), and `clear` + `add`
switches tracks *inside the same process*. It also stays alive after a track
ends rather than exiting.

**Why it matters.** The player never spawns or kills a process per song. Since
there is only ever one child, no slow `await` can finish late and leave a second,
untracked player running in the background — the orphaned-process bug in the
lab code becomes structurally impossible rather than merely guarded against.

**Confirmed:** track switching works cleanly in the running app, and `ps` reports
zero surviving `vlc -I rc` processes after quitting.

### Finding 2 — `is_playing` returns `1` while PAUSED

A paused track is still "playing" as far as `is_playing` is concerned. `status`
tells the truth: `( state paused )`, with `get_time` frozen.

**Why it matters.** This is the finding that makes auto-advance safe. Because
pause reports as playing, a `stopped` state is an **unambiguous end-of-track
signal** — the player can never mistake a paused song for a finished one and
skip ahead while the user is holding it.

**Confirmed:** driving the app through a pty, the clock read `0:01` at pause,
still `0:01` more than a second later, then `0:03` after resume. Frozen, not
merely slowed.

### Finding 3 — at end of track, `get_time` returns an EMPTY line

Not `0`, not the track length — nothing, alongside `is_playing` → `0`.

**Why it matters.** This is a trap: `Number("")` is `0` in JavaScript, so the
obvious parse would silently rewind the progress bar to the start at the exact
moment a song ends. An empty response has to be read as *"no time available"*,
which is a different thing from *zero*.

**Confirmed:** letting the 10s sample run to its natural end, the app advanced to
the next track — marker moved, length switched `0:10` → `1:00`, clock restarted
from `0:00`. The two negative cases hold too: the **last** track reports
`end of list` instead of looping, and a deliberate `x` (stop) does **not**
advance, because `stop()` clears the same flag that marks "playback was seen".

---

## 4. How `lib/player.js` uses all this

* **Commands are queued**, one in flight at a time, each resolved by the next
  `"> "`. A 2-second timeout resolves a lost response as empty so a dropped
  reply can never wedge the queue. (In testing it has never had to fire.)
* **VLC owns the clock.** Every 250 ms the player asks for `status` (state and
  volume in one call) and then `get_time`. There is no local counter to drift,
  stack up, or leak when a track ends.
* **`ended` fires only after playback has actually been observed**, which skips
  the brief `stopped` window between `add` and the first audio. Deliberately
  calling `stop()` clears that same flag, which is what distinguishes "the user
  stopped this" from "the song finished".

## 5. Limits

* Measured on one VLC version on macOS. The rc interface is stable in practice,
  but the exact strings are not a guaranteed API — treat section 2 as the thing
  to re-verify after a VLC upgrade.
* Times are whole seconds only, so the progress bar advances in 1-second steps.
* A file path containing a newline would break the `add` command, since rc reads
  the rest of the line as the path.
