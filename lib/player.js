'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');

// ONE long-lived VLC process drives the whole session. Tracks are switched with
// `clear` + `add` rather than kill/spawn, so there is never more than one child
// and no async race can leave an orphan playing in the background.
//
// VLC's rc interface prints "> " after every command, which gives us a reliable
// response terminator. Commands are therefore queued and answered one at a time.

const PROMPT = '> ';
const COMMAND_TIMEOUT_MS = 2000;

class Player extends EventEmitter {
    constructor({ bin = 'vlc', pollMs = 250 } = {}) {
        super();
        this.bin = bin;
        this.pollMs = pollMs;

        this.child = null;
        this.state = 'stopped';   // 'playing' | 'paused' | 'stopped'
        this.time = null;         // seconds into the current track
        this.length = null;       // seconds, total
        this.volume = null;       // 0-256

        this._buffer = '';
        this._queue = [];
        this._active = null;
        this._ready = false;
        this._pollTimer = null;
        this._polling = false;
        this._sawPlayback = false; // guards end-of-track detection during startup
        this._closed = false;
    }

    // --- lifecycle --------------------------------------------------------

    start() {
        return new Promise((resolve, reject) => {
            try {
                this.child = spawn(this.bin, ['-I', 'rc', '--no-video', '--quiet']);
            } catch (err) {
                return reject(new Error(`Could not start ${this.bin}: ${err.message}`));
            }

            const failFast = (err) => {
                reject(err.code === 'ENOENT'
                    ? new Error(`'${this.bin}' was not found on your PATH. Install it with: brew install vlc`)
                    : err);
            };

            this.child.on('error', failFast);
            this.child.stdout.on('data', (chunk) => this._onData(chunk));
            this.child.stderr.on('data', () => { /* VLC logs noise here; ignore */ });
            this.child.on('close', () => {
                this._closed = true;
                this._stopPolling();
                this.emit('closed');
            });

            this._onReady = () => {
                this.child.off('error', failFast);
                this.child.on('error', (err) => this.emit('error', err));
                this._startPolling();
                resolve();
            };

            setTimeout(() => {
                if (!this._ready) reject(new Error(`${this.bin} did not respond to its rc interface in time`));
            }, 5000);
        });
    }

    async quit() {
        this._stopPolling();
        if (!this.child || this._closed) return;

        const exited = new Promise((resolve) => {
            this.child.once('close', resolve);
            setTimeout(() => {
                try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
                setTimeout(() => {
                    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
                    resolve();
                }, 700);
            }, 1200);
        });

        try { this.child.stdin.write('quit\n'); } catch { /* pipe already closed */ }
        await exited;
    }

    // --- rc command plumbing ---------------------------------------------

    _onData(chunk) {
        this._buffer += chunk.toString();
        if (!this._buffer.endsWith(PROMPT)) return;

        const body = this._buffer.slice(0, -PROMPT.length);
        this._buffer = '';

        const lines = body
            .split('\n')
            .map((line) => line.replace(/\r$/, '').trim())
            .filter((line) => line.length > 0);

        if (!this._ready) {
            // The first prompt follows VLC's startup banner.
            this._ready = true;
            if (this._onReady) this._onReady();
            return;
        }

        if (this._active) {
            clearTimeout(this._active.timer);
            const { resolve } = this._active;
            this._active = null;
            resolve(lines);
        }
        this._drain();
    }

    _drain() {
        if (this._active || this._queue.length === 0 || this._closed) return;

        const job = this._queue.shift();
        this._active = job;
        // A command that never gets an answer must not wedge the queue.
        job.timer = setTimeout(() => {
            this._active = null;
            job.resolve([]);
            this._drain();
        }, COMMAND_TIMEOUT_MS);

        try {
            this.child.stdin.write(job.command + '\n');
        } catch {
            clearTimeout(job.timer);
            this._active = null;
            job.resolve([]);
        }
    }

    send(command) {
        if (this._closed || !this.child) return Promise.resolve([]);
        return new Promise((resolve) => {
            this._queue.push({ command, resolve, timer: null });
            this._drain();
        });
    }

    // --- transport --------------------------------------------------------

    async playFile(songPath) {
        this.length = null;
        this.time = 0;
        this._sawPlayback = false;
        await this.send('clear');
        await this.send(`add ${songPath}`);
        this.state = 'playing';
    }

    async stop() {
        this._sawPlayback = false; // a deliberate stop must not fire 'ended'
        await this.send('stop');
        this.state = 'stopped';
        this.time = null;
        this.length = null;
    }

    /** VLC's `pause` is itself a toggle, so we let it own the truth and read the
     *  real state back from `status` on the next poll. */
    async togglePause() {
        if (this.state === 'stopped') return;
        await this.send('pause');
    }

    /** Relative seek in seconds; VLC accepts `seek +5` / `seek -5`. */
    async seek(deltaSeconds) {
        if (this.state === 'stopped') return;
        const sign = deltaSeconds >= 0 ? '+' : '';
        await this.send(`seek ${sign}${Math.trunc(deltaSeconds)}`);
    }

    async setVolume(value) {
        const clamped = Math.min(256, Math.max(0, Math.round(value)));
        await this.send(`volume ${clamped}`);
        this.volume = clamped;
    }

    // --- polling: VLC is the source of truth for time and state -----------

    _startPolling() {
        this._pollTimer = setInterval(() => this._poll(), this.pollMs);
    }

    _stopPolling() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
    }

    async _poll() {
        if (this._polling || this._closed) return;
        this._polling = true;

        try {
            const status = await this.send('status');
            const joined = status.join(' ');
            const stateMatch = joined.match(/\(\s*state\s+(\w+)\s*\)/);
            const volumeMatch = joined.match(/\(\s*audio volume:\s*(\d+)\s*\)/);

            if (stateMatch) this.state = stateMatch[1];
            if (volumeMatch) this.volume = Number(volumeMatch[1]);

            if (this.state === 'stopped') {
                // At end of track VLC returns an empty get_time and state stopped.
                this.time = null;
                if (this._sawPlayback) {
                    this._sawPlayback = false;
                    this.length = null;
                    this.emit('ended');
                }
            } else {
                this._sawPlayback = true;

                const timeLines = await this.send('get_time');
                const seconds = Number(timeLines[0]);
                this.time = timeLines.length && Number.isFinite(seconds) ? seconds : this.time;

                if (this.length === null) {
                    const lengthLines = await this.send('get_length');
                    const total = Number(lengthLines[0]);
                    if (lengthLines.length && Number.isFinite(total) && total > 0) this.length = total;
                }
            }

            this.emit('tick', { state: this.state, time: this.time, length: this.length, volume: this.volume });
        } catch (err) {
            this.emit('error', err);
        } finally {
            this._polling = false;
        }
    }
}

module.exports = { Player };
