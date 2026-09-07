# Phase 0 — VLC rc interface spike

Measured against **VLC 3.0.23 Vetinari** (Homebrew, Apple Silicon) on 2026-09-07.
Everything below is observed output, not documentation.

Launch line used by the app:

    vlc -I rc --no-video --quiet

## Protocol shape

* VLC prints a two-line banner, then `"> "` — the prompt is the **ready signal**.
* Every command is answered with zero or more `\r`-terminated lines, followed by `"> "`.
* That trailing prompt is a reliable **response terminator**, so commands can be
  queued and answered one at a time instead of guessing with timers.
* Commands that succeed silently (`pause`, `seek`, `stop`, `clear`, `volume N`)
  return *no* lines — only the prompt.

## Command results

| Command | Observed output | Notes |
|---|---|---|
| `add <path>` | *(none)* | Starts playing immediately. Unquoted paths **with spaces work** — rc takes the rest of the line. |
| `get_length` | `10` | Whole seconds. |
| `get_time` | `0` | Whole seconds. |
| `is_playing` | `1` / `0` | See the pause caveat below. |
| `volume` | `128` | Query form. Scale is **0–256**. |
| `volume 128` | *(none)* | Set form. |
| `pause` | *(none)* | A **toggle**, not a set. |
| `seek +3` | *(none)* | Relative seek works (2s → 5s). |
| `seek 30` | *(none)* | Absolute also works. |
| `stop` / `clear` | *(none)* | Both drop `is_playing` to 0. |
| `status` | `( new input: file://… )`<br>`( audio volume: 0 )`<br>`( state playing )` | State is `playing` \| `paused` \| `stopped`. |
| `quit` | `Shutting down.` | Child exits with code 0. |

## The three findings that shaped the design

**1. One VLC process is enough for the whole session.**
Booting with *no* file works (`is_playing` → 0), and `clear` + `add` switches
tracks inside the same process. No kill/spawn per song ⇒ the orphaned-child race
in the lab code cannot occur.

**2. `is_playing` returns `1` while PAUSED.**
Verified via `status` → `( state paused )` with `get_time` frozen at `1` across a
full second. So `stopped` is an **unambiguous end-of-track signal** — no risk of
mistaking a pause for a finished song. This is what makes auto-advance safe.

**3. At end of track, `get_time` returns an EMPTY line.**
Not `0`, not the length — nothing, with `is_playing` → `0`. The parser must treat
an empty response as "no time available" rather than coercing it to `0`
(`Number("")` is `0`, which would silently rewind the progress bar).

Also worth noting: **VLC stays alive after a track ends**, which is exactly what
the long-lived design needs.

## Consequences for `lib/player.js`

* Queue commands; resolve each on the next `"> "`; time out after 2s so a lost
  response can never wedge the queue.
* Poll `status` (state + volume) then `get_time` every 250 ms — VLC owns the
  clock, so there is no drifting local counter to stack up or leak.
* Only fire `ended` after playback has actually been observed, to ignore the
  brief `stopped` window between `add` and the first audio.

---

## Validated in implementation (phases 1-3)

Every assumption above survived contact with the running app:

* **The `"> "` terminator works as a response boundary.** The command queue in
  `lib/player.js` resolves each request on the next prompt and has not desynced
  in testing. The 2s timeout has never needed to fire.
* **Pause really is frozen, not slowed.** Driving the app through a pty, the
  clock read `0:01` at pause and still `0:01` 1.2s later, then `0:03` after
  resume. This is what confirms finding #2 end-to-end: a paused track reports
  `playing`, so it can never be mistaken for a finished one.
* **`clear` + `add` switches tracks cleanly** inside the one process, and `ps`
  shows zero surviving `vlc -I rc` processes after quit.

### End-of-track path, proven in phase 4

Finding #3 — the empty `get_time` at end of track — is now exercised for real.
Letting `sample-10s.mp3` run to its natural end, the app rolled into the next
track by itself: the marker moved, total length switched `0:10` → `1:00`, and
the clock restarted from `0:00`. So `state === 'stopped'` after playback has
been observed is a sound `ended` trigger, and the empty `get_time` is correctly
read as "no time available" rather than being coerced to `0`.

Two negative cases matter just as much, and both hold:

* **The last track does not loop.** With a folder containing only the 10s file,
  the end of it reports `end of list` and stops — it does not restart.
* **A deliberate `stop` never auto-advances.** Pressing `x` mid-track clears
  the player and it stays cleared 4s later. Clearing `_sawPlayback` in `stop()`
  is what separates "the user stopped this" from "the song ended".
