'use strict';

/*
 * The open station catalog radio-browser.info (https://api.radio-browser.info). It runs on several mirrors; the list
 * comes from all.api.radio-browser.info, and a request goes to a random mirror, the next one when it fails. The
 * requests carry a generic User-Agent with the adapter version, nothing about the user.
 */

const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info'];
const SERVER_LIST_TTL = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_LIMIT = 50;

/**
 * @typedef {object} CatalogStation
 * @property {string} uuid - stationuuid
 * @property {string} name - Name
 * @property {string} url - Stream URL (resolved from a playlist by the catalog)
 * @property {string} favicon - Logo URL, empty = none
 * @property {string[]} tags - Tags
 * @property {string} country - Country
 * @property {string} countrycode - ISO 3166-1 code
 * @property {string} language - Language(s)
 * @property {string} codec - e.g. MP3, AAC
 * @property {number} bitrate - kbit/s, 0 = unknown
 * @property {boolean} hls - HLS stream
 * @property {number} votes - Votes
 * @property {string} homepage - Web page of the station
 */

/**
 * @param {Record<string, unknown>} s - Station of the catalog API
 * @returns {CatalogStation} The fields the adapter uses
 */
function toCatalogStation(s) {
    return {
        uuid: String(s.stationuuid || ''),
        name: String(s.name || '').trim(),
        url: String(s.url_resolved || s.url || '').trim(),
        favicon: /^https?:\/\//i.test(String(s.favicon || '')) ? String(s.favicon) : '',
        tags: String(s.tags || '')
            .split(',')
            .map(t => t.trim())
            .filter(Boolean)
            .slice(0, 10),
        country: String(s.country || ''),
        countrycode: String(s.countrycode || ''),
        language: String(s.language || ''),
        codec: String(s.codec || ''),
        bitrate: Number(s.bitrate) || 0,
        hls: Number(s.hls) === 1,
        votes: Number(s.votes) || 0,
        homepage: String(s.homepage || ''),
    };
}

/**
 * Query of a search: a name, and optionally a country code and a tag.
 *
 * @param {{query?: unknown, name?: unknown, country?: unknown, tag?: unknown, limit?: unknown}} q - Search
 * @returns {URLSearchParams} Parameters for /json/stations/search
 */
function searchParams(q) {
    const p = new URLSearchParams();
    const name = String(q.query ?? q.name ?? '').trim();
    if (name) {
        p.set('name', name);
    }
    const country = String(q.country ?? '').trim();
    if (/^[A-Za-z]{2}$/.test(country)) {
        p.set('countrycode', country.toUpperCase());
    } else if (country) {
        p.set('country', country);
    }
    const tag = String(q.tag ?? '').trim();
    if (tag) {
        p.set('tag', tag);
    }
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(Number(q.limit) || 10)));
    p.set('limit', String(limit));
    p.set('hidebroken', 'true');
    p.set('order', 'clickcount');
    p.set('reverse', 'true');
    return p;
}

/** Client of the catalog. */
class RadioBrowser {
    /**
     * @param {object} options - Options
     * @param {string} options.userAgent - e.g. `ioBroker.webradio/0.0.1`
     * @param {string} [options.server] - Fixed mirror (host name), empty = choose
     * @param {typeof fetch} [options.fetch] - fetch (tests)
     */
    constructor(options) {
        this.userAgent = options.userAgent;
        this.fixed = String(options.server || '').trim();
        this.fetch = options.fetch || globalThis.fetch;
        /** @type {string[]} */
        this.servers = [];
        this.serversAt = 0;
    }

    /**
     * @param {string} url - URL
     * @returns {Promise<unknown>} JSON answer
     */
    async getJson(url) {
        const res = await this.fetch(url, {
            headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
    }

    /**
     * @returns {Promise<string[]>} Mirrors to try, in order
     */
    async mirrors() {
        if (this.fixed) {
            return [this.fixed];
        }
        if (!this.servers.length || Date.now() - this.serversAt > SERVER_LIST_TTL) {
            let names = [];
            try {
                const list = await this.getJson('https://all.api.radio-browser.info/json/servers');
                names = [...new Set((Array.isArray(list) ? list : []).map(s => String(s?.name || '')))].filter(n =>
                    /^[a-z0-9.-]+\.radio-browser\.info$/.test(n),
                );
            } catch {
                // the list is optional
            }
            this.servers = names.length ? names : [...FALLBACK_SERVERS];
            this.serversAt = Date.now();
        }
        const list = [...this.servers];
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    /**
     * A request to the first mirror that answers.
     *
     * @param {string} path - Path with query
     * @returns {Promise<unknown>} JSON answer
     */
    async request(path) {
        let last = new Error('no mirror');
        for (const host of (await this.mirrors()).slice(0, 3)) {
            try {
                return await this.getJson(`https://${host}${path}`);
            } catch (e) {
                last = e;
            }
        }
        throw new Error(`radio-browser.info did not answer: ${last.message}`);
    }

    /**
     * @param {{query?: unknown, name?: unknown, country?: unknown, tag?: unknown, limit?: unknown}} q - Search
     * @returns {Promise<CatalogStation[]>} Stations, most played first
     */
    async search(q) {
        const p = searchParams(q);
        if (!p.has('name') && !p.has('tag') && !p.has('country') && !p.has('countrycode')) {
            return [];
        }
        const list = await this.request(`/json/stations/search?${p}`);
        return (Array.isArray(list) ? list : []).map(toCatalogStation).filter(s => s.uuid && s.name && s.url);
    }

    /**
     * @param {string} uuid - stationuuid
     * @returns {Promise<CatalogStation | null>} Station
     */
    async byUuid(uuid) {
        if (!/^[0-9a-f-]{36}$/i.test(String(uuid))) {
            return null;
        }
        const list = await this.request(`/json/stations/byuuid/${uuid}`);
        const s = Array.isArray(list) && list[0] ? toCatalogStation(list[0]) : null;
        return s && s.url ? s : null;
    }

    /**
     * Counts a play at the catalog (its popularity order depends on it); failures do not matter.
     *
     * @param {string} uuid - stationuuid
     */
    async click(uuid) {
        if (/^[0-9a-f-]{36}$/i.test(String(uuid))) {
            await this.request(`/json/url/${uuid}`).catch(() => undefined);
        }
    }
}

module.exports = { RadioBrowser, toCatalogStation, searchParams, FALLBACK_SERVERS };
