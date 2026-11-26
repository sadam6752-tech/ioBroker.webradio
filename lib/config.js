'use strict';

const os = require('node:os');

/**
 * @typedef {import('./types').Station} Station
 * @typedef {import('./types').Target} Target
 * @typedef {import('./types').TargetKind} TargetKind
 */

/** What the `media_title` text entity of the Waveshare firmware takes. */
const TITLE_MAX_BYTES = 48;

/**
 * Object id part of a name: letters with diacritics transliterated, everything else `_`.
 *
 * @param {string} name - Name
 * @param {string} [fallback] - Id when nothing is left
 * @returns {string} Id
 */
function toId(name, fallback = 'item') {
    const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue' };
    const ascii = String(name ?? '')
        .replace(/[äöüßÄÖÜ]/g, c => map[c])
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '');
    return (
        ascii
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '') || fallback
    );
}

/**
 * An id that is not in `used` yet: `id`, `id_2`, `id_3` …
 *
 * @param {string} id - Wanted id
 * @param {Set<string>} used - Ids taken so far (the new one is added)
 * @returns {string} Free id
 */
function uniqueId(id, used) {
    let out = id;
    for (let n = 2; used.has(out); n++) {
        out = `${id}_${n}`;
    }
    used.add(out);
    return out;
}

/**
 * @param {unknown} url - Stream URL
 * @returns {boolean} An http(s) URL
 */
function isStreamUrl(url) {
    return /^https?:\/\/[^\s/]+/i.test(String(url || '').trim());
}

/**
 * Splits a tag text ("rock, 80s;pop") into tags.
 *
 * @param {unknown} value - Tags as text or list
 * @returns {string[]} Tags
 */
function splitTags(value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;]/);
    return [...new Set(list.map(t => String(t).trim()).filter(Boolean))];
}

/**
 * Reads the station table of the settings. Rows without a name or a usable URL are skipped with a reason.
 *
 * @param {unknown} rows - `native.stations`
 * @returns {{stations: Station[], problems: string[]}} Stations and skipped rows
 */
function normalizeStations(rows) {
    const list = asRows(rows);
    /** @type {Station[]} */
    const stations = [];
    const problems = [];
    const used = new Set();
    list.forEach((row, i) => {
        if (!row || row.enabled === false) {
            return;
        }
        const name = String(row.name || '').trim();
        const url = String(row.url || '').trim();
        if (!name) {
            problems.push(`Station row ${i + 1}: the name is missing`);
            return;
        }
        if (!isStreamUrl(url)) {
            problems.push(`Station row ${i + 1} (${name}): the stream URL must start with http:// or https://`);
            return;
        }
        const logo = String(row.logo || '').trim();
        stations.push({
            id: uniqueId(toId(name, 'station'), used),
            name,
            url,
            logo: isStreamUrl(logo) ? logo : '',
            tags: splitTags(row.tags),
            uuid: String(row.uuid || '').trim(),
        });
    });
    return { stations, problems };
}

/**
 * @param {unknown} rows - A table of the settings (array, or an object of rows)
 * @returns {Array<Record<string, unknown>>} Rows
 */
function asRows(rows) {
    return Array.isArray(rows) ? rows : rows && typeof rows === 'object' ? Object.values(rows) : [];
}

/**
 * Reads a stop value as typed: `true`/`false` and numbers keep their type, everything else is text.
 *
 * @param {unknown} value - Setting
 * @returns {ioBroker.StateValue} Value to write
 */
function parseStopValue(value) {
    if (typeof value === 'boolean' || typeof value === 'number') {
        return value;
    }
    const t = String(value ?? '').trim();
    if (t === 'true' || t === 'false') {
        return t === 'true';
    }
    if (t !== '' && Number.isFinite(Number(t))) {
        return Number(t);
    }
    return t;
}

const STREAM_MODES = ['auto', 'direct', 'flac', 'mp3'];

/**
 * @typedef {object} Preset
 * @property {TargetKind} kind - Kind of target
 * @property {string} stopState - Stop state
 * @property {ioBroker.StateValue} stopValue - Stop value
 * @property {string} volumeState - Volume state, empty = none
 * @property {string} titleState - Title state, empty = none
 * @property {number} titleBytes - Byte limit of the title, 0 = none
 * @property {string} device - Device object of the player (for the name and the address), empty = none
 */

/**
 * What a play URL state belongs to, and the states that go with it (the same presets as ioBroker.airplay-receiver).
 *
 * @param {string} urlState - Id of the play URL state
 * @returns {Preset} Preset
 */
