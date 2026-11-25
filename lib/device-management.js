'use strict';

// The players in the Device Manager of ioBroker (@iobroker/dm-utils): a card per player with radio on/off, the
// station, the volume, what plays, the sleep timer and previous / next; below it the details (play state, stream,
// next wake-up, last titles). The players stay configured in the settings; this view only shows and acts.

const { DeviceManagement } = require('@iobroker/dm-utils');
const { DM_TEXTS } = require('./dm-texts');
const { readHistory } = require('./control');
const { parseDays } = require('./alarm');

/**
 * @typedef {import('./types').Station} Station
 * @typedef {import('./types').Target} Target
 * @typedef {import('@iobroker/dm-utils').ActionContext} ActionContext
 * @typedef {import('@iobroker/dm-utils').ConfigItemAny} ConfigItemAny
 * @typedef {import('@iobroker/dm-utils').DeviceInfo<string>} DeviceInfo
 * @typedef {import('@iobroker/dm-utils').DeviceControl<string>} DeviceControl
 * @typedef {import('@iobroker/dm-utils').DeviceAction<string>} DeviceAction
 * @typedef {import('@iobroker/dm-utils').DeviceDetails<string>} DeviceDetails
 * @typedef {import('@iobroker/dm-utils').DeviceLoadContext<string>} DeviceLoadContext
 * @typedef {import('@iobroker/dm-utils').DeviceRefreshResponse<string>} DeviceRefreshResponse
 * @typedef {import('@iobroker/dm-utils').InstanceDetails} InstanceDetails
 * @typedef {import('@iobroker/dm-utils').ControlState} ControlState
 */

/**
 * @typedef {object} RadioHost - What the adapter (main.js) offers to this view
 * @property {string} namespace - e.g. webradio.0
 * @property {Map<string, {t: Target}>} running - The players
 * @property {Station[]} stations - The favourites
 * @property {(t: Target) => {direct: boolean, codec?: string, sampleRate?: number, channels?: number}} streamOf - How a player gets the station
 * @property {() => Promise<Array<Record<string, unknown>>>} checkStations - Checks the favourites now
 * @property {(targetId: string, alarm: {time: string, days: string, station: string}) => Promise<string>} setAlarm -
 *   Sets the wake-up radio of a player; returns an error text, '' = done
 * @property {(id: string, state: ioBroker.SettableState) => Promise<unknown>} setStateAsync - Writes an own state
 * @property {(id: string) => Promise<ioBroker.State | null | undefined>} getStateAsync - Reads an own state
 */

/** Steps of the sleep timer control, in minutes */
const SLEEP_OPTIONS = [0, 15, 30, 60, 90];

/**
 * @param {ioBroker.Translated} texts - A text in every language with %1, %2
 * @param {...(string | number)} values - What goes in
 * @returns {ioBroker.Translated} The texts filled in
 */
function fill(texts, ...values) {
    return /** @type {ioBroker.Translated} */ (
        Object.fromEntries(
            Object.entries(texts).map(([lang, text]) => [
                lang,
                values.reduce(
                    (t, v, i) =>
                        String(t)
                            .split(`%${i + 1}`)
                            .join(String(v)),
                    text,
                ),
            ]),
        )
    );
}

/**
 * @param {Target} t - Player
 * @returns {ioBroker.Translated} What kind of player it is
 */
function modelOf(t) {
    return t.kind === 'assistant'
        ? DM_TEXTS.kindAssistant
        : t.kind === 'satellite-display'
          ? DM_TEXTS.kindDisplay
          : t.kind === 'dune'
            ? DM_TEXTS.kindDune
            : DM_TEXTS.kindCustom;
}

/**
 * Builds the card of a player, without the handlers (those are added by the class).
 *
 * @param {Target} t - Player
 * @param {object} has - What it has
 * @param {string} has.ns - Namespace of the instance, e.g. webradio.0
 * @param {Station[]} has.stations - The favourites, for the station choice
 * @returns {DeviceInfo & {controls: DeviceControl[], actions: DeviceAction[]}} Card without handlers
 */
function cardOf(t, has) {
    const base = `targets.${t.id}`;
    const id = (/** @type {string} */ s) => `${has.ns}.${base}.${s}`;
    /** @type {DeviceControl[]} */
    const controls = [
        { id: 'playing', type: 'switch', stateId: id('playing'), label: DM_TEXTS.playing },
        {
            id: 'station',
            type: 'select',
            stateId: id('station'),
            label: DM_TEXTS.station,
            noTranslation: true,
            options: [{ label: '–', value: '' }, ...has.stations.map(s => ({ label: s.name, value: s.id }))],
        },
    ];
    if (t.volumeState) {
        controls.push({
            id: 'volume',
            type: 'slider',
            stateId: id('volume'),
            label: DM_TEXTS.volume,
            min: 0,
            max: 100,
            step: 5,
            unit: '%',
        });
    }
    controls.push(
        { id: 'title', type: 'info', stateId: id('title'), label: DM_TEXTS.nowPlaying, noTranslation: true },
        {
            id: 'sleep',
            type: 'select',
            stateId: id('sleep'),
            label: DM_TEXTS.sleep,
            options: SLEEP_OPTIONS.map(m => ({ label: m ? `${m} min` : DM_TEXTS.off, value: m })),
        },
        { id: 'alarmTime', type: 'info', stateId: id('alarmTime'), label: DM_TEXTS.wakeUp, noTranslation: true },
    );
    return {
        id: base,
        name: t.name,
        identifier: t.urlState,
        model: modelOf(t),
        group: { key: t.kind, name: modelOf(t) },
        controls,
        actions: [
            { id: 'prev', icon: 'previous', description: DM_TEXTS.previous },
            { id: 'next', icon: 'next', description: DM_TEXTS.next },
            { id: 'alarm', icon: 'settings', description: DM_TEXTS.wakeUp },
        ],
        hasDetails: true,
    };
}

