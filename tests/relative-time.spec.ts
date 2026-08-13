import { test, expect } from '@playwright/test';
import { relativeTimeBucket, parseCreatedAt } from '../frontend/src/lib/time';

test.describe('relativeTimeBucket', () => {
  const NOW = new Date('2026-08-14T00:30:00Z');

  test('parses DB UTC string and computes hours across midnight', () => {
    // created 23:30 UTC Aug 13, now 00:30 UTC Aug 14 → 1 hour
    expect(relativeTimeBucket('2026-08-13 23:30:00', NOW))
      .toEqual({ kind: 'relative', unit: 'hour', value: 1 });
  });

  test('59 seconds stays in seconds; 60 seconds becomes 1 minute', () => {
    expect(relativeTimeBucket('2026-08-14 00:29:01', NOW))
      .toEqual({ kind: 'relative', unit: 'second', value: 59 });
    expect(relativeTimeBucket('2026-08-14 00:29:00', NOW))
      .toEqual({ kind: 'relative', unit: 'minute', value: 1 });
  });

  test('23h59m is hours; 24h becomes 1 day', () => {
    expect(relativeTimeBucket('2026-08-13 00:30:00', NOW))
      .toEqual({ kind: 'relative', unit: 'day', value: 1 });
    expect(relativeTimeBucket('2026-08-14 00:29:00', new Date('2026-08-15T00:28:59Z')))
      .toEqual({ kind: 'relative', unit: 'hour', value: 23 });
  });

  test('7 days or older returns local date', () => {
    const parsed = parseCreatedAt('2026-08-07 00:00:00')!;
    const expected = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
    expect(relativeTimeBucket('2026-08-07 00:00:00', NOW))
      .toEqual({ kind: 'date', date: expected });
  });

  test('unparseable input returns invalid with raw value', () => {
    expect(relativeTimeBucket('not-a-date', NOW))
      .toEqual({ kind: 'invalid', raw: 'not-a-date' });
  });

  test('parseCreatedAt converts space-separated UTC to Date', () => {
    expect(parseCreatedAt('2026-08-13 09:32:42')?.toISOString())
      .toBe('2026-08-13T09:32:42.000Z');
    expect(parseCreatedAt('garbage')).toBeNull();
  });
});
