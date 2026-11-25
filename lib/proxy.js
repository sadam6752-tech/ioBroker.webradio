'use strict';

/*
 * The stream proxy: a player that cannot play the station itself (ESPHome takes only plain MP3/FLAC over http, no AAC,
 * no HLS, no https) fetches http://<host>:<port>/play/<target>.<codec>. The adapter opens the station (following
 * redirects and playlists), takes the ICY titles out, and ffmpeg turns the audio into FLAC or MP3.
 */

const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { IcyStripper, parsePlaylist, kindOf, looksLikePlaylist } = require('./icy');
const { StreamJoiner } = require('./broadcast');

/**
 * @typedef {import('./types').Logger} Logger
 * @typedef {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (h: unknown) => void}} Timers
 */

const CONTENT_TYPES = { flac: 'audio/flac', mp3: 'audio/mpeg' };
/** A player that does not read for this many bytes is dropped instead of filling the memory. */
const MAX_BACKLOG = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 64 * 1024;
/** Playlists inside playlists */
const MAX_PLAYLIST_DEPTH = 3;
const CONNECT_TIMEOUT_MS = 10_000;
/** Attempts to open a station again after it dropped, before the player is stopped */
const MAX_RETRIES = 5;

/**
 * GET with redirects (also between http and https). The response carries the final URL as `finalUrl`.
 *
 * The parser is lenient (`insecureHTTPParser`): stream servers like QuantumCast end the status line with a bare LF,
 * which Node's strict parser refuses ("Missing expected CR after response line") while VLC, browsers and curl play.
 * The answers are audio for ffmpeg or a playlist read as text, never headers the adapter trusts for anything else.
 *
 * @param {string} url - URL
 * @param {Record<string, string>} headers - Request headers
 * @param {number} [redirects] - Redirects left
 * @returns {Promise<http.IncomingMessage & {finalUrl: string}>} Response (body not read)
 */
function get(url, headers, redirects = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(url);
        } catch {
            reject(new Error(`not a URL: ${url}`));
            return;
        }
        const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
        if (!lib) {
            reject(new Error(`unsupported protocol ${u.protocol}`));
            return;
        }
        const req = lib.get(u, { headers, insecureHTTPParser: true }, res => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirects <= 0) {
                    reject(new Error('too many redirects'));
                    return;
                }
                resolve(get(new URL(res.headers.location, u).href, headers, redirects - 1));
                return;
            }
            if (status < 200 || status >= 300) {
                res.resume();
                reject(new Error(`HTTP ${status}`));
                return;
            }
            resolve(Object.assign(res, { finalUrl: u.href }));
        });
        req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error('no answer')));
        req.on('error', reject);
    });
}

/**
 * @param {http.IncomingMessage} res - Response
 * @returns {Promise<string>} Body (at most MAX_PLAYLIST_BYTES)
 */
function readSmallBody(res) {
    return new Promise((resolve, reject) => {
        /** @type {Buffer[]} */
        const parts = [];
        let size = 0;
        res.on('data', d => {
            size += d.length;
            if (size > MAX_PLAYLIST_BYTES) {
                res.destroy();
                resolve(Buffer.concat(parts).toString('utf8'));
                return;
            }
            parts.push(d);
        });
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        res.on('error', reject);
        res.resume(); // peek() leaves it paused
    });
}

/**
 * The first chunk of a body, put back so that the reader still gets the whole body.
 *
 * @param {http.IncomingMessage} res - Response, not read yet
 * @returns {Promise<Buffer>} First chunk (empty when the body is empty)
 */
function peek(res) {
    return new Promise((resolve, reject) => {
        const done = () => {
            res.off('data', onData);
            res.off('end', onEnd);
            res.off('error', onError);
        };
        const onData = d => {
            done();
            res.pause();
            res.unshift(d);
            resolve(d);
        };
        const onEnd = () => {
            done();
            resolve(Buffer.alloc(0));
        };
        const onError = e => {
            done();
            reject(e);
        };
        res.on('data', onData);
        res.on('end', onEnd);
        res.on('error', onError);
    });
}

