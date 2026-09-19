#!/usr/bin/env node
'use strict';

// Terminal Music Player — entry point.
// Wires library (file handling) + player (process management) + ui (ANSI
// rendering) + keys (raw stdin) together and owns the application state.
//
// Scope: phases 0-5 — browse, filter, play, pause, stop, next/previous, seek,
// volume, shuffle, repeat, auto-advance at end of track, and a clean exit.

const path = require('path');
const library = require('./lib/library');
const ui = require('./lib/ui');
const keys = require('./lib/keys');
const { Player } = require('./lib/player');

const RENDER_INTERVAL_MS = 100;
const DEFAULT_VOLUME_PERCENT = 60;
const DEFAULT_VOLUME_LEVEL = Math.round((DEFAULT_VOLUME_PERCENT / 100) * 256); // VLC's 0-256 scale

const USAGE = `Terminal Music Player

  Usage: node index.js [folder] [options]

  folder              folder of audio files to play (default: ./songs)

  --volume <0-100>    starting volume (default: ${DEFAULT_VOLUME_PERCENT})
  --vlc <binary>      VLC executable to use (default: vlc)
  --sleep <minutes>   stop playback after this many minutes
  -h, --help          show this help
  -v, --version       show the version

  Keys: arrows move, enter plays, space pauses, x stops, n/b next/previous,
        left/right seek, 0-9 jump to 0%-90%, +/- volume, m mute,
        [ ] speed, a queue up next, s shuffle, r end-of-track mode,
        t sleep timer, / filter, esc clears the filter, q quits.
`;

/** Explicit parser: every argument is classified, and anything unrecognised is
 *  reported instead of being silently ignored. */
