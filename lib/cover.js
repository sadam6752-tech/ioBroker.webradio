'use strict';

/*
 * Cover art of the song that plays: the ICY title "Artist - Title" is looked up in the iTunes Search API (free, no
 * key). Only artist and title leave the house; the answer is cached, and the lookups per minute are limited.
 */

const SEARCH_URL = 'https://itunes.apple.com/search';
const TIMEOUT_MS = 8_000;
const CACHE_SIZE = 300;
/** Apple asks for about 20 calls per minute at most */
const MAX_PER_MINUTE = 20;
/** Size of the cover in pixels (Apple scales its artwork to any size in the URL) */
const COVER_SIZE = 600;

/**
 * @param {string} s - Text
 * @returns {string} Lower case, without accents, brackets and punctuation, for comparing names
 */
function norm(s) {
    return String(s || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[([{].*?[)\]}]/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/**
 * Artist and title of an ICY title. Station names, jingles and ads have no " - " and are not looked up.
 *
 * @param {string} icy - ICY title
 * @returns {{artist: string, title: string} | null} Parts, null = no song
 */
function splitTitle(icy) {
    const text = String(icy || '').trim();
    const at = text.indexOf(' - ');
    if (at <= 0) {
        return null;
    }
    const artist = text.slice(0, at).trim();
    const title = text
        .slice(at + 3)
        .replace(/\s*[([](?:radio edit|edit|remaster(?:ed)?(?: \d{4})?|live|explicit|clean)[)\]]\s*$/i, '')
        .trim();
    if (!norm(artist) || !norm(title)) {
        return null;
    }
    return { artist, title };
}

/**
 * The best result: the first whose artist and title match the ICY title, else none (a wrong cover is worse than the
 * station logo).
 *
 * @param {Array<Record<string, unknown>>} results - iTunes results
 * @param {{artist: string, title: string}} want - Artist and title
 * @returns {string} Cover URL in COVER_SIZE, or ''
 */
function pickCover(results, want) {
    const artist = norm(want.artist);
    const title = norm(want.title);
    for (const r of Array.isArray(results) ? results : []) {
        const art = typeof r?.artworkUrl100 === 'string' ? r.artworkUrl100 : '';
        const ra = norm(String(r?.artistName || ''));
        const rt = norm(String(r?.trackName || ''));
        if (!/^https:\/\//.test(art) || !ra || !rt) {
            continue;
        }
        const artistOk = ra.includes(artist) || artist.includes(ra);
        const titleOk = rt.includes(title) || title.includes(rt);
        if (artistOk && titleOk) {
            return art.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${COVER_SIZE}x${COVER_SIZE}bb.$1`);
        }
    }
    return '';
}

/** Looks up covers, with a cache and a limit of lookups per minute. */
class CoverFinder {
    /**
     * @param {object} o - Options
     * @param {string} o.userAgent - User-Agent
     * @param {typeof fetch} [o.fetch] - fetch (tests)
     * @param {() => number} [o.now] - Clock (tests)
     */
    constructor(o) {
        this.userAgent = o.userAgent;
        this.fetch = o.fetch || globalThis.fetch;
        this.now = o.now || Date.now;
        /** @type {Map<string, string>} key → cover URL ('' = none) */
        this.cache = new Map();
        /** @type {number[]} times of the last lookups */
        this.calls = [];
    }

    /**
     * @param {string} icy - ICY title
     * @returns {Promise<string>} Cover URL, '' = none (no song, nothing found, limit reached, error)
     */
    async find(icy) {
        const want = splitTitle(icy);
        if (!want) {
            return '';
        }
        const key = `${norm(want.artist)}|${norm(want.title)}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            // the newest at the end: the cache forgets the oldest
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached;
        }
        const now = this.now();
        this.calls = this.calls.filter(t => now - t < 60_000);
        if (this.calls.length >= MAX_PER_MINUTE) {
            return '';
        }
        this.calls.push(now);
        let cover = '';
        try {
            const q = new URLSearchParams({
                term: `${want.artist} ${want.title}`,
                media: 'music',
                entity: 'song',
                limit: '5',
            });
            // the US store writes Cyrillic artists in Latin letters ("Kino"): ask the Russian store for those
            if (/[\u0400-\u04ff]/.test(`${want.artist}${want.title}`)) {
                q.set('country', 'ru');
            }
            const res = await this.fetch(`${SEARCH_URL}?${q}`, {
                headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!res.ok) {
                return ''; // not cached: a later title may try again
            }
            const data = /** @type {{results?: Array<Record<string, unknown>>}} */ (await res.json());
            cover = pickCover(data?.results || [], want);
        } catch {
            return '';
        }
        this.cache.set(key, cover);
        if (this.cache.size > CACHE_SIZE) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }
        return cover;
    }
}

module.exports = { CoverFinder, splitTitle, pickCover, norm, MAX_PER_MINUTE, COVER_SIZE };
