'use strict';

const assert = require('node:assert/strict');
const { RadioBrowser, toCatalogStation, searchParams, sentQuery } = require('../../lib/radio-browser');
const { sniffImage } = require('../../lib/logos');

/**
 * A fetch that answers from a table and records the calls.
 *
 * @param {Record<string, any>} answers - host → JSON answer, or an Error to throw
 * @returns {{fetch: any, calls: Array<{url: string, headers: Record<string, string>}>}} Fake
 */
function fakeFetch(answers) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const host = new URL(url).host;
        const a = answers[host];
        if (a instanceof Error || a === undefined) {
            throw a || new Error('ENOTFOUND');
        }
        return { ok: true, status: 200, json: async () => (typeof a === 'function' ? a(url) : a) };
    };
    return { fetch, calls };
}

const RECORD = {
    stationuuid: '09902861-999f-4a6e-915b-3692401aee84',
    name: ' Radio Record Trancehouse ',
    url: 'https://radiorecord.hostingradio.ru/x.m3u',
    url_resolved: 'https://radiorecord.hostingradio.ru/trancehouse96.aacp',
    favicon: 'https://radiorecord.ru/icons/apple-touch-icon.png',
    tags: 'electronic,trance',
    country: 'The Russian Federation',
    countrycode: 'RU',
    codec: 'AAC',
    bitrate: 96,
    hls: 0,
};

describe('radio-browser.info', () => {
    it('builds the search: name, country code or name, tag, limit 1–50, most played first, no broken', () => {
        const p = searchParams({ query: 'record', country: 'ru', tag: 'trance', limit: 500 });
        assert.equal(p.get('name'), 'record');
        assert.equal(p.get('countrycode'), 'RU');
        assert.equal(p.get('tag'), 'trance');
        assert.equal(p.get('limit'), '50');
        assert.equal(p.get('hidebroken'), 'true');
        assert.equal(p.get('order'), 'clickcount');
        assert.equal(searchParams({ name: 'x', country: 'Germany' }).get('country'), 'Germany');
        assert.equal(searchParams({ name: 'x' }).get('limit'), '10');
    });

    it('sends a two-letter country as countrycode, a longer one as country, names in UTF-8', async () => {
        const ru = searchParams({ query: 'Радио Рекорд', country: 'RU', limit: 15 });
        assert.equal(ru.get('countrycode'), 'RU');
        assert.equal(ru.has('country'), false);
        assert.match(ru.toString(), /name=%D0%A0%D0%B0%D0%B4%D0%B8%D0%BE\+%D0%A0%D0%B5%D0%BA%D0%BE%D1%80%D0%B4/);
        assert.deepEqual(sentQuery(ru), { name: 'Радио Рекорд', countrycode: 'RU', limit: 15 });
        const long = searchParams({ query: 'Record', country: 'Russian Federation' });
        assert.equal(long.get('country'), 'Russian Federation');
        assert.equal(long.has('countrycode'), false);
        assert.equal(searchParams({ query: 'x', countrycode: 'de' }).get('countrycode'), 'DE', 'countrycode as alias');
        assert.deepEqual(sentQuery(searchParams({ tag: 'trance', limit: 3 })), { tag: 'trance', limit: 3 });

        const { fetch, calls } = fakeFetch({
            'de1.api.radio-browser.info': url => (url.includes('countrycode=RU') ? [RECORD] : []),
        });
        const rb = new RadioBrowser({ userAgent: 'ua', server: 'de1.api.radio-browser.info', fetch });
        assert.equal((await rb.search({ query: 'Радио Рекорд', country: 'RU' })).length, 1);
        assert.equal(new URL(calls[0].url).searchParams.get('name'), 'Радио Рекорд');
    });

    it('keeps the fields the adapter uses, the resolved URL first', () => {
        const s = toCatalogStation(RECORD);
        assert.equal(s.name, 'Radio Record Trancehouse');
        assert.equal(s.url, 'https://radiorecord.hostingradio.ru/trancehouse96.aacp');
        assert.deepEqual(s.tags, ['electronic', 'trance']);
        assert.equal(s.hls, false);
        assert.equal(toCatalogStation({ ...RECORD, favicon: 'data:x' }).favicon, '');
    });

    it('asks a mirror from the server list and falls back to the next one', async () => {
        const { fetch, calls } = fakeFetch({
            'all.api.radio-browser.info': [
                { name: 'de1.api.radio-browser.info' },
                { name: 'evil.example.com' },
                { name: 'nl1.api.radio-browser.info' },
            ],
            'de1.api.radio-browser.info': new Error('down'),
            'nl1.api.radio-browser.info': [RECORD],
        });
        const rb = new RadioBrowser({ userAgent: 'ioBroker.webradio/0.0.1', fetch });
        for (let i = 0; i < 3; i++) {
            const found = await rb.search({ query: 'record' });
            assert.equal(found.length, 1);
        }
        assert.ok(!calls.some(c => c.url.includes('evil.example.com')), 'only radio-browser.info hosts');
        assert.equal(calls.filter(c => c.url.includes('/json/servers')).length, 1, 'the list is kept');
        for (const c of calls) {
            assert.equal(c.headers['User-Agent'], 'ioBroker.webradio/0.0.1');
        }
    });

    it('takes the fallback mirrors when the server list fails, and says so when nothing answers', async () => {
        const { fetch } = fakeFetch({});
        const rb = new RadioBrowser({ userAgent: 'x', fetch });
        await assert.rejects(rb.search({ query: 'a' }), /radio-browser.info did not answer/);
        assert.ok(rb.servers.length >= 2);
    });

    it('does not search without anything to search for, and checks a uuid before asking', async () => {
        const { fetch, calls } = fakeFetch({ 'de1.api.radio-browser.info': [RECORD] });
        const rb = new RadioBrowser({ userAgent: 'x', server: 'de1.api.radio-browser.info', fetch });
        assert.deepEqual(await rb.search({ query: '  ' }), []);
        assert.equal(await rb.byUuid('../../etc'), null);
        assert.equal(calls.length, 0);
        assert.equal((await rb.byUuid(RECORD.stationuuid))?.name, 'Radio Record Trancehouse');
    });
});

describe('logos', () => {
    it('knows images by their first bytes', () => {
        assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
        assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
        assert.equal(sniffImage(Buffer.from('GIF89a....')), 'gif');
        assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
        assert.equal(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0])), 'ico');
        assert.equal(sniffImage(Buffer.from('  <svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
        assert.equal(sniffImage(Buffer.from('<html><body>404</body></html>')), '');
    });
});