function parseArgs(argv) {
    const options = { dir: null, volume: DEFAULT_VOLUME_PERCENT, vlc: 'vlc', sleep: null, help: false, version: false };
    const setOption = (name, value) => {
        if (name === 'volume') options.volume = Number(value);
        else if (name === 'sleep') options.sleep = Number(value);
        else options.vlc = value;
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '-h' || arg === '--help') { options.help = true; continue; }
        if (arg === '-v' || arg === '--version') { options.version = true; continue; }

        if (arg === '--volume' || arg === '--vlc' || arg === '--sleep') {
            const value = argv[++i];
            if (value === undefined) throw new Error(`${arg} needs a value`);
            setOption(arg.slice(2), value);
            continue;
        }

        const inlineMatch = arg.match(/^--(volume|vlc|sleep)=(.*)$/);
        if (inlineMatch) {
            setOption(inlineMatch[1], inlineMatch[2]);
            continue;
        }

        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\nTry --help.`);

        if (options.dir !== null) throw new Error(`Unexpected extra argument: ${arg}\nTry --help.`);
        options.dir = arg;
    }

    if (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 100) {
        throw new Error('--volume must be a number between 0 and 100');
    }
    if (options.sleep !== null
        && (!Number.isFinite(options.sleep) || options.sleep <= 0 || options.sleep > 24 * 60)) {
        throw new Error('--sleep must be a number of minutes, above 0 and at most 1440');
    }

    return options;
}

let options;
try {
    options = parseArgs(process.argv.slice(2));
} catch (err) {
    console.error(err.message);
    process.exit(2);
}

if (options.help) { process.stdout.write(USAGE); process.exit(0); }
if (options.version) { console.log(require('./package.json').version); process.exit(0); }

const songsDir = options.dir ? path.resolve(options.dir) : path.join(__dirname, 'songs');

const state = {
    songs: [],        // everything found in the folder
    visible: [],      // what survives the filter — the list on screen
    order: [],        // positions into `visible`: play sequence, shuffled or not
    cursor: 0,        // where the user is browsing, indexes `visible`
    currentPath: null,   // the PLAYING track, identified by path (see below)
    currentName: null,
    currentArtist: null,
    playerState: 'stopped',
    time: null,
    length: null,
    volume: null,
    muted: false,
    volumeBeforeMute: null, // restored by the next `m`
    rate: 1,                // the speed the user chose with [ and ]
    reportedRate: null,     // the speed VLC itself reports; shown when available
    queue: [],              // paths queued with `a`, played before the normal order
    shuffle: false,
    repeat: 'off',    // 'off' | 'all' | 'one' | 'stop'
    query: '',
    filterMode: false,
    sleepAt: null,       // epoch ms when the sleep timer will stop playback
    sleepMinutes: null,  // the preset currently armed, so `t` can step to the next
    message: null,
};

let player = null;
let renderTimer = null;
let sleepTimer = null;
let uiActive = false;
let shuttingDown = false;

function render() {
    if (uiActive) ui.render({ ...state, songs: state.visible });
}

// --- lifecycle ------------------------------------------------------------

// Single cleanup path for every exit route: q, Ctrl-C, a crash, or a signal.
// Restores the terminal AND kills VLC, so nothing keeps playing after we quit.
async function shutdown(code = 0, err = null) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (renderTimer) clearInterval(renderTimer);
    if (sleepTimer) clearTimeout(sleepTimer);

    try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
    } catch { /* stdin already torn down */ }

    if (player) {
        try { await player.quit(); } catch { /* best effort */ }
    }

    if (uiActive) {
        ui.leave();
        uiActive = false;
    }

    if (err) console.error(`\n${err.message}\n`);
    process.exit(code);
}

// --- playback -------------------------------------------------------------

/** `visible` is the list after filtering; `order` is the sequence next/previous
 *  walk through it — identity normally, shuffled when shuffle is on. */
function applyFilter() {
    const query = state.query.trim().toLowerCase();
    // Match the filename AND the tags, so typing an artist finds their songs.
    const matches = (song) => [song.name, song.title, song.artist, song.album]
        .some((field) => field && field.toLowerCase().includes(query));

    state.visible = query ? state.songs.filter(matches) : state.songs.slice();

    rebuildOrder();
    state.cursor = Math.max(0, Math.min(state.cursor, state.visible.length - 1));
}

function rebuildOrder() {
    const count = state.visible.length;
    state.order = state.shuffle
        ? library.shuffledOrder(count)
        : Array.from({ length: count }, (_, index) => index);
}

/** The playing track is identified by PATH, never by index — filtering and
 *  shuffling both move indices around underneath it. Returns -1 when the
 *  playing song is not in the current view (filtered out, or nothing playing). */
function currentVisibleIndex() {
    if (!state.currentPath) return -1;
    return state.visible.findIndex((song) => song.path === state.currentPath);
}

function currentOrderPosition() {
    const visibleIndex = currentVisibleIndex();
    return visibleIndex === -1 ? -1 : state.order.indexOf(visibleIndex);
}

/** Start a song. It may not be on screen (a queued song can be filtered out),
 *  so the cursor only follows it when it's visible. */
async function playSong(song) {
    const visibleIndex = state.visible.indexOf(song);
    if (visibleIndex !== -1) state.cursor = visibleIndex;

    // A queue entry is used up when its song plays, however it was started.
    state.queue = state.queue.filter((queued) => queued !== song.path);

    state.currentPath = song.path;
    state.currentName = library.displayName(song);
    state.currentArtist = song.artist;
    state.time = 0;
    state.length = song.duration;
    state.message = null;

    await player.playFile(song.path);
}

async function playAt(visibleIndex) {
    if (state.visible.length === 0) return;
    const count = state.visible.length;
    await playSong(state.visible[((visibleIndex % count) + count) % count]);
}

/** Play the next queued song, if there is one. Looked up in the full list,
 *  not `visible`, because a queued song may have been filtered out since. */
async function playFromQueue() {
    while (state.queue.length > 0) {
        const song = state.songs.find((candidate) => candidate.path === state.queue[0]);
        if (song) {
            await playSong(song); // also removes it from the queue
            return true;
        }
        state.queue.shift(); // no longer in the library: drop it
    }
    return false;
}

async function playOrderPosition(position) {
    if (state.order.length === 0) return;
    const count = state.order.length;
    await playAt(state.order[((position % count) + count) % count]);
}

function clearCurrent() {
    state.currentPath = null;
    state.currentName = null;
    state.currentArtist = null;
    state.time = null;
    state.length = null;
}

async function stopPlayback() {
    await player.stop();
    clearCurrent();
}

/** Manual next/previous: step through the play order from the PLAYING track,
 *  falling back to the cursor when nothing is loaded. Always wraps. */
async function playRelative(delta) {
    if (delta > 0 && await playFromQueue()) return; // `n` honours the queue; `b` doesn't
    if (state.order.length === 0) return;

    const position = currentOrderPosition();
    if (position === -1) {
        // Nothing playing, or the playing track was filtered out of view.
        // Start from the song under the cursor rather than skipping past it.
        await playAt(state.cursor);
        return;
    }

    await playOrderPosition(position + delta);
}

/** End of track: 'stop' halts here; otherwise the queue goes first; then
 *  repeat-one replays, repeat-all wraps, and 'off' stops at the end of the list. */
async function advanceAuto() {
    if (state.repeat === 'stop') { // an explicit "stop after this" beats the queue
        clearCurrent();
        state.message = 'stopped after track';
        render();
        return;
    }

    if (await playFromQueue()) {
        render();
        return;
    }

    if (state.repeat === 'one') {
        const visibleIndex = currentVisibleIndex();
        if (visibleIndex !== -1) {
            await playAt(visibleIndex);
            render();
            return;
        }
    }

    const nextPosition = currentOrderPosition() + 1;

    if (nextPosition >= state.order.length) {
        if (state.repeat === 'all' && state.order.length > 0) {
            await playOrderPosition(0);
        } else {
            clearCurrent();
            state.message = 'end of list';
        }
        render();
        return;
    }

    await playOrderPosition(nextPosition);
    render();
}

// --- modes ----------------------------------------------------------------

function toggleShuffle() {
    state.shuffle = !state.shuffle;
    rebuildOrder();
    state.message = state.shuffle ? 'shuffle on' : 'shuffle off';
}

const REPEAT_MODES = ['off', 'all', 'one', 'stop'];
const REPEAT_LABELS = {
    off: 'repeat off',
    all: 'repeat all',
    one: 'repeat one',
    stop: 'stop after track',
};

function cycleRepeat() {
    state.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(state.repeat) + 1) % REPEAT_MODES.length];
    state.message = REPEAT_LABELS[state.repeat];
}

const SLEEP_PRESETS = [15, 30, 45, 60];

/** Arm the sleep timer for `minutes`, or disarm it with null. One setTimeout,
 *  replaced on every change, so there is never more than one pending. */
function setSleep(minutes) {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    state.sleepAt = null;
    state.sleepMinutes = null;
    if (!minutes) return;

    const delay = minutes * 60 * 1000;
    state.sleepMinutes = minutes;
    state.sleepAt = Date.now() + delay;
    sleepTimer = setTimeout(() => {
        sleepFired().catch((err) => { state.message = `sleep timer failed: ${err.message}`; });
    }, delay);
}

/** Stop exactly as `x` does, so auto-advance can't start the next song. */
async function sleepFired() {
    sleepTimer = null;
    state.sleepAt = null;
    state.sleepMinutes = null;
    if (state.currentPath) {
        await stopPlayback();
        state.message = 'sleep timer: playback stopped';
    } else {
        state.message = 'sleep timer ended';
    }
    render();
}

/** off -> 15 -> 30 -> 45 -> 60 -> off. Each press restarts the countdown. */
function cycleSleep() {
    const index = SLEEP_PRESETS.indexOf(state.sleepMinutes);
    const next = index === -1 ? SLEEP_PRESETS[0] : SLEEP_PRESETS[index + 1] || null;
    setSleep(next);
    state.message = next ? `sleep timer: ${next} min` : 'sleep timer off';
}

async function nudgeVolume(delta) {
    let current = state.volume === null ? DEFAULT_VOLUME_LEVEL : state.volume;
    if (state.muted) { // like the Mac's own volume keys, adjusting unmutes
        current = state.volumeBeforeMute || DEFAULT_VOLUME_LEVEL;
        state.muted = false;
        state.volumeBeforeMute = null;
    }
    await player.setVolume(current + delta);
}

async function toggleMute() {
    if (state.muted) {
        // Restoring to 0 would be an "unmute" that stays silent.
        const restore = state.volumeBeforeMute || DEFAULT_VOLUME_LEVEL;
        state.muted = false;
        state.volumeBeforeMute = null;
        await player.setVolume(restore);
        state.message = 'unmuted';
    } else {
        state.volumeBeforeMute = state.volume;
        state.muted = true;
        await player.setVolume(0);
        state.message = 'muted';
    }
}

/** 0-9 jump to 0%-90% of the playing track. */
async function jumpToPercent(digit) {
    if (!state.currentPath || !state.length) return;
    await player.seekTo((state.length * digit) / 10);
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** `[` slower, `]` faster, stopping at either end rather than wrapping. */
async function stepRate(direction) {
    const index = RATES.indexOf(state.rate);
    const next = RATES[Math.min(RATES.length - 1, Math.max(0, (index === -1 ? 2 : index) + direction))];
    if (next === state.rate) {
        state.message = `speed ${state.rate}× is the ${direction > 0 ? 'fastest' : 'slowest'}`;
        return;
    }
    state.rate = next;
    await player.setRate(next);
    state.message = `speed ${next}×`;
}

/** `a` toggles the highlighted song in the up-next queue. */
function toggleQueue() {
    const song = state.visible[state.cursor];
    if (!song) return;

    const at = state.queue.indexOf(song.path);
    if (at === -1) {
        state.queue.push(song.path);
        state.message = `queued #${state.queue.length}: ${library.displayName(song)}`;
    } else {
        state.queue.splice(at, 1);
        state.message = `unqueued: ${library.displayName(song)}`;
    }
}

