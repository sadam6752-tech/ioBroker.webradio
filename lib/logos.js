'use strict';

/*
 * Station logos: the favicons of radio stations move or vanish often, so the adapter keeps a copy of every favourite's
 * logo in its file storage and hands it out itself.
 */

const { spawn } = require('node:child_process');

/** A logo larger than this is scaled down (raster) or dropped (SVG) */
const MAX_LOGO_BYTES = 512 * 1024;
/** Nothing larger is downloaded at all */
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Longest side of a scaled logo */
const LOGO_SIZE = 256;
const TIMEOUT_MS = 10_000;
const SHRINK_TIMEOUT_MS = 20_000;

const TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
};

/**
 * The image type of a file from its first bytes (some servers send `text/html` or `application/octet-stream`).
 *
 * @param {Buffer} data - File
 * @returns {string} File extension, empty = no known image
 */
function sniffImage(data) {
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'jpg';
    }
    if (data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a') {
        return 'gif';
    }
    if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
        return 'webp';
    }
    if (data.length >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) {
        return 'ico';
    }
    const head = data.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
        return 'svg';
    }
    return '';
}

/** @type {Record<string, string>} */
const MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
};

/**
 * A PNG without its metadata chunks: ffmpeg copies the ICC profile of a JPEG into the PNG, and that alone can weigh
 * more than the image (485 KB in a 21 KB logo). Every chunk has its own CRC, so leaving chunks out keeps the file valid.
 *
 * @param {Buffer} png - PNG
 * @returns {Buffer} PNG with IHDR, PLTE, tRNS, IDAT and IEND only
 */
function stripPng(png) {
    const keep = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    /** @type {Buffer[]} */
    const parts = [png.subarray(0, 8)];
    let pos = 8;
    while (pos + 12 <= png.length) {
        const len = png.readUInt32BE(pos);
        const end = pos + 12 + len;
        if (end > png.length) {
            return png; // broken: leave it as ffmpeg made it
        }
        if (keep.has(png.toString('latin1', pos + 4, pos + 8))) {
            parts.push(png.subarray(pos, end));
        }
        pos = end;
    }
    return pos === png.length ? Buffer.concat(parts) : png;
}

/**
 * Scales an image down to at most LOGO_SIZE pixels on its longest side, as PNG (the aspect ratio and the transparency
 * stay; a smaller image is not enlarged). ffmpeg reads PNG, JPEG, GIF (first frame), WebP and ICO.
 *
 * @param {string} ffmpegPath - ffmpeg binary
 * @param {Buffer} data - Image
 * @returns {Promise<Buffer>} PNG
 */
function shrinkLogo(ffmpegPath, data) {
    return new Promise((resolve, reject) => {
        // prettier-ignore
        const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-i', 'pipe:0',
            '-frames:v', '1',
            '-vf', `scale=w='min(${LOGO_SIZE},iw)':h='min(${LOGO_SIZE},ih)':force_original_aspect_ratio=decrease`,
            '-c:v', 'png', '-f', 'image2pipe', 'pipe:1',
        ];
        const proc = spawn(ffmpegPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            timeout: SHRINK_TIMEOUT_MS,
        });
        /** @type {Buffer[]} */
        const out = [];
        let err = '';
        proc.stdout.on('data', d => out.push(d));
        proc.stderr.on('data', d => (err = (err + d).slice(-500)));
        proc.stdin.on('error', () => undefined);
        proc.on('error', reject);
        proc.on('close', code => {
            const png = Buffer.concat(out);
            if (code === 0 && sniffImage(png) === 'png') {
                resolve(stripPng(png));
            } else {
                reject(new Error(`cannot scale it (${err.trim().split('\n').pop() || `ffmpeg code ${code}`})`));
            }
        });
        proc.stdin.end(data);
    });
}

/**
 * Downloads a logo. One larger than MAX_LOGO_BYTES is scaled down to a PNG of LOGO_SIZE pixels when a shrinker is
 * given (SVG cannot be, it is dropped).
 *
 * @param {string} url - Logo URL
 * @param {string} userAgent - User-Agent
 * @param {typeof fetch} [fetchFn] - fetch (tests)
 * @param {(data: Buffer) => Promise<Buffer>} [shrink] - Scales a raster image down to a PNG
 * @returns {Promise<{data: Buffer, ext: string, scaled?: number}>} Image; scaled = bytes before scaling
 */
async function downloadLogo(url, userAgent, fetchFn = globalThis.fetch, shrink) {
    const res = await fetchFn(url, {
        headers: { 'User-Agent': userAgent, Accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`too large (${length} bytes)`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_DOWNLOAD_BYTES) {
        throw new Error(`too large (${data.length} bytes)`);
    }
    const type = String(res.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    const ext = sniffImage(data) || TYPES[type] || '';
    if (!ext) {
        throw new Error('not an image');
    }
    if (data.length <= MAX_LOGO_BYTES) {
        return { data, ext };
    }
    if (ext === 'svg' || !shrink) {
        throw new Error(`too large (${data.length} bytes)`);
    }
    const png = await shrink(data);
    if (png.length > MAX_LOGO_BYTES) {
        throw new Error(`too large even when scaled (${png.length} bytes)`);
    }
    return { data: png, ext: 'png', scaled: data.length };
}

module.exports = { downloadLogo, shrinkLogo, stripPng, sniffImage, MIME, MAX_LOGO_BYTES, LOGO_SIZE };
