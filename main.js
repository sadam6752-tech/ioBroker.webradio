'use strict';

/*
 * ioBroker.webradio: favourite internet radio stations (plus the catalog radio-browser.info) played on any ioBroker
 * player that takes a URL — ioBroker.assistant satellites, ioBroker.satellite-display panels, Dune HD and others.
 * ESPHome players get the station through the own stream proxy (ffmpeg → FLAC), the others the station URL.
 */

const utils = require('@iobroker/adapter-core');
const { NAMES } = require('./lib/names');
const { helpAnswer } = require('./lib/help');
const { bindOf } = require('./lib/resources');
const { listenOnFreePort } = require('./lib/port');
const { STORAGE, LOGO_DIR, logoPath, normalizeLogoFile, migrateOldLogos } = require('./lib/storage');
const { RadioBrowser, searchParams, sentQuery } = require('./lib/radio-browser');
const { Channel, StreamServer, SourceReader, playableUrl, probeUrl } = require('./lib/proxy');
const { checkStation, urlInUse, CHECK_INTERVAL_HOURS, FIRST_CHECK_DELAY_MS } = require('./lib/check');
const { downloadLogo, shrinkLogo, MIME } = require('./lib/logos');
const {
    rememberStation,
    resumeStation,
    stepStation,
    percentOf,
    playbackOf,
    ownVolume,
    addHistory,
    readHistory,
    SleepTimer,
} = require('./lib/control');
const { exportStations, importStations } = require('./lib/transfer');
const { CoverFinder } = require('./lib/cover');
const { normalizeTime, parseDays, nextAlarm, Ramp } = require('./lib/alarm');
const { RadioDeviceManagement } = require('./lib/device-management');
const { stationList, targetList } = require('./lib/lists');
const {
    normalizeStations,
    discoverTargets,
    buildTargets,
    streamFor,
    findByName,
    roomsOf,
    isStreamUrl,
    scaleVolume,
    fitTitle,
    streamHost,
    customIds,
    urlStateChoices,
} = require('./lib/config');

/**
 * @typedef {import('./lib/types').Station} Station
 * @typedef {import('./lib/types').Target} Target
 */

/**
 * @typedef {object} Running
 * @property {Target} t - Settings
 * @property {Channel | null} channel - Proxy of the target (null = it plays station URLs directly)
 * @property {SourceReader | null} watcher - Reads the titles of a station played directly
 * @property {Station | null} station - What plays (or played last)
 * @property {boolean} playing - This adapter told the player to play
 * @property {string} url - URL written to the player
 * @property {string} title - ICY title
 * @property {{min?: unknown, max?: unknown} | null} volumeCommon - Range of the volume state (read once)
 * @property {SleepTimer} sleep - Sleep timer
 * @property {number | null} fadeFrom - Volume (%) before the sleep timer began to fade it, -1 = cannot fade, null = no fade
 * @property {Ramp} ramp - Fade-in of the wake-up radio
 * @property {unknown} alarmTimer - Timer of the next wake-up
 * @property {string} stateId - Playback state of the player (role media.state), '' = none
 * @property {boolean} seenPlaying - The player reported playing since this adapter started the station
 * @property {number[]} wroteVolume - The last values this adapter wrote to the volume state of the player
 */

/** Port of the stream server, next to airplay-receiver (8095) */
const DEFAULT_PORT = 8096;
/** How long a player that plays by itself waits for the stream URL inside a playlist */
const DIRECT_URL_TIMEOUT_MS = 8000;

/**
 * @param {unknown} adapter - Adapter
 * @returns {import('./lib/types').UsedResourcesApi | null} Its registry calls, or null without registry
 */
function registryOf(adapter) {
    const api = /** @type {import('./lib/types').UsedResourcesApi} */ (adapter);
    try {
        return api.supportsFeature?.('CONTROLLER_USED_RESOURCES') ? api : null;
    } catch {
        return null;
    }
}

