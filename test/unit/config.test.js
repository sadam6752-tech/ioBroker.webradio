'use strict';

const assert = require('node:assert/strict');
const {
    toId,
    normalizeStations,
    presetFor,
    discoverTargets,
    buildTargets,
    streamFor,
    findByName,
    roomsOf,
    scaleVolume,
    fitTitle,
    parseStopValue,
    urlStateChoices,
    customIds,
} = require('../../lib/config');

/**
 * @param {string} role - Role
 * @returns {ioBroker.Object} State object
 */
const state = role => /** @type {any} */ ({ type: 'state', common: { role, type: 'string', write: true }, native: {} });
/**
 * @param {string} name - Name
 * @param {Record<string, string>} native - native
 * @returns {ioBroker.Object} Device object
 */
const device = (name, native) => /** @type {any} */ ({ type: 'device', common: { name }, native });

describe('stations', () => {
    it('makes ids from names, with umlauts and Cyrillic', () => {
        assert.equal(toId('Radio Köln 1'), 'radio_koeln_1');
        assert.equal(toId('Énergie FM'), 'energie_fm');
        assert.equal(toId('Радио Рекорд', 'station'), 'station');
    });

    it('reads the table: skips rows without name or URL, makes ids unique, splits tags', () => {
        const { stations, problems } = normalizeStations([
            {
                enabled: true,
                name: 'SWR3',
                url: 'https://liveradio.swr.de/sw282p3/swr3/',
                logo: 'https://x/l.png',
                tags: 'pop, news;pop',
            },
            { enabled: true, name: 'SWR3', url: 'http://other/stream' },
            { enabled: false, name: 'Off', url: 'http://off/' },
            { enabled: true, name: '', url: 'http://x/' },
            { enabled: true, name: 'Bad', url: 'ftp://x/' },
            { name: 'Radio Record', url: 'http://air.radiorecord.ru:805/rr_320', logo: 'not a url', uuid: 'abc' },
        ]);
        assert.deepEqual(
            stations.map(s => [s.id, s.name, s.tags, s.logo, s.uuid]),
            [
                ['swr3', 'SWR3', ['pop', 'news'], 'https://x/l.png', ''],
                ['swr3_2', 'SWR3', [], '', ''],
                ['radio_record', 'Radio Record', [], '', 'abc'],
            ],
        );
        assert.equal(problems.length, 2);
        assert.match(problems[0], /name is missing/);
        assert.match(problems[1], /Bad.*http/);
    });

    it('reads a table stored as an object of rows', () => {
        assert.equal(normalizeStations({ a: { name: 'A', url: 'http://a/' } }).stations.length, 1);
        assert.equal(normalizeStations(undefined).stations.length, 0);
    });
});