function presetFor(urlState) {
    const sat = /^((assistant\.\d+\.satellites\.[^.]+)\.controls\.([^.]+))\.url$/.exec(urlState);
    if (sat) {
        // ioBroker.assistant satellite (ESPHome): FLAC 48 kHz mono through the proxy, "stop" stops, volume 0 … 1
        return {
            kind: 'assistant',
            stopState: urlState,
            stopValue: 'stop',
            volumeState: `${sat[1]}.volume`,
            titleState: `${sat[2]}.controls.media_title`,
            titleBytes: TITLE_MAX_BYTES,
            device: sat[2],
        };
    }
    const panel = /^(satellite-display\.\d+\.satellites\.[^.]+)\.media\.url$/.exec(urlState);
    if (panel) {
        // ioBroker.satellite-display panel (ESPHome): a stop button, volume 0 … 100 %, the now-playing bar
        return {
            kind: 'satellite-display',
            stopState: `${panel[1]}.media.stop`,
            stopValue: true,
            volumeState: `${panel[1]}.media.volume`,
            titleState: `${panel[1]}.media.title`,
            titleBytes: TITLE_MAX_BYTES,
            device: panel[1],
        };
    }
    const dune = /^(dune-hd-remote\.\d+)\.media\.playUrl$/.exec(urlState);
    if (dune) {
        // ioBroker.dune-hd-remote: plays every radio stream itself
        return {
            kind: 'dune',
            stopState: `${dune[1]}.control.stop`,
            stopValue: true,
            volumeState: `${dune[1]}.control.volume`,
            titleState: '',
            titleBytes: 0,
            device: '',
        };
    }
    // any other player: an empty URL stops
    return {
        kind: 'custom',
        stopState: urlState,
        stopValue: '',
        volumeState: '',
        titleState: '',
        titleBytes: 0,
        device: '',
    };
}

/**
 * A state id the user typed: empty = take the preset, `-` = none.
 *
 * @param {unknown} value - Setting
 * @param {string} preset - Value of the preset
 * @returns {string} State id or empty
 */
function stateOrPreset(value, preset) {
    const t = String(value ?? '').trim();
    if (t === '-') {
        return '';
    }
    return t || preset;
}

/**
 * @param {string} id - State id
 * @returns {boolean} A plausible id of a foreign state
 */
