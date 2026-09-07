'use strict';

// Raw-mode stdin gives us bytes, not characters. A single chunk may contain
// SEVERAL keypresses (held keys, fast typing, a pasted string), so we decode a
// STREAM of key events out of every chunk instead of only inspecting data[0].

const NAMED_BYTES = {
    0x0d: 'enter',
    0x0a: 'enter',
    0x03: 'ctrl-c',
    0x7f: 'backspace',
    0x08: 'backspace',
    0x09: 'tab',
};

// Final byte of a CSI escape sequence -> key name.
const CSI_FINAL = {
    0x41: 'up',
    0x42: 'down',
    0x43: 'right',
    0x44: 'left',
    0x48: 'home',
    0x46: 'end',
};

// CSI sequences of the form ESC [ <n> ~
const CSI_TILDE = { '1': 'home', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown' };

/**
 * Decode a raw stdin Buffer into an array of key events.
 * Each event is { name } and, for printable input, { name: 'char', ch }.
 */
function decode(buffer) {
    const keys = [];
    let i = 0;

    while (i < buffer.length) {
        const byte = buffer[i];

        // --- escape sequences -------------------------------------------------
        if (byte === 0x1b) {
            if (buffer[i + 1] === 0x5b) {
                // Skip parameter bytes (0x30-0x3f) until the final byte.
                let j = i + 2;
                while (j < buffer.length && buffer[j] >= 0x30 && buffer[j] <= 0x3f) j++;

                if (j >= buffer.length) break; // sequence split across chunks: drop the tail
                const final = buffer[j];
                const params = buffer.slice(i + 2, j).toString('ascii');

                if (CSI_FINAL[final]) keys.push({ name: CSI_FINAL[final] });
                else if (final === 0x7e && CSI_TILDE[params]) keys.push({ name: CSI_TILDE[params] });

                i = j + 1;
                continue;
            }
            keys.push({ name: 'escape' });
            i += 1;
            continue;
        }

        // --- space: named, but also a printable character ---------------------
        if (byte === 0x20) {
            keys.push({ name: 'space', ch: ' ' });
            i += 1;
            continue;
        }

        if (NAMED_BYTES[byte]) {
            keys.push({ name: NAMED_BYTES[byte] });
            i += 1;
            continue;
        }

        if (byte > 0x20 && byte < 0x7f) {
            keys.push({ name: 'char', ch: String.fromCharCode(byte) });
            i += 1;
            continue;
        }

        i += 1; // ignore any other control byte
    }

    return keys;
}

module.exports = { decode };
