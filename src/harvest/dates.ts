import { UserFacingError } from '../core/errors.ts';

/** Calendar dates are handled as YYYY-MM-DD strings, the format Harvest uses. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_30_days',
  'this_year',
  'last_year',
] as const;
export type Period = (typeof PERIODS)[number];

export type WeekStart = 'Monday' | 'Sunday' | 'Saturday';

/** Today's date in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function assertDate(value: string, field: string): string {
  if (!isValidDate(value)) throw new UserFacingError(`${field} must be a real date in YYYY-MM-DD format (got "${value}").`);
  return value;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (inclusive of both ends = result + 1). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function weekdayName(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

function startOfWeek(date: string, weekStart: WeekStart): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const startDay = weekStart === 'Sunday' ? 0 : weekStart === 'Saturday' ? 6 : 1;
  return addDays(date, -((day - startDay + 7) % 7));
}

function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function endOfMonth(date: string): string {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

export function periodRange(period: Period, today: string, weekStart: WeekStart = 'Monday'): { from: string; to: string } {
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'this_week': {
      const from = startOfWeek(today, weekStart);
      return { from, to: addDays(from, 6) };
    }
    case 'last_week': {
      const from = addDays(startOfWeek(today, weekStart), -7);
      return { from, to: addDays(from, 6) };
    }
    case 'this_month':
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case 'last_month': {
      const lastMonthDay = addDays(startOfMonth(today), -1);
      return { from: startOfMonth(lastMonthDay), to: lastMonthDay };
    }
    case 'last_30_days':
      return { from: addDays(today, -29), to: today };
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case 'last_year': {
      const year = Number(today.slice(0, 4)) - 1;
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
  }
}

/**
 * Resolve the date range a tool was asked for: explicit from/to win, then `period`, then the
 * fallback period. A lone `from` runs to today; a lone `to` covers just that day.
 */
export function resolveRange(
  input: { from?: string | undefined; to?: string | undefined; period?: Period | undefined },
  today: string,
  weekStart: WeekStart,
  fallback: Period,
): { from: string; to: string } {
  let range: { from: string; to: string };
  if (input.from || input.to) {
    const from = input.from ? assertDate(input.from, 'from') : assertDate(input.to!, 'to');
    const to = input.to ? assertDate(input.to, 'to') : today < from ? from : today;
    range = { from, to };
  } else {
    range = periodRange(input.period ?? fallback, today, weekStart);
  }
  if (range.from > range.to) throw new UserFacingError(`"from" (${range.from}) is after "to" (${range.to}).`);
  return range;
}

/** YYYYMMDD, the format Harvest's report examples use. */
export function compactDate(date: string): string {
  return date.replaceAll('-', '');
}
