# Terminal Music Player

A terminal music player written in plain Node.js — no npm dependencies. It
browses a folder of audio files and plays them through VLC, with a live
in-place TUI: cursor navigation, play/pause/stop, and a progress bar driven by
VLC's own clock.

```
 ♪  Terminal Music Player
──────────────────────────────────────────────────────────────────────────
    sample-10s.mp3                                                   0:10
 ▶  sample-speech-1m.mp3                                             1:00
    sample-speech-2m.mp3                                             1:00
──────────────────────────────────────────────────────────────────────────
 ▶   sample-speech-1m.mp3
 ███░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  0:03 / 1:00  vol 60%
──────────────────────────────────────────────────────────────────────────
 ↑↓ move · ⏎ play · space pause · x stop · n/b next/prev · q quit
```

## Requirements

* **Node.js** (no packages to install)
* **VLC** — `brew install vlc`. The player talks to it over its `rc` interface.
* **macOS** for song durations, which come from the built-in `afinfo`.
  Without it the list simply shows `--:--`; everything else still works.

## Running

```bash
node index.js                    # plays from ./songs
node index.js /path/to/music     # any other folder
node index.js --volume 0         # start muted (0-100, default 60)
```

It needs a real terminal — piping stdin exits with a message rather than
crashing in raw mode.

## Keys

| Key | Action |
|---|---|
| `↑` `↓` | move the cursor (wraps around) |
| `⏎` | play the highlighted song |
| `space` | pause / resume |
| `x` | stop |
| `n` `b` | next / previous (steps from the playing track, not the cursor) |
| `q` or `Ctrl-C` | quit |

Seek, volume, shuffle, repeat and filtering are planned — see *Status* below.
The on-screen help only ever lists keys that actually work.

## How it fits together

| File | Responsibility |
|---|---|
| `index.js` | app state, key bindings, startup and the single shutdown path |
| `lib/library.js` | **file handling** — scans the folder once, filters to audio, probes durations |
| `lib/player.js` | **process management** — the VLC child and its `rc` command protocol |
| `lib/ui.js` | **rendering** — one full-frame ANSI write per tick |
| `lib/keys.js` | **input** — raw stdin bytes into named key events |
| `lib/format.js` | small helpers (`m:ss`, truncate, pad) |

### Four decisions worth knowing

**One long-lived VLC process.** VLC starts once and tracks are switched with
`clear` + `add`, instead of spawning and killing a player per song. There is
never more than one child, so no async race can strand an orphan playing in the
background.

**VLC owns the clock.** Elapsed time comes from polling `get_time`, not from a
local `setInterval` counter. Nothing drifts, nothing double-counts, and there is
no timer to leak when a track ends.

**One writer to the screen.** Only `ui.render()` touches stdout, from a single
100 ms frame loop. No stray `console.log` can corrupt the display.

**One way out.** `q`, `Ctrl-C`, a signal, or an uncaught exception all funnel
through the same `shutdown()`, which quits VLC, restores cooked mode, unhides
the cursor and leaves the alternate screen buffer. Quitting never leaves music
playing behind it.

## Status

Built in phases, each with a checkpoint that had to actually run.

| Phase | Scope | State |
|---|---|---|
| 0 | VLC `rc` protocol spike → `docs/rc-notes.md` | ✅ done |
| 1 | library scan + static render | ✅ done |
| 2 | key decoding + navigation + clean exit | ✅ done |
| 3 | play / pause / stop / next / prev | ✅ done |
| 4 | auto-advance at end of track | ✅ done |
| 5 | shuffle, repeat, seek, volume, filter | ⬜ next |
| 6 | hardening, `--help`, `docs/BUGS.md` | ⬜ |

Verified by driving the app through a real pseudo-terminal: pause freezes the
clock at `0:01` and it is still `0:01` more than a second later, resuming
continues to `0:03`, and `ps` reports **no** VLC processes left alive after
quitting.

## Auto-advance

When a track finishes, the next one starts by itself. At the end of the list it
stops and says `end of list` rather than looping — repeat modes arrive in phase
5. Stopping with `x` is treated as a deliberate act and never advances.

`n` / `b` step relative to the **playing** track, so browsing the list with the
arrow keys while music plays doesn't change what "next" means.

## Notes

`songs/sample-speech-2m.mp3` is byte-identical to the `1m` file (same md5), so
both correctly show `1:00`. The filename is wrong, not the duration probe.
