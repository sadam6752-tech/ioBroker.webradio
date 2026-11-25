'use strict';

/*
 * Station logos: the favicons of radio stations move or vanish often, so the adapter keeps a copy of every favourite's
 * logo in its file storage and hands it out itself.
 */

const MAX_LOGO_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

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
 * Downloads a logo.
 *
 * @param {string} url - Logo URL
 * @param {string} userAgent - User-Agent
 * @param {typeof fetch} [fetchFn] - fetch (tests)
 * @returns {Promise<{data: Buffer, ext: string}>} Image
 */
async function downloadLogo(url, userAgent, fetchFn = globalThis.fetch) {
    const res = await fetchFn(url, {
        headers: { 'User-Agent': userAgent, Accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_LOGO_BYTES) {
        throw new Error(`too large (${length} bytes)`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_LOGO_BYTES) {
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
    return { data, ext };
}

module.exports = { downloadLogo, sniffImage, MIME, MAX_LOGO_BYTES };
