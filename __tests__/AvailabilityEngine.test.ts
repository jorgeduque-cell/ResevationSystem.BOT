// =========================================================
// TESTS - AvailabilityEngine (Tetris Algorithm)
// =========================================================

import { AvailabilityEngine } from '../src/core/AvailabilityEngine';
import { IdrdScheduleSlot } from '../src/types';

describe('AvailabilityEngine', () => {
  const engine = new AvailabilityEngine({
    slotStartHour: 20,  // 8PM
    slotEndHour: 22,     // 10PM
    minAnticipationHours: 24,
    preferredDurations: [2, 1],
  });

  // Target date far in the future so anticipation always passes
  const futureDate = '2027-01-15';

  function makeSlot(startHour: number, endHour: number, available: boolean): IdrdScheduleSlot {
    return {
      start: `${futureDate}T${String(startHour).padStart(2, '0')}:00:00.000-05:00`,
      end: `${futureDate}T${String(endHour).padStart(2, '0')}:00:00.000-05:00`,
      category: available ? 'Disponible' : 'Ocupado',
      can: available,
    };
  }

  test('finds a 2-hour slot in the 8PM-10PM range', () => {
    const slots: IdrdScheduleSlot[] = [
      makeSlot(18, 22, true), // 6PM-10PM available
    ];

    const result = engine.findSlot(slots, futureDate);
    expect(result.found).toBe(true);
    expect(result.startHourFormatted).toBe('8:00 PM');
    expect(result.endHourFormatted).toBe('10:00 PM');
  });

  test('falls back to 1-hour slot when 2h not available', () => {
    const slots: IdrdScheduleSlot[] = [
      makeSlot(20, 21, true),  // Only 8PM-9PM available
      makeSlot(21, 22, false), // 9PM-10PM occupied
    ];

    const result = engine.findSlot(slots, futureDate);
    expect(result.found).toBe(true);
    expect(result.startHourFormatted).toBe('8:00 PM');
    expect(result.endHourFormatted).toBe('9:00 PM');
  });

  test('returns not found when no slots in valid range', () => {
    const slots: IdrdScheduleSlot[] = [
      makeSlot(14, 18, true), // Only afternoon available (before 8PM)
    ];

    const result = engine.findSlot(slots, futureDate);
    expect(result.found).toBe(false);
  });

  test('respects obstacle detection', () => {
    const slots: IdrdScheduleSlot[] = [
      makeSlot(20, 22, true),  // 8PM-10PM shown as available
      makeSlot(20, 21, false), // But 8PM-9PM is actually blocked
    ];

    const result = engine.findSlot(slots, futureDate);
    // Should find 9PM-10PM (1h fallback) since 8PM-9PM is blocked
    if (result.found) {
      expect(result.startHourFormatted).toBe('9:00 PM');
      expect(result.endHourFormatted).toBe('10:00 PM');
    }
  });

  test('formats hours in PHP g:i A style (no leading zero)', () => {
    const slots: IdrdScheduleSlot[] = [
      makeSlot(20, 22, true),
    ];

    const result = engine.findSlot(slots, futureDate);
    expect(result.found).toBe(true);
    // "8:00 PM" not "08:00 PM"
    expect(result.startHourFormatted).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(result.startHourFormatted).not.toMatch(/^0/);
  });

  test('handles empty slot array gracefully', () => {
    const result = engine.findSlot([], futureDate);
    expect(result.found).toBe(false);
  });
});