/**
 * `entry` is the URL a player that plays by itself should get: the stream URL that the (last) playlist names, else the
 * station URL. Redirects are not resolved into it, their targets often carry short-lived tokens.
 *
 * @typedef {{hls: string, entry: string} | {res: http.IncomingMessage, metaInt: number, url: string, contentType: string, entry: string}} OpenSource
 */

/**
 * Opens a station: follows redirects and playlists (m3u, pls, asx, xspf — told by the Content-Type or the body, not by
 * the extension); HLS is handed to ffmpeg as a URL.
 *
 * @param {string} url - Station URL
 * @param {string} userAgent - User-Agent
 * @param {number} [depth] - Playlist depth
 * @returns {Promise<OpenSource>} Open audio response, or the HLS URL
 */
async function openSource(url, userAgent, depth = 0) {
    const res = await get(url, { 'User-Agent': userAgent, 'Icy-MetaData': '1', Accept: '*/*' });
    const contentType = String(res.headers['content-type'] || '');
    let kind = kindOf(contentType, res.finalUrl);
    if (kind === 'sniff') {
        kind = looksLikePlaylist(await peek(res)) ? 'playlist' : 'audio';
    }
    if (kind === 'playlist') {
        const found = parsePlaylist(await readSmallBody(res), res.finalUrl);
        if (found && 'hls' in found) {
            return { hls: res.finalUrl, entry: url };
        }
        if (!found) {
            throw new Error('the playlist names no stream');
        }
        if (depth >= MAX_PLAYLIST_DEPTH) {
            throw new Error('too many playlists in playlists');
        }
        return openSource(found.url, userAgent, depth + 1);
    }
    return { res, metaInt: Number(res.headers['icy-metaint']) || 0, url: res.finalUrl, contentType, entry: url };
}

/**
 * Whether a station answers: it opens (redirects and playlists followed) with an audio stream or HLS.
 *
 * @param {string} url - Station URL
 * @param {string} userAgent - User-Agent
 * @returns {Promise<void>} Resolves when it answers, rejects with the reason
 */
async function probeUrl(url, userAgent) {
    const src = await openSource(url, userAgent);
    if ('res' in src) {
        src.res.destroy();
    }
}

/**
 * The URL to give a player that plays the station by itself: the stream inside a playlist, which many players
 * (Dune HD, media players of other adapters) cannot read. Falls back to the station URL.
 *
 * @param {string} url - Station URL
 * @param {string} userAgent - User-Agent
 * @returns {Promise<string>} URL
 */
async function playableUrl(url, userAgent) {
    const src = await openSource(url, userAgent);
    if ('res' in src) {
        src.res.destroy();
    }
    return src.entry;
}

/**
 * Reads a station and its titles; opens it again when the connection drops (up to MAX_RETRIES times in a row).
 */
class SourceReader {
    /**
     * @param {object} o - Options
     * @param {string} o.url - Station URL
     * @param {string} o.name - For log lines
     * @param {string} o.userAgent - User-Agent
     * @param {Timers} o.timers - Adapter timers
     * @param {Logger} o.log - Logger
     * @param {(title: string) => void} o.onTitle - A new ICY title
     * @param {(data: Buffer) => void} [o.onData] - Audio (without the metadata); none = only the titles are read
     * @param {(url: string) => void} [o.onHls] - The station is HLS (no ICY titles)
     * @param {(why: string) => void} [o.onEnd] - Given up
     * @param {(src: OpenSource) => Promise<OpenSource>} [o.open] - Opener (tests)
     */
    constructor(o) {
        this.o = o;
        this.stopped = false;
        this.retries = 0;
        /** @type {http.IncomingMessage | null} */
        this.res = null;
        /** @type {unknown} */
        this.timer = null;
    }

    /**
     * @param {OpenSource} [first] - Already open source
     */
    start(first) {
        void this.open(first);
    }

