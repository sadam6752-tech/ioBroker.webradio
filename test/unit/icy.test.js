'use strict';

const assert = require('node:assert/strict');
const {
    parseStreamTitle,
    IcyStripper,
    parsePlaylist,
    kindOf,
    decodeText,
    looksLikePlaylist,
} = require('../../lib/icy');
const { metaBlock } = require('../helpers/icy-server');

/**
 * Runs bytes through a stripper in chunks of a given size.
 *
 * @param {number} metaInt - Interval
 * @param {Buffer} input - Bytes
 * @param {number} chunkSize - Chunk size
 * @returns {Promise<{audio: Buffer, titles: string[]}>} Audio and titles
 */
async function strip(metaInt, input, chunkSize) {
    const titles = [];
    const s = new IcyStripper(metaInt, t => titles.push(t));
    const out = [];
    s.on('data', d => out.push(d));
    for (let i = 0; i < input.length; i += chunkSize) {
        s.write(input.subarray(i, i + chunkSize));
    }
    s.end();
    await new Promise(resolve => s.on('end', resolve));
    return { audio: Buffer.concat(out), titles };
}

describe('ICY', () => {
    it('reads StreamTitle, also with quotes and semicolons inside', () => {
        assert.equal(
            parseStreamTitle("StreamTitle='Queen - Bohemian Rhapsody';StreamUrl='';"),
            'Queen - Bohemian Rhapsody',
        );
        assert.equal(parseStreamTitle("StreamTitle='Guns N' Roses - Don't Cry';"), "Guns N' Roses - Don't Cry");
        assert.equal(parseStreamTitle("StreamTitle='A;B - C';StreamUrl='x';"), 'A;B - C');
        assert.equal(parseStreamTitle("StreamTitle='';"), '');
        assert.equal(parseStreamTitle('StreamUrl=x;'), null);
        assert.equal(
            parseStreamTitle(Buffer.from("StreamTitle='Кино - Группа крови';\0\0\0", 'utf8')),
            'Кино - Группа крови',
        );
    });

    it('decodes Latin-1 when the bytes are no UTF-8', () => {
        assert.equal(decodeText(Buffer.from('Motörhead', 'latin1')), 'Motörhead');
        assert.equal(decodeText(Buffer.from('Motörhead', 'utf8')), 'Motörhead');
    });

    for (const chunk of [1, 7, 100, 100000]) {
        it(`takes the metadata out at any chunk size (${chunk})`, async () => {
            const audio = Buffer.alloc(30, 0xaa);
            const input = Buffer.concat([
                audio.subarray(0, 10),
                metaBlock('One'),
                audio.subarray(10, 20),
                Buffer.from([0]), // no metadata this time
                audio.subarray(20, 30),
                metaBlock('Two'),
            ]);
            const res = await strip(10, input, chunk);
            assert.deepEqual(res.audio, audio);
            assert.deepEqual(res.titles, ['One', 'Two']);
        });
    }

    it('reports a title only when it changes', async () => {
        const input = Buffer.concat([Buffer.alloc(4), metaBlock('Same'), Buffer.alloc(4), metaBlock('Same')]);
        const res = await strip(4, input, 3);
        assert.deepEqual(res.titles, ['Same']);
    });

    it('passes a stream without metaint unchanged', async () => {
        const input = Buffer.from("abcStreamTitle='x';def");
        const res = await strip(0, input, 5);
        assert.deepEqual(res.audio, input);
        assert.deepEqual(res.titles, []);
    });

    it('finds the stream in .pls and .m3u playlists, and HLS', () => {
        assert.deepEqual(parsePlaylist('[playlist]\nFile1=http://a.example/live\nTitle1=x', 'http://b.example/l.pls'), {
            url: 'http://a.example/live',
        });
        assert.deepEqual(parsePlaylist('#EXTM3U\n#EXTINF:-1,X\nstream.mp3\n', 'https://b.example/dir/l.m3u'), {
            url: 'https://b.example/dir/stream.mp3',
        });
        assert.deepEqual(parsePlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts', 'http://b.example/x.m3u8'), {
            hls: true,
        });
        assert.equal(parsePlaylist('<html>nothing</html>', 'http://b.example/'), null);
        assert.equal(parsePlaylist('ftp://x/y', 'http://b.example/'), null);
    });

    it('finds the stream in .asx and .xspf, decodes XML entities, takes the first http(s) entry', () => {
        assert.deepEqual(
            parsePlaylist(
                '<asx version="3.0"><entry><ref href="mms://x/y"/><ref href="http://a.example/s?a=1&amp;b=2"/></entry></asx>',
                'http://b/',
            ),
            { url: 'http://a.example/s?a=1&b=2' },
        );
        assert.deepEqual(
            parsePlaylist(
                '<?xml version="1.0"?><playlist><trackList><track><location>https://a.example/live</location></track></trackList></playlist>',
                'http://b/',
            ),
            { url: 'https://a.example/live' },
        );
        assert.deepEqual(
            parsePlaylist('\uFEFF[playlist]\r\nFile1=ftp://no\r\nFile2=http://a.example/2\r\n', 'http://b/'),
            {
                url: 'http://a.example/2',
            },
        );
        assert.deepEqual(parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunks.m3u8', 'http://b/x'), {
            hls: true,
        });
    });

    it('decides by the Content-Type, and looks at the body when the type or the extension says nothing sure', () => {
        assert.equal(kindOf('audio/mpeg', 'http://x/live'), 'audio');
        assert.equal(kindOf('audio/aac', 'https://x/atsw-rpr1webradio-aac-128'), 'audio');
        assert.equal(kindOf('audio/x-scpls', 'http://x/listen'), 'playlist');
        assert.equal(kindOf('audio/x-mpegurl', 'http://x/listen'), 'playlist');
        assert.equal(kindOf('application/vnd.apple.mpegurl; charset=utf-8', 'http://x/a'), 'playlist');
        assert.equal(kindOf('video/x-ms-asx', 'http://x/a'), 'playlist');
        assert.equal(kindOf('text/plain', 'http://x/listen.m3u'), 'sniff');
        assert.equal(kindOf('audio/mpeg', 'http://x/audio.m3u'), 'sniff', 'the extension makes it look');
        assert.equal(kindOf('', 'http://x/master.m3u8?token=1'), 'sniff');
        assert.equal(kindOf('application/octet-stream', 'http://x/stream'), 'sniff');
        assert.equal(kindOf('text/html', 'http://x/'), 'sniff');
    });

    it('tells a playlist body from audio by the first bytes', () => {
        for (const text of [
            '#EXTM3U\n',
            '\uFEFF#EXTM3U',
            '  [playlist]\nFile1=x',
            '[Playlist]',
            '<asx version="3.0">',
            '<?xml version="1.0"?><playlist>',
            'http://a/live\n',
            '#EXTINF:-1,X\n',
        ]) {
            assert.equal(looksLikePlaylist(Buffer.from(text)), true, text);
        }
        assert.equal(looksLikePlaylist(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0])), false, 'MP3 frame');
        assert.equal(looksLikePlaylist(Buffer.from('ID3\x04\x00')), false, 'ID3');
        assert.equal(looksLikePlaylist(Buffer.from('OggS')), false);
        assert.equal(looksLikePlaylist(Buffer.alloc(0)), false);
    });
});
