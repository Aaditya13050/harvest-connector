import { UserFacingError } from '../core/errors.ts';
import type { TimeEntry } from './types.ts';

/** 1.5 → "1h 30m"; 0.25 → "15m". */
export function formatHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Hours rounded to 2 decimals, as a number (for structured output). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatMoney(amount: number, currency: string | undefined): string {
  if (!currency) return amount.toFixed(2);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/**
 * Parse a duration the way people type it: 1.5, "1.5", "1:30", "90m", "1h 30m", "2h", "45 min".
 */
export function parseHours(input: number | string): number {
  if (typeof input === 'number') return checkHours(input, String(input));
  const raw = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(raw)) return checkHours(Number(raw), input);
  const colon = raw.match(/^(\d+):([0-5]\d)$/);
  if (colon) return checkHours(Number(colon[1]) + Number(colon[2]) / 60, input);
  const units = raw.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/);
  if (units && (units[1] || units[2])) {
    return checkHours(Number(units[1] ?? 0) + Number(units[2] ?? 0) / 60, input);
  }
  throw new UserFacingError(`Couldn't read "${input}" as a duration. Use hours like 1.5, or 1:30, or "1h 30m".`);
}

function checkHours(hours: number, original: string): number {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw new UserFacingError(`A time entry must be more than 0 and at most 24 hours (got ${original}).`);
  }
  return round2(hours);
}

/** Minutes after midnight for "9:00am", "9am", "17:30", "5:30 pm". */
export function parseClockTime(input: string): number {
  const raw = input.trim().toLowerCase().replace(/\s+/g, '');
  const match = raw.match(/^(\d{1,2})(?::([0-5]\d))?(am|pm)?$/);
  if (match) {
    let hour = Number(match[1]);
    const minute = Number(match[2] ?? 0);
    const meridiem = match[3];
    if (meridiem) {
      if (hour < 1 || hour > 12) throw badTime(input);
      if (hour === 12) hour = 0;
      if (meridiem === 'pm') hour += 12;
    } else if (hour > 23 || match[2] === undefined) {
      throw badTime(input);
    }
    return hour * 60 + minute;
  }
  throw badTime(input);
}

function badTime(input: string): UserFacingError {
  return new UserFacingError(`Couldn't read "${input}" as a time of day. Use formats like 9:00am, 2:30pm or 14:30.`);
}

/** Format minutes after midnight in the account's clock style. */
export function formatClockTime(minutes: number, clock: '12h' | '24h'): string {
  const hour = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, '0');
  if (clock === '24h') return `${String(hour).padStart(2, '0')}:${minute}`;
  const meridiem = hour >= 12 ? 'pm' : 'am';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute}${meridiem}`;
}

/** One readable line for a time entry. */
export function describeEntry(entry: TimeEntry, options: { showUser?: boolean } = {}): string {
  const parts = [
    entry.spent_date,
    entry.is_running ? `${formatHours(entry.hours)} so far, timer running` : formatHours(entry.hours),
    `${entry.client.name} / ${entry.project.name} / ${entry.task.name}`,
  ];
  if (options.showUser) parts.push(entry.user.name);
  let line = parts.join(' · ');
  if (entry.started_time && entry.ended_time) line += ` (${entry.started_time}–${entry.ended_time})`;
  if (entry.notes) line += ` — "${truncate(entry.notes, 140)}"`;
  const flags = [
    entry.billable ? 'billable' : 'non-billable',
    entry.is_billed ? `invoiced${entry.invoice?.number ? ` #${entry.invoice.number}` : ''}` : null,
    entry.is_locked ? 'locked' : null,
  ].filter(Boolean);
  return `${line} [${flags.join(', ')}] (entry ID ${entry.id})`;
}

export function entrySummary(entry: TimeEntry) {
  return {
    id: entry.id,
    date: entry.spent_date,
    hours: round2(entry.hours),
    client: entry.client.name,
    project: entry.project.name,
    project_id: entry.project.id,
    task: entry.task.name,
    task_id: entry.task.id,
    notes: entry.notes ?? '',
    billable: entry.billable,
    invoiced: entry.is_billed,
    running: entry.is_running,
    locked: entry.is_locked ?? false,
    user: entry.user.name,
    started_time: entry.started_time ?? null,
    ended_time: entry.ended_time ?? null,
  };
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
