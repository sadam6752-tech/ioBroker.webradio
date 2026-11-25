'use strict';

/*
 * The wake-up radio of a player: at a time on chosen weekdays it plays a station, the volume rising from 0.
 * Times are local time of the ioBroker host.
 */

/**
 * @typedef {{setTimeout: (cb: () => void, ms: number) => unknown, clearTimeout: (h: unknown) => void}} Timers
 */

/** Weekday names in the languages of the users (Monday = 1 … Sunday = 7) */
const DAY_NAMES = [
    ['mo', 'mon', 'monday', 'montag', 'пн', 'понедельник'],
    ['tu', 'tue', 'tuesday', 'di', 'dienstag', 'вт', 'вторник'],
    ['we', 'wed', 'wednesday', 'mi', 'mittwoch', 'ср', 'среда'],
    ['th', 'thu', 'thursday', 'do', 'donnerstag', 'чт', 'четверг'],
    ['fr', 'fri', 'friday', 'freitag', 'пт', 'пятница'],
    ['sa', 'sat', 'saturday', 'samstag', 'сб', 'суббота'],
    ['su', 'sun', 'sunday', 'so', 'sonntag', 'вс', 'воскресенье'],
];

/**
 * @param {unknown} value - "7:00", "07:30", "6.45"
 * @returns {string} "HH:MM", '' = no (valid) time
 */
function normalizeTime(value) {
    const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(value ?? ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
        return '';
    }
    return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * @param {unknown} value - "1-5", "1,2,3", "mo-fr", "sa,su", "Пн-Пт"; empty = every day
 * @returns {number[] | null} Weekdays 1 (Monday) … 7 (Sunday), sorted; null = not understood
 */
function parseDays(value) {
    const text = String(value ?? '')
        .trim()
        .toLowerCase();
    if (!text || text === '*' || text === 'daily') {
        return [1, 2, 3, 4, 5, 6, 7];
    }
    /** @param {string} t - One day */
    const day = t => {
        if (/^[1-7]$/.test(t)) {
            return Number(t);
        }
        const i = DAY_NAMES.findIndex(names => names.includes(t));
        return i >= 0 ? i + 1 : 0;
    };
    const days = new Set();
    for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
        const range = part.split('-');
        if (range.length === 2) {
            const a = day(range[0]);
            const b = day(range[1]);
            if (!a || !b) {
                return null;
            }
            for (let d = a; ; d = (d % 7) + 1) {
                days.add(d);
                if (d === b) {
                    break;
                }
            }
        } else {
            const d = day(part);
            if (!d) {
                return null;
            }
            days.add(d);
        }
    }
    return days.size ? [...days].sort((x, y) => x - y) : null;
}

/**
 * The next time the alarm rings, strictly after now.
 *
 * @param {Date} now - Now
 * @param {string} time - "HH:MM"
 * @param {number[]} days - Weekdays 1 … 7
 * @returns {Date | null} Next alarm, null = none
 */
function nextAlarm(now, time, days) {
    const t = normalizeTime(time);
    if (!t || !days.length) {
        return null;
    }
    const [h, m] = t.split(':').map(Number);
    for (let i = 0; i <= 7; i++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m, 0, 0);
        const weekday = ((d.getDay() + 6) % 7) + 1;
        if (d.getTime() > now.getTime() && days.includes(weekday)) {
            return d;
        }
    }
    return null;
}

/** One volume step of the fade-in every this many milliseconds */
const RAMP_STEP_MS = 5_000;

/** Raises a value from one level to another in steps (the volume of the wake-up radio). */
class Ramp {
    /**
     * @param {Timers} timers - Adapter timers
     * @param {number} [stepMs] - Step (tests)
     */
    constructor(timers, stepMs = RAMP_STEP_MS) {
        this.timers = timers;
        this.stepMs = stepMs;
        /** @type {unknown} */
        this.timer = null;
    }

    /** @returns {boolean} It runs */
    get active() {
        return this.timer !== null;
    }

    /**
     * @param {number} from - Start level
     * @param {number} to - End level
     * @param {number} ms - Duration
     * @param {(level: number) => void} onStep - A new level (whole number), the first one at once
     * @param {() => void} [onDone] - Reached the end level
     */
    start(from, to, ms, onStep, onDone) {
        this.cancel();
        const steps = Math.max(1, Math.round(ms / this.stepMs));
        let i = 0;
        const step = () => {
            this.timer = null;
            const level = Math.round(from + ((to - from) * i) / steps);
            onStep(level);
            if (i >= steps) {
                onDone?.();
                return;
            }
            i++;
            this.timer = this.timers.setTimeout(step, this.stepMs);
        };
        if (ms <= 0) {
            onStep(Math.round(to));
            onDone?.();
            return;
        }
        step();
    }

    /** Stops where it is. */
    cancel() {
        this.timers.clearTimeout(this.timer);
        this.timer = null;
    }
}

module.exports = { normalizeTime, parseDays, nextAlarm, Ramp, RAMP_STEP_MS };
