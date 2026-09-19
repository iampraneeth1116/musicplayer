'use strict';

const { mmss, truncate, padEnd } = require('./format');

// All drawing happens here, in ONE full-frame write per render. Nothing else in
// the app touches stdout, so the screen can never be corrupted by a stray log.

const ESC = '\x1B';
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const HOME = `${ESC}[H`;
const CLEAR_TO_LINE_END = `${ESC}[0K`;
const CLEAR_BELOW = `${ESC}[0J`;
const CLEAR_SCREEN = `${ESC}[2J`;

const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const INVERSE = `${ESC}[7m`;
const CYAN = `${ESC}[36m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;

const CHROME_ROWS = 7; // header, rule, rule, now-playing, bar, rule, help

// Key hints in priority order. On a narrow terminal the tail is dropped, never
// the head — and `q quit` is reserved separately so the way out always shows.
const HELP_ITEMS = [
    ['↑↓', 'move'], ['⏎', 'play'], ['space', 'pause'], ['x', 'stop'], ['n/b', 'skip'],
    ['/', 'find'], ['←→', 'seek'], ['+/-', 'vol'], ['m', 'mute'], ['a', 'queue'],
    ['s', 'shuffle'], ['r', 'mode'], ['0-9', 'jump'], ['t', 'sleep'], ['[ ]', 'speed'],
];
const HELP_TAIL = 'q quit';

/** As many hints as fit in `width`. With a filter active, the hint for
 *  clearing it goes first, since it's the one the user needs right then. */
function helpLine(width, filterActive) {
    const items = filterActive ? [['esc', 'clear filter'], ...HELP_ITEMS] : HELP_ITEMS;
    let line = ' ';
    for (const [key, label] of items) {
        const candidate = `${line}${key} ${label} · `;
        if (candidate.length + HELP_TAIL.length > width) break;
        line = candidate;
    }
    return line + HELP_TAIL;
}

/** Switch to the alternate screen buffer so the user's shell is untouched. */
function enter() {
    process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN + HOME);
}

/** Always paired with enter() — restores the terminal exactly as we found it. */
function leave() {
    process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
}

function size() {
    // Use the REAL width. Clamping up to a minimum would push lines past the
    // edge of a narrow terminal and wrap them, breaking the in-place redraw.
    return {
        width: Math.max(20, process.stdout.columns || 80),
        height: Math.max(6, process.stdout.rows || 24),
    };
}

function progressBar(fraction, width) {
    const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
    return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** Keep the cursor row inside the visible window as the list scrolls. */
function viewport(total, cursor, height) {
    if (total <= height) return { start: 0, end: total };
    let start = cursor - Math.floor(height / 2);
    start = Math.max(0, Math.min(start, total - height));
    return { start, end: start + height };
}

function stateIcon(state) {
    if (state === 'playing') return '▶';
    if (state === 'paused') return '❚❚';
    return '■';
}

function render(model) {
    const { width, height } = size();
    const listHeight = Math.max(1, height - CHROME_ROWS);
    const rule = '─'.repeat(width);
    const lines = [];

    // --- header -----------------------------------------------------------
    const badges = [];
    if (model.shuffle) badges.push('shuffle');
    // Show what VLC reports; fall back to the chosen speed if it can't say.
    const shownRate = model.reportedRate ?? model.rate;
    if (shownRate !== 1) badges.push(`${shownRate}×`);
    if (model.queue.length) badges.push(`queue ${model.queue.length}`);
    if (model.sleepAt) {
        // ceil, so the badge reads 0:01 (not 0:00) until the moment it fires
        badges.push(`sleep ${mmss(Math.ceil(Math.max(0, model.sleepAt - Date.now()) / 1000))}`);
    }
    if (model.repeat === 'stop') badges.push('stop after track');
    else if (model.repeat !== 'off') badges.push(`repeat ${model.repeat}`);
    const title = ' ♪  Terminal Music Player';
    const right = badges.length ? badges.join(' · ') + ' ' : '';
    lines.push(BOLD + CYAN + truncate(padEnd(title, width - right.length) + right, width) + RESET);
    lines.push(DIM + rule + RESET);

    // --- song list --------------------------------------------------------
    if (model.songs.length === 0) {
        const empty = model.query
            ? `  no songs match "${model.query}"`
            : '  no playable audio files in this folder';
        lines.push(DIM + truncate(empty, width) + RESET);
        for (let i = 1; i < listHeight; i++) lines.push('');
    } else {
        const { start, end } = viewport(model.songs.length, model.cursor, listHeight);
        // An artist column appears only when some song has an artist; with
        // none, the title gets the whole width rather than an empty column.
        const showArtists = model.songs.some((song) => song.artist);

        for (let i = start; i < end; i++) {
            const song = model.songs[i];
            const isPlaying = song.path === model.currentPath;
            const isCursor = i === model.cursor;

            // The marker column shows the play state, or a queued song's position.
            const queuePosition = model.queue.indexOf(song.path);
            let marker = ' ';
            if (isPlaying) marker = stateIcon(model.playerState);
            else if (queuePosition !== -1) marker = queuePosition < 99 ? String(queuePosition + 1) : '+';
            const duration = mmss(song.duration);
            // Row is: space + marker(2) + space + name area + 2 spaces + duration + space
            const nameWidth = Math.max(4, width - duration.length - 7);
            const title = song.title || song.name.replace(/\.[^.]+$/, '');

            let nameArea;
            if (showArtists && nameWidth >= 24) {
                // name area = title + 2 spaces + artist, summing to exactly nameWidth
                const artistWidth = Math.floor(nameWidth * 0.4);
                const titleWidth = nameWidth - artistWidth - 2;
                nameArea = padEnd(truncate(title, titleWidth), titleWidth)
                    + '  ' + padEnd(truncate(song.artist || '', artistWidth), artistWidth);
            } else {
                nameArea = padEnd(truncate(title, nameWidth), nameWidth);
            }
            const text = ` ${padEnd(marker, 2)} ${nameArea}  ${duration} `;

            if (isCursor) lines.push(INVERSE + truncate(text, width) + RESET);
            else if (isPlaying) lines.push(GREEN + truncate(text, width) + RESET);
            else lines.push(truncate(text, width));
        }
        for (let i = end - start; i < listHeight; i++) lines.push('');
    }

    // --- now playing + progress ------------------------------------------
    lines.push(DIM + rule + RESET);

    // Truncate the PLAIN text first, then colour it — measuring a string that
    // already contains escape codes counts the codes as visible width.
    const byArtist = model.currentArtist ? ` — ${model.currentArtist}` : '';
    const nowPlaying = model.currentName
        ? `${padEnd(stateIcon(model.playerState), 2)}  ${model.currentName}${byArtist}`
        : `${padEnd(stateIcon('stopped'), 2)}  nothing playing`;
    const nowPlayingText = truncate(nowPlaying, width - 1);
    lines.push(' ' + (model.currentName ? BOLD + nowPlayingText : DIM + nowPlayingText) + RESET);

    const times = `${mmss(model.time)} / ${mmss(model.length)}`;
    let volumeText = '';
    if (model.muted) volumeText = '  muted';
    else if (model.volume !== null) volumeText = `  vol ${Math.round((model.volume / 256) * 100)}%`;
    const fraction = model.length ? (model.time || 0) / model.length : 0;
    const barWidth = width - times.length - volumeText.length - 5;

    if (barWidth < 8) {
        // Too narrow for a meaningful bar: drop it rather than overflow the
        // line, which would wrap and break the in-place redraw.
        lines.push(' ' + truncate(times + volumeText, width - 1));
    } else {
        lines.push(' ' + CYAN + progressBar(fraction, barWidth) + RESET + `  ${times}` + DIM + volumeText + RESET);
    }

    lines.push(DIM + rule + RESET);

    // --- footer -----------------------------------------------------------
    if (model.filterMode) {
        lines.push(YELLOW + truncate(` filter: ${model.query}▏`, width) + RESET);
    } else if (model.message) {
        lines.push(YELLOW + truncate(' ' + model.message, width) + RESET);
    } else {
        lines.push(DIM + helpLine(width, Boolean(model.query)) + RESET);
    }

    process.stdout.write(HOME + lines.join(CLEAR_TO_LINE_END + '\n') + CLEAR_TO_LINE_END + CLEAR_BELOW);
}

module.exports = { enter, leave, render, size };
