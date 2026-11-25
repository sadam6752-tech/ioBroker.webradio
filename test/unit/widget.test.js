'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const w = require('../../widgets/webradio/js/webradio.js');
const { stationList, targetList } = require('../../lib/lists');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'widgets', 'webradio.html'), 'utf8');

describe('vis widget "Radio"', () => {
    it('takes a valid instance only', () => {
        assert.equal(w.instanceOf('webradio.1'), 'webradio.1');
        assert.equal(w.instanceOf(' webradio.0 '), 'webradio.0');
        assert.equal(w.instanceOf('javascript.0'), 'webradio.0');
        assert.equal(w.instanceOf('webradio.0.targets'), 'webradio.0');
        assert.equal(w.instanceOf(undefined), 'webradio.0');
    });

    it('reads the JSON lists of the adapter and ignores broken ones', () => {
        assert.deepEqual(w.parseList('[{"id":"a","name":"A"},{"name":"no id"},null]'), [{ id: 'a', name: 'A' }]);
        assert.deepEqual(w.parseList('not json'), []);
        assert.deepEqual(w.parseList('{"id":"a"}'), []);
        assert.deepEqual(w.parseList(undefined), []);
    });

    it('picks the fixed player by id or name, else the remembered one, else the first', () => {
        const targets = [
            { id: 'kitchen', name: 'Kitchen' },
            { id: 'cinema', name: 'Cinema' },
        ];
        assert.equal(w.pickTarget(targets, 'CINEMA', 'kitchen'), 'cinema');
        assert.equal(w.pickTarget(targets, 'Kitchen', ''), 'kitchen');
        assert.equal(w.pickTarget(targets, 'garage', 'kitchen'), '', 'a fixed player that is missing is not replaced');
        assert.equal(w.pickTarget(targets, '', 'cinema'), 'cinema');
        assert.equal(w.pickTarget(targets, '', 'gone'), 'kitchen');
        assert.equal(w.pickTarget([], '', ''), '');
    });

    it('loads the cached logo through the web adapter first, then the logo URL', () => {
        assert.deepEqual(
            w.logoSources({ file: 'webradio.0.storage/logos/swr3.png', logo: 'http://10.0.0.2:8096/logo/swr3' }),
            ['../webradio.0.storage/logos/swr3.png', 'http://10.0.0.2:8096/logo/swr3'],
        );
        assert.deepEqual(w.logoSources({ file: '', logo: 'https://example.org/x.png' }), ['https://example.org/x.png']);
        assert.deepEqual(w.logoSources({ file: '../../etc/passwd', logo: 'javascript:alert(1)' }), []);
    });

    it('escapes names and limits the attributes', () => {
        assert.equal(w.esc('<b a="1">R&B\'s</b>'), '&lt;b a=&quot;1&quot;&gt;R&amp;B&#39;s&lt;/b&gt;');
        assert.equal(w.columnsOf('0', 4), 1);
        assert.equal(w.columnsOf('99', 4), 12);
        assert.equal(w.columnsOf('x', 4), 4);
        assert.equal(w.flag(undefined, true), true);
        assert.equal(w.flag('false', true), false);
        assert.equal(w.flag(true, false), true);
        assert.equal(w.volumeOf('55.4'), 55);
        assert.equal(w.volumeOf(140), 100);
        assert.equal(w.volumeOf(null), 0);
    });

    it('has every word and attribute name in the eleven languages, translated', () => {
        const dict = w.dictionary();
        for (const [key, langs] of Object.entries(dict)) {
            assert.deepEqual(Object.keys(langs), w.LANGS, key);
            for (const lang of w.LANGS) {
                assert.ok(langs[lang] && langs[lang].trim(), `${key}.${lang}`);
            }
            assert.notEqual(langs.de, langs.en, `${key}: de like en`);
            assert.notEqual(langs.ru, langs.en, `${key}: ru like en`);
        }
        const attrs = [...html.matchAll(/data-vis-attrs\d*="([^"]+)"/g)]
            .flatMap(m => m[1].split(';'))
            .filter(Boolean)
            .map(a => a.split(/[[/]/)[0])
            .map(a => (a.startsWith('group.') ? `group_${a.slice(6)}` : a));
        assert.ok(attrs.length >= 10);
        for (const a of attrs) {
            assert.ok(dict[a], `no translation for the attribute ${a}`);
        }
    });

    it('is a vis widget set named like the adapter, with its files in the package', () => {
        assert.match(html, /data-vis-set="webradio"/);
        assert.match(html, /vis\.binds\.webradio\.radio\(this\.data\.wid, this\.data\)/);
        for (const m of html.matchAll(/(?:href|src)="(widgets\/[^"]+)"/g)) {
            assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
        }
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.ok(pkg.files.includes('widgets/'));
        const io = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));
        assert.ok(io.common.restartAdapters.includes('vis'));
        for (const id of ['info.stations', 'info.targets']) {
            assert.equal(io.instanceObjects.find(o => o._id === id)?.common.role, 'json', id);
        }
    });
});

describe('lists for the widget', () => {
    it('lists the stations with the cached logo file and the players with their rooms', () => {
        const stations = /** @type {any[]} */ ([
            { id: 'swr3', name: 'SWR3', logo: 'https://swr3.de/l.png' },
            { id: 'record', name: 'Record', logo: '' },
        ]);
        const files = new Map([['swr3', 'logos/swr3.png']]);
        assert.deepEqual(
            stationList(stations, files, 'webradio.0.storage', s =>
                files.has(s.id) ? `http://h:8096/logo/${s.id}` : s.logo,
            ),
            [
                {
                    id: 'swr3',
                    name: 'SWR3',
                    logo: 'http://h:8096/logo/swr3',
                    file: 'webradio.0.storage/logos/swr3.png',
                },
                { id: 'record', name: 'Record', logo: '', file: '' },
            ],
        );
        assert.deepEqual(
            targetList([{ id: 'kitchen', name: 'Kitchen', urlState: 'x' }], t =>
                t.id === 'kitchen' ? ['Kitchen'] : [],
            ),
            [{ id: 'kitchen', name: 'Kitchen', rooms: ['Kitchen'] }],
        );
    });
});
