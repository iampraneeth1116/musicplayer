'use strict';

/** Seconds -> m:ss (or h:mm:ss). Returns a placeholder for unknown values. */
function mmss(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '--:--';
    const total = Math.max(0, Math.floor(seconds));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins >= 60) {
        const hours = Math.floor(mins / 60);
        return `${hours}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Cut text to width, marking the cut with an ellipsis. */
function truncate(text, width) {
    if (width <= 0) return '';
    if (text.length <= width) return text;
    if (width === 1) return '…';
    return text.slice(0, width - 1) + '…';
}

function padEnd(text, width) {
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

module.exports = { mmss, truncate, padEnd, clamp };
