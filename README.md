![Logo](admin/webradio.png)

# ioBroker.webradio

[![NPM version](https://img.shields.io/npm/v/iobroker.webradio.svg)](https://www.npmjs.com/package/iobroker.webradio)
[![Downloads](https://img.shields.io/npm/dm/iobroker.webradio.svg)](https://www.npmjs.com/package/iobroker.webradio)
[![License](https://img.shields.io/github/license/sadam6752-tech/ioBroker.webradio.svg)](LICENSE)

[![NPM](https://nodei.co/npm/iobroker.webradio.png?downloads=true)](https://nodei.co/npm/iobroker.webradio/)

![Test and Release](https://github.com/sadam6752-tech/ioBroker.webradio/workflows/Test%20and%20Release/badge.svg)

## Web radio for ioBroker players

The adapter keeps a list of favourite internet radio stations and plays them on any ioBroker player that takes a URL:

- voice satellites of [ioBroker.assistant](https://github.com/ioBroker/ioBroker.assistant) (ESPHome media players),
- panels of [ioBroker.satellite-display](https://github.com/sadam6752-tech/ioBroker.satellite-display),
- Dune HD media players ([ioBroker.dune-hd-remote](https://github.com/sadam6752-tech/ioBroker.dune-hd-remote)),
- every other state with the role `media.url`.

New stations are found in the open catalog [radio-browser.info](https://www.radio-browser.info/) — from the
settings, or by an AI agent such as [ioBroker.pi-agent](https://github.com/sadam6752-tech/ioBroker.pi-agent): the
adapter describes its commands through the message `help`, so "play Radio Paradise in the kitchen" works by voice.

### How a station reaches the player

ESPHome speakers play only plain MP3 or FLAC over `http` — no AAC, no HLS, no `https`. For them the adapter runs a
small stream server: the player fetches `http://<ioBroker>:8096/play/<player>.flac`, the adapter opens the station
(following redirects and playlists), takes the song titles out of the stream (ICY metadata) and `ffmpeg` converts the
audio to FLAC 48 kHz. Dune HD and other players get the station URL directly; a second connection reads the titles
(can be switched off).

## Settings

**Stations** — type a name (and a country code if you like) in the search, choose a result and press
_Add to favourites_; the station lands in the table, save the settings. A row can also be filled by hand: name,
stream URL (`http://` or `https://`, a playlist `.pls`/`.m3u` works too), logo URL, tags. The logos are copied into
the file storage of the instance, `webradio.0.storage` → `logos/<station>.<ext>` (shown in the admin under
**Files**, taken along by backups), and served by the stream server at `/logo/<station>`, because the logos of
radio stations often move or vanish. Version 0.0.1 kept them in `webradio.0.logos`; they are moved once at the start
and the old folder is removed. A logo larger than 512 kB is scaled down to a PNG of 256 px.

Without a name, the search with a country code lists the most played stations of that country. _Import and export_
below the table takes an M3U, PLS or JSON playlist or a list of URLs (pasted into the field) and adds its stations to
the table; stations whose URL is in the table already are skipped. _Export_ writes the table as M3U (logo and tags as
`tvg-logo` and `group-title`) or JSON into the field, to copy it.

**Players** — with _Find … by themselves_ every satellite of ioBroker.assistant with a media player and every panel of
ioBroker.satellite-display becomes a player (a satellite that is also a panel is taken once, as the panel). Rows add
other players: the state that plays a URL, and if needed a stop state and value, a volume state and a title state;
empty fields take the preset (the same presets as ioBroker.airplay-receiver), `-` means none. _Stream_ chooses how
the station is sent: _Automatic_ (proxy for ESPHome players, the station URL for the others), _Station URL_,
_Proxy FLAC_ or _Proxy MP3_. A row with the play URL state of a found player changes that player, a switched-off row
hides it.

A player whose objects were deleted (a removed satellite) is skipped with one warning in the log; nothing is written
to it.

**Settings** — port (8096) and address of the stream server, the address the players reach this host on (empty: the
first network address), reading titles of directly played stations, keeping logos, the cover of the playing song (see
_Privacy_), the daily check of the favourites, a fixed radio-browser.info server and the path of an own ffmpeg (empty:
the one that comes with the adapter).

The **daily check** opens every favourite once a day (the first time two minutes after the start; the button
`info.checkStations` and the message `check_stations` run it at once) and writes `stations.<station>.online`. A station
from radio-browser.info that does not answer gets the URL the catalog has now, when that one answers; the new URL is
kept in the station's object and used until the URL in the settings changes — the settings stay as they are.

**Device Manager** — the tab _Devices_ of the settings (and the tab _Devices_ of the admin, which may have to be switched on with _Filter menu_) shows a card per player: radio on/off (resume / stop), the station,
the volume, now playing, the sleep timer, previous and next; below it the stream, the next wake-up and the last titles.
The instance action checks the favourites.

**Multiroom** — the message `play` with `targets: ["kitchen", "bath"]` (or a `room` and `all: true`) plays a station on
several players at once. Players of the same format (all ESPHome satellites: FLAC 48 kHz mono) share one connection
to the station and one ffmpeg; a player that joins later starts at the next frame. The players are not in sync to the
millisecond: each one buffers on its own.

## States

| State                                                                      | Meaning                                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `webradio.0.targets.<player>.station`                                      | id of a favourite station; writing it plays the station                                   |
| `webradio.0.targets.<player>.play` / `.stop`                               | buttons (play without a selected station: like resume)                                    |
| `webradio.0.targets.<player>.resume`                                       | button: the station that played last, else the first favourite                            |
| `webradio.0.targets.<player>.next` / `.prev`                               | buttons: next / previous favourite, wrapping around (also while stopped)                  |
| `webradio.0.targets.<player>.sleep`                                        | sleep timer in minutes, 0 = off; the volume fades out in the last 30 s                    |
| `webradio.0.targets.<player>.sleepLeft`                                    | minutes left of the sleep timer                                                           |
| `webradio.0.targets.<player>.lastStation`                                  | the station that played last (JSON), for resume                                           |
| `webradio.0.targets.<player>.history`                                      | the last 50 titles (JSON, newest first)                                                   |
| `webradio.0.targets.<player>.alarmTime` / `.alarmDays`                     | wake-up radio: time `HH:MM` (empty = off), weekdays `1-5`, `mo,we,fr` (empty = every day) |
| `webradio.0.targets.<player>.alarmStation` / `.alarmVolume` / `.alarmFade` | its station (empty = the last one), end volume and fade-in in minutes                     |
| `webradio.0.targets.<player>.alarmNext`                                    | the next wake-up (ISO time)                                                               |
| `webradio.0.targets.<player>.playing`                                      | a station of this adapter plays on the player                                             |
| `webradio.0.targets.<player>.title`                                        | now playing, as sent by the station                                                       |
| `webradio.0.targets.<player>.cover`                                        | cover of the playing song (when found), else the logo of the station                      |
| `webradio.0.targets.<player>.volume`                                       | volume of the player, 0–100 %                                                             |
| `webradio.0.targets.<player>.streamUrl`                                    | the URL written to the player                                                             |
| `webradio.0.stations.<station>.name` / `.url` / `.logo` / `.tags`          | the favourites                                                                            |
| `webradio.0.stations.<station>.online` / `.checked`                        | the station answered at the last check / when it was checked                              |
| `webradio.0.info.checkStations`                                            | button: check the favourites now                                                          |
| `webradio.0.info.stations` / `webradio.0.info.targets`                     | the favourites and the players as JSON (vis widget)                                       |

## vis widget "Radio"

The adapter brings a widget for vis (version 1): the logos of the favourite stations as tiles, a tap plays the station
on the chosen player; above them the player choice, the buttons previous / last station / next / stop, a sleep button
(each tap: 15, 30, 60, 90 minutes, off; it shows the minutes left), the volume and what plays now (logo, station, title
sent by the station).

vis copies the widget when it starts; the installation of this adapter restarts vis. In the vis editor the widget is
in the widget set **webradio**, named **Radio**. Its attributes:

- **Adapter instance** — `webradio.0` unless you run more than one instance
- **Fixed player** — id or name of a player (`kitchen`, `Kitchen`); empty: a list to choose the player from, the
  choice is remembered on each device
- **Columns**, **Show now playing**, **Show volume**, **Station names under the logos**
- **Colours** — theme dark, light or auto (follows the device), and own colours for background, text, accent and tiles

The widget reads `info.stations`, `info.targets` and `targets.<player>.station`, `playing`, `title`, `volume`, `sleep`,
`sleepLeft`, and writes `station`, `stop`, `resume`, `next`, `prev`, `sleep` and `volume` — nothing else. The logos come from the file storage through the web adapter
(`/webradio.0.storage/logos/…`, the same address and protocol as vis), else from the stream server.

vis 2 can show vis 1 widgets as well; this set was made and tried for vis 1.

## Messages (scripts and AI agents)

`sendTo('webradio.0', '<command>', {...})` — the command `help` describes all of them:

| Command           | Message                                                    | Answer                                                                                   |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `list_stations`   | `{}`                                                       | `{stations: [{id, name, tags, url, logo}]}`                                              |
| `search_stations` | `{query?, country?, tag?, limit?}`                         | `{query, stations: [{uuid, name, url, country, tags, codec, bitrate}], hint?}`           |
| `list_targets`    | `{}`                                                       | `{targets: [{id, name, rooms, kind, playing, station, title}]}`                          |
| `play`            | `{station, target?, room?, targets?, all?}`                | `{ok, target, station, stationId, source, uuid?}`; several players: `targets`, `errors?` |
| `resume`          | `{target?, room?}`                                         | like `play`; `already: true` when it plays                                               |
| `next` / `prev`   | `{target?, room?}`                                         | like `play`                                                                              |
| `sleep`           | `{minutes, target?, room?}`                                | `{ok, target, minutes, endsAt}`; `minutes: 0` = off                                      |
| `stop`            | `{target?, room?}`                                         | `{ok, stopped}`                                                                          |
| `now_playing`     | `{target?, room?}`                                         | `{targets: [...]}`                                                                       |
| `history`         | `{target?, room?, limit?}`                                 | `{targets: [{id, name, history: [{time, station, title}]}]}`                             |
| `alarm`           | `{target?, room?, time?, days?, station?, volume?, fade?}` | `{ok, target, alarm: {time, days, station, volume, fade, next}}`                         |
| `check_stations`  | `{}`                                                       | `{stations: [{id, name, online, url, refreshed?, error?}]}`                              |
| `export_stations` | `{format?}`                                                | `{format, text}` (M3U or JSON)                                                           |
| `import_stations` | `{text}`                                                   | `{ok, format, added, skipped, restart}`; adding changes the settings and restarts        |

`station` is a stream URL, a favourite (id, name or part of the name; a favourite wins over a catalog station of the
same name), a radio-browser.info uuid, or any other name — then the most played match in radio-browser.info is taken.
The answer of `play` says which: `source` is `favourite` (with `stationId`), `catalog` (with `uuid`) or `url`. `room`
is a room (`enum.rooms`) in any language.

`country` in `search_stations` is an ISO code when it has two letters (`RU`, `DE`), otherwise a part of the English
country name of the catalog (`Russian Federation`). The `query` field of the answer shows the filters as the catalog
got them; `hint` comes when the filters found nothing.

## Privacy

Searches, the play counter and the URL refresh of the daily check go to radio-browser.info with the User-Agent
`ioBroker.webradio/<version>`; the stations themselves see the same User-Agent and the address of the ioBroker host.
With the setting _Show the cover of the playing song_ (on by default) the artist and title of the playing song go to
the iTunes Search API of Apple (`itunes.apple.com`), at most 20 times a minute; switch it off to send nothing there.
Nothing else is sent.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- Cover of the playing song from the iTunes Search API (setting, on by default; artist and title go to Apple)
- Title history per player (`history` state and message)
- Daily check of the favourites; a station of radio-browser.info that does not answer gets its new URL from there
- Multiroom: one station on several players with one connection and one ffmpeg (`play` with `targets`)
- Wake-up radio per player with a fade-in of the volume (`alarm…` states and the message `alarm`)
- Device Manager tab: a card per player with the radio switch, station, volume, sleep timer, previous / next
- Import and export of the favourites (M3U, PLS, JSON, URL lists); the search without a name lists the most played
  stations of a country

### 0.0.2 (2026-11-25)

- Large station logos are scaled down to a PNG of 256 px instead of being left out
- Resume the last station, next and previous favourite: buttons, messages and the vis widget
- Sleep timer per player with a fade-out of the volume: state, message and the vis widget

### 0.0.1 (2026-11-25)

- First version: favourite stations with cached logos, search in radio-browser.info, players found automatically
  (ioBroker.assistant, satellite-display, Dune HD) or any media.url state
- Stream proxy with ffmpeg (FLAC/MP3 for ESPHome players) and ICY titles; playlists (m3u, pls, asx, xspf), HLS and
  redirects; the stream server takes the next free port when the configured one is in use
- vis widget "Radio" (vis 1): station tiles, player choice, stop, volume and now playing
- Help for AI agents (pi-agent): list, search, play, stop and now playing by message

## License

MIT License

Copyright (c) 2026 sadam6752-tech <sadam6752@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
