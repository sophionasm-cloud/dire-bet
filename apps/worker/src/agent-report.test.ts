import { describe, expect, it } from 'vitest';
import { addisWeekStart } from './agent-report';

describe('addisWeekStart', () => {
  it('uses the Addis calendar date just after Monday midnight', () => {
    expect(addisWeekStart(Date.parse('2026-11-15T21:30:00Z'))).toBe('2026-11-16');
  });

  it('keeps Sunday night in the week that started on Monday', () => {
    expect(addisWeekStart(Date.parse('2026-11-22T20:59:59Z'))).toBe('2026-11-16');
  });

  it('starts a new week at Addis midnight on Monday', () => {
    expect(addisWeekStart(Date.parse('2026-11-22T21:00:00Z'))).toBe('2026-11-23');
  });
});
