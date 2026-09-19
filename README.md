# Terminal Music Player

A terminal music player written in plain Node.js — no npm dependencies. It
browses a folder of audio files and plays them through VLC, with a live
in-place TUI: cursor navigation, song titles and artists read from each file's
tags, an up-next queue, speed control, a sleep timer, and a progress bar driven
by VLC's own clock.

```
 ♪  Terminal Music Player                                         sleep 29:45
──────────────────────────────────────────────────────────────────────────────
    23 Theme                                 Anirudh Ravichander, Hect…  0:48
    Deewana Kar Raha Hai                     Rashid Khan, Javed Ali      6:25
    Dhurandhar Song Baloch - Sagar Kadam X…                              3:51
 ▶  Make Way For The King                    Dhp, Sai Abhyankkar         1:55
    Raga of Revenge - MassTamilan            Anirudh Ravichander - Mas…  2:11
──────────────────────────────────────────────────────────────────────────────
 ▶   Make Way For The King — Dhp, Sai Abhyankkar
 █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  0:11 / 1:55  vol 60%
──────────────────────────────────────────────────────────────────────────────
 ↑↓ move · ⏎ play · space pause · x stop · n/b skip · / find · q quit
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
node index.js --sleep 30         # stop playback after 30 minutes
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
| `0`–`9` | jump to 0%, 10% … 90% of the song |
| `+` `-` | volume up / down (10% steps) |
| `m` | mute / unmute |
| `[` `]` | slower / faster: 0.5× to 2× |
| `a` | add the highlighted song to the up-next queue (again to remove) |
| `s` | shuffle on / off |
| `r` | end-of-track mode: off → all → one → stop |
| `t` | sleep timer: off → 15 → 30 → 45 → 60 min |
| `/` | filter by title, artist, album or filename |
| `Esc` | clear the filter |
| `q` or `Ctrl-C` | quit |

While filtering, typing edits the query: `⏎` keeps the filter and returns to
normal keys, `Esc` clears it, backspace deletes. `Ctrl-C` always quits, even
mid-filter. Outside the filter box, `Esc` clears an active filter.

The help line at the bottom fits as many of these as the terminal is wide,
most-used first, and always keeps `q quit`. The full list is in `--help`.

## How it fits together

| File | Responsibility |
|---|---|
| `index.js` | app state, key bindings, startup and the single shutdown path |
| `lib/library.js` | **file handling** — scans the folder once, filters to audio, probes durations |
| `lib/tags.js` | **file handling** — reads title/artist/album from ID3 tags in each file |
| `lib/player.js` | **process management** — the VLC child, its `rc` command protocol, and a read-only web channel for playback speed |
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
| 6 | hardening, `--help`, design notes | ✅ done |

Every checkpoint was verified by driving the app through a real
pseudo-terminal rather than by reading the code. Among other things: pause
freezes the clock and resume continues it, a finished track advances to the next
by itself, repeat-all wraps from last to first, seeking clamps at zero, and `ps`
reports **no** VLC processes left alive after quitting.

Hardening covers an empty folder, a folder that does not exist, VLC missing from
`PATH`, every key pressed with nothing playing, and terminal widths from 28 to
100 columns including a live resize.

Added after phase 6: the `stop` end-of-track mode, `Esc` to clear a filter,
song titles from ID3 tags, the sleep timer, the up-next queue, playback speed,
mute, and jumping by percent. The tag reader was checked
against VLC's own reading of real files, then against 25 hand-built tags covering
every text encoding, the v2.2 and v1 formats, unsynchronisation and corrupt
data.

`docs/rc-notes.md` documents VLC's `rc` protocol as measured.

## Playback order

When a track finishes the next one starts by itself, following the current
mode:

| Mode | At the end of a track | At the end of the list |
|---|---|---|
| `off` | plays the next song | stops, shows `end of list` |
| `all` | plays the next song | wraps back to the first |
| `one` | replays the same song | — |
| `stop` | stops there | — |

`stop` is for listening to one song and letting it end — playback halts when the
track finishes instead of rolling on.

**Queued songs come first.** Anything added with `a` plays before the normal
order, whatever the shuffle and repeat modes — except `stop`, which still stops
and keeps the queue for later. See *Up-next queue* below.

Shuffle reorders that sequence without touching the list on screen, so what you
see stays sorted by title while playback jumps around.

Stopping with `x` is treated as deliberate and never advances — worth noting,
because a stopped player and a finished track look identical to VLC. The
difference is tracked explicitly.

`n` / `b` step relative to the **playing** track, so browsing with the arrow
keys while music plays doesn't change what "next" means. The playing track is
identified by its file path rather than its position, because filtering and
shuffling both move positions around underneath it. If the playing song is
filtered out of view, `n` starts again from the cursor.

## Song titles

Titles, artists and albums come from each file's **ID3 tags**, read directly by
`lib/tags.js` — no child process, and no need to load every song through VLC.
It understands ID3v2.2, v2.3 and v2.4 at the start of a file, and falls back to
the older ID3v1 block at the end. Large frames such as embedded album art are
skipped rather than read.

* The list is **sorted by title**, and gains an artist column when any song has
  an artist.
* A file without tags shows its filename, minus the extension.
* `/` searches titles, artists and albums as well as filenames — type an
  artist's name to find their songs.
* Tags are shown exactly as written in the file. If a download site appended
  its name to the title, fix the file's tags rather than the player.

Column alignment assumes one terminal column per character, which holds for
Latin script. Titles in scripts with combining marks (Tamil, Devanagari) or
double-width characters (Chinese, Japanese) display correctly but may sit a
little out of line.

## Up-next queue

`a` adds the highlighted song to the queue without interrupting what's playing.
Queued songs show their position beside them in the list (`1`, `2` …) and the
header shows `queue 2`. Press `a` on a queued song to take it back out.

```
now:    23 Theme
next:   Raga of Revenge          ← queued 1st
then:   Deewana Kar Raha Hai     ← queued 2nd
after:  normal order resumes
```

* When a song ends, or when you press `n`, the next queued song plays.
* `b` ignores the queue and goes back through the normal order.
* A queue entry is used up when its song plays, however it was started — so
  pressing `⏎` on a queued song plays it now and removes it from the queue.
* A queued song still plays even if a filter is hiding it.

## Speed, mute and jumping

`[` and `]` step the speed through 0.5×, 0.75×, 1×, 1.25×, 1.5× and 2×, and it
stays set when the track changes. The header shows the speed **VLC reports**
whenever it isn't 1×.

VLC's usual control channel can't report its speed — the query crashes inside
VLC's own script (see `docs/rc-notes.md`). So the player also switches on VLC's
built-in web interface and reads the speed from there, about once a second.
That interface:

* listens on your own Mac only (`127.0.0.1`), on a free port picked at startup;
* refuses any request without a password, which is random and new every session;
* exists only while the player is running.

One thing to know: VLC accepts that password only as a command-line argument,
so while the player runs, another account on the same Mac could see it with
`ps` and control the player. On a personal laptop that doesn't matter. If the
web interface can't start, the header shows the speed the player last set, and
everything else works as normal.

`m` mutes and unmutes, restoring the exact volume you had. Pressing `+` or `-`
while muted unmutes too, the way the Mac's own volume keys do.

`0`–`9` jump to that tenth of the song: `5` is halfway, `0` is the start.
While typing in the filter box, digits go into the search instead.

## Sleep timer

`t` arms a timer — 15, 30, 45 or 60 minutes — and each press moves to the next
and restarts the countdown; after 60 it switches off. The header shows the time
remaining, e.g. `sleep 29:41`. `--sleep <minutes>` sets any duration at launch.

When it fires, playback **stops** just as `x` would, so it can't be undone by
auto-advance — not even with `repeat all` on.