function validStateId(id) {
    return /^[^\s*?"'`]+\.[^\s*?"'`]+$/.test(id);
}

/**
 * A target from a row (settings) or from the discovery.
 *
 * @param {Record<string, unknown>} row - `{name, urlState, stopState?, stopValue?, volumeState?, titleState?, stream?}`
 * @param {string} id - Object id part
 * @param {boolean} discovered - Found automatically
 * @returns {Target} Target
 */
function targetFrom(row, id, discovered) {
    const urlState = String(row.urlState).trim();
    const preset = presetFor(urlState);
    const stopState = stateOrPreset(row.stopState, preset.stopState) || urlState;
    const typedStop = String(row.stopValue ?? '').trim();
    // a stop state of its own without a value is a button
    const stopValue =
        typedStop !== '' ? parseStopValue(typedStop) : stopState === preset.stopState ? preset.stopValue : true;
    const titleState = stateOrPreset(row.titleState, preset.titleState);
    const stream = STREAM_MODES.includes(String(row.stream)) ? String(row.stream) : 'auto';
    return {
        id,
        name: String(row.name).trim(),
        kind: preset.kind,
        urlState,
        stopState,
        stopValue,
        volumeState: stateOrPreset(row.volumeState, preset.volumeState),
        titleState,
        titleBytes: titleState === preset.titleState ? preset.titleBytes : 0,
        stream: /** @type {Target['stream']} */ (stream),
        device: preset.device,
        discovered,
        aliases: Array.isArray(row.aliases) ? row.aliases.map(String).filter(a => a && a !== urlState) : [],
    };
}

/**
 * The players found in the object tree: ioBroker.assistant satellites with a media player and ioBroker.satellite-display
 * panels. A satellite that is also a panel (same address) is taken once, as the panel: it shows the title and has a
 * stop button.
 *
 * @param {Record<string, ioBroker.Object>} objects - State objects with role media.url and the device objects above
 * @returns {Array<{name: string, urlState: string}>} Rows, sorted
 */
function discoverTargets(objects) {
    /** @type {Array<{name: string, urlState: string, host: string, kind: TargetKind}>} */
    const found = [];
    const seenDevice = new Set();
    for (const [id, obj] of Object.entries(objects || {})) {
        if (obj?.type !== 'state') {
            continue;
        }
        const preset = presetFor(id);
        if (preset.kind !== 'assistant' && preset.kind !== 'satellite-display') {
            continue;
        }
        // one player per satellite (a satellite may have more than one media player: take the first)
        if (seenDevice.has(preset.device)) {
            continue;
        }
        seenDevice.add(preset.device);
        const device = objects[preset.device];
        const native = /** @type {Record<string, unknown>} */ (device?.native || {});
        found.push({
            name: nameOf(device?.common?.name) || preset.device.split('.').pop() || id,
            urlState: id,
            host: String(native.esphome || native.host || ''),
            kind: preset.kind,
        });
    }
    const panelHosts = new Set(found.filter(f => f.kind === 'satellite-display' && f.host).map(f => f.host));
    // the other players of the same device: something may be played through them (an agent, a script)
    const aliasesOf = f => (f.host ? found.filter(o => o !== f && o.host === f.host).map(o => o.urlState) : []);
    return found
        .filter(f => !(f.kind === 'assistant' && f.host && panelHosts.has(f.host)))
        .sort((a, b) => a.urlState.localeCompare(b.urlState))
        .map(f => ({ name: f.name, urlState: f.urlState, aliases: aliasesOf(f) }));
}

/**
 * @param {unknown} name - common.name (text or translations)
 * @param {string} [lang] - Preferred language
 * @returns {string} Text
 */
function nameOf(name, lang = 'en') {
    if (name && typeof name === 'object') {
        const t = /** @type {Record<string, string>} */ (name);
        return String(t[lang] || t.en || Object.values(t)[0] || '');
    }
    return String(name ?? '');
}

/**
 * All targets: the rows of the settings, then the discovered players whose play URL state no row names.
 *
 * @param {unknown} rows - `native.targets`
 * @param {Array<{name: string, urlState: string, aliases?: string[]}>} discovered - From `discoverTargets`
 * @returns {{targets: Target[], problems: string[]}} Targets and skipped rows
 */
function buildTargets(rows, discovered = []) {
    /** @type {Target[]} */
    const targets = [];
    const problems = [];
    const used = new Set();
    const urls = new Set();
    asRows(rows).forEach((row, i) => {
        if (!row) {
            return;
        }
        const urlState = String(row.urlState || '').trim();
        // a switched-off row also hides the discovered player with that state
        if (validStateId(urlState)) {
            urls.add(urlState);
        }
        if (row.enabled === false) {
            return;
        }
        const name = String(row.name || '').trim();
        if (!name) {
            problems.push(`Player row ${i + 1}: the name is missing`);
            return;
        }
        if (!validStateId(urlState)) {
            problems.push(`Player row ${i + 1} (${name}): choose the state that plays a URL`);
            return;
        }
        const aliases = discovered.find(d => d.urlState === urlState)?.aliases || [];
        targets.push(targetFrom({ ...row, name, urlState, aliases }, uniqueId(toId(name, 'player'), used), false));
    });
    for (const d of discovered) {
        if (!urls.has(d.urlState)) {
            urls.add(d.urlState);
            targets.push(targetFrom(d, uniqueId(toId(d.name, 'player'), used), true));
        }
    }
    return { targets, problems };
}

/**
 * How a station is sent to a target.
 *
 * @param {Target} target - Target
 * @returns {{direct: true} | {direct: false, codec: 'flac' | 'mp3', sampleRate: number, channels: number}} Way
 */
function streamFor(target) {
    if (target.stream === 'direct') {
        return { direct: true };
    }
    if (target.stream === 'mp3') {
        return { direct: false, codec: 'mp3', sampleRate: 44100, channels: 2 };
    }
    if (target.stream === 'flac') {
        return { direct: false, codec: 'flac', sampleRate: 48000, channels: 2 };
    }
    // auto: ESPHome players take only plain MP3/FLAC over http and run at 48 kHz — FLAC 48 kHz mono as in
    // ioBroker.airplay-receiver; Dune HD and others play the station's own stream
    if (target.kind === 'assistant' || target.kind === 'satellite-display') {
        return { direct: false, codec: 'flac', sampleRate: 48000, channels: 1 };
    }
    return { direct: true };
}

/**
 * Text that compares names: lower case, letters and digits of any script only.
 *
 * @param {unknown} text - Text
 * @returns {string} Key
 */
function matchKey(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Finds items by a name the user said: exact id or name first, then names that start with it, then names that contain
 * it (or are contained in it: "radio record trance" finds "Record Trance").
 *
 * @template {{id: string, name: string}} T
 * @param {T[]} items - Items
 * @param {unknown} query - Name, id
 * @param {(item: T) => string[]} [aliases] - More names of an item (e.g. rooms)
 * @returns {T[]} Best matches (several = ambiguous, none = not found)
 */
function findByName(items, query, aliases = () => []) {
    const q = matchKey(query);
    if (!q) {
        return [];
    }
    const keysOf = item => [item.id, item.name, ...aliases(item)].map(matchKey).filter(Boolean);
    const stages = [
        keys => keys.includes(q),
        keys => keys.some(k => k.startsWith(q)),
        keys => keys.some(k => k.includes(q) || (k.length >= 3 && q.includes(k))),
    ];
    for (const test of stages) {
        const hits = items.filter(item => test(keysOf(item)));
        if (hits.length) {
            return hits;
        }
    }
    return [];
}

/**
 * The rooms (enum.rooms) a target belongs to: a member that is its play URL state, its device or a parent of them.
 *
 * @param {Target} target - Target
 * @param {Record<string, ioBroker.Object>} rooms - `enum.rooms.*` objects
 * @returns {Array<{id: string, names: string[]}>} Rooms with their names in every language
 */
function roomsOf(target, rooms) {
    const out = [];
    for (const [id, obj] of Object.entries(rooms || {})) {
        const members = /** @type {string[]} */ (obj?.common?.members || []);
        const hit = members.some(m => target.urlState === m || target.urlState.startsWith(`${m}.`));
        if (hit) {
            const name = obj.common?.name;
            const names = name && typeof name === 'object' ? Object.values(name).map(String) : [String(name ?? '')];
            out.push({ id, names: [...names, id.split('.').pop() || ''].filter(Boolean) });
        }
    }
    return out;
}

/**
 * The value a volume state takes for a level 0 … 1: its `min` … `max` (0 … 1 without a max; whole numbers for a
 * larger range such as 0 … 100 %).
 *
 * @param {number} level - 0 … 1
 * @param {{min?: unknown, max?: unknown}} [common] - common of the volume state
 * @returns {number} Value
 */
function scaleVolume(level, common = {}) {
    const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d);
    const min = num(common.min, 0);
    const max = num(common.max, 1);
    const v = min + Math.max(0, Math.min(1, level)) * (max - min);
    return max - min > 1 ? Math.round(v) : Math.round(v * 100) / 100;
}

/**
 * Text cut to a byte limit (UTF-8; Cyrillic counts twice), never inside a character, with "…" when it was cut.
 *
 * @param {string} text - Text
 * @param {number} [maxBytes] - Limit, 0 = none
 * @returns {string} Text that fits
 */
function fitTitle(text, maxBytes = TITLE_MAX_BYTES) {
    if (!maxBytes || Buffer.byteLength(text) <= maxBytes) {
        return text;
    }
    let out = '';
    for (const ch of text) {
        if (Buffer.byteLength(`${out}${ch}…`) > maxBytes) {
            break;
        }
        out += ch;
    }
    return `${out.trimEnd()}…`;
}

/**
 * The address a player reaches this host on: the configured one, else the first external IPv4 address.
 *
 * @param {string} configured - `native.urlHost`
 * @returns {string} Host for the stream URL
 */
function streamHost(configured) {
    const c = String(configured || '').trim();
    if (c) {
        return c;
    }
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal) {
                return a.address;
            }
        }
    }
    return '127.0.0.1';
}

