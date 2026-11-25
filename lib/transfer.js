'use strict';

/*
 * Import and export of the favourites: M3U (with logo and tags as tvg-logo / group-title, the way IPTV and radio apps
 * write them), PLS, JSON (the rows of the settings) and plain URL lists.
 */

/**
 * @typedef {object} StationRow
 * @property {boolean} enabled - Active
 * @property {string} name - Name
 * @property {string} url - Stream URL
 * @property {string} logo - Logo URL
 * @property {string} tags - Tags, comma separated
 * @property {string} [uuid] - radio-browser.info uuid
 */

/** Rows a single import may add at most */
const MAX_IMPORT = 500;

/**
 * @param {unknown} v - Value
 * @returns {string} Trimmed text
 */
const text = v => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/**
 * @param {string} url - URL
 * @returns {boolean} http(s) URL
 */
const isHttp = url => /^https?:\/\/\S+$/i.test(url);

/**
 * @param {string} s - Text for an M3U attribute or title
 * @returns {string} Text without quotes and line breaks
 */
const clean = s => s.replace(/[\r\n"]+/g, ' ').trim();

/**
 * @param {Array<Record<string, unknown>>} rows - Rows of the settings
 * @param {'m3u' | 'json'} format - Format
 * @returns {string} File content
 */
function exportStations(rows, format) {
    const list = (Array.isArray(rows) ? rows : []).filter(r => r && isHttp(text(r.url)));
    if (format === 'json') {
        return `${JSON.stringify(
            list.map(r => ({
                enabled: r.enabled !== false,
                name: text(r.name),
                url: text(r.url),
                logo: text(r.logo),
                tags: text(r.tags),
                ...(text(r.uuid) ? { uuid: text(r.uuid) } : {}),
            })),
            null,
            2,
        )}\n`;
    }
    const lines = ['#EXTM3U'];
    for (const r of list) {
        const attrs = [
            text(r.logo) ? `tvg-logo="${clean(text(r.logo))}"` : '',
            text(r.tags) ? `group-title="${clean(text(r.tags))}"` : '',
        ]
            .filter(Boolean)
            .join(' ');
        lines.push(`#EXTINF:-1${attrs ? ` ${attrs}` : ''},${clean(text(r.name) || text(r.url))}`);
        lines.push(text(r.url));
    }
    return `${lines.join('\n')}\n`;
}

/**
 * @param {string} body - Text
 * @returns {Partial<StationRow>[]} Entries of a JSON export (an array, or {stations: [...]})
 */
function fromJson(body) {
    const data = JSON.parse(body);
    const list = Array.isArray(data) ? data : Array.isArray(data?.stations) ? data.stations : [];
    return list
        .filter(e => e && typeof e === 'object')
        .map(e => ({
            enabled: e.enabled !== false,
            name: text(e.name),
            url: text(e.url ?? e.url_resolved ?? e.stream),
            logo: text(e.logo ?? e.favicon),
            tags: Array.isArray(e.tags) ? e.tags.map(text).filter(Boolean).join(', ') : text(e.tags),
            uuid: text(e.uuid ?? e.stationuuid),
        }));
}

/**
 * @param {string[]} lines - Lines
 * @returns {Partial<StationRow>[]} Entries of an M3U or a URL list
 */
function fromM3u(lines) {
    /** @type {Partial<StationRow>[]} */
    const out = [];
    /** @type {Partial<StationRow>} */
    let info = {};
    for (const line of lines) {
        if (/^#EXTINF:/i.test(line)) {
            // the title follows the first comma outside the quotes of the attributes
            let inQuote = false;
            let titleAt = -1;
            for (let i = 0; i < line.length && titleAt < 0; i++) {
                if (line[i] === '"') {
                    inQuote = !inQuote;
                } else if (line[i] === ',' && !inQuote) {
                    titleAt = i + 1;
                }
            }
            const title = titleAt >= 0 ? line.slice(titleAt) : '';
            const attr = name =>
                /** @type {RegExpExecArray | null} */ (new RegExp(`${name}="([^"]*)"`, 'i').exec(line))?.[1] || '';
            info = { name: title.trim(), logo: attr('tvg-logo'), tags: attr('group-title') };
        } else if (!line.startsWith('#')) {
            if (isHttp(line)) {
                out.push({
                    enabled: true,
                    name: info.name || '',
                    url: line,
                    logo: info.logo || '',
                    tags: info.tags || '',
                });
            }
            info = {};
        }
    }
    return out;
}

/**
 * @param {string[]} lines - Lines
 * @returns {Partial<StationRow>[]} Entries of a PLS
 */
function fromPls(lines) {
    /** @type {Map<string, Partial<StationRow>>} */
    const byIndex = new Map();
    for (const line of lines) {
        const m = /^(File|Title)(\d+)\s*=\s*(.*)$/i.exec(line);
        if (!m) {
            continue;
        }
        const e = byIndex.get(m[2]) || { enabled: true, name: '', url: '', logo: '', tags: '' };
        if (m[1].toLowerCase() === 'file') {
            e.url = m[3].trim();
        } else {
            e.name = m[3].trim();
        }
        byIndex.set(m[2], e);
    }
    return [...byIndex.values()];
}

/**
 * Reads a list of stations (M3U, PLS, JSON or one URL per line) and adds the new ones to the rows of the settings.
 * A station already there (same URL or same radio-browser uuid) is skipped, so an import can run twice.
 *
 * @param {string} body - File content
 * @param {Array<Record<string, unknown>>} rows - Rows of the settings
 * @returns {{rows: Array<Record<string, unknown>>, added: number, skipped: number, format: string}} Result
 */
function importStations(body, rows) {
    const content = String(body || '').replace(/^\uFEFF/, '');
    const lines = content
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
    /** @type {Partial<StationRow>[]} */
    let found;
    let format;
    // PLS first: "[playlist]" starts with a bracket like JSON
    if (lines.some(l => /^\[playlist\]$/i.test(l) || /^File\d+\s*=/i.test(l))) {
        found = fromPls(lines);
        format = 'pls';
    } else if (/^\s*[[{]/.test(content)) {
        found = fromJson(content);
        format = 'json';
    } else {
        found = fromM3u(lines);
        format = lines[0]?.toUpperCase().startsWith('#EXTM3U') ? 'm3u' : 'urls';
    }
    const out = [...(Array.isArray(rows) ? rows : [])];
    const urls = new Set(out.map(r => text(r?.url)));
    const uuids = new Set(out.map(r => text(r?.uuid)).filter(Boolean));
    let added = 0;
    let skipped = 0;
    for (const e of found) {
        const url = text(e.url);
        if (!isHttp(url) || urls.has(url) || (e.uuid && uuids.has(e.uuid)) || added >= MAX_IMPORT) {
            skipped++;
            continue;
        }
        let name = text(e.name);
        if (!name) {
            try {
                name = new URL(url).hostname;
            } catch {
                name = url;
            }
        }
        out.push({
            enabled: e.enabled !== false,
            name,
            url,
            logo: isHttp(text(e.logo)) ? text(e.logo) : '',
            tags: text(e.tags),
            ...(e.uuid ? { uuid: e.uuid } : {}),
        });
        urls.add(url);
        if (e.uuid) {
            uuids.add(e.uuid);
        }
        added++;
    }
    return { rows: out, added, skipped, format };
}

module.exports = { exportStations, importStations, MAX_IMPORT };
