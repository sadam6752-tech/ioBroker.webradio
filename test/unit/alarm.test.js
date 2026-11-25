'use strict';

// The wake-up radio: times, weekdays in several languages, the next alarm, and the fade-in of the volume.

const assert = require('node:assert/strict');
const { normalizeTime, parseDays, nextAlarm, Ramp } = require('../../lib/alarm');

describe('wake-up radio', () => {
    it('reads times and leaves out what is none', () => {
        assert.equal(normalizeTime('7:05'), '07:05');
        assert.equal(normalizeTime(' 06.30 '), '06:30');
        assert.equal(normalizeTime('23:59'), '23:59');
        for (const bad of ['24:00', '7:60', '7', 'seven', '', null, undefined]) {
            assert.equal(normalizeTime(bad), '', String(bad));
        }
    });

    it('reads weekdays as numbers, ranges, names in German, English and Russian', () => {
        assert.deepEqual(parseDays(''), [1, 2, 3, 4, 5, 6, 7]);
        assert.deepEqual(parseDays('1-5'), [1, 2, 3, 4, 5]);
        assert.deepEqual(parseDays('mo,we,fr'), [1, 3, 5]);
        assert.deepEqual(parseDays('Sa-So'), [6, 7]);
        assert.deepEqual(parseDays('sat-mon'), [1, 6, 7], 'a range over the weekend');
        assert.deepEqual(parseDays('Пн-Пт'), [1, 2, 3, 4, 5]);
        assert.deepEqual(parseDays('7 1'), [1, 7]);
        assert.equal(parseDays('someday'), null);
        assert.equal(parseDays('1-9'), null);
    });

    it('finds the next alarm on the right weekday, never now', () => {
        // Wednesday 2026-11-25 06:00 local time
        const wed = new Date(2026, 10, 25, 6, 0, 0);
        const at = (d, h, m) => new Date(2026, 10, d, h, m, 0).getTime();
        assert.equal(nextAlarm(wed, '07:00', [1, 2, 3, 4, 5])?.getTime(), at(25, 7, 0), 'today');
        assert.equal(nextAlarm(wed, '05:30', [1, 2, 3, 4, 5])?.getTime(), at(26, 5, 30), 'past today: tomorrow');
        assert.equal(nextAlarm(wed, '06:00', [3])?.getTime(), at(25 + 7, 6, 0), 'exactly now: next week');
        assert.equal(nextAlarm(wed, '09:00', [6, 7])?.getTime(), at(28, 9, 0), 'Saturday');
        assert.equal(nextAlarm(wed, '', [1]), null);
        assert.equal(nextAlarm(wed, '07:00', []), null);
    });

    it('raises the volume step by step and can be stopped', () => {
        /** @type {Array<() => void>} */
        const queue = [];
        const timers = {
            setTimeout: cb => (queue.push(cb), queue.length),
            clearTimeout: h => h && (queue[Number(h) - 1] = () => undefined),
        };
        const levels = [];
        let done = 0;
        const ramp = new Ramp(timers, 1000);
        ramp.start(
            0,
            40,
            4000,
            l => levels.push(l),
            () => done++,
        );
        while (queue.length && done === 0 && levels.length < 10) {
            queue.shift()?.();
        }
        assert.deepEqual(levels, [0, 10, 20, 30, 40]);
        assert.equal(done, 1);

        const stopped = [];
        queue.length = 0;
        ramp.start(0, 100, 10_000, l => stopped.push(l));
        queue.shift()?.();
        ramp.cancel();
        assert.equal(ramp.active, false);
        assert.deepEqual(stopped, [0, 10]);

        const at = [];
        ramp.start(
            5,
            70,
            0,
            l => at.push(l),
            () => done++,
        );
        assert.deepEqual(at, [70], 'no fade: the end volume at once');
    });
});
