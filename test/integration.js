const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { tests } = require('@iobroker/testing');
const { startIcyServer } = require('./helpers/icy-server');

const HTTP_PORT = 47196;
const SAT = 'assistant.0.satellites.Kitchen';
const GONE = 'assistant.0.satellites.Gone';
const DUNE = 'dune-hd-remote.0';

/**
 * @param {string} url - URL
 * @param {number} bytes - Read this many bytes, then close
 * @param {number} [ms] - Give up after this long
 * @returns {Promise<{status: number, body: Buffer}>} Response; the body may be shorter when the server closed it
 */
function fetchBytes(url, bytes, ms = 20_000) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let size = 0;
        let status = 0;
        let over = false;
        const done = () => {
            if (!over) {
                over = true;
                req.destroy();
                resolve({ status, body: Buffer.concat(parts) });
            }
        };
        const req = http.get(url, res => {
            status = res.statusCode || 0;
            res.on('data', d => {
                parts.push(d);
                size += d.length;
                if (size >= bytes) {
                    done();
                }
            });
            res.on('end', done);
            res.on('close', done);
        });
        req.setTimeout(ms, done);
        req.on('error', e => (over ? undefined : reject(e)));
    });
}

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Playing a test station on a fake satellite and a fake Dune HD', getHarness => {
            let harness;
            let radio;

            before(async function () {
                this.timeout(60_000);
                harness = getHarness();
                const mp3 = spawnSync(
                    String(ffmpegPath),
                    [
                        '-hide_banner',
                        '-loglevel',
                        'error',
                        '-f',
                        'lavfi',
                        '-i',
                        'sine=frequency=440:duration=1',
                        '-c:a',
                        'libmp3lame',
                        '-f',
                        'mp3',
                        'pipe:1',
                    ],
                    { maxBuffer: 10 * 1024 * 1024 },
                ).stdout;
                radio = await startIcyServer({ audio: mp3, metaInt: 2000, titles: ['Test Artist - Test Song'] });
                // the objects ioBroker.assistant creates for a satellite with a media player, a room, and Dune HD
                await harness.objects.setObjectAsync(SAT, {
                    type: 'device',
                    common: { name: 'Kitchen' },
                    native: { esphome: '10.0.0.5' },
                });
                await harness.objects.setObjectAsync(GONE, { type: 'device', common: { name: 'Gone' }, native: {} });
                for (const [id, type, role, extra] of [
                    [`${SAT}.controls.player.url`, 'string', 'media.url', {}],
                    [`${SAT}.controls.player.volume`, 'number', 'level.volume', { min: 0, max: 1 }],
                    [`${SAT}.controls.media_title`, 'string', 'text', {}],
                    [`${GONE}.controls.player.url`, 'string', 'media.url', {}],
                    [`${DUNE}.media.playUrl`, 'string', 'media.url', {}],
                    [`${DUNE}.control.stop`, 'boolean', 'button.stop', {}],
                ]) {
                    await harness.objects.setObjectAsync(id, {
                        type: 'state',
                        common: { name: id, type, role, read: true, write: true, ...extra },
                        native: {},
                    });
                }
                await harness.objects.setObjectAsync('enum.rooms.kitchen', {
                    type: 'enum',
                    common: { name: { en: 'Kitchen', de: 'Küche', ru: 'Кухня' }, members: [SAT] },
                    native: {},
                });
                await harness.changeAdapterConfig('webradio', {
                    native: {
                        stations: [
                            {
                                enabled: true,
                                name: 'Test Radio',
                                url: `${radio.base}/station`,
                                logo: `${radio.base}/logo.png`,
                                tags: 'test',
                            },
                            {
                                enabled: true,
                                name: 'Playlist Radio',
                                url: `${radio.base}/list.pls`,
                                logo: '',
                                tags: '',
                            },
                        ],
                        targets: [{ enabled: true, name: 'Cinema', urlState: `${DUNE}.media.playUrl` }],
                        port: HTTP_PORT,
                        bind: '127.0.0.1',
                        urlHost: '127.0.0.1',
                        readTitles: true,
                        cacheLogos: true,
                    },
                });
                // the logo folder of version 0.0.1: an own mount point with a cached file
                await harness.objects.setObjectAsync('webradio.0.logos', {
                    type: 'meta',
                    common: { name: 'Station logos', type: 'meta.folder' },
                    native: {},
                });
                await harness.objects.writeFileAsync('webradio.0.logos', 'playlist_radio.png', Buffer.from('OLD'));
                // a player that played before 0.0.2: its station state is set, lastStation does not exist yet
                await harness.states.setStateAsync('webradio.0.targets.cinema.station', {
                    val: 'playlist_radio',
                    ack: true,
                });
                await harness.startAdapterAndWait(true);
                // the satellite "Gone" was found at the start and is removed now (like a deleted satellite)
                await harness.objects.delObjectAsync(`${GONE}.controls.player.url`);
                harness.enableSendTo();
            });

            after(async function () {
                this.timeout(30_000);
                await radio?.close();
                if (!harness) {
                    return;
                }
                const stopped = harness.stopAdapter();
                // js-controller 8 (dev builds from 2026-11-22) obeys sigKill only from the controller of its own host
                const host = (await harness.objects.getObjectAsync('system.adapter.webradio.0'))?.common?.host;
                if (host && harness.isAdapterRunning()) {
                    await harness.states.setStateAsync('system.adapter.webradio.0.sigKill', {
                        val: -1,
                        ack: false,
                        from: `system.host.${host}`,
                    });
                }
                await stopped;
            });

            const state = async id => (await harness.states.getStateAsync(id))?.val;
            /** @returns {string} The warnings and errors of the adapter so far, for a failure message */
            const adapterLog = () => {
                const lines = [...harness.getLogs('warn'), ...harness.getLogs('error')]
                    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
                    .map(l => `${l.level}: ${l.message}`);
                return lines.length ? `\nadapter log:\n${lines.slice(-15).join('\n')}` : '\nadapter log: no warnings';
            };
            /**
             * The FLAC stream of the proxy: the first bytes, connecting again up to three times (a slow CI machine).
             *
             * @param {string} url - Stream URL
             */
            const readFlac = async url => {
                let last = { status: 0, body: Buffer.alloc(0) };
                for (let attempt = 1; attempt <= 3; attempt++) {
                    last = await fetchBytes(url, 4000).catch(e => ({ status: -1, body: Buffer.from(String(e)) }));
                    if (last.status === 200 && last.body.subarray(0, 4).toString('latin1') === 'fLaC') {
                        return last;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
                assert.fail(`no FLAC from ${url}: HTTP ${last.status}, ${last.body.length} bytes${adapterLog()}`);
            };
            const waitFor = async (id, test, ms = 20_000) => {
                let val;
                for (let i = 0; i < ms / 100; i++) {
                    val = await state(id);
                    if (test(val)) {
                        return val;
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
                assert.fail(`${id} = ${JSON.stringify(val)}${adapterLog()}`);
            };
            const send = (command, message) =>
                new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error(`${command}: no answer`)), 15_000);
                    harness.sendTo('webradio.0', command, message, res => {
                        clearTimeout(timer);
                        resolve(res);
                    });
                });

            it('creates the stations and the players (rows and found satellites)', async function () {
                this.timeout(60_000);
                assert.equal(await state('webradio.0.stations.test_radio.url'), `${radio.base}/station`);
                assert.equal(await state('webradio.0.info.connection'), true);
                const last = JSON.parse(String(await state('webradio.0.targets.cinema.lastStation')));
                assert.equal(last.id, 'playlist_radio', 'lastStation taken from the station state of an update');
                assert.equal(
                    await state('webradio.0.targets.kitchen.lastStation'),
                    '',
                    'nothing selected: stays empty',
                );
                const kitchen = await harness.objects.getObjectAsync('webradio.0.targets.kitchen');
                assert.equal(kitchen?.common?.desc, `${SAT}.controls.player.url`);
                assert.ok(await harness.objects.getObjectAsync('webradio.0.targets.cinema.station'));
                const station = await harness.objects.getObjectAsync('webradio.0.targets.kitchen.station');
                assert.equal(station?.common?.states?.test_radio, 'Test Radio');
            });

            it('keeps the logos in webradio.0.storage/logos, moves away the folder of 0.0.1, serves them', async function () {
                this.timeout(60_000);
                const logoUrl = await waitFor('webradio.0.stations.test_radio.logo', v => String(v).includes('/logo/'));
                assert.equal(logoUrl, `http://127.0.0.1:${HTTP_PORT}/logo/test_radio`);
                const storage = await harness.objects.getObjectAsync('webradio.0.storage');
                assert.equal(storage?.type, 'meta');
                assert.equal(storage?.common?.type, 'meta.user');
                const readFile = (mount, name) =>
                    new Promise(resolve =>
                        harness.objects.readFile(mount, name, null, (err, data) => resolve(err ? null : data)),
                    );
                const file = await readFile('webradio.0.storage', 'logos/test_radio.png');
                assert.ok(file, 'logo file in the storage');
                assert.equal(Buffer.from(file).subarray(1, 4).toString('latin1'), 'PNG');
                assert.equal(await harness.objects.getObjectAsync('webradio.0.logos'), null, 'old mount point removed');
                // the moved logo of a station without logo URL is removed as stale
                assert.equal(await readFile('webradio.0.storage', 'logos/playlist_radio.png'), null);
                assert.equal(await readFile('webradio.0.logos', 'playlist_radio.png'), null, 'old file removed');
                // the lists of the vis widget name the cached file and the players
                const stations = JSON.parse(
                    String(await waitFor('webradio.0.info.stations', v => String(v).includes('storage/logos'))),
                );
                assert.deepEqual(
                    stations.find(s => s.id === 'test_radio'),
                    {
                        id: 'test_radio',
                        name: 'Test Radio',
                        logo: logoUrl,
                        file: 'webradio.0.storage/logos/test_radio.png',
                    },
                );
                const targets = JSON.parse(String(await state('webradio.0.info.targets')));
                assert.deepEqual(targets.find(t => t.id === 'kitchen')?.rooms, ['Kitchen']);
                assert.ok(targets.some(t => t.id === 'cinema'));
                const served = await fetchBytes(logoUrl, 11);
                assert.equal(served.status, 200);
                assert.equal(served.body.subarray(1, 4).toString('latin1'), 'PNG');
            });

            it('answers help with the commands', async function () {
                this.timeout(60_000);
                const res = await send('help', {});
                assert.ok(res.help.includes('play {station'));
                assert.ok(res.commands.some(c => c.command === 'play' && c.write === true));
            });

            it('plays a favourite in a room through the proxy: FLAC with the ICY title on the satellite', async function () {
                this.timeout(90_000);
                const res = await send('play', { station: 'test', room: 'кухня' });
                assert.deepEqual(res, {
                    ok: true,
                    target: 'Kitchen',
                    station: 'Test Radio',
                    stationId: 'test_radio',
                    source: 'favourite',
                });
                const url = await waitFor(
                    `${SAT}.controls.player.url`,
                    v => typeof v === 'string' && v.includes('/play/'),
                );
                assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${HTTP_PORT}/play/kitchen\\.flac\\?`));
                assert.equal(await state('webradio.0.targets.kitchen.playing'), true);
                await readFlac(url);
                await waitFor('webradio.0.targets.kitchen.title', v => v === 'Test Artist - Test Song');
                await waitFor(`${SAT}.controls.media_title`, v => v === 'Test Artist - Test Song');
                const now = await send('now_playing', { room: 'Küche' });
                assert.equal(now.targets[0].station, 'Test Radio');
            });

            it('stops the satellite with its stop value', async function () {
                this.timeout(60_000);
                const res = await send('stop', { target: 'kitchen' });
                assert.deepEqual(res, { ok: true, stopped: ['kitchen'] });
                await waitFor(`${SAT}.controls.player.url`, v => v === 'stop');
                assert.equal(await state('webradio.0.targets.kitchen.playing'), false);
            });

            it('gives Dune HD the station URL and reads the titles by itself', async function () {
                this.timeout(60_000);
                await harness.states.setStateAsync('webradio.0.targets.cinema.station', {
                    val: 'test_radio',
                    ack: false,
                });
                await waitFor(`${DUNE}.media.playUrl`, v => v === `${radio.base}/station`);
                await waitFor('webradio.0.targets.cinema.title', v => v === 'Test Artist - Test Song');
                await harness.states.setStateAsync('webradio.0.targets.cinema.stop', { val: true, ack: false });
                await waitFor(`${DUNE}.control.stop`, v => v === true);
            });

            it('asks back when the player is missing or the station is ambiguous', async function () {
                this.timeout(60_000);
                const noPlayer = await send('play', { station: 'test' });
                assert.ok(noPlayer.ask && noPlayer.choices.includes('Kitchen'));
                const twoStations = await send('play', { station: 'radio', target: 'kitchen' });
                assert.ok(twoStations.ask && twoStations.choices.length === 2);
            });

            it('says that a stream URL was played as a URL', async function () {
                this.timeout(60_000);
                const res = await send('play', { station: `${radio.base}/station`, target: 'cinema' });
                assert.deepEqual(res, {
                    ok: true,
                    target: 'Cinema',
                    station: `${radio.base}/station`,
                    stationId: '',
                    source: 'url',
                });
                await send('stop', { target: 'cinema' });
            });

            it('plays a .m3u redirect chain through the proxy and gives a direct player the stream of a playlist', async function () {
                this.timeout(90_000);
                // like RPR1: the .m3u is no playlist, two redirects, a stream server with a bare LF in its status line
                const res = await send('play', { station: `${radio.base}/rpr.m3u`, target: 'kitchen' });
                assert.equal(res.ok, true, JSON.stringify(res));
                const url = await waitFor(
                    `${SAT}.controls.player.url`,
                    v => typeof v === 'string' && v.includes('/play/kitchen.flac?s=url'),
                );
                await readFlac(url);
                await waitFor('webradio.0.targets.kitchen.title', v => v === 'Test Artist - Test Song');
                await send('stop', { target: 'kitchen' });
                // Dune HD plays by itself: it gets the stream inside the playlist, not the playlist
                await send('play', { station: `${radio.base}/nested.m3u`, target: 'cinema' });
                await waitFor(`${DUNE}.media.playUrl`, v => v === `${radio.base}/station`);
                await send('stop', { target: 'cinema' });
            });

            it('resumes the last station and steps through the favourites, by message and by button', async function () {
                this.timeout(90_000);
                await send('play', { station: 'test', target: 'kitchen' });
                await send('stop', { target: 'kitchen' });
                const last = JSON.parse(String(await state('webradio.0.targets.kitchen.lastStation')));
                assert.equal(last.id, 'test_radio');
                let res = await send('resume', { room: 'Kitchen' });
                assert.deepEqual(res, {
                    ok: true,
                    target: 'Kitchen',
                    station: 'Test Radio',
                    stationId: 'test_radio',
                    source: 'favourite',
                });
                res = await send('resume', { target: 'kitchen' });
                assert.equal(res.already, true, 'resume while it plays changes nothing');
                assert.equal((await send('next', { target: 'kitchen' })).stationId, 'playlist_radio');
                assert.equal((await send('next', { target: 'kitchen' })).stationId, 'test_radio', 'wraps around');
                assert.equal((await send('prev', { target: 'kitchen' })).stationId, 'playlist_radio');
                await send('stop', { target: 'kitchen' });
                // the buttons; next works while stopped too
                await harness.states.setStateAsync('webradio.0.targets.kitchen.next', { val: true, ack: false });
                await waitFor('webradio.0.targets.kitchen.station', v => v === 'test_radio');
                await waitFor('webradio.0.targets.kitchen.playing', v => v === true);
                await harness.states.setStateAsync('webradio.0.targets.kitchen.stop', { val: true, ack: false });
                await waitFor('webradio.0.targets.kitchen.playing', v => v === false);
                await harness.states.setStateAsync('webradio.0.targets.kitchen.resume', { val: true, ack: false });
                await waitFor('webradio.0.targets.kitchen.playing', v => v === true);
                assert.equal(await state('webradio.0.targets.kitchen.station'), 'test_radio');
                await send('stop', { target: 'kitchen' });
            });

            it('sleep timer: refuses while stopped, ends with stop or a new station, fades out and stops', async function () {
                this.timeout(120_000);
                const VOLUME = `${SAT}.controls.player.volume`;
                assert.match((await send('sleep', { minutes: 5, target: 'kitchen' })).error, /nothing plays/);
                assert.match((await send('sleep', { minutes: -1, target: 'kitchen' })).error, /minutes/);
                await send('play', { station: 'test', target: 'kitchen' });
                let res = await send('sleep', { minutes: 5, target: 'kitchen' });
                assert.equal(res.ok, true);
                assert.equal(res.minutes, 5);
                assert.ok(Math.abs(Date.parse(res.endsAt) - Date.now() - 300_000) < 10_000, res.endsAt);
                await waitFor('webradio.0.targets.kitchen.sleepLeft', v => v === 5);
                assert.equal(await state('webradio.0.targets.kitchen.sleep'), 5);
                await send('next', { target: 'kitchen' });
                await waitFor('webradio.0.targets.kitchen.sleep', v => v === 0, 5_000);
                assert.equal(await state('webradio.0.targets.kitchen.sleepLeft'), 0, 'a new station ends the timer');
                // the state: 0.6 min = 36 s, the fade begins after 6 s
                await harness.states.setStateAsync(VOLUME, { val: 0.8, ack: true });
                await harness.states.setStateAsync('webradio.0.targets.kitchen.sleep', { val: 0.6, ack: false });
                await waitFor('webradio.0.targets.kitchen.sleep', v => v === 0.6);
                await waitFor(VOLUME, v => typeof v === 'number' && v < 0.8 && v > 0, 20_000);
                await waitFor('webradio.0.targets.kitchen.playing', v => v === false, 45_000);
                assert.equal(await state(`${SAT}.controls.player.url`), 'stop');
                await waitFor(VOLUME, v => v === 0.8, 5_000);
                assert.equal(await state('webradio.0.targets.kitchen.sleep'), 0);
                assert.equal(await state('webradio.0.targets.kitchen.sleepLeft'), 0);
                // 0 turns it off
                await send('play', { station: 'test', target: 'kitchen' });
                await send('sleep', { minutes: 5, target: 'kitchen' });
                res = await send('sleep', { minutes: 0, target: 'kitchen' });
                assert.deepEqual(res, { ok: true, target: 'Kitchen', minutes: 0 });
                assert.equal(await state('webradio.0.targets.kitchen.sleepLeft'), 0);
                await send('stop', { target: 'kitchen' });
            });

            it('keeps the titles that played on a player', async function () {
                this.timeout(60_000);
                const res = await send('history', { target: 'kitchen', limit: 50 });
                assert.ok(
                    res.targets[0].history.some(e => e.station === 'Test Radio'),
                    'the favourite by its name',
                );
                assert.equal(res.targets.length, 1);
                const h = res.targets[0].history;
                assert.ok(h.length >= 2, JSON.stringify(h));
                assert.equal(h[0].title, 'Test Artist - Test Song');
                assert.ok(Date.parse(h[0].time) > Date.now() - 600_000);
                assert.equal((await send('history', { target: 'kitchen', limit: 1 })).targets[0].history.length, 1);
                const all = await send('history', {});
                assert.ok(
                    all.targets.some(t => t.id === 'cinema' && t.history.length >= 1),
                    'Dune titles too',
                );
                const state = JSON.parse(
                    String(await harness.states.getStateAsync('webradio.0.targets.kitchen.history').then(s => s?.val)),
                );
                assert.equal(state[0].title, 'Test Artist - Test Song');
            });

            it('exports the favourites, and the admin adds the stations of a playlist to its table', async function () {
                this.timeout(60_000);
                const m3u = await send('export_stations', {});
                assert.equal(m3u.format, 'm3u');
                assert.match(m3u.text, new RegExp(`^#EXTM3U\n#EXTINF:-1[^\n]*,Test Radio\n${radio.base}/station\n`));
                const json = await send('export_stations', { format: 'json' });
                assert.equal(JSON.parse(json.text).length, 2);
                const form = [{ enabled: true, name: 'A', url: 'http://a.example/', logo: '', tags: '' }];
                const exported = await send('adminExport', { format: 'm3u', stations: form });
                assert.equal(exported.native._transfer, '#EXTM3U\n#EXTINF:-1,A\nhttp://a.example/\n');
                const added = await send('adminImport', {
                    text: '[playlist]\nFile1=http://b.example/\nTitle1=B',
                    stations: form,
                });
                assert.deepEqual(
                    added.native.stations.map(r => r.name),
                    ['A', 'B'],
                );
                assert.match(
                    (await send('adminImport', { text: exported.native._transfer, stations: form })).error,
                    /already/,
                );
                // the admin search without a name: the most played stations of a country (needs radio-browser.info)
                assert.deepEqual(await send('adminSearch', { query: '', country: '' }), []);
            });

            it('skips a player whose objects were deleted, without writing to it', async function () {
                this.timeout(60_000);
                const res = await send('play', { station: 'test', target: 'gone' });
                assert.match(res.error, /does not exist/);
                assert.equal(await harness.states.getStateAsync(`${GONE}.controls.player.url`), null);
            });
        });
    },
});
