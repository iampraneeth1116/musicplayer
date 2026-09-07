#!/usr/bin/env node
'use strict';

// Terminal Music Player — entry point.
// Wires library (file handling) + player (process management) + ui (ANSI
// rendering) + keys (raw stdin) together and owns the application state.
//
// Scope: phases 0-3 — browse, play, pause, stop, next/previous, clean exit.
// Auto-advance, shuffle/repeat, seek and volume keys land in phases 4-5.

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
    cursor: 0,
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
    state.currentPath = song.path;
    state.currentName = song.name;
    state.time = 0;
    state.length = song.duration;
    state.message = null;

    await player.playFile(song.path);
}

async function stopPlayback() {
    await player.stop();
    state.currentPath = null;
    state.currentName = null;
    state.time = null;
    state.length = null;
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
            if (key.ch === 'n') { await playAt(state.cursor + 1); break; }
            if (key.ch === 'b') { await playAt(state.cursor - 1); break; }
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

    // Phase 4 will turn this into auto-advance.
    player.on('ended', () => {
        state.currentPath = null;
        state.currentName = null;
        state.time = null;
        state.length = null;
        state.message = 'track finished';
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
