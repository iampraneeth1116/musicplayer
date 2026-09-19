# Terminal Music Player

A music player that runs inside your terminal. It's built with plain Node.js,
so there's nothing to install from npm, and it plays your songs through VLC.

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

## What you need

- **Node.js**
- **VLC**: install it with `brew install vlc`
- **A Mac**, for showing song lengths. On other systems everything works, but
  lengths show as `--:--`.

## Start it

Put your songs in the `songs` folder, then run:

```bash
node index.js
```

You can add options:

| Command | What it does |
|---|---|
| `node index.js ~/Music` | play songs from a different folder |
| `node index.js --volume 30` | start at 30% volume (normally 60%) |
| `node index.js --sleep 30` | stop playing after 30 minutes |
| `node index.js --vlc /path/to/vlc` | use VLC from an unusual location |
| `node index.js --help` | show every option and key |

If something is wrong, such as a folder that doesn't exist or VLC not being
installed, the player tells you in one clear line instead of crashing.

## Keys

**Playing**

| Key | Does |
|---|---|
| `⏎` Enter | play the highlighted song |
| `space` | pause / resume |
| `x` | stop |
| `n` / `b` | next / previous song |

**Moving around**

| Key | Does |
|---|---|
| `↑` `↓` | move up and down the list |
| `←` `→` | go back / forward 5 seconds |
| `0` – `9` | jump through the song: `5` is halfway, `0` is the start |

**Sound**

| Key | Does |
|---|---|
| `+` `-` | volume up / down |
| `m` | mute / unmute |
| `[` `]` | slower / faster, from 0.5× to 2× |

**Modes**

| Key | Does |
|---|---|
| `s` | shuffle on / off |
| `r` | choose what happens when a song ends (see below) |
| `a` | add the highlighted song to the up-next queue |
| `t` | sleep timer: 15, 30, 45 or 60 minutes |

**Searching and quitting**

| Key | Does |
|---|---|
| `/` | search by song name, artist or album |
| `Esc` | clear the search |
| `q` or `Ctrl-C` | quit |

While you're typing a search, every key types into the search box, including
`q`. Press `Enter` to keep the results, or `Esc` to clear them.

The bottom line of the screen shows as many of these keys as fit. `--help`
lists them all.

## Features

### When a song ends: `r`

Press `r` to step through four modes. Unless it's *off*, the current mode shows
in the top-right corner.

| Mode | When a song finishes |
|---|---|
| off | play the next song, and stop after the last one |
| repeat all | play the next song, and go back to the first after the last one |
| repeat one | play the same song again |
| stop after track | stop |

`x` is different: it stops straight away, while *stop after track* lets the
song finish first.

### Shuffle: `s`

Songs play in a random order, but the list on screen stays in order, so you
can still find any song easily.

### Up-next queue: `a`

Highlight a song and press `a` to play it next, without stopping the current
song. Queued songs show a number (`1`, `2` …) in the list.

```
now:    23 Theme
next:   Raga of Revenge          ← you pressed a on this first
then:   Deewana Kar Raha Hai     ← then on this
after:  the normal order carries on
```

Press `a` again on a queued song to remove it. `n` plays the next queued song;
`b` ignores the queue.

### Song names and artists

The player reads each song's real title and artist from inside the music file.
A file without that information is shown by its filename. Searching with `/`
also finds artists, so typing `anirudh` finds all of his songs.

### Sleep timer: `t`

Each press of `t` sets the timer to the next step: 15 → 30 → 45 → 60 minutes →
off. A countdown shows in the top-right corner. When it reaches zero the music
stops, even if *repeat all* is on.

### Speed, mute and jumping

- `[` `]` change the speed. It stays the same when the song changes.
- `m` mutes, and pressing it again brings back the exact volume you had.
- The number keys jump to part of a song, which is handy for skipping a long
  intro.

## How it works

The player starts **one copy of VLC** in the background and sends it short text
commands like `pause` or `seek +5`, the same ones you could type to VLC by hand.
Four times a second it asks VLC where the song is, which is what moves the
progress bar.

The project shows three main ideas:

| Idea | Where |
|---|---|
| **Command-line app**: reading single key presses and drawing the screen | `lib/keys.js`, `lib/ui.js`, `index.js` |
| **File handling**: finding the songs and reading titles from inside the files | `lib/library.js`, `lib/tags.js` |
| **Process management**: starting VLC, talking to it, and closing it properly | `lib/player.js` |

A few choices that keep it reliable:

- **Only one VLC ever runs.** Changing songs reuses it, so a song can never keep
  playing in the background after you've moved on.
- **The time comes from VLC**, not from a counter in the app, so the progress
  bar is always right, even after pausing or jumping.
- **Quitting cleans up.** Whether you press `q` or `Ctrl-C`, or the player hits
  an error, it stops VLC and puts your terminal back to normal.

## How it was built

It was built in stages, and each stage was tested by actually running it in a
terminal before moving on.

| Stage | What was added |
|---|---|
| 0 | tested how VLC's command interface behaves |
| 1 | reading the songs folder and drawing the screen |
| 2 | keyboard controls and quitting cleanly |
| 3 | play, pause, stop, next and previous |
| 4 | moving to the next song automatically |
| 5 | shuffle, repeat, seeking, volume and search |
| 6 | error handling and command-line options |
| later | song titles, stop-after-track, queue, speed, mute, jumping and the sleep timer |

## Good to know

- **Speed display.** VLC's normal command interface can't report its speed, so
  the player reads it from VLC's small built-in web page instead. That page only
  works on your own computer and needs a password that changes every time. While
  the player is running, other people logged into the same Mac could see that
  password, so it's best used on your own laptop.
- **Titles are shown exactly as stored in the file.** If a download site added
  its name to a title, fix it in the file's details rather than in the player.
- **Non-Latin titles** (for example Tamil, Hindi or Chinese) display correctly
  but may sit slightly out of line in the list.
