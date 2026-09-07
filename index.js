#!/usr/bin/env node
'use strict';

// Terminal Music Player — entry point.
// Wires library (file handling) + player (process management) + ui (ANSI
// rendering) + keys (raw stdin) together and owns the application state.
//
// Scope: phases 0-4 — browse, play, pause, stop, next/previous, auto-advance
// at end of track, clean exit. Shuffle/repeat, seek and volume land in phase 5.

const path = require('path');
const library = require('./lib/library');
const ui = require('./lib/ui');
const keys = require('./lib/keys');
const { Player } = require('./lib/player');

const RENDER_INTERVAL_MS = 100;

const args = process.argv.slice(2);
const volumeFlagIndex = args.indexOf('--volume');
const startVolumePercent = volumeFlagIndex !== -1 ? Number(args[volumeFlagIndex + 1]) : 60;
const dirArg = args.find((arg, i) => !arg.startsWith('--') && i !== volumeFlagIndex + 1);
const songsDir = dirArg ? path.resolve(dirArg) : path.join(__dirname, 'songs');

const state = {
    songs: [],
    cursor: 0,          // where the user is browsing
    currentIndex: null, // which song is actually loaded in the player
    currentPath: null,
    currentName: null,
    playerState: 'stopped',
    time: null,
    length: null,
    volume: null,
    shuffle: false,      // phase 5
    repeat: 'off',       // phase 5
    query: '',           // phase 5
    filterMode: false,   // phase 5
    message: null,
};

let player = null;
let renderTimer = null;
let uiActive = false;
let shuttingDown = false;

function render() {
    if (uiActive) ui.render(state);
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

async function playAt(index) {
    if (state.songs.length === 0) return;

    const count = state.songs.length;
    state.cursor = ((index % count) + count) % count;

    const song = state.songs[state.cursor];
    state.currentIndex = state.cursor;
    state.currentPath = song.path;
    state.currentName = song.name;
    state.time = 0;
    state.length = song.duration;
    state.message = null;

    await player.playFile(song.path);
}

function clearCurrent() {
    state.currentIndex = null;
    state.currentPath = null;
    state.currentName = null;
    state.time = null;
    state.length = null;
}

async function stopPlayback() {
    await player.stop();
    clearCurrent();
}

/** Next/previous step from the PLAYING track, falling back to the cursor when
 *  nothing is loaded — so browsing while a song plays doesn't hijack `n`. */
async function playRelative(delta) {
    const base = state.currentIndex === null ? state.cursor : state.currentIndex;
    await playAt(base + delta);
}

/** A finished track rolls into the next one. Repeat/shuffle arrive in phase 5,
 *  so for now the list simply stops at the end instead of looping. */
async function advanceAuto() {
    const nextIndex = (state.currentIndex === null ? -1 : state.currentIndex) + 1;

    if (nextIndex >= state.songs.length) {
        clearCurrent();
        state.message = 'end of list';
        render();
        return;
    }

    await playAt(nextIndex);
    render();
}

// --- input ----------------------------------------------------------------

function moveCursor(delta) {
    if (state.songs.length === 0) return;
    const count = state.songs.length;
    state.cursor = ((state.cursor + delta) % count + count) % count;
}

async function handleKey(key) {
    switch (key.name) {
        case 'up': moveCursor(-1); break;
        case 'down': moveCursor(1); break;
        case 'enter': await playAt(state.cursor); break;
        case 'space': await player.togglePause(); break;

        case 'ctrl-c': await shutdown(0); break;

        case 'char':
            if (key.ch === 'q') { await shutdown(0); break; }
            if (key.ch === 'n') { await playRelative(1); break; }
            if (key.ch === 'b') { await playRelative(-1); break; }
            if (key.ch === 'x') { await stopPlayback(); break; }
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

    player = new Player();
    await player.start();

    if (Number.isFinite(startVolumePercent)) {
        await player.setVolume((Math.min(100, Math.max(0, startVolumePercent)) / 100) * 256);
    }

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
