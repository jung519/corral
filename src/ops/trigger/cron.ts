/**
 * Five-field cron matching: `minute hour day-of-month month day-of-week`.
 *
 * Written here rather than pulled in. The whole expression language is four forms — a
 * star, a number, a range, a step — and comma lists of those. A dependency for that would
 * be one more package in an app that ships to two platforms and deliberately keeps its
 * runtime dependencies countable on one hand.
 *
 * Matching, not scheduling: the caller ticks once a minute and asks "is this the minute?".
 * That avoids computing next-fire times across DST boundaries, where the arithmetic is
 * where cron libraries go wrong.
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  // 0-7 on purpose: both 0 and 7 mean Sunday, and the parser normalizes 7 to 0 below.
  dayOfWeek: [0, 7],
} as const;

/** Expand one field. Throws with the offending text so a bad definition names itself. */
function expand(text: string, [min, max]: readonly [number, number], field: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const [spec = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step "${part}" in ${field}`);

    let from: number;
    let to: number;
    if (spec === '*') {
      [from, to] = [min, max];
    } else if (spec.includes('-')) {
      const [a, b] = spec.split('-').map(Number);
      [from, to] = [a ?? NaN, b ?? NaN];
    } else {
      from = to = Number(spec);
      if (stepText !== undefined) to = max; // `5/15` means "from 5, every 15"
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`invalid ${field} "${part}" (expected ${min}-${max})`);
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field expression. Throws on anything it cannot execute. */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  }
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = parts;
  return {
    minute: expand(minute, RANGES.minute, 'minute'),
    hour: expand(hour, RANGES.hour, 'hour'),
    dayOfMonth: expand(dayOfMonth, RANGES.dayOfMonth, 'day-of-month'),
    month: expand(month, RANGES.month, 'month'),
    // Both 0 and 7 are Sunday in every cron people have used; accepting only one of them
    // is the kind of surprise that gets found at 3am on a Sunday. `*` therefore expands to
    // eight values and collapses back to seven — which is what "unrestricted" means below.
    dayOfWeek: new Set([...expand(dayOfWeek, RANGES.dayOfWeek, 'day-of-week')].map((d) => d % 7)),
  };
}

// ─────────────────────────────────────────────────────────── which clock's 9am
//
// "Every day at 09:00" is not a question a `Date` can answer on its own — 09:00 where?
// Without a zone the answer is "wherever the core happens to run", which is the machine's
// choice and not the operator's. A schedule set on a laptop and then moved to a VM would
// quietly shift by however far the VM's clock is from home, usually to UTC.

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Built once per zone: a tick asks every minute, for every scheduled pipeline. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // `h23` rather than `hour12: false`, which is allowed to render midnight as 24.
      hourCycle: 'h23',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether the runtime knows this zone. Used to refuse a bad one at load. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export interface CalendarFields {
  minute: number;
  hour: number;
  /** 1-12, like cron writes it. */
  month: number;
  dayOfMonth: number;
  /** 0-6, Sunday first. */
  dayOfWeek: number;
}

/** The calendar fields cron compares against, read on a particular clock. */
export function calendarFieldsIn(date: Date, timeZone?: string): CalendarFields {
  if (!timeZone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      month: date.getMonth() + 1,
      dayOfMonth: date.getDate(),
      dayOfWeek: date.getDay(),
    };
  }
  const parts = formatterFor(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    minute: Number(value('minute')),
    hour: Number(value('hour')),
    month: Number(value('month')),
    dayOfMonth: Number(value('day')),
    dayOfWeek: WEEKDAYS[value('weekday')] ?? 0,
  };
}

/**
 * Whether `date` falls on a minute the expression names, on the given clock.
 *
 * Day-of-month and day-of-week are OR'd when both are restricted — the traditional cron
 * rule, and the one every operator's muscle memory expects.
 */
export function cronMatches(fields: CronFields, date: Date, timeZone?: string): boolean {
  const at = calendarFieldsIn(date, timeZone);
  if (!fields.minute.has(at.minute)) return false;
  if (!fields.hour.has(at.hour)) return false;
  if (!fields.month.has(at.month)) return false;

  const domRestricted = fields.dayOfMonth.size < 31;
  const dowRestricted = fields.dayOfWeek.size < 7;
  const dom = fields.dayOfMonth.has(at.dayOfMonth);
  const dow = fields.dayOfWeek.has(at.dayOfWeek);

  if (domRestricted && dowRestricted) return dom || dow;
  if (domRestricted) return dom;
  if (dowRestricted) return dow;
  return true;
}