describe('players', () => {
    it('knows the presets of the assistant, satellite-display and Dune HD', () => {
        const sat = presetFor('assistant.0.satellites.Gast.controls.waveshare_voice_eb1614.url');
        assert.equal(sat.kind, 'assistant');
        assert.equal(sat.stopValue, 'stop');
        assert.equal(sat.volumeState, 'assistant.0.satellites.Gast.controls.waveshare_voice_eb1614.volume');
        assert.equal(sat.titleState, 'assistant.0.satellites.Gast.controls.media_title');
        assert.equal(sat.device, 'assistant.0.satellites.Gast');
        const panel = presetFor('satellite-display.0.satellites.mini.media.url');
        assert.equal(panel.kind, 'satellite-display');
        assert.equal(panel.stopState, 'satellite-display.0.satellites.mini.media.stop');
        assert.equal(panel.titleState, 'satellite-display.0.satellites.mini.media.title');
        const dune = presetFor('dune-hd-remote.0.media.playUrl');
        assert.equal(dune.kind, 'dune');
        assert.equal(dune.stopState, 'dune-hd-remote.0.control.stop');
        assert.equal(presetFor('sonos.0.root.x.url').kind, 'custom');
    });

    it('finds satellites and panels; a satellite that is a panel too is taken once, as the panel', () => {
        const objects = {
            'assistant.0.satellites.Gast': device('Gast', { esphome: '192.168.1.246' }),
            'assistant.0.satellites.Gast.controls.player.url': state('media.url'),
            'assistant.0.satellites.Gast.controls.second.url': state('media.url'),
            'assistant.0.satellites.Mini': device('Mini', { esphome: '192.168.1.78' }),
            'assistant.0.satellites.Mini.controls.media_player.url': state('media.url'),
            'satellite-display.0.satellites.mini': device('Mini', { host: '192.168.1.78' }),
            'satellite-display.0.satellites.mini.media.url': state('media.url'),
            'satellite-display.0.satellites.panel-mobil.media.url': state('media.url'),
            'dune-hd-remote.0.media.playUrl': state('media.url'),
        };
        assert.deepEqual(discoverTargets(objects), [
            { name: 'Gast', urlState: 'assistant.0.satellites.Gast.controls.player.url' },
            { name: 'Mini', urlState: 'satellite-display.0.satellites.mini.media.url' },
            { name: 'panel-mobil', urlState: 'satellite-display.0.satellites.panel-mobil.media.url' },
        ]);
    });

    it('takes the rows first, then the found players; a row changes or hides a found player', () => {
        const found = [
            { name: 'Gast', urlState: 'assistant.0.satellites.Gast.controls.player.url' },
            { name: 'Mini', urlState: 'satellite-display.0.satellites.mini.media.url' },
            { name: 'Bad', urlState: 'assistant.0.satellites.Bad.controls.player.url' },
        ];
        const { targets, problems } = buildTargets(
            [
                { enabled: true, name: 'Kino', urlState: 'dune-hd-remote.0.media.playUrl' },
                {
                    enabled: true,
                    name: 'Gästezimmer',
                    urlState: 'assistant.0.satellites.Gast.controls.player.url',
                    stream: 'mp3',
                },
                { enabled: false, name: 'Bad', urlState: 'assistant.0.satellites.Bad.controls.player.url' },
                {
                    enabled: true,
                    name: 'Sonos',
                    urlState: 'sonos.0.x.url',
                    stopState: 'sonos.0.x.stop',
                    volumeState: '-',
                },
                { enabled: true, name: 'No state', urlState: '' },
            ],
            found,
        );
        assert.deepEqual(
            targets.map(t => [t.id, t.kind, t.stream, t.discovered]),
            [
                ['kino', 'dune', 'auto', false],
                ['gaestezimmer', 'assistant', 'mp3', false],
                ['sonos', 'custom', 'auto', false],
                ['mini', 'satellite-display', 'auto', true],
            ],
        );
        const sonos = targets.find(t => t.id === 'sonos');
        assert.equal(sonos?.stopValue, true, 'an own stop state without a value is a button');
        assert.equal(sonos?.volumeState, '');
        assert.equal(problems.length, 1);
    });

    it('gives the same id a suffix', () => {
        const { targets } = buildTargets(
            [],
            [
                { name: 'Mini', urlState: 'assistant.0.satellites.Mini.controls.p.url' },
                { name: 'mini', urlState: 'satellite-display.0.satellites.mini.media.url' },
            ],
        );
        assert.deepEqual(
            targets.map(t => t.id),
            ['mini', 'mini_2'],
        );
    });

    it('sends ESPHome players FLAC through the proxy, the others the station URL', () => {
        const [sat, panel, dune, custom] = buildTargets(
            [],
            [
                { name: 'a', urlState: 'assistant.0.satellites.a.controls.p.url' },
                { name: 'b', urlState: 'satellite-display.0.satellites.b.media.url' },
                { name: 'c', urlState: 'dune-hd-remote.0.media.playUrl' },
                { name: 'd', urlState: 'other.0.url' },
            ],
        ).targets;
        assert.deepEqual(streamFor(sat), { direct: false, codec: 'flac', sampleRate: 48000, channels: 1 });
        assert.deepEqual(streamFor(panel), { direct: false, codec: 'flac', sampleRate: 48000, channels: 1 });
        assert.deepEqual(streamFor(dune), { direct: true });
        assert.deepEqual(streamFor(custom), { direct: true });
        assert.deepEqual(streamFor({ ...sat, stream: 'direct' }), { direct: true });
        assert.deepEqual(streamFor({ ...dune, stream: 'mp3' }), {
            direct: false,
            codec: 'mp3',
            sampleRate: 44100,
            channels: 2,
        });
    });

    it('reads stop values as typed', () => {
        assert.equal(parseStopValue('true'), true);
        assert.equal(parseStopValue('0'), 0);
        assert.equal(parseStopValue('stop'), 'stop');
        assert.equal(parseStopValue(''), '');
    });
});

