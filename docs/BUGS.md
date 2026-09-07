# What went wrong in the in-class versions

This player started as a rewrite of three terminal music players written in
class — the `lecture_lab_4/cli.js` VLC version, and two `afplay` versions from
the earlier labs. Reading them turned up **24 distinct issues**. This document
records each one and how the rewrite avoids it.

The point isn't that the originals were bad. Most of these are the natural
consequence of three specific assumptions that feel obviously true and are not:

* that a child process dies when its parent does,
* that a boolean is enough to describe what a player is doing,
* that one keypress arrives as one byte.

---

## A. Process lifecycle

**1. Ctrl-C leaves the music playing.** *(all three versions)*
`process.exit()` does not kill a spawned child. Quitting the app left `afplay`
or `vlc` running with no way to reach it except `kill`. In raw mode this is
worse than it sounds: the terminal is also left in raw mode, so the shell you
return to no longer echoes what you type.

**2. An async gap lets a second player escape.** *(VLC version)*
`playSong` killed the old process, then `await`ed `afinfo` before spawning the
new one. Press `n` twice quickly and the second call kills nothing — the field
is already `undefined` — while the first call's `await` resolves afterwards and
assigns a process no handle points to. It plays until you find its PID.

**3. No handle on the player at all.** *(simple `afplay` version)*
`const play = spawn(...)` was local to the function, so nothing could ever stop
it. Pressing enter three times played three songs *simultaneously*.

**4. Pausing then playing strands a suspended process.** *(second `afplay` version)*
Space `SIGSTOP`s the player and sets `song_is_playing = false`. Enter reads that
same `false` as "nothing is playing" and spawns a second `afplay` — while the
first is still suspended, unreachable, and will never be resumed or killed.

> **How this player avoids all four:** one long-lived VLC process for the whole
> session, switched between tracks with `clear` + `add`. There is never a second
> child to lose. A single `shutdown()` — shared by `q`, `Ctrl-C`, signals and
> uncaught exceptions — quits VLC and restores the terminal on every exit path.

## B. Timers and the clock

**5. `setInterval` was never cleared.** *(VLC version)*
`startElapsedTracking()` ran on *every* play. Three tracks in, three intervals
were live: elapsed time advanced at 3× real speed and the screen repainted 30
times a second. This is the first bug the original's own README asks about.

**6. Elapsed time was counted locally, not measured.** *(VLC version)*
`timeElapsed += 0.1` every 100 ms drifts against the real audio, and cannot know
about a pause it wasn't told about.

**7. Nothing detected the end of a song.** *(all three)*
No `close`/`exit` listener anywhere, so the timer kept counting past the end of
the track, no interval was ever cleaned up, and auto-advance was impossible.

**8. That overflow crashed the app.** *(VLC version)*
Once elapsed exceeded the duration, `playedCharC` exceeded 50 and
`".".repeat(50 - playedCharC)` threw `RangeError: Invalid count value`. Clamping
the percentage hides the crash but freezes the bar at full.

> **How this player avoids them:** VLC owns the clock. `get_time` is polled every
> 250 ms, so there is no local counter to drift or stack, and one timer exists
> for the life of the app rather than one per track. End of track is detected
> from VLC's own state and drives auto-advance.

## C. Talking to the child process

**9. A promise that could never settle.** *(VLC version)*
`getSongDuration` resolved from the *first* stdout chunk with no `reject`, no
`error` handler and no timeout. If `afinfo` were missing, or that chunk didn't
contain `estimated duration:`, the `await` in `playSong` would block forever —
the app would hang with no error.

**10. Pause state was a guess.** *(VLC version)*
A local `isPaused` boolean tracked a `pause` command that is itself a *toggle*.
Press `p` with nothing playing and the flag flips anyway; the app and VLC then
disagree about what is happening.

> **How this player avoids them:** every command is queued and resolved by VLC's
> own `"> "` prompt, with a 2-second timeout so a lost reply cannot wedge the
> queue. `status` is polled for the true state rather than assumed.

## D. Reading the keyboard

**11. Only `data[0]` was ever examined.** *(all three)*
One chunk can carry several keypresses — a held key, fast typing, a paste, or an
escape sequence split across reads. Everything after the first byte was dropped.

