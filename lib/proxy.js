'use strict';

/*
 * The stream proxy: a player that cannot play the station itself (ESPHome takes only plain MP3/FLAC over http, no AAC,
 * no HLS, no https) fetches http://<host>:<port>/play/<target>.<codec>. The adapter opens the station (following
 * redirects and playlists), takes the ICY titles out, and ffmpeg turns the audio into FLAC or MP3.
 */

const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { IcyStripper, parsePlaylist, kindOf } = require('./icy');

/**
 * @typedef {import('./types').Logger} Logger
 * @typedef {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (h: unknown) => void}} Timers
 */

const CONTENT_TYPES = { flac: 'audio/flac', mp3: 'audio/mpeg' };
/** A player that does not read for this many bytes is dropped instead of filling the memory. */
const MAX_BACKLOG = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_PLAYLIST_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
/** Attempts to open a station again after it dropped, before the player is stopped */
const MAX_RETRIES = 5;

/**
 * GET with redirects. The response carries the final URL as `finalUrl`.
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
        const req = lib.get(u, { headers }, res => {
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
    });
}

/**
 * @typedef {{hls: string} | {res: http.IncomingMessage, metaInt: number, url: string, contentType: string}} OpenSource
 */

/**
 * Opens a station: follows redirects and playlists (.pls/.m3u); HLS is handed to ffmpeg as a URL.
 *
 * @param {string} url - Station URL
 * @param {string} userAgent - User-Agent
 * @param {number} [depth] - Playlist depth
 * @returns {Promise<OpenSource>} Open audio response, or the HLS URL
 */
async function openSource(url, userAgent, depth = 0) {
    const res = await get(url, { 'User-Agent': userAgent, 'Icy-MetaData': '1', Accept: '*/*' });
    const contentType = String(res.headers['content-type'] || '');
    const kind = kindOf(contentType, res.finalUrl);
    if (kind === 'hls') {
        res.destroy();
        return { hls: res.finalUrl };
    }
    if (kind === 'playlist') {
        const found = parsePlaylist(await readSmallBody(res), res.finalUrl);
        if (found && 'hls' in found) {
            return { hls: res.finalUrl };
        }
        if (!found || depth >= 3) {
            throw new Error('the playlist names no stream');
        }
        return openSource(found.url, userAgent, depth + 1);
    }
    return { res, metaInt: Number(res.headers['icy-metaint']) || 0, url: res.finalUrl, contentType };
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
 * The proxied stream of one target. Exactly one listener at a time: a new request replaces the old one, and every
 * listener gets its own connection to the station and its own ffmpeg, so its stream starts with a proper header.
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
        /** @type {{res: http.ServerResponse, proc: import('node:child_process').ChildProcess | null, reader: SourceReader | null} | null} */
        this.client = null;
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
        if (!url) {
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
        /** @type {{res: http.ServerResponse, proc: import('node:child_process').ChildProcess | null, reader: SourceReader | null}} */
        const client = { res, proc: null, reader: null };
        this.client = client;
        res.on('close', () => this.drop(client));
        // like an internet radio: no chunked transfer, the body runs until the connection closes (the HTTP client of
        // ESP-IDF hangs on stop when it has to read a chunked endless body to its end)
        res.useChunkedEncodingByDefault = false;
        res.writeHead(200, headers);
        res.flushHeaders();
        const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        this.o.log.debug(`${this.o.name}: stream ${this.path} to ${peer}`);

        /** @type {OpenSource} */
        let first;
        try {
            first = await openSource(url, this.o.userAgent);
        } catch (e) {
            this.o.log.warn(`${this.o.name}: cannot open the station: ${e.message}`);
            this.drop(client);
            this.o.onEnd(e.message);
            return;
        }
        if (this.client !== client) {
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
        client.proc = proc;
        let stderr = '';
        proc.stderr?.on('data', d => {
            stderr = (stderr + d).slice(-2000);
        });
        proc.stdin?.on('error', () => undefined);
        proc.on('error', e => {
            this.o.log.warn(`${this.o.name}: ffmpeg did not start: ${e.message}`);
            this.drop(client);
        });
        proc.on('exit', code => {
            if (code && stderr.trim() && this.client === client) {
                this.o.log.warn(`${this.o.name}: ffmpeg ended with code ${code}: ${stderr.trim().split('\n').pop()}`);
            }
            this.drop(client);
        });
        proc.stdout?.pipe(res);
        if (hls) {
            proc.stdin?.end();
            return;
        }
        const reader = new SourceReader({
            url,
            name: this.o.name,
            userAgent: this.o.userAgent,
            timers: this.o.timers,
            log: this.o.log,
            onTitle: t => this.client === client && this.o.onTitle(t),
            onData: d => {
                const stdin = proc.stdin;
                if (!stdin || stdin.destroyed) {
                    return;
                }
                if (stdin.writableLength > MAX_BACKLOG) {
                    this.o.log.warn(`${this.o.name}: the player does not read the stream, disconnecting it`);
                    this.drop(client);
                    return;
                }
                stdin.write(d);
            },
            onEnd: why => {
                this.drop(client);
                this.o.onEnd(why);
            },
        });
        client.reader = reader;
        reader.start(first);
    }

    /**
     * @param {{res: http.ServerResponse, proc: import('node:child_process').ChildProcess | null, reader: SourceReader | null}} client - Listener to end
     */
    drop(client) {
        if (this.client === client) {
            this.client = null;
        }
        client.reader?.stop();
        const proc = client.proc;
        if (proc) {
            // stop the pipe first: ffmpeg may still have output on its way into the ended response
            proc.stdout?.unpipe(client.res);
            proc.stdout?.resume();
            if (proc.exitCode === null && !proc.killed) {
                proc.kill('SIGKILL');
            }
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
        /** @type {http.Server | null} */
        this.server = null;
    }

    /**
     * @param {Channel} channel - Channel to serve
     */
    add(channel) {
        this.channels.set(channel.path, channel);
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

module.exports = { Channel, StreamServer, SourceReader, openSource, ffmpegArgs, get };
