'use strict';

// Import and export of the favourites: M3U, PLS, JSON and URL lists; nothing is added twice.

const assert = require('node:assert/strict');
const { exportStations, importStations } = require('../../lib/transfer');

const rows = [
    {
        enabled: true,
        name: 'SWR3',
        url: 'https://swr3.de/live.mp3',
        logo: 'https://swr3.de/l.png',
        tags: 'pop, news',
        uuid: 'u-1',
    },
    { enabled: false, name: 'Радио Рекорд, Dance', url: 'https://record.ru/192.mp3', logo: '', tags: '' },
    { enabled: true, name: 'no URL', url: 'file:///x', logo: '', tags: '' },
];

describe('import and export of the favourites', () => {
    it('exports M3U with logo and tags, and JSON with all fields; rows without an http URL are left out', () => {
        assert.equal(
            exportStations(rows, 'm3u'),
            '#EXTM3U\n' +
                '#EXTINF:-1 tvg-logo="https://swr3.de/l.png" group-title="pop, news",SWR3\n' +
                'https://swr3.de/live.mp3\n' +
                '#EXTINF:-1,Радио Рекорд, Dance\n' +
                'https://record.ru/192.mp3\n',
        );
        const json = JSON.parse(exportStations(rows, 'json'));
        assert.equal(json.length, 2);
        assert.deepEqual(json[0], rows[0]);
        assert.equal(json[1].enabled, false);
        assert.equal(json[1].uuid, undefined);
    });

    it('reads its own M3U and JSON back (round trip), and skips what is there already', () => {
        for (const format of /** @type {const} */ (['m3u', 'json'])) {
            const res = importStations(exportStations(rows, format), []);
            assert.equal(res.format, format);
            assert.equal(res.added, 2, format);
            assert.deepEqual(
                res.rows.map(r => [r.name, r.url]),
                [
                    ['SWR3', 'https://swr3.de/live.mp3'],
                    ['Радио Рекорд, Dance', 'https://record.ru/192.mp3'],
                ],
            );
            assert.equal(res.rows[0].logo, 'https://swr3.de/l.png');
            assert.equal(res.rows[0].tags, 'pop, news');
            const again = importStations(exportStations(rows, format), res.rows);
            assert.deepEqual([again.added, again.skipped, again.rows.length], [0, 2, 2]);
        }
    });

    it('reads PLS, a plain URL list, radio-browser JSON and a JSON with a stations list', () => {
        const pls = importStations(
            '[playlist]\r\nFile1=http://a.example/live\r\nTitle1=A Radio\r\nFile2=ftp://x\r\nNumberOfEntries=2\r\n',
            [],
        );
        assert.deepEqual([pls.format, pls.added, pls.skipped], ['pls', 1, 1]);
        assert.deepEqual([pls.rows[0].name, pls.rows[0].url], ['A Radio', 'http://a.example/live']);

        const urls = importStations('﻿http://b.example/stream\n\nnot a url\nhttps://c.example:8000/x.aac\n', []);
        assert.deepEqual([urls.format, urls.added], ['urls', 2]);
        assert.equal(urls.rows[0].name, 'b.example', 'the host as name');

        const rb = importStations(
            JSON.stringify([
                {
                    name: 'RB',
                    url_resolved: 'https://rb.example/s',
                    favicon: 'https://rb.example/f.png',
                    tags: ['rock', 'pop'],
                    stationuuid: 'u-9',
                },
            ]),
            [],
        );
        assert.deepEqual(rb.rows[0], {
            enabled: true,
            name: 'RB',
            url: 'https://rb.example/s',
            logo: 'https://rb.example/f.png',
            tags: 'rock, pop',
            uuid: 'u-9',
        });
        const sameUuid = importStations(
            JSON.stringify({ stations: [{ name: 'RB 2', url: 'https://rb.example/other', uuid: 'u-9' }] }),
            rb.rows,
        );
        assert.equal(sameUuid.added, 0, 'the same radio-browser station');
    });

    it('takes the title after the first comma outside the quotes, and drops a logo that is no URL', () => {
        const res = importStations(
            '#EXTM3U\n#EXTINF:-1 tvg-logo="javascript:x" group-title="a, b",Name, with comma\nhttp://x.example/\n',
            [],
        );
        assert.deepEqual(res.rows[0], {
            enabled: true,
            name: 'Name, with comma',
            url: 'http://x.example/',
            logo: '',
            tags: 'a, b',
        });
    });

    it('finds nothing in text that is no list', () => {
        assert.deepEqual(importStations('<html>nothing</html>', rows).added, 0);
        assert.equal(importStations('', []).rows.length, 0);
        assert.throws(() => importStations('{broken', []), SyntaxError);
    });
});
