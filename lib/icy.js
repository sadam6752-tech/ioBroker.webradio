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

/** Content types of playlists; the body tells whether an m3u is HLS (`#EXT-X-…`) or a plain list */
const PLAYLIST_TYPES = [
    'audio/x-mpegurl',
    'audio/mpegurl',
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'audio/x-scpls',
    'audio/scpls',
    'application/pls+xml',
    'video/x-ms-asx',
    'audio/x-ms-asx',
    'application/xspf+xml',
];

/**
 * @param {string} s - Text from XML
 * @returns {string} Text with the five XML entities decoded
 */
function xmlText(s) {
    return s
        .trim()
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * A playlist file instead of a stream (.m3u, .pls, .asx, .xspf): the first http(s) entry. HLS (`#EXT-X-…`) is not a
 * playlist of streams but the stream itself: ffmpeg reads it.
 *
 * @param {string} text - Body of the response
 * @param {string} base - URL the playlist came from (for relative entries)
 * @returns {{hls: true} | {url: string} | null} What to play, null = no usable entry
 */
function parsePlaylist(text, base) {
    const body = String(text || '').replace(/^\uFEFF/, '');
    if (/^#EXT-X-/m.test(body)) {
        return { hls: true };
    }
    /** @type {string[]} */
    let candidates;
    if (/^\s*</.test(body)) {
        // ASX: <ref href="…"/>, XSPF: <location>…</location>
        candidates = [
            ...[...body.matchAll(/<ref\s[^>]*?href\s*=\s*["']([^"']+)["']/gi)].map(m => xmlText(m[1])),
            ...[...body.matchAll(/<location>([^<]+)<\/location>/gi)].map(m => xmlText(m[1])),
        ];
    } else {
        const lines = body
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean);
        const pls = lines.flatMap(l => /^File\d+\s*=\s*(.+)$/i.exec(l)?.[1] || []);
        candidates = pls.length ? pls : lines.filter(l => !l.startsWith('#') && !l.startsWith('['));
    }
    // an entry is a URL or a path, never text with spaces or markup (an HTML error page)
    for (const c of candidates.filter(l => !/[\s<>"]/.test(l))) {
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
 * What a response is, from its Content-Type; the URL only decides whether to look at the body. A `.m3u` URL often
 * redirects to the audio itself, and many servers send playlists as text/plain or application/octet-stream.
 *
 * @param {string} contentType - Content-Type of the response
 * @param {string} url - URL of the response (after redirects)
 * @returns {'playlist' | 'audio' | 'sniff'} sniff = decide by the first bytes of the body
 */
function kindOf(contentType, url) {
    const ct = String(contentType || '')
        .toLowerCase()
        .split(';')[0]
        .trim();
    if (PLAYLIST_TYPES.includes(ct)) {
        return 'playlist';
    }
    const path = (() => {
        try {
            return new URL(url).pathname.toLowerCase();
        } catch {
            return '';
        }
    })();
    if (/\.(m3u8?|pls|asx|xspf)$/.test(path)) {
        return 'sniff';
    }
    if (ct.startsWith('audio/') || ct.startsWith('video/') || ct === 'application/ogg') {
        return 'audio';
    }
    return 'sniff';
}

/**
 * @param {Buffer} head - First bytes of a body
 * @returns {boolean} It is a playlist (m3u, HLS, pls, asx, xspf, a bare URL), not audio
 */
function looksLikePlaylist(head) {
    const text = head
        .subarray(0, 512)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trimStart();
    return /^(#EXTM3U|#EXTINF|\[playlist\]|<asx|<\?xml|<playlist|https?:\/\/)/i.test(text);
}

module.exports = { parseStreamTitle, decodeText, IcyStripper, parsePlaylist, kindOf, looksLikePlaylist };
