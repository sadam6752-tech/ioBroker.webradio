'use strict';

// Large logos are scaled down to a small PNG instead of being skipped; the ICC profile of a JPEG is left out.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const ffmpegPath = String(require('ffmpeg-static'));
const { downloadLogo, shrinkLogo, stripPng, sniffImage, MAX_LOGO_BYTES, LOGO_SIZE } = require('../../lib/logos');

/**
 * @param {Buffer} png - PNG
 * @returns {{width: number, height: number, chunks: string[]}} Size and chunk types
 */
function pngInfo(png) {
    const chunks = [];
    let pos = 8;
    while (pos + 12 <= png.length) {
        const len = png.readUInt32BE(pos);
        chunks.push(png.toString('latin1', pos + 4, pos + 8));
        pos += 12 + len;
    }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), chunks };
}

/**
 * @param {string} type - PNG chunk type
 * @param {Buffer} data - Chunk data
 * @returns {Buffer} Chunk (the CRC is not checked by stripPng)
 */
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

/**
 * @param {Buffer} body - Response body
 * @param {string} [type] - Content-Type
 * @returns {any} fetch
 */
function fakeFetch(body, type = 'image/jpeg') {
    return async () => ({
        ok: true,
        status: 200,
        headers: new Map([
            ['content-type', type],
            ['content-length', String(body.length)],
        ]),
        arrayBuffer: async () => body,
    });
}

describe('station logos', function () {
    this.timeout(30_000);

    it('scales a large image to a PNG of at most 256 px, aspect ratio kept', async () => {
        // a 2000 × 1000 JPEG made by ffmpeg
        const jpg = spawnSync(
            ffmpegPath,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'testsrc=size=2000x1000:rate=1',
                '-frames:v',
                '1',
                '-f',
                'image2pipe',
                '-c:v',
                'mjpeg',
                'pipe:1',
            ],
            { maxBuffer: 50 * 1024 * 1024 },
        ).stdout;
        assert.equal(sniffImage(jpg), 'jpg');
        const png = await shrinkLogo(ffmpegPath, jpg);
        assert.equal(sniffImage(png), 'png');
        const info = pngInfo(png);
        assert.deepEqual([info.width, info.height], [LOGO_SIZE, LOGO_SIZE / 2]);
        assert.deepEqual(
            info.chunks.filter(c => !['IHDR', 'IDAT', 'IEND'].includes(c)),
            [],
        );
    });

    it('does not enlarge a small image, and keeps transparency', async () => {
        const src = spawnSync(
            ffmpegPath,
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=c=red@0.5:size=100x60,format=rgba',
                '-frames:v',
                '1',
                '-f',
                'image2pipe',
                '-c:v',
                'png',
                'pipe:1',
            ],
            { maxBuffer: 10 * 1024 * 1024 },
        ).stdout;
        const png = await shrinkLogo(ffmpegPath, src);
        const info = pngInfo(png);
        assert.deepEqual([info.width, info.height], [100, 60]);
        assert.equal(png[25], 6, 'colour type 6 = RGBA');
    });

    it('rejects what is no image', async () => {
        await assert.rejects(shrinkLogo(ffmpegPath, Buffer.from('<html>no</html>')), /cannot scale it/);
    });

    it('leaves out the metadata chunks of a PNG', () => {
        const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const png = Buffer.concat([
            sig,
            chunk('IHDR', Buffer.alloc(13)),
            chunk('iCCP', Buffer.alloc(5000)),
            chunk('pHYs', Buffer.alloc(9)),
            chunk('IDAT', Buffer.alloc(10)),
            chunk('IEND', Buffer.alloc(0)),
        ]);
        const out = stripPng(png);
        assert.deepEqual(pngInfo(out).chunks, ['IHDR', 'IDAT', 'IEND']);
        assert.equal(out.length, png.length - 5012 - 21);
        assert.equal(
            stripPng(Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)).subarray(0, 10)])).length,
            18,
            'broken: as is',
        );
    });

    it('downloads a large logo scaled, keeps a small one, drops a large SVG', async () => {
        const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_LOGO_BYTES + 10)]);
        const tiny = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
        let shrunk = 0;
        const shrink = async () => {
            shrunk++;
            return tiny;
        };
        const scaled = await downloadLogo('http://x/l.jpg', 'ua', fakeFetch(big), shrink);
        assert.deepEqual([scaled.ext, scaled.data, scaled.scaled], ['png', tiny, big.length]);
        const small = await downloadLogo('http://x/s.png', 'ua', fakeFetch(tiny, 'image/png'), shrink);
        assert.deepEqual([small.ext, small.scaled, shrunk], ['png', undefined, 1]);
        await assert.rejects(downloadLogo('http://x/l.jpg', 'ua', fakeFetch(big)), /too large/, 'no shrinker');
        const svg = Buffer.concat([
            Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'),
            Buffer.alloc(MAX_LOGO_BYTES),
        ]);
        await assert.rejects(
            downloadLogo('http://x/l.svg', 'ua', fakeFetch(svg, 'image/svg+xml'), shrink),
            /too large/,
        );
        await assert.rejects(
            downloadLogo('http://x/l.jpg', 'ua', fakeFetch(big), async () => Buffer.alloc(MAX_LOGO_BYTES + 1)),
            /too large even when scaled/,
        );
    });
});
