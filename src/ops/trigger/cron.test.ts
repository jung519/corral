/**
 * Cron matching. Written by hand rather than depended on, so it has to earn that by
 * behaving the way every operator's muscle memory expects.
 */
import { describe, expect, it } from 'vitest';
import { calendarFieldsIn, cronMatches, isTimeZone, parseCron } from './cron.js';

const at = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m - 1, d, h, min);
const matches = (expr: string, date: Date): boolean => cronMatches(parseCron(expr), date);

describe('the four forms', () => {
  it('every minute', () => {
    expect(matches('* * * * *', at(2026, 8, 15, 13, 37))).toBe(true);
  });

  it('a fixed minute and hour', () => {
    expect(matches('30 2 * * *', at(2026, 8, 15, 2, 30))).toBe(true);
    expect(matches('30 2 * * *', at(2026, 8, 15, 2, 31))).toBe(false);
    expect(matches('30 2 * * *', at(2026, 8, 15, 3, 30))).toBe(false);
  });

  it('a range', () => {
    expect(matches('0 9-17 * * *', at(2026, 8, 15, 9, 0))).toBe(true);
    expect(matches('0 9-17 * * *', at(2026, 8, 15, 17, 0))).toBe(true);
    expect(matches('0 9-17 * * *', at(2026, 8, 15, 18, 0))).toBe(false);
  });

  it('a step', () => {
    const every15 = parseCron('*/15 * * * *');
    expect([0, 15, 30, 45].every((m) => cronMatches(every15, at(2026, 8, 15, 1, m)))).toBe(true);
    expect(cronMatches(every15, at(2026, 8, 15, 1, 16))).toBe(false);
  });

  it('a step from an offset', () => {
    const fields = parseCron('5/15 * * * *');

    expect([5, 20, 35, 50].every((m) => cronMatches(fields, at(2026, 8, 15, 1, m)))).toBe(true);
    expect(cronMatches(fields, at(2026, 8, 15, 1, 0))).toBe(false);
  });

  it('a comma list', () => {
    const fields = parseCron('0 0,12 * * *');

    expect(cronMatches(fields, at(2026, 8, 15, 0, 0))).toBe(true);
    expect(cronMatches(fields, at(2026, 8, 15, 12, 0))).toBe(true);
    expect(cronMatches(fields, at(2026, 8, 15, 6, 0))).toBe(false);
  });
});

describe('days', () => {
  it('takes Sunday as either 0 or 7', () => {
    // Both appear in the wild, and accepting only one is the kind of surprise that gets
    // found at 3am on a Sunday.
    const sunday = at(2026, 8, 16, 9, 0);
    expect(sunday.getDay()).toBe(0);
    expect(matches('0 9 * * 0', sunday)).toBe(true);
    expect(matches('0 9 * * 7', sunday)).toBe(true);
  });

  it('matches weekdays by name-free range', () => {
    expect(matches('0 9 * * 1-5', at(2026, 8, 14, 9, 0))).toBe(true); // Friday
    expect(matches('0 9 * * 1-5', at(2026, 8, 15, 9, 0))).toBe(false); // Saturday
  });

  it('ORs day-of-month with day-of-week when both are restricted', () => {
    // Traditional cron: "the 1st OR any Monday", not "a Monday that is the 1st".
    const fields = parseCron('0 0 1 * 1');

    expect(cronMatches(fields, at(2026, 8, 1, 0, 0))).toBe(true); // the 1st (a Saturday)
    expect(cronMatches(fields, at(2026, 8, 17, 0, 0))).toBe(true); // a Monday
    expect(cronMatches(fields, at(2026, 8, 18, 0, 0))).toBe(false); // neither
  });

  it('ANDs nothing when only one of them is restricted', () => {
    expect(matches('0 0 15 * *', at(2026, 8, 15, 0, 0))).toBe(true);
    expect(matches('0 0 15 * *', at(2026, 8, 16, 0, 0))).toBe(false);
  });

  it('respects the month field', () => {
    expect(matches('0 0 1 1 *', at(2026, 1, 1, 0, 0))).toBe(true);
    expect(matches('0 0 1 1 *', at(2026, 2, 1, 0, 0))).toBe(false);
  });
});

