'use strict';

// Multiroom: the FLAC header is kept, and a player that joins late starts at a whole frame, so its decoder starts
// cleanly. Checked with real ffmpeg output and by decoding the late stream with ffmpeg.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const ffmpegPath = String(require('ffmpeg-static'));
const { StreamJoiner, isFlacFrame, isMp3Frame, flacHeaderLength, crc8 } = require('../../lib/broadcast');

/**
 * @param {string[]} out - Output arguments of ffmpeg
 * @returns {Buffer} Three seconds of a tone, encoded
 */
function encode(out) {
    const r = spawnSync(
        ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', ...out, 'pipe:1'],
        { maxBuffer: 50 * 1024 * 1024 },
    );
    assert.equal(r.status, 0, String(r.stderr));
    return r.stdout;
}

/**
 * @param {Buffer} data - Encoded audio
 * @param {string} format - ffmpeg input format
 * @returns {string} Errors of ffmpeg while it decodes, '' = clean
 */
function decodeErrors(data, format) {
    const r = spawnSync(
        ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-f', format, '-i', 'pipe:0', '-f', 'null', '-'],
        {
            input: data,
        },
    );
    return r.status === 0 ? String(r.stderr).trim() : `code ${r.status}: ${r.stderr}`;
}

describe('multiroom stream', function () {
    this.timeout(30_000);

    // the same output arguments as the proxy (lib/proxy.js ffmpegArgs)
    const flac = encode([
        '-ar',
        '48000',
        '-ac',
        '1',
        '-sample_fmt',
        's16',
        '-c:a',
        'flac',
        '-compression_level',
        '2',
        '-f',
        'flac',
        '-flush_packets',
        '1',
    ]);
    const mp3 = encode([
        '-ar',
        '44100',
        '-ac',
        '2',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-id3v2_version',
        '0',
        '-write_xing',
        '0',
        '-f',
        'mp3',
    ]);

    it('checks the CRC-8 of FLAC frame headers', () => {
        assert.equal(crc8(Buffer.from('123456789'), 0, 9), 0xf4, 'the check value of CRC-8 (poly 0x07)');
    });

    it('finds the FLAC header and every frame of ffmpeg output, and nothing inside the frames', () => {
        const h = flacHeaderLength(flac);
        assert.ok(h > 42, String(h));
        assert.equal(flacHeaderLength(flac.subarray(0, h - 1)), 0, 'not complete yet');
        assert.equal(flacHeaderLength(Buffer.from('ID3 something')), -1);
        const frames = [];
        for (let i = h; i < flac.length - 1; i++) {
            if (isFlacFrame(flac, i)) {
                frames.push(i);
            }
        }
        assert.equal(frames[0], h, 'the first frame follows the header');
        // 3 s at 48 kHz in blocks of 1152 samples (the last one shorter)
        assert.equal(frames.length, Math.ceil((3 * 48000) / 1152));
    });

    it('gives a late listener the header and the stream from the next frame: it decodes without errors', () => {
        const joiner = new StreamJoiner('flac');
        /** @type {Buffer[]} */
        const early = [];
        /** @type {Buffer[]} */
        const late = [];
        let joined = false;
        // chunks of odd sizes, as a pipe delivers them
        for (let i = 0, n = 0; i < flac.length; i += 1000 + (n++ % 7) * 333) {
            const data = joiner.take(flac.subarray(i, i + 1000 + (n % 7) * 333));
            if (!data.length) {
                continue;
            }
            early.push(data);
            if (i > flac.length / 3) {
                if (!joined) {
                    const at = joiner.frameStart(data);
                    if (at >= 0) {
                        joined = true;
                        late.push(joiner.header, data.subarray(at));
                    }
                } else {
                    late.push(data);
                }
            }
        }
        assert.ok(joined);
        assert.ok(Buffer.concat([joiner.header, ...early]).equals(flac), 'the first listener gets everything');
        const lateStream = Buffer.concat(late);
        assert.ok(lateStream.length < flac.length * 0.8);
        assert.equal(decodeErrors(lateStream, 'flac'), '');
        // without the alignment the decoder complains
        const cut = Buffer.concat([joiner.header, flac.subarray(Math.floor(flac.length / 2) + 3)]);
        assert.notEqual(decodeErrors(cut, 'flac'), '', 'a cut in the middle of a frame is no clean start');
    });

    it('finds MP3 frames for a late listener', () => {
        const joiner = new StreamJoiner('mp3');
        assert.equal(joiner.take(mp3.subarray(0, 10)).length, 10, 'MP3 has no header to keep');
        const middle = mp3.subarray(Math.floor(mp3.length / 2));
        const at = joiner.frameStart(middle);
        assert.ok(at >= 0 && at < 1500, String(at));
        assert.ok(isMp3Frame(middle, at));
        assert.equal(decodeErrors(middle.subarray(at), 'mp3'), '');
        assert.equal(isMp3Frame(Buffer.from([0xff, 0xfb, 0xf0, 0x00]), 0), false, 'bitrate 1111 is invalid');
    });
});
