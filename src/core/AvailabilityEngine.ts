// =========================================================
// AVAILABILITY ENGINE - Algoritmo "Tetris" de búsqueda
// Extraído y tipado del nodo "Code in JavaScript" de n8n
// =========================================================

import { IdrdScheduleSlot, SlotResult } from '../types';
import { formatHourPhp } from '../utils/date';

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
  findSlot(slots: IdrdScheduleSlot[], targetDate: string): SlotResult {
    // 1. Map obstacles (non-available slots)
    const obstacles: Obstacle[] = [];
    slots.forEach((slot) => {
      if (slot.can === false || slot.category !== 'Disponible') {
        obstacles.push({
          start: new Date(slot.start).getTime(),
          end: new Date(slot.end).getTime(),
        });
      }
    });

    // 2. Filter available blocks for the target date
    const availableBlocks = slots.filter((slot) => {
      if (!slot.start) return false;
      return (
        slot.category === 'Disponible' &&
        slot.can === true &&
        slot.start.startsWith(targetDate)
      );
    });

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
      return {
        found: true,
        debugInfo: '¡Cancha encontrada!',
        startTime: candidateStart,
        endTime: candidateEnd,
        dateFormatted: candidateStart.toISOString().split('T')[0],
        startHourFormatted: formatHourPhp(candidateStart),
        endHourFormatted: formatHourPhp(candidateEnd),
      };
    }

    return {
      found: false,
      debugInfo: `No hay huecos para ${targetDate} en rango ${this.config.slotStartHour}:00-${this.config.slotEndHour}:00`,
    };
  }
}
