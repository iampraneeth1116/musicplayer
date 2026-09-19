'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readTags } = require('./tags');

const AUDIO_EXTENSIONS = new Set([
    '.mp3', '.m4a', '.aac', '.wav', '.aiff', '.aif', '.flac', '.ogg', '.opus', '.wma', '.alac',
]);

/**
 * Read the songs folder ONCE. Hidden files (.DS_Store) and non-audio files are
 * filtered out so they can never be handed to the player.
 */
function load(directoryPath) {
    let entries;
    try {
        entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`Songs folder not found: ${directoryPath}`);
        if (err.code === 'ENOTDIR') throw new Error(`Not a folder: ${directoryPath}`);
        throw err;
    }

    return entries
        .filter((entry) => entry.isFile()
            && !entry.name.startsWith('.')
            && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => ({
            name: entry.name,
            path: path.join(directoryPath, entry.name),
            duration: null,
            title: null,   // from the file's ID3 tags, when it has them
            artist: null,
            album: null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Ask afinfo for one song's duration.
 * Never rejects and never hangs: stdout is accumulated and parsed on close,
 * a missing binary resolves to null, and a stuck probe is killed after 5s.
 */
function probeDuration(songPath) {
    return new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        let child;
        try {
            child = spawn('afinfo', [songPath]);
        } catch {
            return finish(null);
        }

        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* already gone */ }
            finish(null);
        }, 5000);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.on('error', () => { clearTimeout(timer); finish(null); });
        child.on('close', () => {
            clearTimeout(timer);
            const match = stdout.match(/estimated duration:\s*([0-9.]+)/);
            // Truncate, as VLC's get_length does, so the list and the progress
            // bar show the same length for the same song.
            finish(match ? Math.floor(Number(match[1])) : null);
        });
    });
}

/** Probe every song in the background, calling onUpdate as results arrive. */
function probeAll(songs, onUpdate, concurrency = 4) {
    let next = 0;
    const worker = async () => {
        while (next < songs.length) {
            const song = songs[next++];
            song.duration = await probeDuration(song.path);
            if (onUpdate) onUpdate(song);
        }
    };
    const workers = Array.from({ length: Math.min(concurrency, songs.length) }, worker);
    return Promise.all(workers);
}

/** What to show for a song: its tagged title, or the filename (minus its
 *  extension) when the file is untagged. */
function displayName(song) {
    return song.title || path.parse(song.name).name;
}

/**
 * Read every song's tags. This is in-process and takes about a millisecond per
 * file, so it's awaited before the first render — that way sorting by title
 * can't reshuffle the list under the user's cursor a moment after it appears.
 * A small pool keeps a huge folder from exhausting file handles.
 */
async function loadTags(songs, concurrency = 16) {
    let next = 0;
    const worker = async () => {
        while (next < songs.length) {
            const song = songs[next++];
            const tags = await readTags(song.path);
            song.title = tags.title || null;
            song.artist = tags.artist || null;
            song.album = tags.album || null;
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, songs.length) }, worker));
}

/** Sort by what the user actually sees, case-insensitively, with "2" before "10". */
function sortForDisplay(songs) {
    return songs.sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, {
        numeric: true,
        sensitivity: 'base',
    }));
}

/** Fisher-Yates shuffle of the indices 0..count-1. */
function shuffledOrder(count) {
    const order = Array.from({ length: count }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
}

module.exports = {
    load, loadTags, sortForDisplay, displayName, probeDuration, probeAll, shuffledOrder, AUDIO_EXTENSIONS,
};
