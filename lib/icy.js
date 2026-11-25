'use strict';

/*
 * Shoutcast/Icecast ("ICY") streams: the title of what plays is sent inside the audio. With the request header
 * `Icy-MetaData: 1` the server answers `icy-metaint: N`; then after every N bytes of audio comes one length byte
 * (× 16) and that many bytes of metadata, e.g. `StreamTitle='Artist - Title';StreamUrl='';`.
 */

const { Transform } = require('node:stream');

/**
 * Reads `StreamTitle` from an ICY metadata block.
 *
 * @param {Buffer | string} block - Metadata (padded with NUL bytes)
 * @returns {string | null} Title, null = the block names none
 */
function parseStreamTitle(block) {
    const text = (Buffer.isBuffer(block) ? decodeText(block) : String(block)).replace(/\0+$/, '');
    const m =
        /StreamTitle='([\s\S]*?)';(?=\s*(?:[A-Za-z]+=|$))/.exec(text) || /StreamTitle='([\s\S]*?)'?;?$/.exec(text);
    if (!m) {
        return null;
    }
    return m[1].replace(/\s+/g, ' ').trim();
}

/**
 * UTF-8 when the bytes are valid UTF-8, else Latin-1 (old Shoutcast servers).
 *
 * @param {Buffer} buf - Bytes
 * @returns {string} Text
 */
function decodeText(buf) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        return buf.toString('latin1');
    }
}

/**
 * Takes the ICY metadata out of a stream: audio goes through, every new title is reported.
 */
class IcyStripper extends Transform {
    /**
     * @param {number} metaInt - `icy-metaint` of the response, 0 = the stream has no metadata
     * @param {(title: string) => void} onTitle - A new title (also an empty one)
     */
    constructor(metaInt, onTitle) {
        super();
        this.metaInt = metaInt > 0 ? metaInt : 0;
        this.onTitle = onTitle;
        /** audio bytes left before the next length byte */
        this.left = this.metaInt;
        /** bytes of metadata still to collect, -1 = waiting for the length byte */
        this.metaLeft = -1;
        /** @type {Buffer[]} */
        this.meta = [];
        /** @type {string | null} */
        this.last = null;
    }

    /**
     * @param {Buffer} chunk - Bytes from the server
     * @param {BufferEncoding} _enc - Unused
     * @param {import('node:stream').TransformCallback} done - Callback
     */
    _transform(chunk, _enc, done) {
        if (!this.metaInt) {
            done(null, chunk);
            return;
        }
        let pos = 0;
        while (pos < chunk.length) {
            if (this.left > 0) {
                const n = Math.min(this.left, chunk.length - pos);
                this.push(chunk.subarray(pos, pos + n));
                pos += n;
                this.left -= n;
            } else if (this.metaLeft < 0) {
                this.metaLeft = chunk[pos++] * 16;
                this.meta = [];
                if (this.metaLeft === 0) {
                    this.endMeta();
                }
            } else {
                const n = Math.min(this.metaLeft, chunk.length - pos);
                this.meta.push(chunk.subarray(pos, pos + n));
                pos += n;
                this.metaLeft -= n;
                if (this.metaLeft === 0) {
                    this.endMeta();
                }
            }
        }
        done();
    }

    /** One metadata block is complete: report its title, go on with audio. */
    endMeta() {
        if (this.meta.length) {
            const title = parseStreamTitle(Buffer.concat(this.meta));
            if (title !== null && title !== this.last) {
                this.last = title;
                this.onTitle(title);
            }
        }
        this.meta = [];
        this.metaLeft = -1;
        this.left = this.metaInt;
    }
}

/**
 * A playlist file instead of a stream (.pls, .m3u): the first stream URL in it. HLS (`#EXT-X-…`) is not a playlist of
 * streams but the stream itself: ffmpeg reads it.
 *
 * @param {string} text - Body of the response
 * @param {string} base - URL the playlist came from (for relative entries)
 * @returns {{hls: true} | {url: string} | null} What to play, null = no usable entry
 */
function parsePlaylist(text, base) {
    const body = String(text || '');
    if (/^#EXT-X-/m.test(body)) {
        return { hls: true };
    }
    const lines = body
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
    const pls = lines.map(l => /^File\d+\s*=\s*(.+)$/i.exec(l)?.[1]).find(Boolean);
    // an entry is a URL or a path, never text with spaces or markup (an HTML error page)
    const candidates = (pls ? [pls] : lines.filter(l => !l.startsWith('#') && !l.startsWith('['))).filter(
        l => !/[\s<>"]/.test(l),
    );
    for (const c of candidates) {
        try {
            const url = new URL(c, base);
            if (url.protocol === 'http:' || url.protocol === 'https:') {
                return { url: url.href };
            }
        } catch {
            // not a URL
        }
    }
    return null;
}

/**
 * @param {string} contentType - Content-Type of the response
 * @param {string} url - URL
 * @returns {'hls' | 'playlist' | 'audio'} What the response is
 */
function kindOf(contentType, url) {
    const ct = String(contentType || '')
        .toLowerCase()
        .split(';')[0]
        .trim();
    const path = (() => {
        try {
            return new URL(url).pathname.toLowerCase();
        } catch {
            return '';
        }
    })();
    if (ct === 'application/vnd.apple.mpegurl' || path.endsWith('.m3u8')) {
        return 'hls';
    }
    if (
        ['audio/x-scpls', 'audio/scpls', 'audio/x-mpegurl', 'audio/mpegurl', 'application/pls+xml'].includes(ct) ||
        /\.(pls|m3u)$/.test(path)
    ) {
        return 'playlist';
    }
    return 'audio';
}

module.exports = { parseStreamTitle, decodeText, IcyStripper, parsePlaylist, kindOf };