/**
 * The form below a card.
 *
 * @param {Target} t - Player
 * @param {object} info - What to show
 * @param {{direct: boolean, codec?: string, sampleRate?: number, channels?: number}} info.way - How it gets the station
 * @param {string} info.alarmNext - Next wake-up, ISO time or ''
 * @param {Array<{ts: number, station: string, title: string}>} info.history - Last titles, newest first
 * @returns {{schema: {type: 'panel', items: Record<string, ConfigItemAny>}, data: Record<string, unknown>}} JSON config schema
 */
function detailsOf(t, info) {
    const way = info.way.direct
        ? DM_TEXTS.wayDirect
        : fill(
              DM_TEXTS.wayProxy,
              `${String(info.way.codec).toUpperCase()} ${info.way.sampleRate} Hz, ${info.way.channels} ch`,
          );
    /** @type {Record<string, ConfigItemAny>} */
    const items = {
        _url: { type: 'staticInfo', label: DM_TEXTS.playUrlState, data: t.urlState, sm: 12 },
        _way: { type: 'staticInfo', label: DM_TEXTS.way, data: way, sm: 12 },
        _alarm: {
            type: 'staticInfo',
            label: DM_TEXTS.nextAlarm,
            data: info.alarmNext ? new Date(info.alarmNext).toLocaleString() : '–',
            sm: 12,
        },
    };
    const lines = info.history
        .slice(0, 10)
        .map(
            e => `${new Date(e.ts).toLocaleTimeString().slice(0, 5)}  ${e.title}${e.station ? ` (${e.station})` : ''}`,
        );
    items._history = {
        type: 'staticInfo',
        label: DM_TEXTS.lastTitles,
        data: lines.length ? lines.join('\n') : '–',
        sm: 12,
    };
    return { schema: { type: 'panel', items }, data: {} };
}

/**
 * The form of the wake-up radio of a player.
 *
 * @param {Station[]} stations - The favourites
 * @returns {{type: 'panel', items: Record<string, ConfigItemAny>}} JSON config schema
 */
function alarmForm(stations) {
    /** @type {Record<string, ConfigItemAny>} */
    const items = {
        time: { type: 'text', label: DM_TEXTS.alarmTime, sm: 12 },
        _days: { type: 'staticText', text: DM_TEXTS.alarmDays, sm: 12 },
    };
    for (let d = 1; d <= 7; d++) {
        items[`d${d}`] = {
            type: 'checkbox',
            label: /** @type {ioBroker.Translated} */ (
                Object.fromEntries(Object.entries(DM_TEXTS.weekdays).map(([l, t]) => [l, t.split(',')[d - 1]]))
            ),
            xs: 3,
            sm: 3,
            md: 1,
        };
    }
    items.station = {
        type: 'select',
        label: DM_TEXTS.station,
        newLine: true,
        sm: 12,
        options: [{ label: DM_TEXTS.lastStation, value: '' }, ...stations.map(s => ({ label: s.name, value: s.id }))],
    };
    return { type: 'panel', items };
}

/**
 * @param {string} days - Value of alarmDays
 * @returns {Record<string, boolean>} d1 … d7 for the form; every day = none ticked
 */
function daysToForm(days) {
    const list = parseDays(days) || [];
    const every = list.length === 7;
    return Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(d => [`d${d}`, !every && list.includes(d)]));
}

/**
 * @param {Record<string, unknown>} data - Form data
 * @returns {string} Value for alarmDays ('' = every day)
 */
function daysFromForm(data) {
    const ticked = [1, 2, 3, 4, 5, 6, 7].filter(d => data[`d${d}`] === true);
    return ticked.length === 0 || ticked.length === 7 ? '' : ticked.join(',');
}

/** The players of the instance in the Device Manager; dm-utils answers the dm:* messages through it. */
class RadioDeviceManagement extends DeviceManagement {
    /**
     * @param {RadioHost & import('@iobroker/adapter-core').AdapterInstance} adapter - The adapter (main.js)
     */
    constructor(adapter) {
        super(adapter);
        /** @type {RadioHost} */
        this.app = adapter;
    }

