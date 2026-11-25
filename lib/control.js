'use strict';

/*
 * Player control without a station name: resume the last station, step to the next or previous favourite, and the
 * sleep timer that fades the volume out and stops the player.
 */

/**
 * @typedef {import('./types').Station} Station
 * @typedef {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (h: unknown) => void}} Timers
 */

/**
 * What a player remembers of its last station (state targets.<player>.lastStation, JSON): a favourite by its id, any
 * other station (catalog, URL) with its URL.
 *
 * @param {Station} station - Station
 * @returns {{id: string, name: string, url: string, logo: string, uuid: string}} JSON-able copy
 */
function rememberStation(station) {
    return {
        id: station.id,
        name: station.name,
        url: station.url,
        logo: station.logo || '',
        uuid: station.uuid || '',
    };
}

/**
 * The station to resume: the remembered favourite as it is configured now, the remembered catalog or URL station,
 * else the first favourite.
 *
 * @param {Station[]} favourites - Favourites, in their order
 * @param {unknown} last - Value of lastStation (JSON text or object), or the station that played last in this run
 * @returns {Station | null} Station, null = nothing to play
 */
function resumeStation(favourites, last) {
    let saved = last;
    if (typeof saved === 'string') {
        try {
            saved = JSON.parse(saved);
        } catch {
            saved = null;
        }
    }
    const s = /** @type {Partial<Station> | null} */ (saved && typeof saved === 'object' ? saved : null);
    if (s?.id) {
        const fav = favourites.find(f => f.id === s.id);
        if (fav) {
            return fav;
        }
    }
    if (s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
        return {
            id: '',
            name: String(s.name || s.url),
            url: s.url,
            logo: String(s.logo || ''),
            tags: [],
            uuid: String(s.uuid || ''),
        };
    }
    return favourites[0] || null;
}

/**
 * The next or previous favourite, wrapping around. From a station that is no favourite (or none): next = the first,
 * previous = the last.
 *
 * @param {Station[]} favourites - Favourites, in their order
 * @param {string} currentId - Id of the current station ('' = none or not a favourite)
 * @param {1 | -1} step - 1 = next, -1 = previous
 * @returns {Station | null} Station, null = no favourites
 */
function stepStation(favourites, currentId, step) {
    if (!favourites.length) {
        return null;
    }
    const i = currentId ? favourites.findIndex(f => f.id === currentId) : -1;
    if (i < 0) {
        return step > 0 ? favourites[0] : favourites[favourites.length - 1];
    }
    const n = favourites.length;
    return favourites[(((i + step) % n) + n) % n];
}

/**
 * The volume of a player in percent from the value of its volume state and the state's range (the inverse of
 * scaleVolume).
 *
 * @param {unknown} value - Value of the volume state
 * @param {{min?: unknown, max?: unknown}} [common] - Range (default 0 … 1)
 * @returns {number | null} 0 … 100, null = unknown
 */
function percentOf(value, common = {}) {
    const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
    const v = num(value, null);
    if (v === null) {
        return null;
    }
    const min = num(common.min, 0);
    const max = num(common.max, 1);
    if (max <= min) {
        return null;
    }
    return Math.round(Math.max(0, Math.min(1, (v - min) / (max - min))) * 100);
}

/** Titles kept per player */
const HISTORY_SIZE = 50;

/**
 * @typedef {{ts: number, station: string, title: string}} HistoryEntry
 */

/**
 * The title history of a player with a new title in front: the same title as the newest one is not added again (a
 * stream repeats its metadata), the list keeps HISTORY_SIZE entries.
 *
 * @param {unknown} list - Current history (array, or the JSON text of the state)
 * @param {HistoryEntry} entry - New title
 * @returns {HistoryEntry[]} New history, newest first
 */
function addHistory(list, entry) {
    const now = readHistory(list);
    if (now[0] && now[0].title === entry.title && now[0].station === entry.station) {
        return now;
    }
    return [entry, ...now].slice(0, HISTORY_SIZE);
}

/**
 * @param {unknown} value - Array, or the JSON text of the history state
 * @returns {HistoryEntry[]} Valid entries
 */
function readHistory(value) {
    let list = value;
    if (typeof list === 'string') {
        try {
            list = JSON.parse(list);
        } catch {
            list = [];
        }
    }
    return (Array.isArray(list) ? list : [])
        .filter(e => e && typeof e.title === 'string' && Number.isFinite(e.ts))
        .map(e => ({ ts: e.ts, station: String(e.station || ''), title: e.title }))
        .slice(0, HISTORY_SIZE);
}

/** The volume fades out during the last this many milliseconds */
const FADE_MS = 30_000;
/** One volume step of the fade every this many milliseconds */
const FADE_STEP_MS = 3_000;

/**
 * Sleep timer of one player: reports the minutes left, fades in the last FADE_MS, then ends.
 */
class SleepTimer {
    /**
     * @param {object} o - Options
     * @param {Timers} o.timers - Adapter timers
     * @param {(minutesLeft: number, endsAt: number) => void} o.onLeft - Minutes left (rounded up), at the start and every minute
     * @param {(fraction: number) => void} o.onFade - Volume factor 1 … 0 during the fade
     * @param {() => void} o.onEnd - Time is up
     * @param {() => number} [o.now] - Clock (tests)
     * @param {number} [o.fadeMs] - Fade length (tests)
     * @param {number} [o.stepMs] - Fade step (tests)
     */
    constructor(o) {
        this.o = o;
        this.now = o.now || Date.now;
        this.fadeMs = o.fadeMs ?? FADE_MS;
        this.stepMs = o.stepMs ?? FADE_STEP_MS;
        /** @type {unknown} */
        this.timer = null;
        /** End time (ms), 0 = off */
        this.endsAt = 0;
    }

    /** @returns {boolean} The timer runs */
    get active() {
        return this.endsAt > 0;
    }

    /**
     * @param {number} minutes - Minutes from now; 0 or less = off
     */
    start(minutes) {
        this.cancel();
        if (!(minutes > 0)) {
            return;
        }
        this.endsAt = this.now() + Math.round(minutes * 60_000);
        this.tick();
    }

    /** Stops the timer without ending anything. */
    cancel() {
        this.o.timers.clearTimeout(this.timer);
        this.timer = null;
        this.endsAt = 0;
    }

    /** @private */
    tick() {
        this.timer = null;
        const left = this.endsAt - this.now();
        if (left <= 0) {
            this.endsAt = 0;
            this.o.onEnd();
            return;
        }
        this.o.onLeft(Math.ceil(left / 60_000), this.endsAt);
        if (left <= this.fadeMs) {
            this.o.onFade(left / this.fadeMs);
        }
        // the next minute mark, the start of the fade, the next fade step or the end, whichever comes first
        const toMinute = ((left - 1) % 60_000) + 1;
        const toFade = left - this.fadeMs;
        const next = left <= this.fadeMs ? Math.min(this.stepMs, left) : Math.min(toMinute, toFade);
        this.timer = this.o.timers.setTimeout(() => this.tick(), Math.max(1, next));
    }
}

module.exports = {
    rememberStation,
    resumeStation,
    stepStation,
    percentOf,
    addHistory,
    readHistory,
    SleepTimer,
    FADE_MS,
    HISTORY_SIZE,
};