describe('an expression it cannot execute', () => {
  it('says what is wrong instead of guessing', () => {
    expect(() => parseCron('* * * *')).toThrow(/needs 5 fields/);
    expect(() => parseCron('61 * * * *')).toThrow(/minute "61" \(expected 0-59\)/);
    expect(() => parseCron('* 25 * * *')).toThrow(/hour "25"/);
    expect(() => parseCron('* * * 13 *')).toThrow(/month "13"/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/invalid step/);
    expect(() => parseCron('abc * * * *')).toThrow(/minute "abc"/);
    expect(() => parseCron('10-5 * * * *')).toThrow(/minute "10-5"/);
  });

  it('accepts the extra whitespace people actually type', () => {
    expect(matches('  0   9  *  *  * ', at(2026, 8, 15, 9, 0))).toBe(true);
  });
});

describe("which clock's 9am", () => {
  /** 2026-08-16T00:30:00Z — 09:30 in Seoul, 00:30 in London, 20:30 the day before in New York. */
  const instant = new Date('2026-08-16T00:30:00Z');

  it('reads the calendar on the zone it was given', () => {
    expect(calendarFieldsIn(instant, 'Asia/Seoul')).toMatchObject({ hour: 9, minute: 30, dayOfMonth: 16, dayOfWeek: 0 });
    expect(calendarFieldsIn(instant, 'UTC')).toMatchObject({ hour: 0, minute: 30, dayOfMonth: 16, dayOfWeek: 0 });
    // A different day, not just a different hour — which is why day-of-week has to be read
    // on the same clock rather than taken from the machine.
    expect(calendarFieldsIn(instant, 'America/New_York')).toMatchObject({ hour: 20, dayOfMonth: 15, dayOfWeek: 6 });
  });

  it('fires "every day at 09:00" on the operator\'s clock, not the machine\'s', () => {
    const daily = parseCron('0 9 * * *');
    // The same instant: 09:00 in Seoul is not 09:00 anywhere else.
    const nine = new Date('2026-08-16T00:00:00Z');
    expect(cronMatches(daily, nine, 'Asia/Seoul')).toBe(true);
    expect(cronMatches(daily, nine, 'UTC')).toBe(false);
    expect(cronMatches(daily, new Date('2026-08-16T09:00:00Z'), 'UTC')).toBe(true);
  });

  it('handles midnight as 0 rather than 24', () => {
    // `hour12: false` is allowed to render midnight as "24"; a schedule at `0 0 * * *`
    // would then never fire.
    expect(calendarFieldsIn(new Date('2026-08-15T15:00:00Z'), 'Asia/Seoul').hour).toBe(0);
    expect(cronMatches(parseCron('0 0 * * *'), new Date('2026-08-15T15:00:00Z'), 'Asia/Seoul')).toBe(true);
  });

  it('follows the zone across its own daylight saving change', () => {
    const daily = parseCron('0 9 * * *');
    // New York is UTC-4 in August and UTC-5 in January. 09:00 local is a different instant
    // in each, and neither is the one the machine's clock would have picked.
    expect(cronMatches(daily, new Date('2026-08-16T13:00:00Z'), 'America/New_York')).toBe(true);
    expect(cronMatches(daily, new Date('2026-01-16T14:00:00Z'), 'America/New_York')).toBe(true);
    expect(cronMatches(daily, new Date('2026-01-16T13:00:00Z'), 'America/New_York')).toBe(false);
  });

  it('falls back to the machine when no zone is given', () => {
    const local = at(2026, 8, 15, 13, 37);
    expect(calendarFieldsIn(local)).toMatchObject({ hour: 13, minute: 37, dayOfMonth: 15 });
  });

  it('knows a real zone from a made-up one', () => {
    expect(isTimeZone('Asia/Seoul')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Seoul')).toBe(false);
    expect(isTimeZone('GMT+9')).toBe(false);
  });
});
