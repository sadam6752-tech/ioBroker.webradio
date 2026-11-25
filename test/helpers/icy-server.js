'use strict';

// A tiny internet radio for the tests: an endless ICY stream with titles, redirects, playlists of every kind, a broken
// station, and a raw server whose status line ends with a bare LF (like the QuantumCast streamer of RPR1).

const http = require('node:http');
const net = require('node:net');

/**
 * @param {string} title - Title
 * @returns {Buffer} ICY metadata block with its length byte
 */
function metaBlock(title) {
    const text = Buffer.from(`StreamTitle='${title}';`, 'utf8');
    const len = Math.ceil(text.length / 16);
    const out = Buffer.alloc(1 + len * 16);
    out[0] = len;
    text.copy(out, 1);
    return out;
}

/**
 * Writes the endless stream: audio blocks of metaInt bytes, each followed by a title block when icy.
 *
 * @param {{write: (b: Buffer) => boolean, once: (e: string, f: () => void) => unknown, on: (e: string, f: () => void) => unknown}} out - Response or socket
 * @param {Buffer} audio - Audio bytes
 * @param {number} metaInt - Bytes between metadata blocks
 * @param {string[]} titles - Titles
 * @param {boolean} icy - Send metadata
 */
function sendStream(out, audio, metaInt, titles, icy) {
    let pos = 0;
    let block = 0;
    let stopped = false;
    const send = () => {
        while (!stopped) {
            const chunk = Buffer.alloc(metaInt);
            for (let i = 0; i < metaInt; i++) {
                chunk[i] = audio[pos++ % audio.length];
            }
            const parts = [chunk];
            if (icy) {
                parts.push(metaBlock(titles[block++ % titles.length]));
            }
            if (!out.write(Buffer.concat(parts))) {
                out.once('drain', send);
                return;
            }
        }
    };
    out.on('close', () => (stopped = true));
    send();
}

/**
 * @param {object} o - Options
 * @param {Buffer} o.audio - Audio bytes, sent in a loop
 * @param {number} [o.metaInt] - Bytes between metadata blocks
 * @param {string[]} [o.titles] - Titles, one per block in turn
 * @returns {Promise<{server: http.Server, base: string, rawBase: string, requests: string[], close: () => Promise<void>}>} Server
 */
async function startIcyServer(o) {
    const metaInt = o.metaInt || 4000;
    const titles = o.titles || ['Artist One - Song One'];
    const requests = [];
    // the stream server of the redirect chain: HTTP/1.1 with a bare LF after the status line
    const raw = net.createServer(socket => {
        socket.once('data', d => {
            const icy = /^icy-metadata:\s*1/im.test(d.toString('latin1'));
            const meta = icy ? `icy-metaint: ${metaInt}\r\n` : '';
            socket.write(`HTTP/1.1 200 OK\nContent-Type: audio/aac\r\n${meta}Connection: close\r\n\r\n`);
            sendStream(socket, o.audio, metaInt, titles, icy);
        });
        socket.on('error', () => undefined);
    });
    await new Promise(resolve => raw.listen(0, '127.0.0.1', () => resolve(undefined)));
    const rawBase = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (raw.address()).port}`;
    /** @type {Record<string, [string, string]>} path → [Content-Type, body]; BASE is replaced by the server URL */
    const lists = {
        '/octet.m3u': ['application/octet-stream', '#EXTM3U\n#EXTINF:-1,Test\nBASE/station\n'],
        '/text.pls': ['text/plain', '[playlist]\r\nFile1=BASE/station\r\nLength1=-1\r\n'],
        '/nested.m3u': ['audio/x-mpegurl', 'BASE/list.pls\n'],
        '/loop.m3u': ['audio/x-mpegurl', 'BASE/loop.m3u\n'],
        '/list.asx': [
            'video/x-ms-asx',
            '<asx version="3.0"><entry><ref href="BASE/station?a=1&amp;b=2"/></entry></asx>',
        ],
        '/list.xspf': [
            'application/xspf+xml',
            '<?xml version="1.0"?><playlist><trackList><track><location>BASE/station</location></track></trackList></playlist>',
        ],
        '/hls-in-mpegurl': ['audio/x-mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nchunks.m3u8\n'],
        '/empty.m3u': ['audio/x-mpegurl', '# nothing\n'],
    };
    const server = http.createServer((req, res) => {
        requests.push(`${req.url} ${req.headers['user-agent'] || ''} icy=${req.headers['icy-metadata'] || ''}`);
        const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: '/station' }).end();
            return;
        }
        // like http://streams.rpr1.de/rpr-dab-192-mp3.m3u: no playlist, a chunked HTML 302, a second 302, the stream
        if (req.url === '/rpr.m3u') {
            res.writeHead(302, { Location: '/rpr-hop', 'Content-Type': 'text/html' });
            res.write('<html><body>moved</body></html>');
            res.end();
            return;
        }
        if (req.url === '/rpr-hop') {
            res.writeHead(302, { Location: `${rawBase}/webradio/aac-128` }).end();
            return;
        }
        const list = lists[String(req.url).split('?')[0]];
        if (list) {
            res.writeHead(200, { 'Content-Type': list[0] });
            res.end(list[1].replace(/BASE/g, base));
            return;
        }
        if (req.url === '/list.pls') {
            res.writeHead(200, { 'Content-Type': 'audio/x-scpls' });
            res.end(`[playlist]\nNumberOfEntries=1\nFile1=${base}/station\nTitle1=Test\n`);
            return;
        }
        if (req.url === '/list.m3u') {
            res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
            res.end(`#EXTM3U\n#EXTINF:-1,Test\n${base}/redirect\n`);
            return;
        }
        if (req.url === '/hls.m3u8') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end('#EXTM3U\n#EXT-X-VERSION:3\n');
            return;
        }
        if (req.url === '/logo.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
            return;
        }
        if (req.url === '/broken') {
            res.writeHead(404).end();
            return;
        }
        // the extension lies: audio behind a .m3u URL
        const path = String(req.url).split('?')[0];
        if (path !== '/station' && path !== '/audio.m3u') {
            res.writeHead(404).end();
            return;
        }
        const icy = req.headers['icy-metadata'] === '1';
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            ...(icy ? { 'icy-metaint': String(metaInt) } : {}),
            'icy-name': 'Test radio',
        });
        sendStream(res, o.audio, metaInt, titles, icy);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    return {
        server,
        base,
        requests,
        rawBase,
        close: async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(() => resolve(undefined)));
            await new Promise(resolve => raw.close(() => resolve(undefined)));
        },
    };
}

module.exports = { startIcyServer, metaBlock };
