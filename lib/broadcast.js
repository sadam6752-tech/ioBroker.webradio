'use strict';

/*
 * Multiroom: one station for several players with one connection to the station and one ffmpeg. Every player that
 * takes the same format (codec, sample rate, channels) listens to the same broadcast. A player that joins late gets the
 * FLAC header first and then the stream from the start of the next frame, so its decoder starts cleanly.
 */

/**
 * CRC-8 of a FLAC frame header (polynomial x^8 + x^2 + x + 1).
 *
 * @param {Buffer} data - Bytes
 * @param {number} start - First byte
 * @param {number} end - After the last byte
 * @returns {number} CRC
 */
function crc8(data, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        crc ^= data[i];
        for (let b = 0; b < 8; b++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}

/**
 * Whether a FLAC frame starts at a position: sync code, valid fields and a matching header CRC.
 *
 * @param {Buffer} b - Bytes
 * @param {number} i - Position
 * @returns {boolean} A frame starts there
 */
function isFlacFrame(b, i) {
    if (i + 6 > b.length || b[i] !== 0xff || (b[i + 1] & 0xfe) !== 0xf8) {
        return false;
    }
    const blockCode = b[i + 2] >> 4;
    const rateCode = b[i + 2] & 0x0f;
    const chanCode = b[i + 3] >> 4;
    const sizeCode = (b[i + 3] >> 1) & 0x07;
    if (blockCode === 0 || rateCode === 15 || chanCode > 10 || sizeCode === 3 || sizeCode === 7 || b[i + 3] & 1) {
        return false;
    }
    // the frame or sample number, UTF-8 coded
    let p = i + 4;
    const lead = b[p];
    let extra = 0;
    if (lead < 0x80) {
        extra = 0;
    } else if ((lead & 0xe0) === 0xc0) {
        extra = 1;
    } else if ((lead & 0xf0) === 0xe0) {
        extra = 2;
    } else if ((lead & 0xf8) === 0xf0) {
        extra = 3;
    } else if ((lead & 0xfc) === 0xf8) {
        extra = 4;
    } else if ((lead & 0xfe) === 0xfc) {
        extra = 5;
    } else if (lead === 0xfe) {
        extra = 6;
    } else {
        return false;
    }
    p += 1 + extra;
    p += blockCode === 6 ? 1 : blockCode === 7 ? 2 : 0;
    p += rateCode === 12 ? 1 : rateCode === 13 || rateCode === 14 ? 2 : 0;
    if (p >= b.length) {
        return false;
    }
    for (let k = i + 5; k < i + 5 + extra; k++) {
        if ((b[k] & 0xc0) !== 0x80) {
            return false;
        }
    }
    return crc8(b, i, p) === b[p];
}

/**
 * Whether an MP3 frame starts at a position: sync and valid header fields (and the next frame follows when it is in
 * the buffer).
 *
 * @param {Buffer} b - Bytes
 * @param {number} i - Position
 * @returns {boolean} A frame starts there
 */
function isMp3Frame(b, i) {
    if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) {
        return false;
    }
    const version = (b[i + 1] >> 3) & 3;
    const layer = (b[i + 1] >> 1) & 3;
    const bitrate = b[i + 2] >> 4;
    const rate = (b[i + 2] >> 2) & 3;
    return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && rate !== 3;
}

/**
 * The FLAC stream header ("fLaC" and the metadata blocks) at the start of the output of ffmpeg.
 *
 * @param {Buffer} b - The first bytes of the output
 * @returns {number} Length of the header, 0 = not complete yet, -1 = no FLAC header
 */
function flacHeaderLength(b) {
    if (b.length < 4) {
        return 0;
    }
    if (b.toString('latin1', 0, 4) !== 'fLaC') {
        return -1;
    }
    let p = 4;
    for (;;) {
        if (p + 4 > b.length) {
            return 0;
        }
        const last = b[p] & 0x80;
        const len = b.readUIntBE(p + 1, 3);
        p += 4 + len;
        if (p > b.length) {
            return 0;
        }
        if (last) {
            return p;
        }
    }
}

/**
 * Splits the output of ffmpeg for listeners that join at different times: keeps the FLAC header, and finds the start
 * of the next frame for a new listener.
 */
class StreamJoiner {
    /**
     * @param {'flac' | 'mp3'} codec - Codec of the stream
     */
    constructor(codec) {
        this.codec = codec;
        /** @type {Buffer} the FLAC header, or the bytes so far while it is not complete */
        this.header = Buffer.alloc(0);
        this.headerDone = codec !== 'flac';
        /** Bytes of the stream so far (after the header) */
        this.sent = 0;
    }

    /**
     * The bytes of a chunk of ffmpeg's output that belong to the stream after the header (the header part is kept).
     *
     * @param {Buffer} chunk - Output of ffmpeg
     * @returns {Buffer} Stream bytes after the header
     */
    take(chunk) {
        if (this.headerDone) {
            this.sent += chunk.length;
            return chunk;
        }
        const all = Buffer.concat([this.header, chunk]);
        const len = flacHeaderLength(all);
        if (len === 0) {
            this.header = all;
            return Buffer.alloc(0);
        }
        this.headerDone = true;
        if (len < 0) {
            // no FLAC header (should not happen): pass everything on
            this.header = Buffer.alloc(0);
            this.sent += all.length;
            return all;
        }
        this.header = all.subarray(0, len);
        const rest = all.subarray(len);
        this.sent += rest.length;
        return rest;
    }

    /**
     * Where a listener that joined after the start may begin in a chunk: the start of the first whole frame.
     *
     * @param {Buffer} chunk - Stream bytes
     * @returns {number} Position, -1 = no frame starts in this chunk
     */
    frameStart(chunk) {
        const test = this.codec === 'flac' ? isFlacFrame : isMp3Frame;
        for (let i = 0; i < chunk.length - 1; i++) {
            if (chunk[i] === 0xff && test(chunk, i)) {
                return i;
            }
        }
        return -1;
    }
}

module.exports = { StreamJoiner, isFlacFrame, isMp3Frame, flacHeaderLength, crc8 };