    /**
     * @param {OpenSource} [first] - Already open source
     */
    async open(first) {
        this.timer = null;
        let src;
        try {
            src = first || (await openSource(this.o.url, this.o.userAgent));
        } catch (e) {
            this.retry(e.message);
            return;
        }
        if (this.stopped) {
            if ('res' in src) {
                src.res.destroy();
            }
            return;
        }
        if ('hls' in src) {
            this.o.onHls?.(src.hls);
            return;
        }
        const res = src.res;
        this.res = res;
        const strip = new IcyStripper(src.metaInt, t => this.o.onTitle(t));
        let over = false;
        const again = why => {
            if (!over) {
                over = true;
                res.unpipe(strip);
                res.destroy();
                if (!this.stopped) {
                    this.retry(why);
                }
            }
        };
        strip.on('data', d => {
            this.retries = 0;
            this.o.onData?.(d);
        });
        res.on('end', () => again('the station ended the stream'));
        res.on('close', () => again('the connection was closed'));
        res.on('error', e => again(e.message));
        res.pipe(strip);
    }

    /**
     * @param {string} why - Reason
     */
    retry(why) {
        if (this.stopped) {
            return;
        }
        this.retries++;
        if (this.retries > MAX_RETRIES) {
            this.o.log.warn(`${this.o.name}: the station cannot be played: ${why}`);
            this.stopped = true;
            this.o.onEnd?.(why);
            return;
        }
        this.o.log.debug(`${this.o.name}: ${why}, opening the station again (${this.retries}/${MAX_RETRIES})`);
        this.timer = this.o.timers.setTimeout(() => void this.open(), 1000 * this.retries);
    }

    /** Stops reading for good. */
    stop() {
        this.stopped = true;
        this.o.timers.clearTimeout(this.timer);
        this.timer = null;
        this.res?.destroy();
        this.res = null;
    }
}

/**
 * ffmpeg arguments: any audio (or an HLS URL) in, FLAC or MP3 out.
 *
 * @param {'flac' | 'mp3'} codec - Output codec
 * @param {number} sampleRate - Output sample rate
 * @param {number} channels - Output channels
 * @param {string} [hlsUrl] - Read this HLS URL instead of stdin
 * @returns {string[]} Arguments
 */
function ffmpegArgs(codec, sampleRate, channels, hlsUrl) {
    // MP3 like an internet radio: no ID3 tag, no Xing header; FLAC in 16 bit
    const out =
        codec === 'mp3'
            ? ['-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3']
            : ['-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', '2', '-f', 'flac'];
    const input = hlsUrl ? ['-reconnect', '1', '-reconnect_streamed', '1', '-i', hlsUrl] : ['-i', 'pipe:0'];
    // prettier-ignore
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...input,
        '-map', '0:a:0', '-map_metadata', '-1', '-vn',
        '-ar', String(sampleRate), '-ac', String(channels),
        ...out,
        '-flush_packets', '1',
        'pipe:1',
    ];
}

/**
 * @typedef {{channel: Channel, res: http.ServerResponse, aligned: boolean, fromStart: boolean}} Listener
 */

/**
 * One station in one format for any number of players: one connection to the station, one ffmpeg (multiroom).
 */
class Broadcast {
    /**
     * @param {object} o - Options
     * @param {string} o.url - Station URL
     * @param {'flac' | 'mp3'} o.codec - Output codec
     * @param {number} o.sampleRate - Output sample rate
     * @param {number} o.channels - Output channels
     * @param {string} o.ffmpegPath - ffmpeg binary
     * @param {string} o.userAgent - User-Agent towards the station
     * @param {Timers} o.timers - Adapter timers
     * @param {Logger} o.log - Logger
     * @param {() => void} o.onClose - The last listener left: the broadcast is over
     */
    constructor(o) {
        this.o = o;
        /** @type {Set<Listener>} */
        this.listeners = new Set();
        this.joiner = new StreamJoiner(o.codec);
        /** @type {import('node:child_process').ChildProcess | null} */
        this.proc = null;
        /** @type {SourceReader | null} */
        this.reader = null;
        this.opened = false;
        this.closed = false;
        /** The last ICY title, for a player that joins later */
        this.title = '';
    }

