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
node index.js --vlc /path/to/vlc # a VLC that isn't on your PATH
node index.js --help             # full usage
```

It needs a real terminal — piping stdin exits with a message rather than
crashing in raw mode. Unknown options, a bad `--volume`, or a folder that does
not exist all fail with a specific message and a non-zero exit code, rather than
a stack trace.

## Keys

| Key | Action |
|---|---|
| `↑` `↓` | move the cursor (wraps around) |
| `⏎` | play the highlighted song |
| `space` | pause / resume |
| `x` | stop |
| `n` `b` | next / previous (steps from the playing track, not the cursor) |
| `←` `→` | seek 5 seconds back / forward |
| `+` `-` | volume up / down (10% steps) |
| `s` | shuffle on / off |
| `r` | repeat: off → all → one |
| `/` | filter the list by name |
| `q` or `Ctrl-C` | quit |

While filtering, typing edits the query: `⏎` keeps the filter and returns to
normal keys, `Esc` clears it, backspace deletes. `Ctrl-C` always quits, even
mid-filter.

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
| 5 | shuffle, repeat, seek, volume, filter | ✅ done |
| 6 | hardening, `--help`, `docs/BUGS.md` | ✅ done |

Every checkpoint was verified by driving the app through a real
pseudo-terminal rather than by reading the code. Among other things: pause
freezes the clock and resume continues it, a finished track advances to the next
by itself, repeat-all wraps from last to first, seeking clamps at zero, and `ps`
reports **no** VLC processes left alive after quitting.

Hardening covers an empty folder, a folder that does not exist, VLC missing from
`PATH`, every key pressed with nothing playing, and terminal widths from 28 to
100 columns including a live resize.

`docs/BUGS.md` catalogues the 24 issues found in the in-class versions this was
rewritten from, and the four bugs the rewrite introduced that testing caught.
`docs/rc-notes.md` documents VLC's `rc` protocol as measured.

## Playback order

When a track finishes the next one starts by itself, following the current
mode:

| Repeat | At the end of a track | At the end of the list |
|---|---|---|
| `off` | plays the next song | stops, shows `end of list` |
| `all` | plays the next song | wraps back to the first |
| `one` | replays the same song | — |

Shuffle reorders that sequence without touching the list on screen, so what you
see stays alphabetical while playback jumps around.

Stopping with `x` is treated as deliberate and never advances — worth noting,
because a stopped player and a finished track look identical to VLC. The
difference is tracked explicitly.

`n` / `b` step relative to the **playing** track, so browsing with the arrow
keys while music plays doesn't change what "next" means. The playing track is
identified by its file path rather than its position, because filtering and
shuffling both move positions around underneath it. If the playing song is
filtered out of view, `n` starts again from the cursor.

## Notes

`songs/sample-speech-2m.mp3` is byte-identical to the `1m` file (same md5), so
both correctly show `1:00`. The filename is wrong, not the duration probe.
