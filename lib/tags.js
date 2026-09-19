'use strict';

// Reads title / artist / album straight from an audio file's ID3 tags, in
// process — no child process, and no need to load the file into VLC.
//
// ID3v2 (versions 2.2, 2.3 and 2.4) sits at the START of the file. ID3v1 is a
// fixed 128-byte block at the very END, and is only used as a fallback.
//
// Frames are walked with positional reads, so large frames such as embedded
// album art are skipped over instead of being read into memory.

const fs = require('fs/promises');

const WANTED_FRAMES = {
    TIT2: 'title', TPE1: 'artist', TALB: 'album', // ID3v2.3 / v2.4
    TT2: 'title', TP1: 'artist', TAL: 'album',    // ID3v2.2 uses 3-letter ids
};

const MAX_TEXT_FRAME_BYTES = 64 * 1024;       // a title larger than this is corrupt
const MAX_UNSYNC_TAG_BYTES = 16 * 1024 * 1024;

/** ID3 "syncsafe" integer: 4 bytes, 7 bits each, so no byte is ever 0xFF. */
function syncsafe(buffer, offset) {
    return ((buffer[offset] & 0x7f) << 21)
        | ((buffer[offset + 1] & 0x7f) << 14)
        | ((buffer[offset + 2] & 0x7f) << 7)
        | (buffer[offset + 3] & 0x7f);
}

/** Undo ID3 "unsynchronisation": the writer inserted 0x00 after every 0xFF. */
function deUnsync(buffer) {
    const out = Buffer.alloc(buffer.length);
    let length = 0;
    for (let i = 0; i < buffer.length; i++) {
        out[length++] = buffer[i];
        if (buffer[i] === 0xff && buffer[i + 1] === 0x00) i++;
    }
    return out.subarray(0, length);
}

/** Node has no UTF-16 big-endian decoder, so flip each byte pair first. */
function swapBytePairs(buffer) {
    const even = buffer.subarray(0, buffer.length - (buffer.length % 2));
    return Buffer.from(even).swap16();
}

/** Decode a text frame. The first byte names the encoding; v2.4 may hold
 *  several values separated by NULs, which are joined with ", ". */
function decodeText(body) {
    if (body.length < 2) return '';
    const data = body.subarray(1);
    let text;

    switch (body[0]) {
        case 0: text = data.toString('latin1'); break;
        case 1: // UTF-16, byte order given by a BOM
            text = data[0] === 0xfe && data[1] === 0xff
                ? swapBytePairs(data).toString('utf16le')
                : data.toString('utf16le');
            break;
        case 2: text = swapBytePairs(data).toString('utf16le'); break; // UTF-16BE, no BOM
        case 3: text = data.toString('utf8'); break;
        default: return '';
    }

    return text
        .split('\u0000')
        .map((value) => value.replace(/\uFEFF/g, '').trim())
        .filter(Boolean)
        .join(', ');
}

/** Strip the extra bytes a frame's flags can add; null means "can't read it". */
function frameBody(body, major, flagByte, unsyncAll) {
    if (major === 3) {
        if (flagByte & 0xc0) return null;                  // compressed or encrypted
        if (flagByte & 0x20) body = body.subarray(1);      // grouping id
        return body;
    }
    if (major === 4) {
        if (flagByte & 0x0c) return null;                  // compressed or encrypted
        if (flagByte & 0x40) body = body.subarray(1);      // grouping id
        if (flagByte & 0x01) body = body.subarray(4);      // data length indicator
        if ((flagByte & 0x02) || unsyncAll) body = deUnsync(body);
        return body;
    }
    return body; // v2.2 frames have no flags
}

async function readId3v2(handle) {
    const header = Buffer.alloc(10);
    const { bytesRead } = await handle.read(header, 0, 10, 0);
    if (bytesRead < 10 || header.toString('latin1', 0, 3) !== 'ID3') return {};

    const major = header[3];
    const flags = header[5];
    let tagSize = syncsafe(header, 6);
    if (major < 2 || major > 4 || tagSize === 0) return {};
    if (major === 2 && (flags & 0x40)) return {}; // v2.2 "compression" was never defined

    // readAt reads relative to the start of the tag body (just after the header).
    let readAt = async (offset, length) => {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, 10 + offset);
        return buffer.subarray(0, result.bytesRead);
    };

    // In v2.2/v2.3 unsynchronisation covers the whole tag, frame headers
    // included, so frame boundaries only exist after reversing it. That case
    // is rare and is read into memory in one go.
    if ((flags & 0x80) && major < 4) {
        const raw = await readAt(0, Math.min(tagSize, MAX_UNSYNC_TAG_BYTES));
        const body = deUnsync(raw);
        tagSize = body.length;
        readAt = async (offset, length) => body.subarray(offset, offset + length);
    }

    let offset = 0;
    if (flags & 0x40) { // extended header: skip it
        const size = await readAt(0, 4);
        if (size.length < 4) return {};
        offset = major === 3 ? 4 + size.readUInt32BE(0) : syncsafe(size, 0);
    }

    const idLength = major === 2 ? 3 : 4;
    const headerLength = major === 2 ? 6 : 10;
    const tags = {};

    while (offset + headerLength <= tagSize) {
        const frameHeader = await readAt(offset, headerLength);
        if (frameHeader.length < headerLength || frameHeader[0] === 0) break; // padding

        const id = frameHeader.toString('latin1', 0, idLength);
        if (!/^[A-Z0-9]+$/.test(id)) break; // not a frame: stop rather than guess

        let size;
        if (major === 2) size = (frameHeader[3] << 16) | (frameHeader[4] << 8) | frameHeader[5];
        else if (major === 3) size = frameHeader.readUInt32BE(4);
        else size = syncsafe(frameHeader, 4);

        const bodyStart = offset + headerLength;
        if (size <= 0 || bodyStart + size > tagSize) break;

        const field = WANTED_FRAMES[id];
        if (field && !tags[field] && size <= MAX_TEXT_FRAME_BYTES) {
            const raw = await readAt(bodyStart, size);
            const body = frameBody(raw, major, frameHeader[9], (flags & 0x80) !== 0);
            const text = body ? decodeText(body) : '';
            if (text) tags[field] = text;
        }

        if (tags.title && tags.artist && tags.album) break;
        offset = bodyStart + size; // skip everything else, album art included
    }

    return tags;
}

async function readId3v1(handle, fileSize) {
    if (fileSize < 128) return {};
    const block = Buffer.alloc(128);
    await handle.read(block, 0, 128, fileSize - 128);
    if (block.toString('latin1', 0, 3) !== 'TAG') return {};

    const field = (start) => block.toString('latin1', start, start + 30).split('\u0000')[0].trim();
    const tags = {};
    for (const [name, start] of [['title', 3], ['artist', 33], ['album', 63]]) {
        const value = field(start);
        if (value) tags[name] = value;
    }
    return tags;
}

/**
 * Read { title, artist, album } from a file. Any field may be missing.
 * Never throws: an unreadable or untagged file simply yields {}.
 */
async function readTags(filePath) {
    let handle;
    try {
        handle = await fs.open(filePath, 'r');
        const v2 = await readId3v2(handle);
        if (v2.title && v2.artist && v2.album) return v2;

        const { size } = await handle.stat();
        const v1 = await readId3v1(handle, size);
        return { ...v1, ...v2 }; // ID3v2 wins wherever it has a value
    } catch {
        return {};
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
}

module.exports = { readTags, decodeText, syncsafe, deUnsync };
