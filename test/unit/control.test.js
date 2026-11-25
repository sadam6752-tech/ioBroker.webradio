'use strict';

// Resume, next/previous favourite, the volume in percent, and the sleep timer with its fade-out (on a fake clock).

const assert = require('node:assert/strict');
const {
    rememberStation,
    resumeStation,
    stepStation,
    percentOf,
    addHistory,
    readHistory,
    SleepTimer,
    HISTORY_SIZE,
} = require('../../lib/control');

/** @param {string} id - Id */
const fav = id => ({ id, name: id.toUpperCase(), url: `http://x/${id}`, logo: '', tags: [], uuid: '' });
const favourites = [fav('swr3'), fav('1live'), fav('record')];

/**
 * Fake adapter timers on a fake clock.
 *
 * @returns {{timers: any, now: () => number, advance: (ms: number) => void, pending: () => number}} Clock
 */
function fakeClock() {
    let t = 1_000_000;
    /** @type {Map<number, {at: number, cb: () => void}>} */
    const queue = new Map();
    let next = 1;
    const timers = {
        setTimeout: (cb, ms) => {
            const id = next++;
            queue.set(id, { at: t + ms, cb });
            return id;
        },
        clearTimeout: id => queue.delete(/** @type {number} */ (id)),
    };
    const advance = ms => {
        const end = t + ms;
        for (;;) {
            const due = [...queue.entries()].filter(([, q]) => q.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) {
                break;
            }
            queue.delete(due[0]);
            t = due[1].at;
            due[1].cb();
        }
        t = end;
    };
    return { timers, now: () => t, advance, pending: () => queue.size };
}

describe('player control', () => {
    it('resumes the remembered favourite as configured now, a remembered URL station, else the first favourite', () => {
        const moved = { ...fav('1live'), url: 'http://new/1live' };
        assert.equal(resumeStation([favourites[0], moved], JSON.stringify(rememberStation(fav('1live')))), moved);
        const other = resumeStation(favourites, { id: '', name: 'Catalog', url: 'https://c/x', uuid: 'u-1' });
        assert.deepEqual(other, { id: '', name: 'Catalog', url: 'https://c/x', logo: '', tags: [], uuid: 'u-1' });
        assert.equal(resumeStation(favourites, ''), favourites[0]);
        assert.equal(resumeStation(favourites, 'not json'), favourites[0]);
        assert.equal(resumeStation(favourites, { id: 'gone', url: 'javascript:x' }), favourites[0]);
        assert.equal(resumeStation([], ''), null);
    });

    it('steps through the favourites with wrap-around, from anywhere', () => {
        assert.equal(stepStation(favourites, 'swr3', 1)?.id, '1live');
        assert.equal(stepStation(favourites, 'record', 1)?.id, 'swr3');
        assert.equal(stepStation(favourites, 'swr3', -1)?.id, 'record');
        assert.equal(stepStation(favourites, '', 1)?.id, 'swr3');
        assert.equal(stepStation(favourites, 'not-a-favourite', -1)?.id, 'record');
        assert.equal(stepStation([fav('one')], 'one', 1)?.id, 'one');
        assert.equal(stepStation([], 'x', 1), null);
    });

    it('turns the value of a volume state into percent', () => {
        assert.equal(percentOf(0.8), 80);
        assert.equal(percentOf(35, { min: 0, max: 100 }), 35);
        assert.equal(percentOf('12', { min: 0, max: 15 }), 80);
        assert.equal(percentOf(2, { min: 0, max: 1 }), 100);
        assert.equal(percentOf(null), null);
        assert.equal(percentOf('', {}), null);
        assert.equal(percentOf(5, { min: 10, max: 10 }), null);
    });

    it('keeps the title history newest first, without repeats, at most 50 entries', () => {
        const e = (ts, title, station = 'SWR3') => ({ ts, station, title });
        let list = addHistory('', e(1, 'A - One'));
        list = addHistory(JSON.stringify(list), e(2, 'A - One'));
        assert.deepEqual(list, [e(1, 'A - One')], 'the same title again is no new entry');
        list = addHistory(list, e(3, 'A - One', '1LIVE'));
        list = addHistory(list, e(4, 'B - Two', '1LIVE'));
        assert.deepEqual(
            list.map(x => x.ts),
            [4, 3, 1],
        );
        for (let i = 0; i < 60; i++) {
            list = addHistory(list, e(10 + i, `T ${i}`));
        }
        assert.equal(list.length, HISTORY_SIZE);
        assert.equal(list[0].title, 'T 59');
        assert.deepEqual(readHistory('not json'), []);
        assert.deepEqual(readHistory([{ ts: 'x', title: 'a' }, null, { ts: 5, title: 'ok' }]), [e(5, 'ok', '')]);
    });

    it('counts the minutes down, fades in the last 30 s, then ends', () => {
        const clock = fakeClock();
        const left = [];
        const fades = [];
        let ended = 0;
        const timer = new SleepTimer({
            timers: clock.timers,
            now: clock.now,
            onLeft: m => left.push(m),
            onFade: f => fades.push(Math.round(f * 100) / 100),
            onEnd: () => ended++,
        });
        timer.start(2);
        assert.equal(timer.active, true);
        assert.equal(timer.endsAt, clock.now() + 120_000);
        assert.deepEqual(left, [2]);
        clock.advance(60_000);
        assert.deepEqual(left, [2, 1]);
        assert.deepEqual(fades, []);
        clock.advance(30_000);
        assert.deepEqual(fades, [1], 'the fade starts 30 s before the end');
        clock.advance(29_000);
        assert.deepEqual(fades, [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
        assert.equal(ended, 0);
        clock.advance(1_000);
        assert.equal(ended, 1);
        assert.equal(timer.active, false);
        assert.equal(clock.pending(), 0, 'no timer left');
    });

    it('can be cancelled or started again, and 0 minutes means off', () => {
        const clock = fakeClock();
        let ended = 0;
        const timer = new SleepTimer({
            timers: clock.timers,
            now: clock.now,
            onLeft: () => undefined,
            onFade: () => undefined,
            onEnd: () => ended++,
        });
        timer.start(1);
        timer.start(3);
        clock.advance(120_000);
        assert.equal(ended, 0, 'the second start replaced the first');
        timer.cancel();
        clock.advance(600_000);
        assert.equal(ended, 0);
        assert.equal(clock.pending(), 0);
        timer.start(0);
        assert.equal(timer.active, false);
        timer.start(0.25);
        clock.advance(15_000);
        assert.equal(ended, 1, 'a timer shorter than the fade fades from the start and ends');
    });
});