    /** @returns {string} Names of the players, for log lines */
    get names() {
        return [...new Set([...this.listeners].map(l => l.channel.o.name))].join(', ') || '–';
    }

    /**
     * @param {Channel} channel - Player
     * @param {http.ServerResponse} res - Its response (headers sent)
     * @returns {Listener} Listener
     */
    add(channel, res) {
        /** @type {Listener} */
        const l = { channel, res, aligned: false, fromStart: this.joiner.sent === 0 };
        this.listeners.add(l);
        if (this.title) {
            channel.o.onTitle(this.title);
        }
        if (!this.opened) {
            this.opened = true;
            void this.open();
        } else {
            this.o.log.debug(`${channel.o.name}: joins the stream of ${this.names}`);
        }
        return l;
    }

    /**
     * @param {Listener} l - Listener that left
     */
    remove(l) {
        this.listeners.delete(l);
        if (!this.listeners.size) {
            this.close();
        }
    }

    /** Opens the station and starts ffmpeg. */
    async open() {
        /** @type {OpenSource} */
        let first;
        try {
            first = await openSource(this.o.url, this.o.userAgent);
        } catch (e) {
            this.o.log.warn(`${this.names}: cannot open the station: ${e.message}`);
            this.endAll(e.message);
            return;
        }
        if (this.closed) {
            if ('res' in first) {
                first.res.destroy();
            }
            return;
        }
        const hls = 'hls' in first ? first.hls : undefined;
        const proc = spawn(this.o.ffmpegPath, ffmpegArgs(this.o.codec, this.o.sampleRate, this.o.channels, hls), {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.proc = proc;
        let stderr = '';
        proc.stderr?.on('data', d => {
            stderr = (stderr + d).slice(-2000);
        });
        proc.stdin?.on('error', () => undefined);
        proc.on('error', e => {
            this.o.log.warn(`${this.names}: ffmpeg did not start: ${e.message}`);
            this.endAll(`ffmpeg did not start: ${e.message}`, false);
        });
        proc.on('exit', code => {
            if (code && stderr.trim() && !this.closed) {
                this.o.log.warn(`${this.names}: ffmpeg ended with code ${code}: ${stderr.trim().split('\n').pop()}`);
            }
            this.endAll('ffmpeg ended', false);
        });
        proc.stdout?.on('data', d => this.feed(d));
        if (hls) {
            proc.stdin?.end();
            return;
        }
        const reader = new SourceReader({
            url: this.o.url,
            name: this.names,
            userAgent: this.o.userAgent,
            timers: this.o.timers,
            log: this.o.log,
            onTitle: t => {
                this.title = t;
                for (const c of new Set([...this.listeners].map(l => l.channel))) {
                    c.o.onTitle(t);
                }
            },
            onData: d => {
                const stdin = proc.stdin;
                if (!stdin || stdin.destroyed) {
                    return;
                }
                if (stdin.writableLength > MAX_BACKLOG) {
                    this.o.log.warn(`${this.names}: ffmpeg does not keep up with the station, ending the stream`);
                    this.endAll('ffmpeg does not keep up', false);
                    return;
                }
                stdin.write(d);
            },
            onEnd: why => this.endAll(why),
        });
        this.reader = reader;
        reader.start(first);
    }

    /**
     * Output of ffmpeg to every listener; a listener that joined late starts at the next frame, after the header.
     *
     * @param {Buffer} chunk - Output of ffmpeg
     */
    feed(chunk) {
        const data = this.joiner.take(chunk);
        if (!data.length) {
            return;
        }
        for (const l of [...this.listeners]) {
            if (!l.aligned) {
                const at = l.fromStart ? 0 : this.joiner.frameStart(data);
                if (at < 0) {
                    continue;
                }
                l.aligned = true;
                l.res.write(this.joiner.header);
                l.res.write(at ? data.subarray(at) : data);
            } else {
                l.res.write(data);
            }
            if (l.res.writableLength > MAX_BACKLOG) {
                this.o.log.warn(`${l.channel.o.name}: the player does not read the stream, disconnecting it`);
                this.listeners.delete(l);
                l.channel.leave(l);
            }
        }
    }

    /**
     * The station or ffmpeg ended: every player stops.
     *
     * @param {string} why - Reason
     * @param {boolean} [tell] - Tell the players (they stop and report it)
     */
    endAll(why, tell = true) {
        if (this.closed) {
            return;
        }
        const listeners = [...this.listeners];
        this.close();
        for (const l of listeners) {
            l.channel.leave(l, tell ? why : '');
        }
    }

    /** Ends the broadcast. */
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.reader?.stop();
        const proc = this.proc;
        if (proc) {
            proc.stdout?.removeAllListeners('data');
            proc.stdout?.resume();
            if (proc.exitCode === null && !proc.killed) {
                proc.kill('SIGKILL');
            }
        }
        this.o.onClose();
    }
}

/**
 * The stream of one player: http://<host>:<port>/play/<target>.<codec>. Players with the same station and format
 * listen to the same Broadcast of the StreamServer.
 */
class Channel {
    /**
     * @param {object} o - Options
     * @param {string} o.id - Target id (path)
     * @param {string} o.name - For log lines
     * @param {'flac' | 'mp3'} o.codec - Output codec
     * @param {number} o.sampleRate - Output sample rate
     * @param {number} o.channels - Output channels
     * @param {string} o.ffmpegPath - ffmpeg binary
     * @param {string} o.userAgent - User-Agent towards the station
     * @param {Timers} o.timers - Adapter timers
     * @param {Logger} o.log - Logger
     * @param {(title: string) => void} o.onTitle - ICY title of the station
     * @param {(why: string) => void} o.onEnd - The station cannot be played any more
     */
    constructor(o) {
        this.o = o;
        /** @type {string} station URL, empty = nothing to play */
        this.source = '';
        /** @type {{res: http.ServerResponse, listener: Listener | null, broadcast: Broadcast | null} | null} */
        this.client = null;
        /** @type {StreamServer | null} set by StreamServer.add */
        this.server = null;
    }

