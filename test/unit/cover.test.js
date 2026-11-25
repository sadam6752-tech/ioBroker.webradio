'use strict';

// Covers of the playing song from the iTunes Search API: which titles are looked up, which result is taken, the cache
// and the limit per minute.

const assert = require('node:assert/strict');
const { CoverFinder, splitTitle, pickCover, MAX_PER_MINUTE, COVER_SIZE } = require('../../lib/cover');

const ART = 'https://is1-ssl.mzstatic.com/image/thumb/Music/x/y.jpg/100x100bb.jpg';

/**
 * @param {Array<Record<string, unknown>>} results - Results to answer
 * @param {{ok?: boolean, fail?: boolean}} [o] - Answer an error
 * @returns {{fetch: any, urls: string[]}} Fake
 */
function fakeItunes(results, o = {}) {
    const urls = [];
    const fetch = async url => {
        urls.push(url);
        if (o.fail) {
            throw new Error('offline');
        }
        return { ok: o.ok !== false, status: o.ok === false ? 503 : 200, json: async () => ({ results }) };
    };
    return { fetch, urls };
}

describe('covers of the playing song', () => {
    it('looks up "Artist - Title" only, without the edit and remaster notes', () => {
        assert.deepEqual(splitTitle('Daft Punk - Get Lucky (Radio Edit)'), { artist: 'Daft Punk', title: 'Get Lucky' });
        assert.deepEqual(splitTitle('Кино - Группа крови'), { artist: 'Кино', title: 'Группа крови' });
        assert.deepEqual(splitTitle('AC/DC - Back In Black - Remastered'), {
            artist: 'AC/DC',
            title: 'Back In Black - Remastered',
        });
        assert.equal(splitTitle('SWR3 Nachrichten'), null);
        assert.equal(splitTitle(' - '), null);
        assert.equal(splitTitle('Werbung -'), null);
        assert.equal(splitTitle(''), null);
    });

    it('takes a result whose artist and title match, in 600 px, else none', () => {
        const want = { artist: 'Daft Punk', title: 'Get Lucky' };
        const results = [
            { artistName: 'Someone Else', trackName: 'Get Lucky', artworkUrl100: `${ART}?a` },
            { artistName: 'Daft Punk, Pharrell Williams & Nile Rodgers', trackName: 'Get Lucky', artworkUrl100: ART },
        ];
        assert.equal(pickCover(results, want), ART.replace('100x100bb', `${COVER_SIZE}x${COVER_SIZE}bb`));
        assert.equal(
            pickCover([{ artistName: 'Daft Punk', trackName: 'Around the World', artworkUrl100: ART }], want),
            '',
        );
        assert.equal(
            pickCover([{ artistName: 'Daft Punk', trackName: 'Get Lucky', artworkUrl100: 'http://x/a.jpg' }], want),
            '',
            'https only',
        );
        assert.equal(pickCover(/** @type {any} */ (null), want), '');
    });

    it('asks once per song, sends only artist and title, and keeps to the limit per minute', async () => {
        let now = 1_000_000;
        const it = fakeItunes([{ artistName: 'Daft Punk', trackName: 'Get Lucky', artworkUrl100: ART }]);
        const finder = new CoverFinder({ userAgent: 'ua', fetch: it.fetch, now: () => now });
        const first = await finder.find('Daft Punk - Get Lucky');
        assert.match(first, /600x600bb\.jpg$/);
        assert.equal(await finder.find('DAFT PUNK - get lucky'), first, 'from the cache');
        assert.equal(it.urls.length, 1);
        const q = new URL(it.urls[0]).searchParams;
        assert.deepEqual([q.get('term'), q.get('media'), q.get('entity')], ['Daft Punk Get Lucky', 'music', 'song']);
        assert.equal(await finder.find('Station jingle'), '');
        await finder.find('Кино - Группа крови');
        assert.equal(new URL(it.urls[1]).searchParams.get('country'), 'ru', 'Cyrillic: the Russian store');
        assert.equal(q.get('country'), null);
        assert.equal(it.urls.length, 2, 'no lookup for a title without a song');

        for (let i = 0; i < MAX_PER_MINUTE + 5; i++) {
            await finder.find(`Artist ${i} - Song ${i}`);
        }
        assert.equal(it.urls.length, MAX_PER_MINUTE, 'at most 20 lookups per minute');
        now += 61_000;
        await finder.find('Artist 99 - Song 99');
        assert.equal(it.urls.length, MAX_PER_MINUTE + 1, 'a minute later it asks again');
    });

    it('gives none on errors and tries again later', async () => {
        const down = fakeItunes([], { fail: true });
        const finder = new CoverFinder({ userAgent: 'ua', fetch: down.fetch });
        assert.equal(await finder.find('A - B'), '');
        assert.equal(await finder.find('A - B'), '');
        assert.equal(down.urls.length, 2, 'an error is not cached');
        const busy = fakeItunes([], { ok: false });
        assert.equal(await new CoverFinder({ userAgent: 'ua', fetch: busy.fetch }).find('A - B'), '');
    });
});
