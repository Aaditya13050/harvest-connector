import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../../src/core/errors.ts';
import { periodRange, resolveRange, todayIn } from '../../src/harvest/dates.ts';
import { formatClockTime, formatHours, parseClockTime, parseHours } from '../../src/harvest/format.ts';
import { pickOne } from '../../src/harvest/resolve.ts';
import { toIanaTimeZone } from '../../src/harvest/timezones.ts';

describe('durations', () => {
  it.each([
    [1.5, 1.5],
    ['1.5', 1.5],
    ['1:30', 1.5],
    ['90m', 1.5],
    ['1h 30m', 1.5],
    ['2h', 2],
    ['2 hours', 2],
    ['45 min', 0.75],
    [' 0:05 ', 0.08],
  ])('parses %j as %d hours', (input, hours) => {
    expect(parseHours(input)).toBe(hours);
  });

  it.each(['abc', '0', 0, 25, '-1', '1:75', ''])('rejects %j', (input) => {
    expect(() => parseHours(input)).toThrow(UserFacingError);
  });

  it('formats hours for people', () => {
    expect(formatHours(1.5)).toBe('1h 30m');
    expect(formatHours(0.25)).toBe('15m');
    expect(formatHours(2)).toBe('2h');
    expect(formatHours(7.25)).toBe('7h 15m');
  });
});

describe('clock times', () => {
  it.each([
    ['9am', 540],
    ['9:30am', 570],
    ['9:30 AM', 570],
    ['12:15pm', 735],
    ['12:00am', 0],
    ['17:30', 1050],
    ['00:00', 0],
  ])('parses %s', (input, minutes) => {
    expect(parseClockTime(input)).toBe(minutes);
  });

  it.each(['17', '13pm', '9:60am', 'noon', '24:00'])('rejects %s', (input) => {
    expect(() => parseClockTime(input)).toThrow(UserFacingError);
  });

  it('formats in the account clock style', () => {
    expect(formatClockTime(570, '12h')).toBe('9:30am');
    expect(formatClockTime(0, '12h')).toBe('12:00am');
    expect(formatClockTime(735, '12h')).toBe('12:15pm');
    expect(formatClockTime(1050, '24h')).toBe('17:30');
  });
});

describe('dates', () => {
  it('computes today in a time zone', () => {
    const lateEvening = new Date('2026-11-20T20:00:00Z');
    expect(todayIn('Asia/Kolkata', lateEvening)).toBe('2026-11-21');
    expect(todayIn('America/Los_Angeles', lateEvening)).toBe('2026-11-20');
  });

  it('respects the week start day', () => {
    // 2026-11-20 is a Friday.
    expect(periodRange('this_week', '2026-11-20', 'Monday')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(periodRange('this_week', '2026-11-20', 'Sunday')).toEqual({ from: '2026-11-15', to: '2026-11-21' });
    expect(periodRange('this_week', '2026-11-20', 'Saturday')).toEqual({ from: '2026-11-14', to: '2026-11-20' });
    expect(periodRange('last_week', '2026-11-16', 'Monday')).toEqual({ from: '2026-11-09', to: '2026-11-15' });
  });

  it('handles month ends and leap years', () => {
    expect(periodRange('last_month', '2026-03-15')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('last_month', '2028-03-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('this_month', '2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(periodRange('last_month', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('resolves explicit ranges and rejects bad ones', () => {
    expect(resolveRange({ from: '2026-11-01' }, '2026-11-20', 'Monday', 'this_week')).toEqual({ from: '2026-11-01', to: '2026-11-20' });
    expect(resolveRange({ to: '2026-11-03' }, '2026-11-20', 'Monday', 'this_week')).toEqual({ from: '2026-11-03', to: '2026-11-03' });
    expect(resolveRange({}, '2026-11-20', 'Monday', 'today')).toEqual({ from: '2026-11-20', to: '2026-11-20' });
    expect(() => resolveRange({ from: '2026-11-10', to: '2026-11-01' }, '2026-11-20', 'Monday', 'today')).toThrow(/after/);
    expect(() => resolveRange({ from: '2026-02-30' }, '2026-11-20', 'Monday', 'today')).toThrow(/real date/);
  });
});

describe('time zones', () => {
  it('maps Harvest zone names to IANA', () => {
    expect(toIanaTimeZone('Chennai')).toBe('Asia/Kolkata');
    expect(toIanaTimeZone('Eastern Time (US & Canada)')).toBe('America/New_York');
    expect(toIanaTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(toIanaTimeZone('Nowhere Land')).toBeUndefined();
    expect(toIanaTimeZone(undefined)).toBeUndefined();
  });
});

describe('name matching', () => {
  const items = [
    { id: 1, name: 'Website Redesign' },
    { id: 2, name: 'Website Maintenance' },
    { id: 3, name: 'Mobile App' },
  ];
  const opts = { kind: 'project', id: (i: { id: number }) => i.id, names: (i: { name: string }) => [i.name], label: (i: { name: string }) => i.name };

  it('matches by ID, exact name, and unique partial words', () => {
    expect(pickOne(items, '3', opts).name).toBe('Mobile App');
    expect(pickOne(items, 'website redesign', opts).id).toBe(1);
    expect(pickOne(items, 'maint', opts).id).toBe(2);
    expect(pickOne(items, 'web redes', opts).id).toBe(1);
  });

  it('explains ambiguous and unknown names', () => {
    expect(() => pickOne(items, 'website', opts)).toThrow(/more than one project: Website Redesign; Website Maintenance/);
    expect(() => pickOne(items, 'zebra', opts)).toThrow(/No project matches "zebra". Available: Website Redesign/);
  });
});
