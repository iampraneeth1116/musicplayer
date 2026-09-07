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

const USAGE = `Terminal Music Player

  Usage: node index.js [folder] [options]

  folder              folder of audio files to play (default: ./songs)

  --volume <0-100>    starting volume (default: ${DEFAULT_VOLUME_PERCENT})
  --vlc <binary>      VLC executable to use (default: vlc)
  -h, --help          show this help
  -v, --version       show the version

  Keys: arrows move, enter plays, space pauses, x stops, n/b next/previous,
        left/right seek, +/- volume, s shuffle, r repeat, / filter, q quits.
`;

/** Explicit parser: every argument is classified, and anything unrecognised is
 *  reported instead of being silently ignored. */
function parseArgs(argv) {
    const options = { dir: null, volume: DEFAULT_VOLUME_PERCENT, vlc: 'vlc', help: false, version: false };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '-h' || arg === '--help') { options.help = true; continue; }
        if (arg === '-v' || arg === '--version') { options.version = true; continue; }

        if (arg === '--volume' || arg === '--vlc') {
            const value = argv[++i];
            if (value === undefined) throw new Error(`${arg} needs a value`);
            if (arg === '--volume') options.volume = Number(value);
            else options.vlc = value;
            continue;
        }

        const inlineMatch = arg.match(/^--(volume|vlc)=(.*)$/);
        if (inlineMatch) {
            if (inlineMatch[1] === 'volume') options.volume = Number(inlineMatch[2]);
            else options.vlc = inlineMatch[2];
            continue;
        }

        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\nTry --help.`);

        if (options.dir !== null) throw new Error(`Unexpected extra argument: ${arg}\nTry --help.`);
        options.dir = arg;
    }

    if (!Number.isFinite(options.volume) || options.volume < 0 || options.volume > 100) {
        throw new Error('--volume must be a number between 0 and 100');
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
    playerState: 'stopped',
    time: null,
    length: null,
    volume: null,
    shuffle: false,
    repeat: 'off',    // 'off' | 'all' | 'one'
    query: '',
    filterMode: false,
    message: null,
};

let player = null;
let renderTimer = null;
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
    state.visible = query
        ? state.songs.filter((song) => song.name.toLowerCase().includes(query))
        : state.songs.slice();

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

async function playAt(visibleIndex) {
    if (state.visible.length === 0) return;

    const count = state.visible.length;
    state.cursor = ((visibleIndex % count) + count) % count;

    const song = state.visible[state.cursor];
    state.currentPath = song.path;
    state.currentName = song.name;
    state.time = 0;
    state.length = song.duration;
    state.message = null;

    await player.playFile(song.path);
}

async function playOrderPosition(position) {
    if (state.order.length === 0) return;
    const count = state.order.length;
    await playAt(state.order[((position % count) + count) % count]);
}

function clearCurrent() {
    state.currentPath = null;
    state.currentName = null;
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

/** End of track: repeat-one replays it, repeat-all wraps to the start,
 *  otherwise the list stops at the end instead of looping. */
async function advanceAuto() {
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

function cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
    state.message = `repeat ${state.repeat}`;
}

async function nudgeVolume(delta) {
    const current = state.volume === null ? 154 : state.volume;
    await player.setVolume(current + delta);
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

        case 'char':
            if (key.ch === 'q') { await shutdown(0); break; }
            if (key.ch === 'n') { await playRelative(1); break; }
            if (key.ch === 'b') { await playRelative(-1); break; }
            if (key.ch === 'x') { await stopPlayback(); break; }
            if (key.ch === 's') { toggleShuffle(); break; }
            if (key.ch === 'r') { cycleRepeat(); break; }
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
    applyFilter(); // seeds `visible` and `order` from the full list

    player = new Player({ bin: options.vlc });
    await player.start();

    await player.setVolume((options.volume / 100) * 256);

    player.on('tick', (snapshot) => {
        state.playerState = snapshot.state;
        state.time = snapshot.time;
        if (snapshot.length !== null) state.length = snapshot.length;
        state.volume = snapshot.volume;
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