// --- input ----------------------------------------------------------------

const SEEK_SECONDS = 5;
const VOLUME_STEP = 26; // ~10% of VLC's 0-256 scale

function moveCursor(delta) {
    if (state.visible.length === 0) return;
    const count = state.visible.length;
    state.cursor = ((state.cursor + delta) % count + count) % count;
}

/** While filtering, printable keys build the query instead of firing commands. */
function handleFilterKey(key) {
    if (key.name === 'escape') {
        state.filterMode = false;
        state.query = '';
        applyFilter();
    } else if (key.name === 'enter') {
        state.filterMode = false; // keep the filter, just stop typing
    } else if (key.name === 'backspace') {
        state.query = state.query.slice(0, -1);
        applyFilter();
    } else if (key.name === 'char' || key.name === 'space') {
        state.query += key.ch;
        applyFilter();
    }
}

async function handleKey(key) {
    if (key.name === 'ctrl-c') { await shutdown(0); return; }  // always quits

    if (state.filterMode) {
        handleFilterKey(key);
        render();
        return;
    }

    switch (key.name) {
        case 'up': moveCursor(-1); break;
        case 'down': moveCursor(1); break;
        case 'left': await player.seek(-SEEK_SECONDS); break;
        case 'right': await player.seek(SEEK_SECONDS); break;
        case 'enter': await playAt(state.cursor); break;
        case 'space': await player.togglePause(); break;

        case 'escape': // clear an active filter without re-entering the filter box
            if (state.query) {
                state.query = '';
                applyFilter();
                state.message = 'filter cleared';
            }
            break;

        case 'char':
            if (key.ch === 'q') { await shutdown(0); break; }
            if (key.ch === 'n') { await playRelative(1); break; }
            if (key.ch === 'b') { await playRelative(-1); break; }
            if (key.ch === 'x') { await stopPlayback(); break; }
            if (key.ch === 's') { toggleShuffle(); break; }
            if (key.ch === 'r') { cycleRepeat(); break; }
            if (key.ch === 't') { cycleSleep(); break; }
            if (key.ch === 'm') { await toggleMute(); break; }
            if (key.ch === 'a') { toggleQueue(); break; }
            if (key.ch === '[') { await stepRate(-1); break; }
            if (key.ch === ']') { await stepRate(1); break; }
            if (key.ch >= '0' && key.ch <= '9') { await jumpToPercent(Number(key.ch)); break; }
            if (key.ch === '+' || key.ch === '=') { await nudgeVolume(VOLUME_STEP); break; }
            if (key.ch === '-' || key.ch === '_') { await nudgeVolume(-VOLUME_STEP); break; }
            if (key.ch === '/') { state.filterMode = true; state.message = null; break; }
            break;

        default: break;
    }
    render();
}

