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
    'A station URL may be a stream, a playlist (m3u, pls, asx, xspf — also behind redirects) or HLS; the adapter opens it.',
    '',
    'Commands (sendTo("webradio.<instance>", command, message)); every answer is an object, failures are',
    '{error: "<text>"} and, when the request is ambiguous, {error, ask: "<question for the user>", choices: [...]}:',
    '- list_stations {} → {stations: [{id, name, tags, url, logo}]}: the favourites.',
    '- search_stations {query?, country?, tag?, limit?} → {query: {name, countrycode | country, tag, limit}, stations:',
    '  [{uuid, name, url, country, tags, codec, bitrate}], hint?}: radio-browser.info, most played first. query is a',
    '  part of the station name in any script (Cyrillic works). country is optional: two letters are an ISO 3166-1 code',
    '  (RU, DE …), anything longer is a part of the English country name of the catalog ("Russian Federation"); names in',
    '  other languages find nothing. tag is a genre tag (e.g. trance). limit 1–50, default 10. The answer field query',
    '  shows the filters as the catalog got them; hint comes when the filters found nothing.',
    '  Without query and with a country: the most played stations of that country ("top stations of Germany").',
    '- check_stations {} → {stations: [{id, name, online, url, refreshed?, error?}]}: checks every favourite now (the',
    '  adapter also does it once a day). A station of radio-browser.info that does not answer gets the URL the catalog',
    '  has now, when that one answers (refreshed: true). Takes a few seconds per station.',
    '- export_stations {format?} → {format, text}: the favourites as M3U (default; tvg-logo, group-title = tags) or JSON',
    '  (format "json", the rows of the settings).',
    '- import_stations {text} → {ok, format, added, skipped, restart}: adds the stations of an M3U, PLS, JSON or URL',
    '  list to the favourites (a station with the same URL or uuid is skipped). When something was added, the settings',
    '  change and the adapter restarts at once; ask the user first.',
    '- list_targets {} → {targets: [{id, name, rooms, kind, playing, station, title}]}: the players and their rooms.',
    '- play {station, target?, room?} → {ok, target, station, stationId, source, uuid?}: plays a station on one player.',
    '  station is resolved in this order: 1. a http(s) stream URL; 2. a favourite by id or name (also a part of the',
    '  name) — a favourite always wins over a catalog station with the same name; 3. a uuid from search_stations;',
    '  4. otherwise the most played match of radio-browser.info. The answer says what was taken: source "favourite"',
    '  (stationId = its id), "catalog" (stationId empty, uuid = catalog uuid) or "url" (stationId empty).',
    '  target is a player id or name; room is a room name in any language (enum.rooms) or a',
    '  player name. Without target and room the answer asks. A room with several players answers with ask/choices.',
    '  Multiroom: targets: ["kitchen", "Bath"] or room with all: true plays the station on several players at once',
    '  (answer {ok, target: "names", targets: [names], …, errors?}); players of the same kind share one stream.',
    '- resume {target?, room?} → like play: plays the station that played last on this player (remembered across',
    '  restarts), else the first favourite ("turn on the radio" without a station). Plays already → {…, already: true}.',
    '- next {target?, room?} → like play: the next favourite in the order of the settings, wrapping around; works',
    '  while the player is stopped too (it starts).',
    '- prev {target?, room?} → like next, the previous favourite.',
    '- sleep {minutes, target?, room?} → {ok, target, minutes, endsAt} or {ok, target, minutes: 0}: stops the player',
    '  after this many minutes (1–720); in the last 30 s the volume fades out when the player has a volume state, and',
    '  comes back after the stop. minutes 0 turns the timer off. Only while something plays; a new play, resume, next,',
    '  prev or stop ends the timer.',
    '- alarm {target?, room?, time?, days?, station?, volume?, fade?} → {ok, target, alarm: {time, days, station, volume,',
    '  fade, next}}: the wake-up radio of a player; only the fields given change, {} with a target reads it. time "HH:MM"',
    '  local time of the ioBroker host, "" = off; days "1-5", "mo,we,fr", "sa-su", "" = every day (1 = Monday); station',
    '  a favourite (id or name), "" = the last station; volume the end volume 0–100 % (default 30); fade minutes 0–60',
    '  (default 5) in which the volume rises from 0 (players with a volume state). next is the next alarm (ISO time).',
    '- stop {target?, room?} → {ok, stopped: [ids]}: stops the player(s) this adapter started; without both: all.',
    '- now_playing {target?, room?} → {targets: [{id, name, playing, station, title}]}: what plays now.',
    '- history {target?, room?, limit?} → {targets: [{id, name, history: [{time, station, title}]}]}: the titles that',
    '  played, newest first (time ISO 8601 UTC); limit 1–50, default 10; without target and room: all players. Only',
    '  stations that send titles (ICY) appear.',
    '',
    'States below webradio.<instance>.targets.<player> (one channel per player, its name is the player name):',
    '- station (string, writable): id of a favourite; writing it plays that station on the player',
    '- play (button, write true): plays the selected station (none selected: like resume); stop (button): stops',
    '- playing (boolean, read-only): a station of this adapter plays on the player; a stop on the player itself (its',
    '  playback state, role media.state) sets it to false',
    '- title (string, read-only): now playing as sent by the station (ICY title, "Artist - Title"); empty when the',
    '  stream sends no title (some stations never do) — the station name is then in station / now_playing',
    '- cover (string, read-only): URL of the cover of the playing song (iTunes, when the setting is on and the',
    '  song is found), else of the logo of the station',
    '- volume (number 0–100 %, writable): sets the volume of the player',
    '- streamUrl (string, read-only): the URL written to the player',
    '- resume, next, prev (buttons, write true): like the commands of the same name',
    '- sleep (number, minutes, writable): sleep timer, 0 = off; sleepLeft (number, read-only): minutes left',
    '- history (JSON, read-only): the last 50 titles [{ts (ms), station, title}], newest first',
    '- alarmTime, alarmDays, alarmStation, alarmVolume, alarmFade (writable): the wake-up radio, like the message alarm;',
    '  alarmNext (read-only): the next alarm (ISO time, "" = none). Changing the volume (also on the player), a stop',
    '  (also on the player) or another station ends the fade-in',
    '- lastStation (JSON, read-only): {id, name, url, logo, uuid} of the station that played last (for resume)',
    'States below webradio.<instance>.stations.<station> (read-only): name, url (the URL in use), logo (URL of the',
    '  cached logo), tags, online (the station answered at the last check, null = not checked yet), checked (time).',
    'info.checkStations (button, write true): checks the favourites now.',
    'The cached logos are files in the file storage webradio.<instance>.storage, folder logos/<station>.<ext>.',
    'info.stations and info.targets (JSON lists of {id, name, …}) feed the vis widget "Radio".',
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
    { command: 'history', write: false },
    { command: 'check_stations', write: false },
    { command: 'play', write: true },
    { command: 'resume', write: true },
    { command: 'next', write: true },
    { command: 'prev', write: true },
    { command: 'sleep', write: true },
    { command: 'alarm', write: true },
    { command: 'stop', write: true },
    { command: 'export_stations', write: false },
    { command: 'import_stations', write: true },
];

/** Commands that only serve the admin settings */
const ADMIN_COMMANDS = ['adminSearch', 'adminAddStation', 'adminExport', 'adminImport', 'listUrlStates'];

/**
 * @returns {{help: string, commands: {command: string, write: boolean}[]}} Answer to "help"
 */
function helpAnswer() {
    return { help: HELP, commands: COMMANDS.map(c => ({ ...c })) };
}

module.exports = { HELP, COMMANDS, ADMIN_COMMANDS, helpAnswer };
