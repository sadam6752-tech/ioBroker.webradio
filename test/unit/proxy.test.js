'use strict';

// The proxy against a small local radio: redirects, playlists, ICY titles, the probe of ioBroker.assistant, and a
// real ffmpeg run (the bundled ffmpeg-static) that turns the station into FLAC.

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { openSource, SourceReader, Channel, StreamServer, ffmpegArgs } = require('../../lib/proxy');
const { startIcyServer } = require('../helpers/icy-server');

const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(/** @type {any} */ (h)) };

/**
 * @param {string} url - URL
 * @param {Record<string, string>} [headers] - Headers
 * @param {number} [bytes] - Read this many bytes, then close
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: Buffer}>} Response
 */
function fetchBytes(url, headers = {}, bytes = 0) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, res => {
            const parts = [];
            let size = 0;
            const done = () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(parts) });
            res.on('data', d => {
                parts.push(d);
                size += d.length;
                if (bytes && size >= bytes) {
                    res.destroy();
                    done();
                }
            });
            res.on('end', done);
        });
        req.on('error', reject);
    });
}

describe('stream proxy', function () {
    this.timeout(30_000);
    let radio;
    /** MP3 made by ffmpeg: one second of a tone */
    let mp3;

    before(async () => {
        const r = spawnSync(
            String(ffmpegPath),
            ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'],
            { maxBuffer: 10 * 1024 * 1024 },
        );
        assert.equal(r.status, 0, String(r.stderr));
        mp3 = r.stdout;
        radio = await startIcyServer({ audio: mp3, metaInt: 2000, titles: ['Artist - First', 'Artist - Second'] });
    });

    after(async () => {
        await radio?.close();
    });

    it('opens a station through a redirect and asks for ICY metadata with a generic User-Agent', async () => {
        const src = await openSource(`${radio.base}/redirect`, 'ioBroker.webradio/0.0.1');
        assert.ok('res' in src);
        assert.equal(src.metaInt, 2000);
        assert.equal(src.url, `${radio.base}/station`);
        src.res.destroy();
        const last = radio.requests[radio.requests.length - 1];
        assert.match(last, /^\/station ioBroker\.webradio\/0\.0\.1 icy=1$/);
    });

    it('follows .pls and .m3u playlists, and hands HLS on', async () => {
        for (const path of ['/list.pls', '/list.m3u']) {
            const src = await openSource(`${radio.base}${path}`, 'x');
            assert.ok('res' in src, path);
            src.res.destroy();
        }
        assert.deepEqual(await openSource(`${radio.base}/hls.m3u8`, 'x'), { hls: `${radio.base}/hls.m3u8` });
        await assert.rejects(openSource(`${radio.base}/broken`, 'x'), /HTTP 404/);
        await assert.rejects(openSource('file:///etc/passwd', 'x'), /unsupported protocol/);
    });

    it('reads the titles and the audio without the metadata', async () => {
        const titles = [];
        let bytes = 0;
        const reader = new SourceReader({
            url: `${radio.base}/station`,
            name: 'test',
            userAgent: 'x',
            timers,
            log,
            onTitle: t => titles.push(t),
            onData: d => (bytes += d.length),
        });
        reader.start();
        for (let i = 0; i < 50 && titles.length < 2; i++) {
            await new Promise(r => setTimeout(r, 50));
        }
        reader.stop();
        assert.deepEqual(titles.slice(0, 2), ['Artist - First', 'Artist - Second']);
        assert.ok(bytes >= 2000);
    });

    it('gives up on a broken station after its retries', async () => {
        const fast = { setTimeout: (cb) => setTimeout(cb, 1), clearTimeout: h => clearTimeout(/** @type {any} */ (h)) };
        const why = await new Promise(resolve => {
            new SourceReader({
                url: `${radio.base}/broken`,
                name: 'test',
                userAgent: 'x',
                timers: fast,
                log,
                onTitle: () => undefined,
                onEnd: resolve,
            }).start();
        });
        assert.match(String(why), /HTTP 404/);
    });

    it('builds ffmpeg arguments for FLAC, MP3 and HLS', () => {
        const flac = ffmpegArgs('flac', 48000, 1);
        assert.deepEqual(flac.slice(flac.indexOf('-i'), flac.indexOf('-i') + 2), ['-i', 'pipe:0']);
        assert.ok(flac.includes('flac') && flac.includes('48000'));
        const mp3Args = ffmpegArgs('mp3', 44100, 2, 'http://x/a.m3u8');
        assert.ok(mp3Args.includes('libmp3lame'));
        assert.deepEqual(mp3Args.slice(mp3Args.indexOf('-i'), mp3Args.indexOf('-i') + 2), ['-i', 'http://x/a.m3u8']);
    });

    it('serves FLAC through ffmpeg, answers the probe of the assistant with headers only, and reports titles', async () => {
        const titles = [];
        const channel = new Channel({
            id: 'kitchen',
            name: 'Kitchen',
            codec: 'flac',
            sampleRate: 48000,
            channels: 1,
            ffmpegPath: String(ffmpegPath),
            userAgent: 'x',
            timers,
            log,
            onTitle: t => titles.push(t),
            onEnd: () => undefined,
        });
        const server = new StreamServer(log, async id => (id === 'swr3' ? { data: Buffer.from('PNG'), type: 'image/png' } : null));
        server.add(channel);
        const port = await server.listen(0, '127.0.0.1');
        try {
            const url = `http://127.0.0.1:${port}${channel.path}?s=a&n=1`;
            assert.equal((await fetchBytes(url)).status, 503, 'nothing selected yet');
            channel.setSource(`${radio.base}/station`);
            const probe = await fetchBytes(url, { 'User-Agent': 'ioBroker.assistant/1.10' });
            assert.equal(probe.status, 200);
            assert.equal(probe.headers['content-type'], 'audio/flac');
            assert.equal(probe.body.length, 0);
            const requestsBefore = radio.requests.length;
            const res = await fetchBytes(url, {}, 4000);
            assert.equal(res.status, 200);
            assert.equal(res.body.subarray(0, 4).toString('latin1'), 'fLaC');
            assert.ok(radio.requests.length > requestsBefore);
            assert.ok(titles.includes('Artist - First'));
            assert.equal((await fetchBytes(`http://127.0.0.1:${port}/logo/swr3`)).body.toString(), 'PNG');
            assert.equal((await fetchBytes(`http://127.0.0.1:${port}/logo/none`)).status, 404);
            assert.equal((await fetchBytes(`http://127.0.0.1:${port}/logo/../x`)).status, 404);
        } finally {
            await server.close();
        }
    });
});