/**
 * The ids of objects that other adapters are linked to (History, InfluxDB, SQL …: a non-empty `common.custom`).
 *
 * @param {Record<string, ioBroker.Object>} objects - Objects
 * @returns {string[]} Ids
 */
function customIds(objects) {
    return Object.entries(objects || {})
        .filter(([, obj]) => {
            const custom = obj?.common?.custom;
            return custom && typeof custom === 'object' && Object.keys(custom).length > 0;
        })
        .map(([id]) => id)
        .sort();
}

/**
 * The states a station can play on: writable states with role `media.url`, for the admin.
 *
 * @param {Record<string, ioBroker.Object>} objects - State objects
 * @param {string} own - Own namespace, left out
 * @returns {Array<{label: string, value: string}>} Choices
 */
function urlStateChoices(objects, own) {
    const out = [];
    for (const [id, obj] of Object.entries(objects || {})) {
        const c = /** @type {Partial<ioBroker.StateCommon>} */ (obj?.common || {});
        if (obj?.type !== 'state' || c.role !== 'media.url' || c.write === false || id.startsWith(`${own}.`)) {
            continue;
        }
        const name = nameOf(c.name);
        out.push({ label: name ? `${id} (${name})` : id, value: id });
    }
    return out.sort((a, b) => a.value.localeCompare(b.value));
}

module.exports = {
    TITLE_MAX_BYTES,
    toId,
    uniqueId,
    isStreamUrl,
    splitTags,
    normalizeStations,
    parseStopValue,
    presetFor,
    discoverTargets,
    buildTargets,
    streamFor,
    matchKey,
    findByName,
    roomsOf,
    nameOf,
    scaleVolume,
    fitTitle,
    streamHost,
    customIds,
    urlStateChoices,
};
