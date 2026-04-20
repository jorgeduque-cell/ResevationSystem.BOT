// =========================================================
// AVAILABILITY ENGINE - Algoritmo "Tetris" de búsqueda
// Extraído y tipado del nodo "Code in JavaScript" de n8n
// =========================================================

import { IdrdScheduleSlot, SlotResult } from '../types';
import { formatHourPhp, toIsoDate } from '../utils/date';
import { extractCourtId } from '../services/CourtCatalog';

interface AvailabilityConfig {
  slotStartHour: number;  // 20 (8PM)
  slotEndHour: number;    // 22 (10PM)
  minAnticipationHours: number; // 24
  preferredDurations: number[]; // [2, 1] hours
}

interface Obstacle {
  start: number; // timestamp ms
  end: number;   // timestamp ms
}

export class AvailabilityEngine {
  private config: AvailabilityConfig;

  constructor(config: AvailabilityConfig) {
    this.config = config;
  }

  /**
   * Finds the best available slot for a given date
   * Replicates the exact Tetris algorithm from the n8n Soldados bots
   *
   * @param slots Raw schedule data from IDRD API
   * @param targetDate YYYY-MM-DD format
   * @returns SlotResult with found status and slot details
   */
  findSlot(slots: IdrdScheduleSlot[], targetDate: string, targetCourtId?: string): SlotResult {
    // Pre-filter by court if specified — a park's schedule mixes many courts
    const courtSlots = targetCourtId
      ? slots.filter((s) => extractCourtId(s) === targetCourtId)
      : slots;

    // Defensive truthy check — IDRD has shipped `can` as both boolean and
    // stringified booleans across endpoints. Treat anything that equals true,
    // "true" or 1 as reservable.
    const isAvailable = (v: unknown): boolean => v === true || v === 'true' || v === 1 || v === '1';
    const isBlocked = (v: unknown): boolean => v === false || v === 'false' || v === 0 || v === '0';

    // 1. Map obstacles — slots explicitly marked as NOT bookable
    const obstacles: Obstacle[] = [];
    courtSlots.forEach((slot) => {
      if (isBlocked(slot.can)) {
        obstacles.push({
          start: new Date(slot.start).getTime(),
          end: new Date(slot.end).getTime(),
        });
      }
    });

    // 2. Filter available blocks for the target date
    const slotsForDate = courtSlots.filter((s) => s.start?.startsWith(targetDate));
    const availableBlocks = slotsForDate.filter((slot) => isAvailable(slot.can));

    // 3. Tetris algorithm: try to fit durations in priority order
    const nowMs = Date.now();
    let candidateStart: Date | null = null;
    let candidateEnd: Date | null = null;

    for (const duration of this.config.preferredDurations) {
      if (candidateStart) break;

      for (const block of availableBlocks) {
        if (candidateStart) break;

        let currentTime = new Date(block.start).getTime();
        const blockEnd = new Date(block.end).getTime();
        const durationMs = duration * 3600000; // hours to ms

        while (currentTime + durationMs <= blockEnd) {
          const attemptStart = currentTime;
          const attemptEnd = currentTime + durationMs;

          const startHour = new Date(attemptStart).getHours();
          const endHour = new Date(attemptEnd).getHours();

          // Validate time range (8PM - 10PM)
          const endValid =
            (endHour <= this.config.slotEndHour && endHour !== 0) ||
            (endHour === 0 && this.config.slotEndHour >= 22);

          const meetsSchedule =
            startHour >= this.config.slotStartHour && endValid;

          // Validate anticipation (>= 24h from now)
          const hoursUntil = (attemptStart - nowMs) / 3600000;
          const meetsAnticipation = hoursUntil >= this.config.minAnticipationHours;

          if (meetsSchedule && meetsAnticipation) {
            // Check for collisions with obstacles
            const hasCollision = obstacles.some((obs) => {
              return attemptStart < obs.end && attemptEnd > obs.start;
            });

            if (!hasCollision) {
              candidateStart = new Date(attemptStart);
              candidateEnd = new Date(attemptEnd);
              break;
            }
          }

          currentTime += 3600000; // 1-hour steps
        }
      }
    }

    // 4. Build result
    if (candidateStart && candidateEnd) {
      // Find the block we landed in to recover its court/price metadata
      const matchedBlock = availableBlocks.find((b) => {
        const s = new Date(b.start).getTime();
        const e = new Date(b.end).getTime();
        return candidateStart!.getTime() >= s && candidateEnd!.getTime() <= e;
      });
      return {
        found: true,
        debugInfo: '¡Cancha encontrada!',
        startTime: candidateStart,
        endTime: candidateEnd,
        dateFormatted: toIsoDate(candidateStart),
        startHourFormatted: formatHourPhp(candidateStart),
        endHourFormatted: formatHourPhp(candidateEnd),
        matchedCourtId: matchedBlock ? extractCourtId(matchedBlock) : targetCourtId,
        price: matchedBlock?.price ?? matchedBlock?.amount,
      };
    }

    // Rich diagnostic: why didn't we find anything?
    const nowMs2 = Date.now();
    const inWindow = availableBlocks.filter((b) => {
      const sh = new Date(b.start).getHours();
      const eh = new Date(b.end).getHours();
      return sh >= this.config.slotStartHour &&
        ((eh <= this.config.slotEndHour && eh !== 0) || (eh === 0 && this.config.slotEndHour >= 22));
    });
    const meetAnticipation = availableBlocks.filter(
      (b) => (new Date(b.start).getTime() - nowMs2) / 3600000 >= this.config.minAnticipationHours,
    );

    return {
      found: false,
      debugInfo:
        `date=${targetDate} ` +
        `slots_total=${slots.length} ` +
        `slots_date=${slotsForDate.length} ` +
        `available=${availableBlocks.length} ` +
        `in_window_${this.config.slotStartHour}-${this.config.slotEndHour}=${inWindow.length} ` +
        `meets_anticipation_${this.config.minAnticipationHours}h=${meetAnticipation.length}`,
    };
  }
}
