import { describe, expect, it } from 'vitest';
import { costThreshold, utcCostPeriod } from './observability';

describe('UTC cost periods and thresholds', () => {
  it('uses UTC month/day boundaries across offsets and leap years', () => {
    const period = utcCostPeriod(new Date('2024-03-01T02:00:00+05:30'));
    expect(period.start.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(period.day.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(period.daysInMonth).toBe(29);
  });
  it('avoids a division by zero or a minute-long forecast baseline', () => {
    expect(utcCostPeriod(new Date('2026-11-01T00:01:00Z')).elapsedDays).toBe(1);
    expect(costThreshold('day', 0, 0, [50, 80, 100])).toMatchObject({
      percentUsed: null,
      reached: [],
    });
    expect(costThreshold('day', 0, 1, [100])).toMatchObject({ percentUsed: null, reached: [100] });
    expect(() => utcCostPeriod(new Date('invalid'))).toThrow();
  });
  it('sorts/deduplicates crossings including an exact boundary', () => {
    expect(costThreshold('month', 20, 16, [100, 80, 50, 80])).toMatchObject({
      percentUsed: 80,
      reached: [50, 80],
    });
    expect(() => costThreshold('month', -1, 0, [50])).toThrow();
  });
});
