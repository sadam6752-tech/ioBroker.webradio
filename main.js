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
const { Channel, StreamServer, SourceReader } = require('./lib/proxy');
const { downloadLogo, MIME } = require('./lib/logos');
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
 */

/** Port of the stream server, next to airplay-receiver (8095) */
const DEFAULT_PORT = 8096;

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
        /** @type {() => void} */
        this.markReady = () => undefined;
        this.ready = new Promise(resolve => (this.markReady = () => resolve(undefined)));
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
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
        const ffmpegPath = String(this.config.ffmpegPath || '').trim() || String(require('ffmpeg-static') || '');

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
        }
        await this.subscribeStatesAsync('targets.*');
        for (const id of this.byUrlState.keys()) {
            await this.subscribeForeignStatesAsync(id);
        }
        this.log.info(
            `${this.stations.length} station(s), player(s): ${
                tg.targets.map(t => `${t.name}${t.discovered ? ' (found)' : ''}`).join(', ') || 'none'
            }; stream server on port ${this.httpPort}`,
        );
        await this.setState('info.connection', { val: true, ack: true });
        void this.cacheLogos(this.stations);
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
            await this.extendObject(`stations.${s.id}`, {
                type: 'channel',
                common: { name: s.name },
                native: { uuid: s.uuid },
            });
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
            // nothing plays after a start; the selected station and the volume stay
            for (const key of ['playing', 'title', 'cover', 'streamUrl']) {
                const def = states.find(s => s[0] === key)?.[4];
                await this.setState(`targets.${t.id}.${key}`, { val: def ?? '', ack: true });
            }
        }
        await this.removeStale('stations', new Set(stations.map(s => `${this.namespace}.stations.${s.id}`)));
        await this.removeStale('targets', new Set(targets.map(t => `${this.namespace}.targets.${t.id}`)));
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
                    const img = await downloadLogo(s.logo, this.userAgent);
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
        this.stopReaders(r);
        r.station = station;
        r.title = '';
        let url;
        if (r.channel) {
            r.channel.setSource(station.url);
            // a new URL every time: a player that gets the same URL again may keep playing the old stream
            url = `http://${streamHost(this.config.urlHost)}:${this.httpPort}${r.channel.path}?s=${station.id || 'url'}&n=${++this.counter}`;
        } else {
            url = station.url;
        }
        r.url = url;
        r.playing = true;
        const base = `targets.${r.t.id}`;
        await this.setState(`${base}.station`, { val: station.id, ack: true });
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
        await this.writeTarget(r.t.volumeState, scaleVolume(percent / 100, r.volumeCommon));
    }

    /**
     * @param {string} id - State id
     * @param {ioBroker.State | null | undefined} state - State
     */
    async onStateChange(id, state) {
        if (!state) {
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
            const station = this.stations.find(s => s.id === selected) || r.station;
            if (station) {
                await this.playLogged(r, station);
            } else {
                this.log.warn(`${r.t.name}: choose a station first (targets.${targetId}.station)`);
            }
        } else if (key === 'stop' && state.val) {
            await this.stopTarget(r);
        } else if (key === 'volume') {
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
        if (!obj?.command) {
            return;
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
            } else if (obj.command === 'play') {
                const sel = await this.resolveTargets(msg, false);
                if ('error' in sel) {
                    answer(sel);
                    return;
                }
                const st = await this.resolveStation(msg.station);
                if ('error' in st) {
                    answer(st);
                    return;
                }
                const r = sel.targets[0];
                const error = await this.playStation(r, st.station);
                answer(
                    error
                        ? { error }
                        : {
                              ok: true,
                              target: r.t.name,
                              station: st.station.name,
                              stationId: st.station.id,
                              source: st.source,
                              ...(st.source === 'catalog' ? { uuid: st.station.uuid } : {}),
                          },
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
        if (query.length < 2) {
            return [];
        }
        const found = await this.catalog.search({ query, country: msg.country, limit: 30 });
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