// --- startup --------------------------------------------------------------

async function main() {
    if (!process.stdin.isTTY) {
        console.error('This player needs an interactive terminal (a TTY). Run it directly: node index.js');
        process.exit(1);
    }

    state.songs = library.load(songsDir);
    await library.loadTags(state.songs);
    library.sortForDisplay(state.songs);
    applyFilter(); // seeds `visible` and `order` from the full list

    player = new Player({ bin: options.vlc });
    await player.start();

    await player.setVolume((options.volume / 100) * 256);
    if (options.sleep) setSleep(options.sleep);

    player.on('tick', (snapshot) => {
        state.playerState = snapshot.state;
        state.time = snapshot.time;
        if (snapshot.length !== null) state.length = snapshot.length;
        state.volume = snapshot.volume;
        state.reportedRate = snapshot.reportedRate;
    });

    player.on('ended', () => {
        advanceAuto().catch((err) => { state.message = `could not advance: ${err.message}`; });
    });

    player.on('error', (err) => { state.message = `player error: ${err.message}`; });
    player.on('closed', () => { if (!shuttingDown) shutdown(1, new Error('VLC exited unexpectedly.')); });

    ui.enter();
    uiActive = true;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
        for (const key of keys.decode(chunk)) handleKey(key);
    });

    process.stdout.on('resize', render);
    renderTimer = setInterval(render, RENDER_INTERVAL_MS);
    render();

    // Durations fill in the background; the UI shows --:-- until they arrive.
    library.probeAll(state.songs, render);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => shutdown(1, err));
process.on('unhandledRejection', (err) => shutdown(1, err instanceof Error ? err : new Error(String(err))));

main().catch((err) => shutdown(1, err));
