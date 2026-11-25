'use strict';

const assert = require('node:assert/strict');
const { logoPath, normalizeLogoFile, migrateOldLogos } = require('../../lib/storage');

/**
 * An in-memory file storage with mount point objects.
 *
 * @param {Record<string, Record<string, string>>} mounts - mount → path → content
 * @returns {{api: import('../../lib/storage').FileApi, mounts: Record<string, Record<string, string>>, objects: Set<string>}} Fake
 */
function fakeFiles(mounts) {
    const objects = new Set(Object.keys(mounts));
    const api = {
        hasObject: async id => objects.has(id),
        readDir: async (mount, path) => {
            if (!mounts[mount]) {
                throw new Error('Not exists');
            }
            return Object.keys(mounts[mount])
                .filter(p => (path ? p.startsWith(`${path}/`) : !p.includes('/')))
                .map(p => ({ file: p.split('/').pop() || '', isDir: false }));
        },
        readFile: async (mount, path) => {
            const c = mounts[mount]?.[path];
            if (c === undefined || c === 'unreadable') {
                throw new Error('Not exists');
            }
            return Buffer.from(c);
        },
        writeFile: async (mount, path, data) => {
            (mounts[mount] ||= {})[path] = data.toString();
        },
        delFile: async (mount, path) => {
            delete mounts[mount]?.[path];
        },
        delObject: async id => {
            objects.delete(id);
        },
    };
    return { api, mounts, objects };
}

describe('file storage', () => {
    it('puts logos below logos/ and reads the bare names of 0.0.1', () => {
        assert.equal(logoPath('swr3.png'), 'logos/swr3.png');
        assert.equal(normalizeLogoFile('swr3.png'), 'logos/swr3.png');
        assert.equal(normalizeLogoFile('logos/swr3.png'), 'logos/swr3.png');
        assert.equal(normalizeLogoFile(''), '');
        assert.equal(normalizeLogoFile('../x.png'), '');
        assert.equal(normalizeLogoFile(undefined), '');
    });

    it('moves the logos of the old mount point into storage/logos and removes the old one', async () => {
        const f = fakeFiles({
            'webradio.0.logos': {
                'swr3.png': 'PNG1',
                'record.jpg': 'JPG',
                'broken.png': 'unreadable',
                'x y.png': 'odd',
            },
            'webradio.0.storage': {},
        });
        const res = await migrateOldLogos('webradio.0', f.api);
        assert.deepEqual(res, { moved: ['swr3.png', 'record.jpg'], failed: ['broken.png'] });
        assert.deepEqual(f.mounts['webradio.0.storage'], { 'logos/swr3.png': 'PNG1', 'logos/record.jpg': 'JPG' });
        assert.ok(!f.objects.has('webradio.0.logos'), 'old mount point deleted');
        assert.deepEqual(Object.keys(f.mounts['webradio.0.logos']), ['x y.png'], 'moved and failed files deleted');
    });

    it('does nothing without the old mount point, and removes an empty one', async () => {
        const none = fakeFiles({ 'webradio.0.storage': {} });
        assert.equal(await migrateOldLogos('webradio.0', none.api), null);
        const empty = fakeFiles({ 'webradio.0.logos': {} });
        delete empty.mounts['webradio.0.logos']; // the object exists, its folder does not
        assert.deepEqual(await migrateOldLogos('webradio.0', empty.api), { moved: [], failed: [] });
        assert.ok(!empty.objects.has('webradio.0.logos'));
    });
});
