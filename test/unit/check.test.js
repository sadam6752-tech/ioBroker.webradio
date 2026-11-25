'use strict';

// The daily check of the favourites, and the new URL from radio-browser.info for a station that does not answer.

const assert = require('node:assert/strict');
const { checkStation, urlInUse } = require('../../lib/check');

/**
 * @param {string} url - URL
 * @param {string} [uuid] - radio-browser.info uuid
 * @returns {any} Station
 */
const station = (url, uuid = '') => ({ id: 'x', name: 'X', url, logo: '', tags: [], uuid });

/**
 * @param {string[]} working - URLs that answer
 * @returns {{probe: (url: string) => Promise<void>, tried: string[]}} Probe
 */
function probeOf(working) {
    const tried = [];
    return {
        tried,
        probe: async url => {
            tried.push(url);
            if (!working.includes(url)) {
                throw new Error('HTTP 404');
            }
        },
    };
}

describe('check of the favourites', () => {
    it('reports a station that answers, without asking the catalog', async () => {
        const p = probeOf(['http://ok/']);
        let asked = 0;
        const res = await checkStation(station('http://ok/', 'u'), {
            probe: p.probe,
            byUuid: async () => (asked++, null),
        });
        assert.deepEqual(res, { online: true, url: 'http://ok/', refreshed: false });
        assert.equal(asked, 0);
    });

    it('takes the new URL of the catalog when the old one is dead and the new one answers', async () => {
        const p = probeOf(['https://new/']);
        const res = await checkStation(station('http://old/', 'u-1'), {
            probe: p.probe,
            byUuid: async uuid => (uuid === 'u-1' ? { url: 'https://new/' } : null),
        });
        assert.deepEqual(res, { online: true, url: 'https://new/', refreshed: true });
        assert.deepEqual(p.tried, ['http://old/', 'https://new/']);
    });

    it('stays offline when there is no uuid, no new URL, the same URL, or the new one is dead too', async () => {
        const dead = probeOf([]);
        const cases = [
            [station('http://old/'), async () => ({ url: 'https://new/' })],
            [station('http://old/', 'u'), async () => null],
            [station('http://old/', 'u'), async () => ({ url: 'http://old/' })],
            [station('http://old/', 'u'), async () => ({ url: 'https://also-dead/' })],
            [
                station('http://old/', 'u'),
                async () => {
                    throw new Error('catalog down');
                },
            ],
        ];
        for (const [s, byUuid] of cases) {
            const res = await checkStation(/** @type {any} */ (s), {
                probe: dead.probe,
                byUuid: /** @type {any} */ (byUuid),
            });
            assert.deepEqual(res, { online: false, url: 'http://old/', refreshed: false, error: 'HTTP 404' });
        }
    });

    it('plays the refreshed URL only while the settings keep the URL it replaced', () => {
        const native = { refreshedUrl: 'https://new/', configUrl: 'http://old/' };
        assert.equal(urlInUse('http://old/', native), 'https://new/');
        assert.equal(urlInUse('http://edited/', native), 'http://edited/', 'the user changed the URL');
        assert.equal(urlInUse('http://old/', {}), 'http://old/');
        assert.equal(
            urlInUse('http://old/', { refreshedUrl: 'javascript:x', configUrl: 'http://old/' }),
            'http://old/',
        );
    });
});
