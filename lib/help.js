'use strict';

/*
 * The answer to the message "help" (js-controller PR #3638, common.supportedMessages.help): a fixed text for an AI
 * agent (pi-agent) or a script author, and the commands with `write: true` for those that change something.
 *
 * The text must stay the same while the adapter runs: pi-agent keeps a fingerprint of it and tells its conversations
 * to read the help again whenever it changes. No station or player names, addresses or values in it — those come
 * from list_stations, list_targets and now_playing.
 *
 * Left out on purpose: `adminSearch`, `adminAddStation` and `listUrlStates` only serve the admin settings.
 */

const HELP = [
    'webradio plays internet radio stations on ioBroker players that take a URL: ioBroker.assistant voice satellites,',
    'ioBroker.satellite-display panels, Dune HD and any other state with role media.url. It keeps a list of favourite',
    'stations (set up in the admin) and can search the open catalog radio-browser.info for any other station.',
    'ESPHome players get the station through the adapter (ffmpeg turns AAC/HLS/https into FLAC), others the station URL.',
    '',
    'Commands (sendTo("webradio.<instance>", command, message)); every answer is an object, failures are',
    '{error: "<text>"} and, when the request is ambiguous, {error, ask: "<question for the user>", choices: [...]}:',
    '- list_stations {} → {stations: [{id, name, tags, url, logo}]}: the favourites.',
    '- search_stations {query, country?, tag?, limit?} → {stations: [{uuid, name, url, country, tags, codec, bitrate}]}:',
    '  radio-browser.info, most played first. country is a two-letter code (DE, RU …) or a country name; limit 1–50.',
    '- list_targets {} → {targets: [{id, name, rooms, kind, playing, station, title}]}: the players and their rooms.',
    '- play {station, target?, room?} → {ok, target, station, title?}: plays a station on one player. station is the id',
    '  or name of a favourite (also a part of the name), a uuid from search_stations, or an http(s) stream URL; a name',
    '  that is no favourite is looked up in radio-browser.info and the most played match is taken (answer field',
    '  fromCatalog: true). target is a player id or name; room is a room name in any language (enum.rooms) or a',
    '  player name. Without target and room the answer asks. A room with several players answers with ask/choices.',
    '- stop {target?, room?} → {ok, stopped: [ids]}: stops the player(s) this adapter started; without both: all.',
    '- now_playing {target?, room?} → {targets: [{id, name, playing, station, title}]}: what plays now.',
    '',
    'States below webradio.<instance>.targets.<player> (one channel per player, its name is the player name):',
    '- station (string, writable): id of a favourite; writing it plays that station on the player',
    '- play (button, write true): plays the selected station; stop (button, write true): stops the player',
    '- playing (boolean, read-only): a station of this adapter plays on the player',
    '- title (string, read-only): now playing as sent by the station (ICY title, "Artist - Title"), empty when unknown',
    '- cover (string, read-only): URL of the logo of the playing station',
    '- volume (number 0–100 %, writable): sets the volume of the player',
    '- streamUrl (string, read-only): the URL written to the player',
    'States below webradio.<instance>.stations.<station> (read-only): name, url, logo (URL of the cached logo), tags.',
    'The cached logos are files in the file storage webradio.<instance>.storage, folder logos/<station>.<ext>.',
    'info.connection is true while the stream server runs.',
    '',
    'Favourites and the players found automatically are configured in the admin settings, not by messages. A player',
    'that disappeared (its object was deleted) is skipped with a warning in the log.',
].join('\n');

/** Commands an agent may use, in the order of the answer */
const COMMANDS = [
    { command: 'help', write: false },
    { command: 'list_stations', write: false },
    { command: 'search_stations', write: false },
    { command: 'list_targets', write: false },
    { command: 'now_playing', write: false },
    { command: 'play', write: true },
    { command: 'stop', write: true },
];

/** Commands that only serve the admin settings */
const ADMIN_COMMANDS = ['adminSearch', 'adminAddStation', 'listUrlStates'];

/**
 * @returns {{help: string, commands: {command: string, write: boolean}[]}} Answer to "help"
 */
function helpAnswer() {
    return { help: HELP, commands: COMMANDS.map(c => ({ ...c })) };
}

module.exports = { HELP, COMMANDS, ADMIN_COMMANDS, helpAnswer };