    /** @returns {string} Path of the stream */
    get path() {
        return `/play/${this.o.id}.${this.o.codec}`;
    }

    /**
     * @param {string} url - Station URL, empty = stop
     */
    setSource(url) {
        this.source = url;
        this.disconnect();
    }

    /**
     * @param {http.IncomingMessage} req - Request
     * @param {http.ServerResponse} res - Response
     */
    async serve(req, res) {
        const url = this.source;
        if (!url || !this.server) {
            res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Nothing is playing');
            return;
        }
        const headers = {
            'Content-Type': CONTENT_TYPES[this.o.codec],
            'Cache-Control': 'no-cache, no-store',
            Connection: 'close',
        };
        // ioBroker.assistant looks at the headers first and drops the connection: no station and no ffmpeg for that
        if (req.method === 'HEAD' || /^ioBroker.assistant/i.test(String(req.headers['user-agent'] || ''))) {
            res.writeHead(200, headers).end();
            return;
        }
        this.disconnect();
        // like an internet radio: no chunked transfer, the body runs until the connection closes (the HTTP client of
        // ESP-IDF hangs on stop when it has to read a chunked endless body to its end)
        res.useChunkedEncodingByDefault = false;
        res.writeHead(200, headers);
        res.flushHeaders();
        const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        this.o.log.debug(`${this.o.name}: stream ${this.path} to ${peer}`);
        const broadcast = this.server.broadcastFor(this, url);
        const client = { res, listener: /** @type {Listener | null} */ (null), broadcast };
        this.client = client;
        res.on('close', () => this.drop(client));
        client.listener = broadcast.add(this, res);
    }

    /**
     * The broadcast lets this player go (it ended, or the player does not read).
     *
     * @param {Listener} listener - The listener of this channel
     * @param {string} [why] - Reason to report (the station cannot be played), empty = none
     */
    leave(listener, why = '') {
        const client = this.client?.listener === listener ? this.client : null;
        if (!client) {
            // not the current listener of this player any more: the broadcast has let it go already
            if (!listener.res.writableEnded) {
                listener.res.end();
            }
            return;
        }
        this.drop(client);
        if (why) {
            this.o.onEnd(why);
        }
    }

