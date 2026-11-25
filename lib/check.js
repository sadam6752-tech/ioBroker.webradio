'use strict';

/*
 * The daily check of the favourites: does each station still answer? A station that does not, but came from
 * radio-browser.info, gets the URL the catalog has now, when that one answers. The new URL is kept in the station's
 * object, not in the settings (no restart); it is dropped as soon as the URL in the settings changes.
 */

/**
 * @typedef {import('./types').Station} Station
 * @typedef {{online: boolean, url: string, refreshed: boolean, error?: string}} CheckResult
 */

/** Hours between two checks */
const CHECK_INTERVAL_HOURS = 24;
/** The first check after the start waits this long, so it does not slow the start */
const FIRST_CHECK_DELAY_MS = 2 * 60_000;

/**
 * Checks one station.
 *
 * @param {Station} station - Station (with the URL in use)
 * @param {object} o - Helpers
 * @param {(url: string) => Promise<void>} o.probe - Resolves when the URL plays (a stream, a playlist or HLS), rejects with the reason
 * @param {(uuid: string) => Promise<{url: string} | null>} o.byUuid - The station in radio-browser.info
 * @returns {Promise<CheckResult>} Result
 */
async function checkStation(station, o) {
    try {
        await o.probe(station.url);
        return { online: true, url: station.url, refreshed: false };
    } catch (e) {
        const error = String(e?.message || e);
        if (!station.uuid) {
            return { online: false, url: station.url, refreshed: false, error };
        }
        let fresh = null;
        try {
            fresh = await o.byUuid(station.uuid);
        } catch {
            // the catalog does not answer: try again next time
        }
        if (!fresh?.url || fresh.url === station.url) {
            return { online: false, url: station.url, refreshed: false, error };
        }
        try {
            await o.probe(fresh.url);
            return { online: true, url: fresh.url, refreshed: true };
        } catch {
            return { online: false, url: station.url, refreshed: false, error };
        }
    }
}

/**
 * The URL a station is played with: the refreshed one, while the settings still have the URL it replaced.
 *
 * @param {string} configUrl - URL in the settings
 * @param {Record<string, unknown>} native - native of the station's channel
 * @returns {string} URL to use
 */
function urlInUse(configUrl, native) {
    const refreshed = typeof native?.refreshedUrl === 'string' ? native.refreshedUrl : '';
    return refreshed && native.configUrl === configUrl && /^https?:\/\//i.test(refreshed) ? refreshed : configUrl;
}

module.exports = { checkStation, urlInUse, CHECK_INTERVAL_HOURS, FIRST_CHECK_DELAY_MS };
