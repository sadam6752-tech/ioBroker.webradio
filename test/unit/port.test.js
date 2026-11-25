'use strict';

// The stream server on a busy port: the next free port is taken (the case of the dev installation, where 8096 was
// in use and the adapter stayed without a stream server).

const assert = require('node:assert/strict');
const net = require('node:net');
const { listenOnFreePort } = require('../../lib/port');
const { StreamServer } = require('../../lib/proxy');

const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * @returns {Promise<net.Server>} A server that holds a port on 127.0.0.1
 */
async function occupy() {
    const s = net.createServer();
    await new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(undefined)));
    return s;
}

/**
 * @param {net.Server} s - Server
 * @returns {number} Its port
 */
const portOf = s => /** @type {net.AddressInfo} */ (s.address()).port;

describe('port of the stream server', () => {
    /** @type {net.Server[]} */
    const busy = [];
    /** @type {StreamServer[]} */
    const servers = [];

    afterEach(async () => {
        for (const s of servers.splice(0)) {
            await s.close();
        }
        for (const s of busy.splice(0)) {
            await new Promise(resolve => s.close(() => resolve(undefined)));
        }
    });

    it('keeps the configured port when it is free', async () => {
        const probe = await occupy();
        const free = portOf(probe);
        await new Promise(resolve => probe.close(() => resolve(undefined)));
        const server = new StreamServer(log, async () => null);
        servers.push(server);
        const res = await listenOnFreePort(free, {
            findFree: async p => p,
            heldBy: async () => [],
            listen: p => server.listen(p, '127.0.0.1'),
        });
        assert.equal(res.port, free);
        assert.deepEqual(res.skipped, []);
    });

    it('takes the next port when listen fails with EADDRINUSE (a check that missed the listener)', async () => {
        const holder = await occupy();
        busy.push(holder);
        const taken = portOf(holder);
        const server = new StreamServer(log, async () => null);
        servers.push(server);
        const res = await listenOnFreePort(taken, {
            findFree: async p => p, // like a check on another address: it thinks the port is free
            heldBy: async () => [],
            listen: p => server.listen(p, '127.0.0.1'),
        });
        assert.ok(res.port > taken, `${res.port} > ${taken}`);
        assert.deepEqual(res.skipped[0], { port: taken, by: 'another program' });
        // the server really answers on the new port
        await new Promise((resolve, reject) => {
            const c = net.connect(res.port, '127.0.0.1', () => {
                c.destroy();
                resolve(undefined);
            });
            c.on('error', reject);
        });
    });

    it('skips a port the operating system check or another instance (js-controller 8) holds', async () => {
        const tried = [];
        const res = await listenOnFreePort(8096, {
            findFree: async p => (p === 8096 ? 8097 : p),
            heldBy: async p => (p === 8097 ? ['system.adapter.airplay-receiver.0'] : []),
            listen: async p => {
                tried.push(p);
                return p;
            },
        });
        assert.equal(res.port, 8098);
        assert.deepEqual(tried, [8098], 'listen only on a port nobody holds');
        assert.deepEqual(res.skipped, [
            { port: 8096, by: 'another program' },
            { port: 8097, by: 'system.adapter.airplay-receiver.0' },
        ]);
    });

    it('gives up with a clear error after the tries, and passes other errors on', async () => {
        const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
        await assert.rejects(
            listenOnFreePort(8096, {
                findFree: async p => p,
                heldBy: async () => [],
                listen: async () => Promise.reject(inUse),
            }),
            /no free port from 8096 on \(8096: another program; 8097/,
        );
        await assert.rejects(
            listenOnFreePort(8096, {
                findFree: async p => p,
                heldBy: async () => [],
                listen: async () => Promise.reject(new Error('EADDRNOTAVAIL')),
            }),
            /EADDRNOTAVAIL/,
        );
    });
});
