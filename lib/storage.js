'use strict';

/*
 * Files of the adapter hang on one mount point, `<namespace>.storage` (type meta.user, so backups take it along).
 * Station logos lie below it in `logos/<station>.<ext>`.
 *
 * Version 0.0.1 kept the logos on an own mount point `<namespace>.logos` (meta.folder) as `<station>.<ext>`; they are
 * moved once and the old mount point is removed.
 */

const STORAGE = 'storage';
const LOGO_DIR = 'logos';
const OLD_LOGO_MOUNT = 'logos';

/**
 * @param {string} name - File name, e.g. `swr3.png`
 * @returns {string} Path below the storage mount point
 */
function logoPath(name) {
    return `${LOGO_DIR}/${name}`;
}

/**
 * The path of a logo as stored in a station's native.logoFile: 0.0.1 stored the bare file name.
 *
 * @param {unknown} stored - native.logoFile
 * @returns {string} Path below the storage mount point, empty = none
 */
function normalizeLogoFile(stored) {
    const f = String(stored ?? '').trim();
    if (!f || f.includes('..') || f.startsWith('/')) {
        return '';
    }
    return f.startsWith(`${LOGO_DIR}/`) ? f : logoPath(f);
}

/**
 * @typedef {object} FileApi
 * @property {(id: string) => Promise<boolean>} hasObject - The mount point object exists
 * @property {(mount: string, path: string) => Promise<Array<{file: string, isDir: boolean}>>} readDir - Directory
 * @property {(mount: string, path: string) => Promise<Buffer>} readFile - File
 * @property {(mount: string, path: string, data: Buffer) => Promise<void>} writeFile - Write a file
 * @property {(mount: string, path: string) => Promise<void>} delFile - Delete a file
 * @property {(id: string) => Promise<void>} delObject - Delete the mount point object
 */

/**
 * Moves the logos of the old mount point `<ns>.logos` to `<ns>.storage/logos/` and removes the old one. A file that
 * cannot be copied is left out (the logo is downloaded again); the old mount point goes in any case.
 *
 * @param {string} namespace - e.g. `webradio.0`
 * @param {FileApi} api - File API of the adapter
 * @returns {Promise<{moved: string[], failed: string[]} | null>} What was moved, null = nothing to migrate
 */
async function migrateOldLogos(namespace, api) {
    const old = `${namespace}.${OLD_LOGO_MOUNT}`;
    if (!(await api.hasObject(old))) {
        return null;
    }
    const moved = [];
    const failed = [];
    let entries = [];
    try {
        entries = await api.readDir(old, '');
    } catch {
        entries = []; // no folder: nothing was cached
    }
    for (const e of entries) {
        if (e.isDir || !/^[a-z0-9_-]+\.[a-z0-9]+$/i.test(e.file)) {
            continue;
        }
        try {
            const data = await api.readFile(old, e.file);
            await api.writeFile(`${namespace}.${STORAGE}`, logoPath(e.file), data);
            moved.push(e.file);
        } catch {
            failed.push(e.file);
        }
        await api.delFile(old, e.file).catch(() => undefined);
    }
    await api.delObject(old);
    return { moved, failed };
}

module.exports = { STORAGE, LOGO_DIR, OLD_LOGO_MOUNT, logoPath, normalizeLogoFile, migrateOldLogos };
