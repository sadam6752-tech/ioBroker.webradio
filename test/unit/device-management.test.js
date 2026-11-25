'use strict';

// The players in the Device Manager: the card, its details, and what the controls and actions write.

const assert = require('node:assert/strict');
const {
    RadioDeviceManagement,
    cardOf,
    detailsOf,
    alarmForm,
    daysToForm,
    daysFromForm,
    SLEEP_OPTIONS,
} = require('../../lib/device-management');

/** @type {any} */
const kitchen = {
    id: 'kitchen',
    name: 'Kitchen',
    kind: 'assistant',
    urlState: 'assistant.0.satellites.Kitchen.controls.player.url',
    volumeState: 'assistant.0.satellites.Kitchen.controls.player.volume',
};
/** @type {any} */
const dune = {
    id: 'cinema',
    name: 'Cinema',
    kind: 'dune',
    urlState: 'dune-hd-remote.0.media.playUrl',
    volumeState: '',
};
/** @type {any[]} */
const stations = [
    { id: 'swr3', name: 'SWR3' },
    { id: 'record', name: 'Record' },
];

/**
 * @returns {{dm: RadioDeviceManagement, app: any}} Device management on a fake adapter
 */
function setup() {
    const states = new Map([
        ['targets.kitchen.playing', true],
        ['targets.kitchen.alarmNext', '2026-11-26T06:00:00.000Z'],
        [
            'targets.kitchen.history',
            JSON.stringify([{ ts: Date.UTC(2026, 10, 25, 19, 5), station: 'SWR3', title: 'A - B' }]),
        ],
    ]);
    const app = {
        namespace: 'webradio.0',
        log: { warn() {}, info() {}, debug() {}, error() {} },
        on() {},
        running: new Map([
            ['kitchen', { t: kitchen }],
            ['cinema', { t: dune }],
        ]),
        stations,
        written: /** @type {Array<[string, unknown]>} */ ([]),
        streamOf: t =>
            t.kind === 'dune' ? { direct: true } : { direct: false, codec: 'flac', sampleRate: 48000, channels: 1 },
        checkStations: async () => [{ online: true }, { online: false }, { online: true }],
        alarms: /** @type {any[]} */ ([]),
        setAlarm: async (id, alarm) => {
            app.alarms.push([id, alarm]);
            if (alarm.time === '25:00') {
                return '"25:00" is no time (HH:MM); the alarm is off';
            }
            states.set(`targets.${id}.alarmNext`, alarm.time ? '2026-11-27T05:30:00.000Z' : '');
            return '';
        },
        setStateAsync: async (id, st) => {
            app.written.push([id, st.val]);
            states.set(id, st.val);
        },
        getStateAsync: async id =>
            states.has(id) ? { val: states.get(id), ack: true, ts: 1, lc: 1, from: '', q: 0 } : null,
    };
    return { dm: new RadioDeviceManagement(/** @type {any} */ (app)), app };
}