**12. `if (data[0] == "0x6E")` compares a number to a string.** *(second `afplay` version)*
It works, but by accident: `==` coerces via `Number("0x6E")`, which JavaScript
parses as hex → `110`. Change it to the `===` everyone recommends and the key
silently stops working. `"0x64"` is `100` — that's `d`, not the `b` the code
appears to intend.

**13. Keys crash before anything is playing.** *(second `afplay` version)*
`player.kill(...)` on space, `n` or `d` throws a `TypeError` when `player` is
still `undefined`.

**14. Enter was overloaded into a quit key.** *(second `afplay` version)*
The second press killed the player and called `process.exit(0)`, so enter could
never be used to change songs. The line after it was unreachable.

> **How this player avoids them:** `lib/keys.js` decodes a *stream* of key events
> from each chunk, handles a CSI sequence split across reads, and returns named
> keys. Every action checks that a player exists first.

## E. Reading the folder

**15. `readdirSync` on the render path.** *(all three)*
The VLC version re-read the directory 10× a second inside its render loop; the
others re-read it on every keypress. The song list does not change that often.

**16. No filter on file type.** *(VLC version, second `afplay` version)*
A `.DS_Store` — which macOS creates in any folder you open in Finder — would be
listed as a song and handed to the player. *The simple `afplay` version got this
right* with `.endsWith(".mp3")`, and is the only one of the three that did.

**17. Paths relative to the current directory.** *(both `afplay` versions)*
`join("songs")` resolves against wherever you happened to `cd`, so the app only
ran from inside its own folder.

> **How this player avoids them:** the folder is read **once** at startup,
> filtered to known audio extensions, hidden files skipped, resolved against a
> real path. Durations are probed in the background and never block the UI.

## F. Modelling what the player is doing

**18. One boolean for two different questions.** *(second `afplay` version)*
`song_is_playing` meant "a song is loaded" in one branch and "not paused" in
another. Bug **4** above is the direct consequence.

**19. Playback position identified by list index.** *(all three)*
Fine until the list can be filtered or reordered — then the index silently
points at a different song.

> **How this player avoids them:** separate `playerState` (`playing`/`paused`/
> `stopped`, read from VLC) and `currentPath`. The playing track is identified by
> **path**, so filtering and shuffling cannot re-point it.

## G. Drawing the screen

**20. No screen clear before the first paint.** *(VLC version)*
The menu was drawn at row 2 over whatever the terminal already contained.
`\x1B[0K` clears to the end of a *line*, so anything below the menu survived.

**21. `console.log` mixed into a cursor-addressed UI.** *(both `afplay` versions)*
Both logged the raw input buffer on every keypress, fighting the very redraw
they were built around.

**22. Append-only output.** *(simple `afplay` version)*
Every keypress printed the whole list again below the last one, so the terminal
scrolled forever. Not a TUI so much as a very repetitive log.

**23. The cursor was never hidden.** *(all three)*
A blinking block sits in the middle of the progress bar.

**24. Dead code.** *(VLC version)*
`PROGRESS_BAR_WIDTH = 50` is declared and then ignored in favour of a hardcoded
`50` on the next line — the kind of thing that turns into a real bug the first
time someone "changes the width".

> **How this player avoids them:** one full-frame write per render from a single
> function, into the alternate screen buffer with the cursor hidden. Nothing
> else in the app writes to stdout, so no stray log can corrupt the display, and
> quitting restores the shell exactly as it was found.

---

## Bugs this rewrite introduced (and testing caught)

Worth recording, because they make the same point in the other direction — all
four were invisible on the page and only appeared once the code actually ran:

1. **Row text was `width + 1` characters**, so every row overflowed by one and
   the duration column rendered as `--:-…`.
2. **ANSI codes counted as visible width** when truncating the now-playing line.
3. **A folder passed as an argument was silently ignored** — `node index.js
   /some/music` played `./songs` instead, because the "skip the flag's value"
   logic skipped index `0` when no `--volume` flag was present. A documented
   feature that never worked.
4. **The progress bar had a minimum width that ignored the terminal's width**,
   so at 32 columns the status line came to 34 characters and wrapped.

The lesson is the one this whole document is really about: reading code proves
syntax, running it proves behaviour.
