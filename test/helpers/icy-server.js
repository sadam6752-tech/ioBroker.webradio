'use strict';

// A tiny internet radio for the tests: an endless ICY stream with titles, a redirect, playlists and a broken station.

const http = require('node:http');

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
 * @param {object} o - Options
 * @param {Buffer} o.audio - Audio bytes, sent in a loop
 * @param {number} [o.metaInt] - Bytes between metadata blocks
 * @param {string[]} [o.titles] - Titles, one per block in turn
 * @returns {Promise<{server: http.Server, base: string, requests: string[], close: () => Promise<void>}>} Server
 */
async function startIcyServer(o) {
    const metaInt = o.metaInt || 4000;
    const titles = o.titles || ['Artist One - Song One'];
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(`${req.url} ${req.headers['user-agent'] || ''} icy=${req.headers['icy-metadata'] || ''}`);
        const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: '/station' }).end();
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
        if (req.url === '/broken') {
            res.writeHead(404).end();
            return;
        }
        if (req.url !== '/station') {
            res.writeHead(404).end();
            return;
        }
        const icy = req.headers['icy-metadata'] === '1';
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            ...(icy ? { 'icy-metaint': String(metaInt) } : {}),
            'icy-name': 'Test radio',
        });
        let pos = 0;
        let block = 0;
        let stopped = false;
        const send = () => {
            while (!stopped) {
                const chunk = Buffer.alloc(metaInt);
                for (let i = 0; i < metaInt; i++) {
                    chunk[i] = o.audio[pos++ % o.audio.length];
                }
                const parts = [chunk];
                if (icy) {
                    parts.push(metaBlock(titles[block++ % titles.length]));
                }
                if (!res.write(Buffer.concat(parts))) {
                    res.once('drain', send);
                    return;
                }
            }
        };
        res.on('close', () => (stopped = true));
        send();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    return {
        server,
        base,
        requests,
        close: async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(() => resolve(undefined)));
        },
    };
}

module.exports = { startIcyServer, metaBlock };