class Webradio extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options = {}) {
        super({ ...options, name: 'webradio' });
        /** @type {Station[]} */
        this.stations = [];
        /** @type {Map<string, Running>} */
        this.running = new Map();
        /** @type {Map<string, Running>} play URL state → target */
        this.byUrlState = new Map();
        /** @type {Map<string, Running>} playback state of a player → target */
        this.byPlayerState = new Map();
        /** @type {Map<string, Running>} volume state of a player → target */
        this.byVolumeState = new Map();
        /** @type {StreamServer | null} */
        this.http = null;
        this.httpPort = 0;
        /** @type {Map<string, string>} station id → logo file in the file storage */
        this.logoFiles = new Map();
        /** @type {import('./lib/types').Target[]} */
        this.targets = [];
        /** @type {Set<string>} states whose absence was already logged */
        this.missing = new Set();
        this.counter = 0;
        this.catalog = new RadioBrowser({ userAgent: 'ioBroker.webradio' });
        /** @type {CoverFinder | null} */
        this.covers = null;
        /** @type {Map<string, string>} station id → URL in the settings (before a refresh) */
        this.configUrls = new Map();
        /** @type {Promise<Array<Record<string, unknown>>> | null} the check that runs */
        this.checking = null;
        /** @type {() => void} */
        this.markReady = () => undefined;
        this.ready = new Promise(resolve => (this.markReady = () => resolve(undefined)));
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        // the players in the Device Manager (tab Devices); it answers the dm:* messages itself
        this.deviceManagement = new RadioDeviceManagement(this);
        this.on('unload', this.onUnload.bind(this));
    }

    /** @returns {string} User-Agent towards stations and the catalog: the adapter and its version, nothing else */
    get userAgent() {
        return `ioBroker.webradio/${this.version || '0'}`;
    }

    /** @returns {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (h: unknown) => void}} Timers */
    get timers() {
        return {
            setTimeout: (cb, ms) => this.setTimeout(cb, ms),
            clearTimeout: h => h && this.clearTimeout(/** @type {ioBroker.Timeout} */ (h)),
        };
    }

    async onReady() {
        try {
            await this.start();
        } finally {
            this.markReady();
        }
    }

    async start() {
        await this.setState('info.connection', { val: false, ack: true });
        this.catalog = new RadioBrowser({ userAgent: this.userAgent, server: String(this.config.catalogServer || '') });
        this.covers = this.config.trackCovers !== false ? new CoverFinder({ userAgent: this.userAgent }) : null;
        const ffmpegPath = String(this.config.ffmpegPath || '').trim() || String(require('ffmpeg-static') || '');
        this.ffmpegPath = ffmpegPath;

        const st = normalizeStations(this.config.stations);
        this.stations = st.stations;
        const discovered = this.config.autoDiscover !== false ? await this.discover() : [];
        const tg = buildTargets(this.config.targets, discovered);
        for (const p of [...st.problems, ...tg.problems]) {
            this.log.warn(`Skipped: ${p}`);
        }
        await this.createObjects(this.stations, tg.targets);
        this.targets = tg.targets;
        await this.writeLists();

        const http = new StreamServer(this.log, id => this.readLogo(id));
        this.http = http;
        const port = Number(this.config.port) || DEFAULT_PORT;
        const bind = String(this.config.bind || '0.0.0.0');
        try {
            const open = await listenOnFreePort(port, {
                // the operating system: getPort of adapter-core tries the port and the ones after it
                findFree: p =>
                    new Promise(resolve => {
                        const host = bindOf(bind);
                        if (host) {
                            this.getPort(p, host, resolve);
                        } else {
                            this.getPort(p, resolve);
                        }
                    }),
                // js-controller 8: ports that other running instances declare, also while they are not listening
                heldBy: p => this.heldBy(p, bind),
                listen: p => {
                    if (this.http !== http) {
                        throw new Error('stopped while starting');
                    }
                    return http.listen(p, bind);
                },
            });
            this.httpPort = open.port;
            if (open.port !== port) {
                this.log.info(
                    `Stream server on port ${open.port}: the configured port ${port} is taken (${open.skipped
                        .map(s => `${s.port} by ${s.by}`)
                        .join(', ')}); set a free port in the settings (tab Settings, HTTP port) to keep a fixed one`,
                );
            }
        } catch (e) {
            if (this.http !== http) {
                return; // stopped while it was starting
            }
            this.http = null;
            this.log.error(
                `The stream server cannot start, nothing can be played: ${e.message}. Set a free port in the settings (tab Settings, HTTP port of the stream server)`,
            );
            return;
        }
        if (this.http !== http) {
            return;
        }
        await this.registerPort(this.httpPort, bind);

        for (const t of tg.targets) {
            const way = streamFor(t);
            /** @type {Running} */
            const r = {
                t,
                channel: null,
                watcher: null,
                station: null,
                playing: false,
                url: '',
                title: '',
                volumeCommon: null,
                // the callbacks run later, when r exists
                sleep: new SleepTimer({
                    timers: this.timers,
                    onLeft: minutes => void this.setState(`targets.${t.id}.sleepLeft`, { val: minutes, ack: true }),
                    onFade: fraction => void this.fadeStep(r, fraction),
                    onEnd: () => void this.sleepEnd(r),
                }),
                fadeFrom: null,
                ramp: new Ramp(this.timers),
                alarmTimer: null,
                stateId: '',
                seenPlaying: false,
                wroteVolume: [],
            };
            if (!way.direct) {
                if (!ffmpegPath) {
                    this.log.error(`${t.name}: no ffmpeg for this platform; set the path of an installed ffmpeg`);
                    continue;
                }
                r.channel = new Channel({
                    id: t.id,
                    name: t.name,
                    codec: way.codec,
                    sampleRate: way.sampleRate,
                    channels: way.channels,
                    ffmpegPath,
                    userAgent: this.userAgent,
                    timers: this.timers,
                    log: this.log,
                    onTitle: title => void this.onTitle(r, title),
                    onEnd: () => void this.onStationEnd(r),
                });
                http.add(r.channel);
            }
            this.running.set(t.id, r);
            this.byUrlState.set(t.urlState, r);
            r.stateId = await this.playerStateOf(t);
            if (r.stateId) {
                this.byPlayerState.set(r.stateId, r);
            }
            if (t.volumeState) {
                this.byVolumeState.set(t.volumeState, r);
            }
        }
        await this.extendObject('info.checkStations', {
            type: 'state',
            common: {
                name: NAMES.checkStations,
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            native: {},
        });
        await this.subscribeStatesAsync('targets.*');
        await this.subscribeStatesAsync('info.checkStations');
        for (const id of [...this.byPlayerState.keys(), ...this.byVolumeState.keys()]) {
            await this.subscribeForeignStatesAsync(id);
        }
        for (const id of this.byUrlState.keys()) {
            await this.subscribeForeignStatesAsync(id);
        }
        this.log.info(
            `${this.stations.length} station(s), player(s): ${
                tg.targets.map(t => `${t.name}${t.discovered ? ' (found)' : ''}`).join(', ') || 'none'
            }; stream server on port ${this.httpPort}`,
        );
        await this.setState('info.connection', { val: true, ack: true });
        for (const r of this.running.values()) {
            await this.scheduleAlarm(r);
        }
        void this.cacheLogos(this.stations);
        if (this.config.checkStations !== false) {
            this.scheduleCheck(FIRST_CHECK_DELAY_MS);
        }
    }

    /**
     * Other running instances that declare the TCP port (js-controller 8; empty on 7.x).
     *
     * @param {number} port - Port
     * @param {string} bind - Listen address
     * @returns {Promise<string[]>} Instances
     */
    async heldBy(port, bind) {
        const reg = registryOf(this);
        if (!reg || !(port > 0)) {
            return [];
        }
        const b = bindOf(bind);
        try {
            const held = await reg.checkUsedResource('tcpPort', b ? { port, bind: b } : { port });
            return [...new Set(held.map(h => h.instance))].filter(i => i !== `system.adapter.${this.namespace}`);
        } catch (e) {
            this.log.debug(`Used resources: check of port ${port} failed: ${e.message}`);
            return [];
        }
    }

    /**
     * @param {number} port - Port that is open now
     * @param {string} bind - Listen address
     */
    async registerPort(port, bind) {
        const reg = registryOf(this);
        if (!reg || !(port > 0)) {
            return;
        }
        const b = bindOf(bind);
        try {
            await reg.registerUsedResource('tcpPort', b ? { port, bind: b } : { port });
        } catch (e) {
            this.log.debug(`Used resources: port ${port} not registered: ${e.message}`);
        }
    }

    /**
     * Objects of every instance of an adapter below a prefix.
     *
     * @param {string} adapter - Adapter name
     * @param {'state' | 'device'} type - Object type
     * @returns {Promise<Record<string, ioBroker.Object>>} Objects
     */
    async objectsOf(adapter, type) {
        const res = await this.getObjectViewAsync('system', type, {
            startkey: `${adapter}.`,
            endkey: `${adapter}.香`,
        });
        /** @type {Record<string, ioBroker.Object>} */
        const out = {};
        for (const row of res?.rows || []) {
            if (row.value) {
                out[row.id] = /** @type {ioBroker.Object} */ (row.value);
            }
        }
        return out;
    }

    /**
     * Satellites of ioBroker.assistant and panels of ioBroker.satellite-display.
     *
     * @returns {Promise<Array<{name: string, urlState: string}>>} Rows
     */
    async discover() {
        try {
            /** @type {Record<string, ioBroker.Object>} */
            const objects = {};
            for (const adapter of ['assistant', 'satellite-display']) {
                const states = await this.objectsOf(adapter, 'state');
                for (const [id, obj] of Object.entries(states)) {
                    if (obj.common?.role === 'media.url') {
                        objects[id] = obj;
                    }
                }
                Object.assign(objects, await this.objectsOf(adapter, 'device'));
            }
            return discoverTargets(objects);
        } catch (e) {
            this.log.warn(`Search for players failed: ${e.message}`);
            return [];
        }
    }

    /**
     * @param {Station[]} stations - Stations
     * @param {Target[]} targets - Targets
     */
    async createObjects(stations, targets) {
        // the file storage of the instance; meta.user: backups take it along
        await this.setObjectNotExistsAsync(STORAGE, {
            type: 'meta',
            common: { name: NAMES.storage, type: 'meta.user' },
            native: {},
        });
        await this.migrateLogos();
        await this.extendObject('stations', { type: 'folder', common: { name: NAMES.stations }, native: {} });
        for (const s of stations) {
            const channel = await this.getObjectAsync(`stations.${s.id}`);
            this.configUrls.set(s.id, s.url);
            s.url = urlInUse(s.url, /** @type {Record<string, unknown>} */ (channel?.native || {}));
            await this.extendObject(`stations.${s.id}`, {
                type: 'channel',
                common: { name: s.name },
                native: { uuid: s.uuid },
            });
            for (const [key, type, role, def] of /** @type {const} */ ([
                ['online', 'boolean', 'indicator.reachable', null],
                ['checked', 'number', 'date', 0],
            ])) {
                await this.extendObject(`stations.${s.id}.${key}`, {
                    type: 'state',
                    common: { name: NAMES[key], type, role, read: true, write: false, def },
                    native: {},
                });
            }
            for (const [key, role, val] of [
                ['name', 'text', s.name],
                ['url', 'text.url', s.url],
                ['logo', 'media.cover', s.logo],
                ['tags', 'text', s.tags.join(', ')],
            ]) {
                await this.extendObject(`stations.${s.id}.${key}`, {
                    type: 'state',
                    common: { name: NAMES[key], type: 'string', role, read: true, write: false, def: '' },
                    native: {},
                });
                // the logo state gets the cached copy later; keep it when it is there already
                if (key !== 'logo' || !(await this.getStateAsync(`stations.${s.id}.logo`))?.val) {
                    await this.setState(`stations.${s.id}.${key}`, { val, ack: true });
                }
            }
        }

        /** @type {Record<string, string>} */
        const choice = { '': '–' };
        for (const s of stations) {
            choice[s.id] = s.name;
        }
        await this.extendObject('targets', { type: 'folder', common: { name: NAMES.targets }, native: {} });
        /** @type {Array<[string, ioBroker.CommonType, string, boolean, ioBroker.StateValue, Partial<ioBroker.StateCommon>]>} */
        const states = [
            // key, type, role, write, def, extra
            ['station', 'string', 'text', true, '', { states: choice }],
            ['play', 'boolean', 'button.play', true, false, {}],
            ['stop', 'boolean', 'button.stop', true, false, {}],
            ['playing', 'boolean', 'media.state', false, false, {}],
            ['title', 'string', 'media.title', false, '', {}],
            ['cover', 'string', 'media.cover', false, '', {}],
            ['volume', 'number', 'level.volume', true, 0, { min: 0, max: 100, unit: '%' }],
            ['streamUrl', 'string', 'text.url', false, '', {}],
            ['resume', 'boolean', 'button', true, false, {}],
            ['next', 'boolean', 'button.next', true, false, {}],
            ['prev', 'boolean', 'button.prev', true, false, {}],
            ['sleep', 'number', 'level.timer', true, 0, { min: 0, max: 720, unit: 'min' }],
            ['sleepLeft', 'number', 'value', false, 0, { min: 0, unit: 'min' }],
            ['lastStation', 'string', 'json', false, '', {}],
            ['history', 'string', 'json', false, '[]', {}],
            ['alarmTime', 'string', 'text', true, '', {}],
            ['alarmDays', 'string', 'text', true, '', {}],
            ['alarmStation', 'string', 'text', true, '', { states: choice }],
            ['alarmNext', 'string', 'date', false, '', {}],
        ];
        for (const t of targets) {
            await this.extendObject(`targets.${t.id}`, {
                type: 'channel',
                common: { name: t.name, desc: t.urlState },
                native: { urlState: t.urlState, kind: t.kind },
            });
            for (const [key, type, role, write, def, extra] of states) {
                const button = role.startsWith('button');
                await this.extendObject(`targets.${t.id}.${key}`, {
                    type: 'state',
                    common: {
                        name: NAMES[key],
                        type: /** @type {ioBroker.CommonType} */ (type),
                        role,
                        read: !button,
                        write,
                        def,
                        ...extra,
                    },
                    native: {},
                });
            }
            // nothing plays after a start and no sleep timer runs; the selected station, the volume and the last
            // station stay
            for (const key of ['playing', 'title', 'cover', 'streamUrl', 'sleep', 'sleepLeft']) {
                const def = states.find(s => s[0] === key)?.[4];
                await this.setState(`targets.${t.id}.${key}`, { val: def ?? '', ack: true });
            }
            // before 0.0.2 there was no lastStation: take the selected favourite, so resume plays what played last
            if (!(await this.getStateAsync(`targets.${t.id}.lastStation`))?.val) {
                const selected = String((await this.getStateAsync(`targets.${t.id}.station`))?.val || '');
                const fav = stations.find(s => s.id === selected);
                if (fav) {
                    await this.setState(`targets.${t.id}.lastStation`, {
                        val: JSON.stringify(rememberStation(fav)),
                        ack: true,
                    });
                }
            }
        }
        await this.removeStale('stations', new Set(stations.map(s => `${this.namespace}.stations.${s.id}`)));
        await this.removeStale('targets', new Set(targets.map(t => `${this.namespace}.targets.${t.id}`)));
        // 0.0.3-beta: volume and fade-in of the wake-up radio were per player; they are settings of the instance now
        for (const t of targets) {
            for (const key of ['alarmVolume', 'alarmFade']) {
                if (await this.getObjectAsync(`targets.${t.id}.${key}`)) {
                    await this.delObjectAsync(`targets.${t.id}.${key}`);
                }
            }
        }
    }

    /**
     * Deletes the channels of stations or players that are no longer configured, unless a state has custom settings.
     *
     * @param {string} folder - `stations` or `targets`
     * @param {Set<string>} keep - Channel ids to keep
     */
    async removeStale(folder, keep) {
        const channels = await this.getObjectViewAsync('system', 'channel', {
            startkey: `${this.namespace}.${folder}.`,
            endkey: `${this.namespace}.${folder}.香`,
        });
        for (const row of channels?.rows || []) {
            if (keep.has(row.id)) {
                continue;
            }
            const linked = customIds(await this.getForeignObjectsAsync(`${row.id}.*`));
            if (linked.length) {
                this.log.warn(
                    `${row.id} is no longer configured but kept: ${linked.join(', ')} ${linked.length === 1 ? 'has' : 'have'} custom settings (History, InfluxDB, SQL …); remove them and restart the adapter to delete it`,
                );
                continue;
            }
            await this.delForeignObjectAsync(row.id, { recursive: true });
        }
    }

    /**
     * Keeps a copy of every favourite's logo in the file storage (favicons of stations move or vanish).
     *
     * @param {Station[]} stations - Stations
     */
    async cacheLogos(stations) {
        if (this.config.cacheLogos === false) {
            return;
        }
        for (const s of stations) {
            if (!this.http) {
                return;
            }
            if (!s.logo) {
                continue;
            }
            const channel = await this.getObjectAsync(`stations.${s.id}`);
            const native = /** @type {Record<string, unknown>} */ (channel?.native || {});
            let file = normalizeLogoFile(native.logoFile);
            if (file !== native.logoFile && file) {
                // 0.0.1 stored the bare file name of the old mount point
                await this.extendObject(`stations.${s.id}`, { native: { logoFile: file } });
            }
            if (native.logoSource !== s.logo || !file || !(await this.fileExistsAsync(this.mount, file))) {
                try {
                    const ffmpeg = this.ffmpegPath;
                    const img = await downloadLogo(
                        s.logo,
                        this.userAgent,
                        undefined,
                        ffmpeg ? data => shrinkLogo(ffmpeg, data) : undefined,
                    );
                    if (img.scaled) {
                        this.log.info(`${s.name}: logo scaled down (${img.scaled} → ${img.data.length} bytes)`);
                    }
                    file = logoPath(`${s.id}.${img.ext}`);
                    await this.writeFileAsync(this.mount, file, img.data);
                    await this.extendObject(`stations.${s.id}`, { native: { logoSource: s.logo, logoFile: file } });
                } catch (e) {
                    this.log.info(`${s.name}: logo not cached (${e.message}), the station's own URL stays in use`);
                    await this.setState(`stations.${s.id}.logo`, { val: s.logo, ack: true });
                    continue;
                }
            }
            this.logoFiles.set(s.id, file);
            await this.setState(`stations.${s.id}.logo`, { val: this.logoUrl(s.id), ack: true });
        }
        await this.removeStaleLogos(new Set(this.logoFiles.values()));
        await this.writeLists();
    }

    /**
     * Writes info.stations and info.targets, the lists the vis widget draws.
     */
    async writeLists() {
        const rooms = await this.rooms();
        const stations = stationList(this.stations, this.logoFiles, this.mount, s => this.coverOf(s));
        const targets = targetList(this.targets, t => [...new Set(roomsOf(t, rooms).map(x => x.names[0]))]);
        await this.setState('info.stations', { val: JSON.stringify(stations), ack: true });
        await this.setState('info.targets', { val: JSON.stringify(targets), ack: true });
    }

    /**
     * Deletes logo files of stations that are no longer favourites.
     *
     * @param {Set<string>} keep - Paths below the storage mount point
     */
    async removeStaleLogos(keep) {
        try {
            const entries = await this.readDirAsync(this.mount, LOGO_DIR);
            for (const e of entries || []) {
                const path = logoPath(e.file);
                if (!e.isDir && !keep.has(path)) {
                    await this.delFileAsync(this.mount, path);
                }
            }
        } catch {
            // no logo folder yet
        }
    }

    /**
     * Moves the logos of version 0.0.1 (own mount point `<ns>.logos`) into the file storage and removes the old one.
     */
    async migrateLogos() {
        try {
            const res = await migrateOldLogos(this.namespace, {
                hasObject: async id => !!(await this.getForeignObjectAsync(id)),
                readDir: async (mount, path) => (await this.readDirAsync(mount, path)) || [],
                readFile: async (mount, path) => {
                    const r = await this.readFileAsync(mount, path);
                    return Buffer.isBuffer(r?.file) ? r.file : Buffer.from(String(r?.file ?? ''));
                },
                writeFile: (mount, path, data) => this.writeFileAsync(mount, path, data),
                delFile: (mount, path) => this.delFileAsync(mount, path),
                delObject: id => this.delForeignObjectAsync(id),
            });
            if (res) {
                this.log.info(
                    `Station logos moved to ${this.mount}/${LOGO_DIR} (${res.moved.length} file(s)${
                        res.failed.length ? `, ${res.failed.length} will be downloaded again` : ''
                    }); the old folder ${this.namespace}.logos was removed`,
                );
            }
        } catch (e) {
            this.log.warn(`Station logos could not be moved to ${this.mount}: ${e.message}`);
        }
    }

    /** @returns {string} Id of the mount point of the file storage */
    get mount() {
        return `${this.namespace}.${STORAGE}`;
    }

    /**
     * @param {string} id - Station id
     * @returns {string} URL of the cached logo on the own HTTP server
     */
    logoUrl(id) {
        return `http://${streamHost(this.config.urlHost)}:${this.httpPort}/logo/${id}`;
    }

    /**
     * @param {string} id - Station id
     * @returns {Promise<{data: Buffer, type: string} | null>} Cached logo
     */
    async readLogo(id) {
        const file = this.logoFiles.get(id);
        if (!file) {
            return null;
        }
        const res = await this.readFileAsync(this.mount, file);
        const data = Buffer.isBuffer(res?.file) ? res.file : Buffer.from(String(res?.file ?? ''));
        return { data, type: MIME[file.split('.').pop() || ''] || 'application/octet-stream' };
    }

    /**
     * @param {Station} s - Station
     * @returns {string} Logo for a player: the cached copy, else the station's own
     */
    coverOf(s) {
        return this.logoFiles.has(s.id) ? this.logoUrl(s.id) : s.logo;
    }

    /**
     * Plays a station on a target.
     *
     * @param {Running} r - Target
     * @param {Station} station - Station
     * @returns {Promise<string>} Error text, empty = playing
     */
    async playStation(r, station) {
        if (!(await this.exists(r.t.urlState))) {
            return `the player ${r.t.name} does not exist any more (${r.t.urlState})`;
        }
        await this.cancelSleep(r);
        r.ramp.cancel();
        r.seenPlaying = false;
        this.stopReaders(r);
        r.station = station;
        r.title = '';
        let url;
        if (r.channel) {
            r.channel.setSource(station.url);
            // a new URL every time: a player that gets the same URL again may keep playing the old stream
            url = `http://${streamHost(this.config.urlHost)}:${this.httpPort}${r.channel.path}?s=${station.id || 'url'}&n=${++this.counter}`;
        } else {
            url = await this.directUrl(station);
            if (r.station !== station) {
                return ''; // another station was chosen meanwhile
            }
        }
        r.url = url;
        r.playing = true;
        const base = `targets.${r.t.id}`;
        await this.setState(`${base}.station`, { val: station.id, ack: true });
        await this.setState(`${base}.lastStation`, { val: JSON.stringify(rememberStation(station)), ack: true });
        await this.setState(`${base}.streamUrl`, { val: url, ack: true });
        await this.setState(`${base}.cover`, { val: this.coverOf(station), ack: true });
        await this.setState(`${base}.title`, { val: '', ack: true });
        await this.setState(`${base}.playing`, { val: true, ack: true });
        this.log.info(`${r.t.name}: playing ${station.name}${r.channel ? ' through the proxy' : ''} (${url})`);
        // the station name first: the ICY title of the stream replaces it as soon as it arrives
        await this.writeTarget(r.t.titleState, fitTitle(station.name, r.t.titleBytes), true);
        await this.writeTarget(r.t.urlState, url);
        if (!r.channel && this.config.readTitles !== false && r.playing && r.station === station) {
            r.watcher = new SourceReader({
                url: station.url,
                name: `${r.t.name} (titles)`,
                userAgent: this.userAgent,
                timers: this.timers,
                log: this.log,
                onTitle: title => void this.onTitle(r, title),
            });
            r.watcher.start();
        }
        if (station.uuid) {
            void this.catalog.click(station.uuid);
        }
        return '';
    }

    /**
     * The URL for a player that plays by itself: the stream inside a playlist (m3u, pls, asx, xspf), which many players
     * cannot read; the station URL when that is the stream, is HLS or does not answer in time.
     *
     * @param {Station} station - Station
     * @returns {Promise<string>} URL
     */
    async directUrl(station) {
        /** @type {unknown} */
        let timer = null;
        const late = new Promise(resolve => {
            timer = this.timers.setTimeout(() => resolve(station.url), DIRECT_URL_TIMEOUT_MS);
        });
        try {
            const url = await Promise.race([playableUrl(station.url, this.userAgent).catch(() => station.url), late]);
            if (url !== station.url) {
                this.log.debug(`${station.name}: the playlist names ${url}`);
            }
            return String(url);
        } finally {
            this.timers.clearTimeout(timer);
        }
    }

    /**
     * Stops a target, if this adapter started it.
     *
     * @param {Running} r - Target
     * @param {boolean} [tellPlayer] - Write the stop state of the player
     */
    async stopTarget(r, tellPlayer = true) {
        this.stopReaders(r);
        r.channel?.setSource('');
        const was = r.playing;
        r.playing = false;
        r.url = '';
        r.title = '';
        const base = `targets.${r.t.id}`;
        await this.setState(`${base}.playing`, { val: false, ack: true });
        await this.setState(`${base}.title`, { val: '', ack: true });
        if (was && tellPlayer) {
            this.log.info(`${r.t.name}: stopped`);
            await this.writeTarget(r.t.stopState, r.t.stopValue);
            await this.writeTarget(r.t.titleState, '', true);
        }
        r.ramp.cancel();
        await this.cancelSleep(r);
    }

    /**
     * The station to resume on a target: what played last (this run, else lastStation), else the first favourite.
     *
     * @param {Running} r - Target
     * @returns {Promise<Station | null>} Station
     */
    async lastStationOf(r) {
        if (r.station) {
            return resumeStation(this.stations, rememberStation(r.station));
        }
        const saved = (await this.getStateAsync(`targets.${r.t.id}.lastStation`))?.val;
        return resumeStation(this.stations, saved);
    }

    /**
     * The next or previous favourite of a target, from the station that plays or played last.
     *
     * @param {Running} r - Target
     * @param {1 | -1} step - 1 = next, -1 = previous
     * @returns {Promise<Station | null>} Station
     */
    async stepStationOf(r, step) {
        const last = await this.lastStationOf(r);
        const current = r.station?.id ?? (last && this.stations.includes(last) ? last.id : '');
        return stepStation(this.stations, current, step);
    }

    /**
     * Starts or ends the sleep timer of a target.
     *
     * @param {Running} r - Target
     * @param {number} minutes - Minutes, 0 = off
     * @returns {Promise<string>} Error text, empty = done
     */
    async startSleep(r, minutes) {
        const base = `targets.${r.t.id}`;
        if (!(minutes > 0)) {
            await this.cancelSleep(r);
            await this.setState(`${base}.sleep`, { val: 0, ack: true });
            return '';
        }
        if (!r.playing) {
            await this.setState(`${base}.sleep`, { val: 0, ack: true });
            return `nothing plays on ${r.t.name}`;
        }
        await this.cancelSleep(r);
        const m = Math.min(720, minutes);
        r.sleep.start(m);
        await this.setState(`${base}.sleep`, { val: m, ack: true });
        this.log.info(`${r.t.name}: sleep timer ${m} min`);
        return '';
    }

    /**
     * Ends the sleep timer of a target without stopping it; a faded volume comes back.
     *
     * @param {Running} r - Target
     */
    async cancelSleep(r) {
        const was = r.sleep.active || r.fadeFrom !== null;
        r.sleep.cancel();
        const from = r.fadeFrom;
        r.fadeFrom = null;
        if (from !== null && from >= 0) {
            await this.setVolume(r, from);
        }
        if (was) {
            await this.setState(`targets.${r.t.id}.sleep`, { val: 0, ack: true });
            await this.setState(`targets.${r.t.id}.sleepLeft`, { val: 0, ack: true });
        }
    }

    /**
     * One step of the fade-out before the sleep timer stops a target.
     *
     * @param {Running} r - Target
     * @param {number} fraction - 1 … 0
     */
    async fadeStep(r, fraction) {
        if (!r.t.volumeState || !r.playing) {
            return;
        }
        if (r.fadeFrom === null) {
            const obj = await this.getForeignObjectAsync(r.t.volumeState).catch(() => null);
            r.volumeCommon = /** @type {{min?: unknown, max?: unknown}} */ (obj?.common || {});
            const now = (await this.getForeignStateAsync(r.t.volumeState).catch(() => null))?.val;
            const own = Number((await this.getStateAsync(`targets.${r.t.id}.volume`))?.val);
            const from = percentOf(now, r.volumeCommon) ?? (own > 0 ? own : null);
            r.fadeFrom = from && from > 0 ? from : -1;
        }
        if (r.fadeFrom > 0) {
            await this.setVolume(r, Math.round(r.fadeFrom * Math.max(0, fraction)));
        }
    }

    /**
     * The sleep timer ran out: stop, then give the player its volume back.
     *
     * @param {Running} r - Target
     */
    async sleepEnd(r) {
        this.log.info(`${r.t.name}: sleep timer ended`);
        if (r.playing) {
            await this.stopTarget(r, true);
        } else {
            await this.cancelSleep(r);
        }
        await this.setState(`targets.${r.t.id}.sleep`, { val: 0, ack: true });
        await this.setState(`targets.${r.t.id}.sleepLeft`, { val: 0, ack: true });
    }

    /**
     * What a command answers about a station that started.
     *
     * @param {Running} r - Target
     * @param {Station} station - Station
     * @returns {Record<string, unknown>} Answer
     */
    playedAnswer(r, station) {
        const source = station.id ? 'favourite' : station.uuid ? 'catalog' : 'url';
        return {
            ok: true,
            target: r.t.name,
            station: station.name,
            stationId: station.id,
            source,
            ...(source === 'catalog' ? { uuid: station.uuid } : {}),
        };
    }

    /**
     * @param {Running} r - Target
     */
    stopReaders(r) {
        r.watcher?.stop();
        r.watcher = null;
    }

    /**
     * A new ICY title of the station that plays on a target.
     *
     * @param {Running} r - Target
     * @param {string} title - Title
     */
    async onTitle(r, title) {
        if (!r.playing || title === r.title) {
            return;
        }
        r.title = title;
        await this.setState(`targets.${r.t.id}.title`, { val: title, ack: true });
        await this.writeTarget(r.t.titleState, fitTitle(title || r.station?.name || '', r.t.titleBytes), true);
        if (this.covers) {
            void this.updateCover(r, title);
        }
        if (title) {
            const id = `targets.${r.t.id}.history`;
            const entry = { ts: Date.now(), station: r.station?.name || '', title };
            const after = addHistory((await this.getStateAsync(id))?.val, entry);
            if (after[0] === entry) {
                await this.setState(id, { val: JSON.stringify(after), ack: true });
            }
        }
    }

    /**
     * @param {Target} t - Player
     * @returns {{direct: boolean, codec?: string, sampleRate?: number, channels?: number}} How it gets the station
     */
    streamOf(t) {
        return streamFor(t);
    }

    /**
     * Writes one alarm setting of a player (normalized, ack) and plans the alarm again.
     *
     * @param {Running} r - Target
     * @param {string} key - alarmTime, alarmDays or alarmStation
     * @param {unknown} value - Value
     * @returns {Promise<string>} Error text, empty = done
     */
    async setAlarmState(r, key, value) {
        const id = `targets.${r.t.id}.${key}`;
        /** @type {ioBroker.StateValue} */
        let val;
        if (key === 'alarmTime') {
            val = normalizeTime(value);
            if (!val && String(value ?? '').trim()) {
                await this.setState(id, { val: '', ack: true });
                await this.scheduleAlarm(r);
                return `"${value}" is no time (HH:MM); the alarm is off`;
            }
        } else if (key === 'alarmDays') {
            val = String(value ?? '').trim();
            if (!parseDays(val)) {
                return `"${val}" are no weekdays (e.g. 1-5, mo,we,fr; empty = every day)`;
            }
        } else if (key === 'alarmStation') {
            val = String(value ?? '').trim();
            const hits = val ? findByName(this.stations, val) : [];
            if (val && hits.length !== 1) {
                return `no single favourite station matches "${val}"`;
            }
            val = hits[0]?.id || '';
        } else {
            return `${key} is no alarm setting`;
        }
        await this.setState(id, { val, ack: true });
        await this.scheduleAlarm(r);
        return '';
    }

    /**
     * Sets the wake-up radio of a player in one go (the form of the Device Manager and the vis widget).
     *
     * @param {string} targetId - Player id
     * @param {{time: string, days: string, station: string}} alarm - Time ('' = off), weekdays, station
     * @returns {Promise<string>} Error text, '' = done
     */
    async setAlarm(targetId, alarm) {
        const r = this.running.get(targetId);
        if (!r) {
            return `no player ${targetId}`;
        }
        for (const [key, value] of [
            ['alarmDays', alarm.days],
            ['alarmStation', alarm.station],
            ['alarmTime', alarm.time],
        ]) {
            const error = await this.setAlarmState(r, key, value);
            if (error) {
                return error;
            }
        }
        return '';
    }

    /**
     * @returns {{volume: number, fade: number}} End volume (%) and fade-in (minutes) of the wake-up radio, from the
     *   settings
     */
    alarmLevels() {
        const num = (v, d) =>
            v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v);
        return {
            volume: Math.max(0, Math.min(100, Math.round(num(this.config.alarmVolume, 40)))),
            fade: Math.max(0, Math.min(60, num(this.config.alarmFade, 5))),
        };
    }

    /**
     * Plans the next wake-up of a player from its alarm states (alarmNext shows it).
     *
     * @param {Running} r - Target
     */
    async scheduleAlarm(r) {
        if (r.alarmTimer) {
            this.clearTimeout(/** @type {ioBroker.Timeout} */ (r.alarmTimer));
        }
        r.alarmTimer = null;
        const base = `targets.${r.t.id}`;
        const time = String((await this.getStateAsync(`${base}.alarmTime`))?.val || '');
        const days = parseDays((await this.getStateAsync(`${base}.alarmDays`))?.val) || [];
        const next = time ? nextAlarm(new Date(), time, days) : null;
        await this.setState(`${base}.alarmNext`, { val: next ? next.toISOString() : '', ack: true });
        if (!next || !this.http) {
            return;
        }
        r.alarmTimer = this.setTimeout(
            () => {
                r.alarmTimer = null;
                void this.wakeUp(r).finally(() => this.scheduleAlarm(r));
            },
            Math.max(1000, next.getTime() - Date.now()),
        );
    }

    /**
     * The alarm rings: play the alarm station (else the last one) with the volume rising from 0.
     *
     * @param {Running} r - Target
     */
    async wakeUp(r) {
        const base = `targets.${r.t.id}`;
        const chosen = String((await this.getStateAsync(`${base}.alarmStation`))?.val || '');
        const station = this.stations.find(s => s.id === chosen) || (await this.lastStationOf(r));
        if (!station) {
            this.log.warn(`${r.t.name}: wake-up radio without a station: add favourites in the settings`);
            return;
        }
        const { volume, fade } = this.alarmLevels();
        this.log.info(`${r.t.name}: wake-up radio, ${station.name}`);
        const ramp = r.t.volumeState && fade > 0;
        if (r.t.volumeState) {
            await this.setVolume(r, ramp ? 0 : volume);
        }
        const error = await this.playStation(r, station);
        if (error) {
            this.log.warn(`${r.t.name}: wake-up radio: ${error}`);
            return;
        }
        if (ramp) {
            r.ramp.start(
                0,
                volume,
                fade * 60_000,
                level => void this.setVolume(r, level),
                () => void this.setState(`${base}.volume`, { val: volume, ack: true }),
            );
        } else if (r.t.volumeState) {
            await this.setState(`${base}.volume`, { val: volume, ack: true });
        }
    }

    /**
     * @param {number} ms - Delay of the next check of the favourites
     */
    scheduleCheck(ms) {
        this.setTimeout(async () => {
            if (!this.http) {
                return;
            }
            await this.checkStations();
            this.scheduleCheck(CHECK_INTERVAL_HOURS * 3600_000);
        }, ms);
    }

    /**
     * Checks every favourite once (one at a time); a running check is joined, not started twice.
     *
     * @returns {Promise<Array<Record<string, unknown>>>} Result per station
     */
    checkStations() {
        if (!this.checking) {
            this.checking = this.runCheck().finally(() => (this.checking = null));
        }
        return this.checking;
    }

    /**
     * @returns {Promise<Array<Record<string, unknown>>>} Result per station
     */
    async runCheck() {
        const out = [];
        let offline = 0;
        for (const s of [...this.stations]) {
            if (!this.http) {
                break;
            }
            const res = await checkStation(s, {
                probe: url => probeUrl(url, this.userAgent),
                byUuid: async uuid => await this.catalog.byUuid(uuid),
            });
            await this.setState(`stations.${s.id}.online`, { val: res.online, ack: true });
            await this.setState(`stations.${s.id}.checked`, { val: Date.now(), ack: true });
            if (res.refreshed) {
                this.log.info(`${s.name}: did not answer; radio-browser.info has a new URL that does: ${res.url}`);
                s.url = res.url;
                await this.extendObject(`stations.${s.id}`, {
                    native: { refreshedUrl: res.url, configUrl: this.configUrls.get(s.id) || '' },
                });
                await this.setState(`stations.${s.id}.url`, { val: res.url, ack: true });
            } else if (!res.online) {
                offline++;
                this.log.info(`${s.name}: does not answer (${res.error})`);
            }
            out.push({
                id: s.id,
                name: s.name,
                online: res.online,
                url: res.url,
                ...(res.refreshed ? { refreshed: true } : {}),
                ...(res.error && !res.online ? { error: res.error } : {}),
            });
        }
        this.log.debug(`Check of ${out.length} favourite(s): ${offline} do not answer`);
        return out;
    }

    /**
     * The cover of the song that plays, else the logo of the station.
     *
     * @param {Running} r - Target
     * @param {string} title - ICY title the cover is for
     */
    async updateCover(r, title) {
        const found = (await this.covers?.find(title)) || '';
        if (!r.playing || r.title !== title || !r.station) {
            return; // the title or the station changed meanwhile
        }
        const cover = found || this.coverOf(r.station);
        const id = `targets.${r.t.id}.cover`;
        if ((await this.getStateAsync(id))?.val !== cover) {
            await this.setState(id, { val: cover, ack: true });
        }
    }

    /**
     * The proxy gave up on the station (it does not answer any more).
     *
     * @param {Running} r - Target
     */
    async onStationEnd(r) {
        if (r.playing) {
            await this.stopTarget(r, true);
        }
    }

    /**
     * @param {string} id - Object id
     * @returns {Promise<boolean>} It exists; a missing one is logged once
     */
    async exists(id) {
        const obj = await this.getForeignObjectAsync(id).catch(() => null);
        if (obj) {
            this.missing.delete(id);
            return true;
        }
        if (!this.missing.has(id)) {
            this.missing.add(id);
            this.log.warn(`${id} does not exist (player removed?), skipped`);
        }
        return false;
    }

    /**
     * Writes a state of a player (a command, ack false). A state that does not exist is skipped: writing would
     * create a state without an object.
     *
     * @param {string} id - State id; empty = nothing to do
     * @param {ioBroker.StateValue} val - Value
     * @param {boolean} [quiet] - Do not log a missing state
     */
    async writeTarget(id, val, quiet = false) {
        if (!id) {
            return;
        }
        try {
            const ok = quiet ? !!(await this.getForeignObjectAsync(id)) : await this.exists(id);
            if (ok) {
                await this.setForeignStateAsync(id, { val, ack: false });
            }
        } catch (e) {
            this.log.warn(`Cannot write ${id}: ${e.message}`);
        }
    }

    /**
     * @param {Running} r - Target
     * @param {number} percent - 0 … 100
     */
    async setVolume(r, percent) {
        if (!r.t.volumeState) {
            return;
        }
        if (!r.volumeCommon) {
            const obj = await this.getForeignObjectAsync(r.t.volumeState).catch(() => null);
            r.volumeCommon = /** @type {{min?: unknown, max?: unknown}} */ (obj?.common || {});
        }
        const value = scaleVolume(percent / 100, r.volumeCommon);
        r.wroteVolume = [...r.wroteVolume.slice(-2), value];
        await this.writeTarget(r.t.volumeState, value);
    }

    /**
     * The playback state of a player: the state with role media.state next to its URL state (ioBroker.assistant:
     * controls.<player>.state, satellite-display: media.state).
     *
     * @param {Target} t - Player
     * @returns {Promise<string>} State id, '' = none
     */
    async playerStateOf(t) {
        const id = t.urlState.replace(/\.[^.]+$/, '.state');
        if (id === t.urlState) {
            return '';
        }
        const obj = await this.getForeignObjectAsync(id).catch(() => null);
        return obj?.type === 'state' && obj.common?.role === 'media.state' ? id : '';
    }

    /**
     * @param {string} id - State id
     * @param {ioBroker.State | null | undefined} state - State
     */
    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        const byState = this.byPlayerState.get(id);
        if (byState) {
            // stopped on the player itself (its button, its own UI): the URL stays, only the playback state says it
            const playback = playbackOf(state.val);
            if (byState.playing && playback === 'playing') {
                byState.seenPlaying = true;
            } else if (byState.playing && byState.seenPlaying && playback === 'stopped') {
                this.log.info(`${byState.t.name}: stopped on the player`);
                await this.stopTarget(byState, false);
            }
            return;
        }
        const byVolume = this.byVolumeState.get(id);
        if (byVolume) {
            // the volume changed on the player or by hand: the fade-in of the wake-up radio ends
            if (byVolume.ramp.active && !ownVolume(byVolume.wroteVolume, state.val, byVolume.volumeCommon)) {
                this.log.info(`${byVolume.t.name}: volume changed by hand, the fade-in ends`);
                byVolume.ramp.cancel();
            }
            return;
        }
        const foreign = this.byUrlState.get(id);
        if (foreign) {
            // the player was given another URL (by its own UI, another adapter) or stopped: this station is over
            if (foreign.playing && state.val !== foreign.url) {
                this.log.debug(`${foreign.t.name}: the player plays something else now`);
                await this.stopTarget(foreign, false);
            }
            return;
        }
        if (!state.ack && id === `${this.namespace}.info.checkStations` && state.val) {
            void this.checkStations();
            return;
        }
        if (state.ack || !id.startsWith(`${this.namespace}.targets.`)) {
            return;
        }
        const [, targetId, key] = id.slice(this.namespace.length + 1).split('.');
        const r = this.running.get(targetId);
        if (!r) {
            return;
        }
        if (key === 'station') {
            const value = String(state.val ?? '').trim();
            if (!value) {
                await this.stopTarget(r);
                return;
            }
            const hits = findByName(this.stations, value);
            if (hits.length === 1) {
                await this.playLogged(r, hits[0]);
            } else {
                this.log.warn(`${r.t.name}: no single favourite station matches "${value}"`);
            }
        } else if (key === 'play' && state.val) {
            const selected = String((await this.getStateAsync(`targets.${targetId}.station`))?.val || '');
            const station = this.stations.find(s => s.id === selected) || (await this.lastStationOf(r));
            if (station) {
                await this.playLogged(r, station);
            } else {
                this.log.warn(`${r.t.name}: no station to play: add favourites in the settings`);
            }
        } else if (key === 'resume' && state.val) {
            const station = r.playing ? null : await this.lastStationOf(r);
            if (station) {
                await this.playLogged(r, station);
            } else if (!r.playing) {
                this.log.warn(`${r.t.name}: no station to play: add favourites in the settings`);
            }
        } else if ((key === 'next' || key === 'prev') && state.val) {
            const station = await this.stepStationOf(r, key === 'next' ? 1 : -1);
            if (station) {
                await this.playLogged(r, station);
            } else {
                this.log.warn(`${r.t.name}: no favourites to step through`);
            }
        } else if (key === 'sleep') {
            const error = await this.startSleep(r, Number(state.val) || 0);
            if (error) {
                this.log.warn(`${r.t.name}: sleep timer not started: ${error}`);
            }
        } else if (key === 'stop' && state.val) {
            await this.stopTarget(r);
        } else if (key === 'alarmTime' || key === 'alarmDays' || key === 'alarmStation') {
            const error = await this.setAlarmState(r, key, state.val);
            if (error) {
                this.log.warn(`${r.t.name}: ${error}`);
            }
        } else if (key === 'volume') {
            r.ramp.cancel();
            const v = Math.max(0, Math.min(100, Number(state.val) || 0));
            await this.setVolume(r, v);
            await this.setState(id, { val: v, ack: true });
        }
    }

    /**
     * @param {Running} r - Target
     * @param {Station} station - Station
     */
    async playLogged(r, station) {
        const error = await this.playStation(r, station);
        if (error) {
            this.log.warn(`${r.t.name}: ${error}`);
        }
    }

    /**
     * @returns {Promise<Record<string, ioBroker.Object>>} The rooms (enum.rooms)
     */
    async rooms() {
        try {
            return (await this.getForeignObjectsAsync('enum.rooms.*', 'enum')) || {};
        } catch {
            return {};
        }
    }

    /**
     * The players of a play command: several with targets: [...] or with room and all: true (multiroom), else one.
     *
     * @param {Record<string, unknown>} msg - `{target?, room?, targets?, all?}`
     * @returns {Promise<{targets: Running[]} | {error: string, ask?: string, choices?: string[]}>} Players
     */
    async playTargets(msg) {
        if (Array.isArray(msg.targets) && msg.targets.length) {
            /** @type {Running[]} */
            const out = [];
            for (const target of msg.targets) {
                const sel = await this.resolveTargets({ target }, false);
                if ('error' in sel) {
                    return sel;
                }
                if (!out.includes(sel.targets[0])) {
                    out.push(sel.targets[0]);
                }
            }
            return { targets: out };
        }
        return this.resolveTargets(msg, msg.all === true && !!msg.room);
    }

    /**
     * The targets a message means.
     *
     * @param {{target?: unknown, room?: unknown}} msg - Message
     * @param {boolean} all - Without target and room: every target (else: ask)
     * @returns {Promise<{targets: Running[]} | {error: string, ask?: string, choices?: string[]}>} Targets
     */
    async resolveTargets(msg, all) {
        const list = [...this.running.values()];
        const items = list.map(r => ({ id: r.t.id, name: r.t.name, r }));
        const want = String(msg.target ?? '').trim();
        const room = String(msg.room ?? '').trim();
        if (!want && !room) {
            if (all) {
                return { targets: list };
            }
            return {
                error: 'no player given',
                ask: 'On which player should it play?',
                choices: list.map(r => r.t.name),
            };
        }
        if (want) {
            const hits = findByName(items, want);
            if (hits.length === 1) {
                return { targets: [hits[0].r] };
            }
            if (hits.length > 1) {
                return {
                    error: `"${want}" matches several players`,
                    ask: `Which one: ${hits.map(h => h.name).join(', ')}?`,
                    choices: hits.map(h => h.name),
                };
            }
            if (!room) {
                return { error: `no player "${want}"`, choices: list.map(r => r.t.name) };
            }
        }
        const rooms = await this.rooms();
        const inRoom = findByName(items, room, item =>
            roomsOf(item.r.t, rooms).flatMap(x => [...x.names, x.id.split('.').pop() || '']),
        );
        if (inRoom.length === 1 || (all && inRoom.length)) {
            return { targets: inRoom.map(h => h.r) };
        }
        if (inRoom.length > 1) {
            return {
                error: `several players in "${room}"`,
                ask: `On which player in ${room}: ${inRoom.map(h => h.name).join(', ')}?`,
                choices: inRoom.map(h => h.name),
            };
        }
        return { error: `no player in "${room}"`, choices: list.map(r => r.t.name) };
    }

    /**
     * The station a message means: a favourite, a catalog uuid, a URL, or the best catalog match for a name.
     *
     * @param {unknown} value - Station from the message
     * @returns {Promise<{station: Station, source: 'favourite' | 'catalog' | 'url'} | {error: string, ask?: string, choices?: string[]}>}
     *   Station and where it came from
     */
    async resolveStation(value) {
        const q = String(value ?? '').trim();
        if (!q) {
            return { error: 'no station given', choices: this.stations.map(s => s.name) };
        }
        if (isStreamUrl(q)) {
            return { station: { id: '', name: q, url: q, logo: '', tags: [], uuid: '' }, source: 'url' };
        }
        const fav = findByName(this.stations, q, s => s.tags);
        const exact = fav.filter(s => s.id === q || s.name.toLowerCase() === q.toLowerCase());
        if (exact.length === 1 || fav.length === 1) {
            return { station: exact[0] || fav[0], source: 'favourite' };
        }
        if (fav.length > 1) {
            return {
                error: `"${q}" matches several favourites`,
                ask: `Which station: ${fav.map(s => s.name).join(', ')}?`,
                choices: fav.map(s => s.name),
            };
        }
        const fromCatalog = /^[0-9a-f-]{36}$/i.test(q)
            ? await this.catalog.byUuid(q)
            : (await this.catalog.search({ query: q, limit: 1 }))[0];
        if (!fromCatalog) {
            return { error: `no station "${q}" in the favourites or in radio-browser.info` };
        }
        return {
            station: {
                id: '',
                name: fromCatalog.name,
                url: fromCatalog.url,
                logo: fromCatalog.favicon,
                tags: fromCatalog.tags,
                uuid: fromCatalog.uuid,
            },
            source: 'catalog',
        };
    }

    /**
     * @param {Running} r - Target
     * @param {Record<string, ioBroker.Object>} rooms - Rooms
     * @returns {Record<string, unknown>} What a message answer says about a target
     */
    describe(r, rooms) {
        return {
            id: r.t.id,
            name: r.t.name,
            rooms: [...new Set(roomsOf(r.t, rooms).map(x => x.names[0]))],
            kind: r.t.kind,
            playing: r.playing,
            station: r.playing ? r.station?.name || '' : '',
            title: r.playing ? r.title : '',
        };
    }

    /**
     * @param {ioBroker.Message} obj - Message
     */
    async onMessage(obj) {
        if (!obj?.command || obj.command.startsWith('dm:')) {
            return; // dm:* is answered by lib/device-management.js
        }
        const answer = result => obj.callback && this.sendTo(obj.from, obj.command, result, obj.callback);
        const msg = /** @type {Record<string, unknown>} */ (
            obj.message && typeof obj.message === 'object' ? obj.message : {}
        );
        try {
            await this.ready;
            if (obj.command === 'help') {
                answer(helpAnswer());
            } else if (obj.command === 'list_stations') {
                answer({
                    stations: this.stations.map(s => ({
                        id: s.id,
                        name: s.name,
                        tags: s.tags,
                        url: s.url,
                        logo: this.coverOf(s),
                    })),
                });
            } else if (obj.command === 'search_stations') {
                const found = await this.catalog.search(msg);
                const query = sentQuery(searchParams(msg));
                const filtered = 'countrycode' in query || 'country' in query || 'tag' in query;
                answer({
                    query,
                    ...(!found.length && filtered
                        ? {
                              hint: 'Nothing with these filters. Try again without country/tag, or with another spelling of the name (Latin or the original script).',
                          }
                        : {}),
                    stations: found.map(s => ({
                        uuid: s.uuid,
                        name: s.name,
                        url: s.url,
                        country: s.country,
                        tags: s.tags,
                        codec: s.codec,
                        bitrate: s.bitrate,
                    })),
                });
            } else if (obj.command === 'list_targets' || obj.command === 'now_playing') {
                const rooms = await this.rooms();
                const sel =
                    obj.command === 'now_playing' && (msg.target || msg.room)
                        ? await this.resolveTargets(msg, true)
                        : { targets: [...this.running.values()] };
                if ('error' in sel) {
                    answer(sel);
                } else {
                    answer({ targets: sel.targets.map(r => this.describe(r, rooms)) });
                }
            } else if (obj.command === 'alarm') {
                const sel = await this.resolveTargets(msg, false);
                if ('error' in sel) {
                    answer(sel);
                    return;
                }
                const r = sel.targets[0];
                for (const [field, key] of [
                    ['time', 'alarmTime'],
                    ['days', 'alarmDays'],
                    ['station', 'alarmStation'],
                ]) {
                    if (msg[field] !== undefined) {
                        const error = await this.setAlarmState(r, key, msg[field]);
                        if (error) {
                            answer({ error });
                            return;
                        }
                    }
                }
                const base = `targets.${r.t.id}`;
                const read = async key => (await this.getStateAsync(`${base}.${key}`))?.val;
                answer({
                    ok: true,
                    target: r.t.name,
                    alarm: {
                        time: (await read('alarmTime')) || '',
                        days: (await read('alarmDays')) || '',
                        station: (await read('alarmStation')) || '',
                        ...this.alarmLevels(),
                        next: (await read('alarmNext')) || '',
                    },
                });
            } else if (obj.command === 'check_stations') {
                answer({ stations: await this.checkStations() });
            } else if (obj.command === 'history') {
                const sel =
                    msg.target || msg.room
                        ? await this.resolveTargets(msg, true)
                        : { targets: [...this.running.values()] };
                if ('error' in sel) {
                    answer(sel);
                    return;
                }
                const limit = Math.max(1, Math.min(50, Math.round(Number(msg.limit) || 10)));
                const out = [];
                for (const r of sel.targets) {
                    const list = readHistory((await this.getStateAsync(`targets.${r.t.id}.history`))?.val);
                    out.push({
                        id: r.t.id,
                        name: r.t.name,
                        history: list.slice(0, limit).map(e => ({
                            time: new Date(e.ts).toISOString(),
                            station: e.station,
                            title: e.title,
                        })),
                    });
                }
                answer({ targets: out });
            } else if (obj.command === 'play') {
                const sel = await this.playTargets(msg);
                if ('error' in sel) {
                    answer(sel);
                    return;
                }
                const st = await this.resolveStation(msg.station);
                if ('error' in st) {
                    answer(st);
                    return;
                }
                if (sel.targets.length === 1) {
                    const r = sel.targets[0];
                    const error = await this.playStation(r, st.station);
                    answer(error ? { error } : { ...this.playedAnswer(r, st.station), source: st.source });
                    return;
                }
                // multiroom: players with the same format share one stream of the adapter
                const played = [];
                const errors = [];
                for (const r of sel.targets) {
                    const error = await this.playStation(r, st.station);
                    if (error) {
                        errors.push({ target: r.t.name, error });
                    } else {
                        played.push(r.t.name);
                    }
                }
                answer(
                    played.length
                        ? {
                              ...this.playedAnswer(sel.targets[0], st.station),
                              target: played.join(', '),
                              targets: played,
                              source: st.source,
                              ...(errors.length ? { errors } : {}),
                          }
                        : { error: errors.map(e => `${e.target}: ${e.error}`).join('; ') },
                );
            } else if (obj.command === 'resume' || obj.command === 'next' || obj.command === 'prev') {
                const sel = await this.resolveTargets(msg, false);
                if ('error' in sel) {
                    answer(sel);
                    return;
                }
                const r = sel.targets[0];
                if (obj.command === 'resume' && r.playing && r.station) {
                    answer({ ...this.playedAnswer(r, r.station), already: true });
                    return;
                }
                const station =
                    obj.command === 'resume'
                        ? await this.lastStationOf(r)
                        : await this.stepStationOf(r, obj.command === 'next' ? 1 : -1);
                if (!station) {
                    answer({ error: 'no favourite stations are configured' });
                    return;
                }
                const error = await this.playStation(r, station);
                answer(error ? { error } : this.playedAnswer(r, station));
            } else if (obj.command === 'sleep') {
                const sel = await this.resolveTargets(msg, false);
                if ('error' in sel) {
                    answer(sel);
                    return;
                }
                const r = sel.targets[0];
                const minutes = Number(msg.minutes);
                if (!Number.isFinite(minutes) || minutes < 0) {
                    answer({ error: 'minutes must be a number ≥ 0 (0 = off)' });
                    return;
                }
                const error = await this.startSleep(r, minutes);
                answer(
                    error
                        ? { error }
                        : r.sleep.active
                          ? {
                                ok: true,
                                target: r.t.name,
                                minutes: Math.min(720, minutes),
                                endsAt: new Date(r.sleep.endsAt).toISOString(),
                            }
                          : { ok: true, target: r.t.name, minutes: 0 },
                );
            } else if (obj.command === 'stop') {
                const sel = await this.resolveTargets(msg, true);
                if ('error' in sel) {
                    answer(sel);
                    return;
                }
                const stopped = [];
                for (const r of sel.targets) {
                    if (r.playing) {
                        stopped.push(r.t.id);
                    }
                    await this.stopTarget(r);
                }
                answer({ ok: true, stopped });
            } else if (obj.command === 'export_stations') {
                const format = msg.format === 'json' ? 'json' : 'm3u';
                answer({ format, text: exportStations(this.config.stations || [], format) });
            } else if (obj.command === 'import_stations') {
                const res = importStations(String(msg.text ?? ''), this.config.stations || []);
                answer({
                    ok: true,
                    format: res.format,
                    added: res.added,
                    skipped: res.skipped,
                    restart: res.added > 0,
                });
                if (res.added) {
                    this.log.info(`Import: ${res.added} station(s) added (${res.format}), the adapter restarts`);
                    // the settings change, js-controller restarts the instance with the new favourites
                    await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                        native: { stations: res.rows },
                    });
                }
            } else if (obj.command === 'adminExport') {
                // admin only: the favourites of the form as text in the transfer field
                const rows = Array.isArray(msg.stations) ? msg.stations : this.config.stations || [];
                const format = msg.format === 'json' ? 'json' : 'm3u';
                answer({ native: { _transfer: exportStations(rows, format) } });
            } else if (obj.command === 'adminImport') {
                // admin only: adds the stations of the transfer field to the table of the form
                const rows = Array.isArray(msg.stations) ? msg.stations : this.config.stations || [];
                const res = importStations(String(msg.text ?? ''), rows);
                answer(
                    res.added
                        ? { native: { stations: res.rows } }
                        : {
                              error: res.skipped
                                  ? 'All stations are in the list already'
                                  : 'No stations found in the text',
                          },
                );
            } else if (obj.command === 'adminSearch') {
                // admin only: the choice list of the search in the settings
                answer(await this.adminSearch(msg));
            } else if (obj.command === 'adminAddStation') {
                // admin only: adds the chosen search result to the station table of the form
                answer(await this.adminAddStation(msg));
            } else if (obj.command === 'listUrlStates') {
                // admin only: every writable state with role media.url
                answer(urlStateChoices(await this.getForeignObjectsAsync('*', 'state'), this.namespace));
            } else {
                answer({ error: `Unknown command ${obj.command}` });
            }
        } catch (e) {
            answer({ error: e.message });
        }
    }

    /**
     * @param {Record<string, unknown>} msg - `{query, country}`
     * @returns {Promise<Array<{label: string, value: string}>>} Choices of the search field in the admin
     */
    async adminSearch(msg) {
        const query = String(msg.query ?? '').trim();
        const country = String(msg.country ?? '').trim();
        // a name, or only a country: then the most played stations of that country
        if (query.length < 2 && country.length < 2) {
            return [];
        }
        const found = await this.catalog.search({ query, country, limit: query ? 30 : 50 });
        return found.map(s => ({
            label: [s.name, s.countrycode, [s.codec, s.bitrate ? `${s.bitrate}k` : ''].filter(Boolean).join(' ')]
                .filter(Boolean)
                .join(' · '),
            value: s.uuid,
        }));
    }

    /**
     * @param {Record<string, unknown>} msg - `{uuid, stations}`: the chosen result and the table as it is in the form
     * @returns {Promise<Record<string, unknown>>} `{native: {stations}}` for the form, or `{error}`
     */
    async adminAddStation(msg) {
        const s = await this.catalog.byUuid(String(msg.uuid ?? ''));
        if (!s) {
            return { error: 'Choose a station from the search first' };
        }
        const rows = Array.isArray(msg.stations) ? msg.stations : this.config.stations || [];
        if (rows.some(r => r && (r.uuid === s.uuid || String(r.url).trim() === s.url))) {
            return { native: { stations: rows } };
        }
        const row = { enabled: true, name: s.name, url: s.url, logo: s.favicon, tags: s.tags.join(', '), uuid: s.uuid };
        return { native: { stations: [...rows, row] } };
    }

    /**
     * @param {() => void} callback - Done
     */
    async onUnload(callback) {
        try {
            const http = this.http;
            this.http = null;
            for (const r of this.running.values()) {
                r.sleep.cancel();
                r.ramp.cancel();
                this.stopReaders(r);
                // a proxied stream ends with the adapter: stop that player; a player with a direct URL keeps playing
                if (r.channel) {
                    await this.stopTarget(r, true);
                }
            }
            await http?.close();
            await this.setState('info.connection', { val: false, ack: true });
        } catch (e) {
            this.log.error(`Unload: ${e.message}`);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new Webradio(options);
} else {
    new Webradio();
}