    /**
     * @param {{res: http.ServerResponse, listener: Listener | null, broadcast: Broadcast | null}} client - Listener to end
     */
    drop(client) {
        if (this.client === client) {
            this.client = null;
        }
        if (client.listener) {
            client.broadcast?.remove(client.listener);
            client.listener = null;
        }
        if (!client.res.writableEnded) {
            client.res.end();
        }
    }

    /** Ends the current listener. */
    disconnect() {
        if (this.client) {
            this.drop(this.client);
        }
    }
}

/**
 * The HTTP server: `/play/<target>.<codec>` (proxied streams) and `/logo/<station>` (cached logos).
 */
class StreamServer {
    /**
     * @param {Logger} log - Logger
     * @param {(id: string) => Promise<{data: Buffer, type: string} | null>} logo - Cached logo of a station
     */
    constructor(log, logo) {
        this.log = log;
        this.logo = logo;
        /** @type {Map<string, Channel>} */
        this.channels = new Map();
        /** @type {Map<string, Broadcast>} station and format → broadcast */
        this.broadcasts = new Map();
        /** @type {http.Server | null} */
        this.server = null;
    }

    /**
     * @param {Channel} channel - Channel to serve
     */
    add(channel) {
        this.channels.set(channel.path, channel);
        channel.server = this;
    }

    /**
     * The broadcast of a station in the format of a player: a running one, or a new one.
     *
     * @param {Channel} channel - Player
     * @param {string} url - Station URL
     * @returns {Broadcast} Broadcast
     */
    broadcastFor(channel, url) {
        const o = channel.o;
        const key = [url, o.codec, o.sampleRate, o.channels, o.ffmpegPath].join('\n');
        const running = this.broadcasts.get(key);
        if (running && !running.closed) {
            return running;
        }
        const b = new Broadcast({
            url,
            codec: o.codec,
            sampleRate: o.sampleRate,
            channels: o.channels,
            ffmpegPath: o.ffmpegPath,
            userAgent: o.userAgent,
            timers: o.timers,
            log: o.log,
            onClose: () => {
                if (this.broadcasts.get(key) === b) {
                    this.broadcasts.delete(key);
                }
            },
        });
        this.broadcasts.set(key, b);
        return b;
    }

    /**
     * @param {http.IncomingMessage} req - Request
     * @param {http.ServerResponse} res - Response
     */
    async handle(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method not allowed');
            return;
        }
        const path = new URL(req.url || '/', 'http://x').pathname;
        const channel = this.channels.get(path);
        if (channel) {
            await channel.serve(req, res);
            return;
        }
        const logo = /^\/logo\/([a-z0-9_-]+)$/.exec(path);
        if (logo) {
            const file = await this.logo(logo[1]).catch(() => null);
            if (file) {
                res.writeHead(200, {
                    'Content-Type': file.type,
                    'Content-Length': file.data.length,
                    'Cache-Control': 'max-age=3600',
                });
                res.end(req.method === 'HEAD' ? undefined : file.data);
                return;
            }
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }

    /**
     * @param {number} port - Port
     * @param {string} bind - Address
     * @returns {Promise<number>} Port
     */
    async listen(port, bind) {
        const server = http.createServer((req, res) => {
            this.handle(req, res).catch(e => {
                this.log.warn(`HTTP ${req.url}: ${e.message}`);
                if (!res.headersSent) {
                    res.writeHead(500).end();
                }
            });
        });
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, bind || undefined, () => {
                server.off('error', reject);
                resolve(undefined);
            });
        });
        server.on('error', e => this.log.warn(`HTTP server error: ${e.message}`));
        return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    }

    /** Ends every stream and closes the server. */
    async close() {
        for (const c of this.channels.values()) {
            c.setSource('');
        }
        const server = this.server;
        this.server = null;
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(() => resolve(undefined)));
        }
    }
}

module.exports = {
    Channel,
    Broadcast,
    StreamServer,
    SourceReader,
    openSource,
    playableUrl,
    probeUrl,
    ffmpegArgs,
    get,
};
