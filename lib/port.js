'use strict';

/*
 * The port of the stream server: the configured one when it is free, else the next free one. "Free" means: the
 * operating system has no listener on it (adapter.getPortAsync), and on js-controller 8 no other running instance
 * declares it in the used resources registry. A port taken between the check and listen() (EADDRINUSE) is skipped
 * as well.
 */

/** Ports tried after the configured one before the server gives up */
const MAX_TRIES = 20;

/**
 * @typedef {object} PortDeps
 * @property {(port: number) => Promise<number>} findFree - First port >= port without a listener (getPortAsync)
 * @property {(port: number) => Promise<string[]>} heldBy - Other running instances that declare the port (registry)
 * @property {(port: number) => Promise<number>} listen - Opens the server, rejects with EADDRINUSE when taken
 */

/**
 * Opens the server on the configured port or the next free one.
 *
 * @param {number} wanted - Configured port
 * @param {PortDeps} deps - Port check and listen
 * @returns {Promise<{port: number, skipped: Array<{port: number, by: string}>}>} Open port, and the ports passed over
 */
async function listenOnFreePort(wanted, deps) {
    /** @type {Array<{port: number, by: string}>} */
    const skipped = [];
    let candidate = wanted;
    for (let i = 0; i < MAX_TRIES && candidate < 65536; i++) {
        let port = candidate;
        try {
            port = await deps.findFree(candidate);
        } catch {
            // no answer from the check: try the port itself
        }
        if (port !== candidate) {
            skipped.push({ port: candidate, by: 'another program' });
        }
        const held = await deps.heldBy(port).catch(() => []);
        if (held.length) {
            skipped.push({ port, by: held.join(', ') });
            candidate = port + 1;
            continue;
        }
        try {
            return { port: await deps.listen(port), skipped };
        } catch (e) {
            if (e?.code !== 'EADDRINUSE' && e?.code !== 'EACCES') {
                throw e;
            }
            skipped.push({ port, by: e.code === 'EACCES' ? 'the system (no permission)' : 'another program' });
            candidate = port + 1;
        }
    }
    const err = new Error(
        `no free port from ${wanted} on (${skipped.map(s => `${s.port}: ${s.by}`).join('; ') || 'nothing tried'})`,
    );
    throw Object.assign(err, { skipped });
}

module.exports = { listenOnFreePort, MAX_TRIES };