    /**
     * @returns {InstanceDetails} Instance information with the action "check the favourites"
     */
    getInstanceInfo() {
        const info = /** @type {InstanceDetails} */ (super.getInstanceInfo());
        info.actions = [
            {
                id: 'checkStations',
                icon: 'refresh',
                title: DM_TEXTS.checkStations,
                handler: context => this.check(context),
            },
        ];
        return info;
    }

    /**
     * @param {ActionContext} context - Action context of dm-utils
     * @returns {Promise<{refresh: boolean}>} Nothing to reload
     */
    async check(context) {
        const res = await this.app.checkStations();
        const online = res.filter(r => r.online).length;
        await context.showMessage(fill(DM_TEXTS.checkResult, online, res.length));
        return { refresh: false };
    }

    /**
     * @param {DeviceLoadContext} context - Load context of dm-utils
     */
    async loadDevices(context) {
        const players = [...this.app.running.values()].map(r => r.t).sort((a, b) => a.name.localeCompare(b.name));
        context.setTotalDevices(players.length);
        for (const t of players) {
            const card = cardOf(t, { ns: this.app.namespace, stations: this.app.stations });
            for (const control of card.controls) {
                const own = String(control.stateId).slice(this.app.namespace.length + 1);
                control.handler = (_d, _c, val) => this.onControl(t, control.id, own, val);
                control.getStateHandler = () => this.read(own);
            }
            for (const action of card.actions) {
                Object.assign(action, {
                    handler: async (/** @type {string} */ _d, /** @type {ActionContext} */ ctx) => {
                        if (action.id === 'alarm') {
                            await this.editAlarm(t, ctx);
                        } else {
                            await this.app.setStateAsync(`targets.${t.id}.${action.id}`, { val: true, ack: false });
                        }
                        return { refresh: 'none' };
                    },
                });
            }
            context.addDevice(card);
        }
    }

    /**
     * The form of the wake-up radio of a player: time, weekdays, station.
     *
     * @param {Target} t - Player
     * @param {ActionContext} context - Action context of dm-utils
     */
    async editAlarm(t, context) {
        const base = `targets.${t.id}`;
        const read = async (/** @type {string} */ key) =>
            String((await this.app.getStateAsync(`${base}.${key}`))?.val ?? '');
        const data = {
            time: await read('alarmTime'),
            ...daysToForm(await read('alarmDays')),
            station: await read('alarmStation'),
        };
        const res = await context.showForm(alarmForm(this.app.stations), {
            data,
            title: DM_TEXTS.wakeUp,
            buttons: ['apply', 'cancel'],
            ignoreApplyDisabled: true,
        });
        if (!res) {
            return; // cancelled
        }
        const error = await this.app.setAlarm(t.id, {
            time: String(res.time ?? '').trim(),
            days: daysFromForm(res),
            station: String(res.station ?? ''),
        });
        if (error) {
            await context.showMessage(error);
            return;
        }
        const next = await read('alarmNext');
        await context.showMessage(
            next ? fill(DM_TEXTS.alarmSaved, new Date(next).toLocaleString()) : DM_TEXTS.alarmOff,
        );
    }

    /**
     * @param {string} deviceId - Id of the card (targets.kitchen)
     * @returns {Promise<DeviceDetails | {error: string}>} The form below the card
     */
    async getDeviceDetails(deviceId) {
        const t = [...this.app.running.values()].map(r => r.t).find(x => `targets.${x.id}` === deviceId);
        if (!t) {
            return { error: `unknown player ${deviceId}` };
        }
        const alarmNext = String((await this.app.getStateAsync(`${deviceId}.alarmNext`))?.val || '');
        const history = readHistory((await this.app.getStateAsync(`${deviceId}.history`))?.val);
        return { id: deviceId, ...detailsOf(t, { way: this.app.streamOf(t), alarmNext, history }) };
    }

    /**
     * A control of a card was used: the radio switch resumes or stops, the others write their state (the adapter
     * acts on it as on any other command).
     *
     * @param {Target} t - Player
     * @param {string} controlId - playing, station, volume or sleep
     * @param {string} own - State id below the namespace
     * @param {ControlState} val - New value
     * @returns {Promise<ioBroker.State>} The state as the control shows it
     */
    async onControl(t, controlId, own, val) {
        if (controlId === 'playing') {
            await this.app.setStateAsync(`targets.${t.id}.${val ? 'resume' : 'stop'}`, { val: true, ack: false });
        } else {
            await this.app.setStateAsync(own, { val: /** @type {ioBroker.StateValue} */ (val), ack: false });
        }
        return this.read(own);
    }

    /**
     * @param {string} own - State id below the namespace
     * @returns {Promise<ioBroker.State>} The state, or an empty one
     */
    async read(own) {
        const now = Date.now();
        return (await this.app.getStateAsync(own)) ?? { val: null, ack: true, ts: now, lc: now, from: '', q: 0 };
    }
}

module.exports = { RadioDeviceManagement, cardOf, detailsOf, alarmForm, daysToForm, daysFromForm, fill, SLEEP_OPTIONS };
