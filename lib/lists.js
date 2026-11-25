'use strict';

/*
 * The lists in info.stations and info.targets (JSON). The vis widget reads them to draw the station tiles and the
 * player choice; scripts may use them too.
 */

/**
 * @typedef {object} StationEntry
 * @property {string} id - Station id (stations.<id>, targets.<player>.station)
 * @property {string} name - Name
 * @property {string} logo - Logo URL: the cached copy on the stream server, else the station's own, or ''
 * @property {string} file - Cached logo as `<instance>.storage/logos/<file>` (the web adapter serves it as
 *   `/<file>`), or ''
 */

/**
 * @param {import('./types').Station[]} stations - Favourites
 * @param {Map<string, string>} logoFiles - Station id → path below the mount point
 * @param {string} mount - Mount point of the file storage (`webradio.0.storage`)
 * @param {(s: import('./types').Station) => string} logoOf - Logo URL of a station
 * @returns {StationEntry[]} List
 */
function stationList(stations, logoFiles, mount, logoOf) {
    return stations.map(s => {
        const file = logoFiles.get(s.id);
        return { id: s.id, name: s.name, logo: logoOf(s) || '', file: file ? `${mount}/${file}` : '' };
    });
}

/**
 * @template {{id: string, name: string}} T
 * @param {T[]} targets - Players
 * @param {(t: T) => string[]} roomsOf - Room names of a player
 * @returns {{id: string, name: string, rooms: string[]}[]} List
 */
function targetList(targets, roomsOf) {
    return targets.map(t => ({ id: t.id, name: t.name, rooms: roomsOf(t) }));
}

module.exports = { stationList, targetList };