describe('names and rooms', () => {
    const stations = [
        { id: 'swr3', name: 'SWR3' },
        { id: 'radio_record', name: 'Radio Record' },
        { id: 'record_trance', name: 'Record Trance' },
        { id: 'deutschlandfunk', name: 'Deutschlandfunk' },
    ];

    it('finds exact names first, then the start, then a part', () => {
        assert.deepEqual(
            findByName(stations, 'swr 3').map(s => s.id),
            ['swr3'],
        );
        assert.deepEqual(
            findByName(stations, 'Radio Record').map(s => s.id),
            ['radio_record'],
        );
        assert.deepEqual(
            findByName(stations, 'deutschland').map(s => s.id),
            ['deutschlandfunk'],
        );
        assert.deepEqual(
            findByName(stations, 'record').map(s => s.id),
            ['record_trance'],
        );
        assert.deepEqual(
            findByName(stations, 'cord').map(s => s.id),
            ['radio_record', 'record_trance'],
        );
        assert.deepEqual(
            findByName(stations, 'play deutschlandfunk please').map(s => s.id),
            ['deutschlandfunk'],
        );
        assert.deepEqual(findByName(stations, 'xyz'), []);
        assert.deepEqual(findByName(stations, ''), []);
    });

    it('finds the room of a player through enum.rooms, in any language', () => {
        const [t] = buildTargets(
            [],
            [{ name: 'Gast', urlState: 'assistant.0.satellites.Gast.controls.p.url' }],
        ).targets;
        const rooms = /** @type {any} */ ({
            'enum.rooms.guest': {
                common: {
                    name: { en: 'Guest room', de: 'Gästezimmer', ru: 'Гостевая' },
                    members: ['assistant.0.satellites.Gast'],
                },
            },
            'enum.rooms.kitchen': { common: { name: 'Kitchen', members: ['hue.0.lamp'] } },
        });
        const found = roomsOf(t, rooms);
        assert.equal(found.length, 1);
        assert.ok(found[0].names.includes('Гостевая'));
        const items = [{ id: t.id, name: t.name }];
        assert.equal(findByName(items, 'гостевая', () => found[0].names).length, 1);
    });
});

describe('helpers', () => {
    it('scales the volume to the range of the player', () => {
        assert.equal(scaleVolume(0.5, {}), 0.5);
        assert.equal(scaleVolume(0.333, { min: 0, max: 1 }), 0.33);
        assert.equal(scaleVolume(0.5, { min: 0, max: 100 }), 50);
        assert.equal(scaleVolume(2, { max: 100 }), 100);
    });

    it('cuts a title to 48 bytes without breaking a character', () => {
        const ru = 'Сейчас играет очень длинное название песни';
        const cut = fitTitle(ru, 48);
        assert.ok(Buffer.byteLength(cut) <= 48);
        assert.ok(cut.endsWith('…'));
        assert.equal(fitTitle('short', 48), 'short');
        assert.equal(fitTitle(ru, 0), ru);
    });

    it('lists writable media.url states of other adapters for the admin', () => {
        const objects = /** @type {any} */ ({
            'dune-hd-remote.0.media.playUrl': {
                type: 'state',
                common: { role: 'media.url', name: 'Play URL', write: true },
            },
            'webradio.0.targets.x.streamUrl': { type: 'state', common: { role: 'media.url', write: true } },
            'x.0.read': { type: 'state', common: { role: 'media.url', write: false } },
        });
        assert.deepEqual(urlStateChoices(objects, 'webradio.0'), [
            { label: 'dune-hd-remote.0.media.playUrl (Play URL)', value: 'dune-hd-remote.0.media.playUrl' },
        ]);
    });

    it('names objects with custom settings', () => {
        assert.deepEqual(
            customIds(
                /** @type {any} */ ({ a: { common: { custom: { 'history.0': {} } } }, b: { common: { custom: {} } } }),
            ),
            ['a'],
        );
    });
});