describe('Device Manager', () => {
    it('shows a card per player: radio switch, station, volume when it has one, title, sleep timer, prev / next', () => {
        const card = cardOf(kitchen, { ns: 'webradio.0', stations });
        assert.equal(card.id, 'targets.kitchen');
        assert.equal(card.identifier, kitchen.urlState);
        assert.deepEqual(
            card.controls.map(c => [c.id, c.type, c.stateId]),
            [
                ['playing', 'switch', 'webradio.0.targets.kitchen.playing'],
                ['station', 'select', 'webradio.0.targets.kitchen.station'],
                ['volume', 'slider', 'webradio.0.targets.kitchen.volume'],
                ['title', 'info', 'webradio.0.targets.kitchen.title'],
                ['sleep', 'select', 'webradio.0.targets.kitchen.sleep'],
                ['alarmTime', 'info', 'webradio.0.targets.kitchen.alarmTime'],
            ],
        );
        assert.deepEqual(
            card.controls[1].options?.map(o => o.value),
            ['', 'swr3', 'record'],
        );
        assert.deepEqual(
            card.controls[4].options?.map(o => o.value),
            SLEEP_OPTIONS,
        );
        assert.deepEqual(
            card.actions.map(a => a.id),
            ['prev', 'next', 'alarm'],
        );
        const noVolume = cardOf(dune, { ns: 'webradio.0', stations });
        assert.ok(!noVolume.controls.some(c => c.id === 'volume'), 'no volume state, no slider');
        assert.equal(/** @type {any} */ (noVolume.model).en, 'Dune HD');
    });

    it('shows the play state, the stream, the next wake-up and the last titles below the card', () => {
        const d = detailsOf(kitchen, {
            way: { direct: false, codec: 'flac', sampleRate: 48000, channels: 1 },
            alarmNext: '',
            history: [{ ts: 0, station: 'SWR3', title: 'A - B' }],
        });
        const items = /** @type {any} */ (d.schema.items);
        assert.equal(items._url.data, kitchen.urlState);
        assert.equal(items._way.data.en, 'through the adapter: FLAC 48000 Hz, 1 ch');
        assert.equal(items._alarm.data, '–');
        assert.match(items._history.data, /A - B \(SWR3\)$/);
        assert.equal(
            /** @type {any} */ (detailsOf(dune, { way: { direct: true }, alarmNext: '', history: [] }).schema.items)
                ._history.data,
            '–',
        );
    });

    it('writes resume or stop for the switch, the state for the others, and the buttons for prev / next', async () => {
        const { dm, app } = setup();
        /** @type {any[]} */
        const cards = [];
        await dm.loadDevices(/** @type {any} */ ({ setTotalDevices() {}, addDevice: c => cards.push(c) }));
        assert.deepEqual(
            cards.map(c => c.name),
            ['Cinema', 'Kitchen'],
        );
        const card = cards[1];
        const control = id => card.controls.find(c => c.id === id);
        const shown = await control('playing').handler('targets.kitchen', 'playing', false, null);
        assert.equal(shown.val, true, 'the switch shows the state as it is');
        await control('playing').handler('targets.kitchen', 'playing', true, null);
        await control('station').handler('targets.kitchen', 'station', 'record', null);
        await control('sleep').handler('targets.kitchen', 'sleep', 30, null);
        await card.actions.find(a => a.id === 'next').handler();
        assert.deepEqual(app.written, [
            ['targets.kitchen.stop', true],
            ['targets.kitchen.resume', true],
            ['targets.kitchen.station', 'record'],
            ['targets.kitchen.sleep', 30],
            ['targets.kitchen.next', true],
        ]);
        assert.equal((await control('station').getStateHandler()).val, 'record');
    });

    it('answers the details of a card and checks the stations from the instance', async () => {
        const { dm } = setup();
        const details = /** @type {any} */ (await dm.getDeviceDetails('targets.kitchen'));
        assert.equal(details.id, 'targets.kitchen');
        assert.match(details.schema.items._history.data, /A - B/);
        assert.notEqual(details.schema.items._alarm.data, '–');
        assert.deepEqual(await dm.getDeviceDetails('targets.gone'), { error: 'unknown player targets.gone' });
        const info = dm.getInstanceInfo();
        assert.deepEqual(
            info.actions?.map(a => a.id),
            ['checkStations'],
        );
        /** @type {any[]} */
        const shown = [];
        const res = await /** @type {any} */ (info.actions?.[0]).handler({ showMessage: async m => shown.push(m) });
        assert.deepEqual(res, { refresh: false });
        assert.equal(shown[0].en, '2 of 3 stations answer.');
    });

    it('turns the weekdays into ticks of the form and back; none or all ticked = every day', () => {
        assert.deepEqual(daysToForm('1-5'), { d1: true, d2: true, d3: true, d4: true, d5: true, d6: false, d7: false });
        assert.deepEqual(Object.values(daysToForm('')), [false, false, false, false, false, false, false]);
        assert.equal(daysFromForm({ d1: true, d3: true, d5: true }), '1,3,5');
        assert.equal(daysFromForm({}), '');
        assert.equal(daysFromForm({ d1: true, d2: true, d3: true, d4: true, d5: true, d6: true, d7: true }), '');
        const form = /** @type {any} */ (alarmForm(stations)).items;
        assert.deepEqual(
            form.station.options.map(o => o.value),
            ['', 'swr3', 'record'],
        );
        assert.equal(form.d1.label.de, 'Mo');
        assert.equal(form.d7.label.ru, 'Вс');
    });

    it('sets the wake-up radio from the form of a card, and says when it rings next', async () => {
        const { dm, app } = setup();
        /** @type {any[]} */
        const cards = [];
        await dm.loadDevices(/** @type {any} */ ({ setTotalDevices() {}, addDevice: c => cards.push(c) }));
        const action = cards[1].actions.find(a => a.id === 'alarm');
        /** @type {any[]} */
        const shown = [];
        const ctx = answer => ({
            showForm: async (_schema, o) => (shown.push(['form', o.data]), answer),
            showMessage: async m => shown.push(['message', m]),
        });
        await action.handler('targets.kitchen', ctx({ time: '6:30', d1: true, d2: true, station: 'record' }));
        assert.deepEqual(app.alarms[0], ['kitchen', { time: '6:30', days: '1,2', station: 'record' }]);
        assert.match(shown[1][1].en, /^Next wake-up: /);
        await action.handler('targets.kitchen', ctx(undefined));
        assert.equal(app.alarms.length, 1, 'cancelled: nothing set');
        await action.handler('targets.kitchen', ctx({ time: '25:00' }));
        assert.match(shown[shown.length - 1][1], /no time/);
        await action.handler('targets.kitchen', ctx({ time: '' }));
        assert.equal(shown[shown.length - 1][1].en, 'The wake-up radio is off.');
    });
});
