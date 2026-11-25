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
and the old folder is removed.

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
first network address), reading titles of directly played stations, keeping logos, a fixed radio-browser.info server
and the path of an own ffmpeg (empty: the one that comes with the adapter).

## States

| State                                                             | Meaning                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| `webradio.0.targets.<player>.station`                             | id of a favourite station; writing it plays the station |
| `webradio.0.targets.<player>.play` / `.stop`                      | buttons                                                 |
| `webradio.0.targets.<player>.playing`                             | a station of this adapter plays on the player           |
| `webradio.0.targets.<player>.title`                               | now playing, as sent by the station                     |
| `webradio.0.targets.<player>.cover`                               | logo of the playing station                             |
| `webradio.0.targets.<player>.volume`                              | volume of the player, 0–100 %                           |
| `webradio.0.targets.<player>.streamUrl`                           | the URL written to the player                           |
| `webradio.0.stations.<station>.name` / `.url` / `.logo` / `.tags` | the favourites                                          |
| `webradio.0.info.stations` / `webradio.0.info.targets`            | the favourites and the players as JSON (vis widget)     |

## vis widget "Radio"

The adapter brings a widget for vis (version 1): the logos of the favourite stations as tiles, a tap plays the station
on the chosen player; above them the player choice, a stop button, the volume and what plays now (logo, station, title
sent by the station).

vis copies the widget when it starts; the installation of this adapter restarts vis. In the vis editor the widget is
in the widget set **webradio**, named **Radio**. Its attributes:

- **Adapter instance** — `webradio.0` unless you run more than one instance
- **Fixed player** — id or name of a player (`kitchen`, `Kitchen`); empty: a list to choose the player from, the
  choice is remembered on each device
- **Columns**, **Show now playing**, **Show volume**, **Station names under the logos**
- **Colours** — theme dark, light or auto (follows the device), and own colours for background, text, accent and tiles

The widget reads `info.stations`, `info.targets` and `targets.<player>.station`, `playing`, `title`, `volume`, and
writes `station`, `stop` and `volume` — nothing else. The logos come from the file storage through the web adapter
(`/webradio.0.storage/logos/…`, the same address and protocol as vis), else from the stream server.

vis 2 can show vis 1 widgets as well; this set was made and tried for vis 1.

## Messages (scripts and AI agents)

`sendTo('webradio.0', '<command>', {...})` — the command `help` describes all of them:

| Command           | Message                           | Answer                                                                         |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `list_stations`   | `{}`                              | `{stations: [{id, name, tags, url, logo}]}`                                    |
| `search_stations` | `{query, country?, tag?, limit?}` | `{query, stations: [{uuid, name, url, country, tags, codec, bitrate}], hint?}` |
| `list_targets`    | `{}`                              | `{targets: [{id, name, rooms, kind, playing, station, title}]}`                |
| `play`            | `{station, target?, room?}`       | `{ok, target, station, stationId, source, uuid?}`                              |
| `stop`            | `{target?, room?}`                | `{ok, stopped}`                                                                |
| `now_playing`     | `{target?, room?}`                | `{targets: [...]}`                                                             |

`station` is a stream URL, a favourite (id, name or part of the name; a favourite wins over a catalog station of the
same name), a radio-browser.info uuid, or any other name — then the most played match in radio-browser.info is taken.
The answer of `play` says which: `source` is `favourite` (with `stationId`), `catalog` (with `uuid`) or `url`. `room`
is a room (`enum.rooms`) in any language.

`country` in `search_stations` is an ISO code when it has two letters (`RU`, `DE`), otherwise a part of the English
country name of the catalog (`Russian Federation`). The `query` field of the answer shows the filters as the catalog
got them; `hint` comes when the filters found nothing.

## Privacy

Searches and the play counter go to radio-browser.info with the User-Agent `ioBroker.webradio/<version>`; the
stations themselves see the same User-Agent and the address of the ioBroker host. Nothing else is sent.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- The stream server takes the next free port when the configured one is in use, also one that another instance
  declares (js-controller 8)
- Station logos are kept in the file storage `webradio.0.storage/logos`; the folder `webradio.0.logos` of 0.0.1 is
  moved once
- vis widget "Radio": station logos as tiles, player choice, stop, volume and now playing; the lists
  `info.stations` and `info.targets` for it
- `search_stations` answers with the filters it sent (`query`) and a hint when they found nothing; `play` says whether
  it took a favourite, a catalog station or a URL (`source`, `stationId`, `uuid`)
- Stations whose stream server ends the HTTP status line without CR (e.g. RPR1) play again; playlists are recognised
  by their content (m3u, pls, asx, xspf, HLS) instead of the extension, and players that play by themselves get the
  stream inside a playlist

### 0.0.1 (2026-11-25)

- First version: favourite stations, search in radio-browser.info, players found automatically, stream proxy with
  ffmpeg and ICY titles, help for AI agents

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
