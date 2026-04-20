// =========================================================
// COURT CATALOG - Validates a user-supplied court (escenario) id
// by calling the IDRD schedules endpoint directly. The ID in the
// URL /app/reservas/{ID}/reservar is itself the scenary id used
// by /parks/schedules/{ID} — there is no separate parkId lookup.
// =========================================================

import { CourtInfo, IdrdScheduleSlot, AccountConfig } from '../types';
import { IdrdApiClient } from './IdrdApiClient';
import { getNextDateForDay } from '../utils/date';
import { logger } from '../utils/logger';

/** Extract scenary/court id from a schedule slot (for debug/enrichment only) */
export function extractCourtId(slot: IdrdScheduleSlot): string | undefined {
  const raw = slot.scenary_id ?? slot.court_id;
  return raw !== undefined && raw !== null ? String(raw) : undefined;
}

/** Extract a human-readable name from a schedule slot if present */
export function extractCourtName(slot: IdrdScheduleSlot): string | undefined {
  return slot.scenary_name ?? slot.court_name ?? slot.title;
}

export class CourtCatalog {
  private cache: Map<string, CourtInfo> = new Map();

  constructor(private apiClient: IdrdApiClient) {}

  /**
   * Validate a court id by calling /parks/schedules/{id}.
   *   - 200 OK (any payload)        → id exists
   *   - 404 / network error         → id invalid
   * We try to enrich courtName/parkName from the slot metadata if the
   * IDRD response provides it; otherwise we fall back to "Cancha {id}".
   */
  async resolve(
    courtId: string,
    probeAccount: AccountConfig,
    probeToken: string,
    userProvidedName?: string,
  ): Promise<CourtInfo | null> {
    const cached = this.cache.get(courtId);
    if (cached) {
      // Refresh with user-provided name if we now have one
      if (userProvidedName) {
        return { ...cached, parkName: userProvidedName, courtName: userProvidedName };
      }
      return cached;
    }

    const numericId = Number(courtId);
    if (!Number.isFinite(numericId)) return null;

    const probeDate = getNextDateForDay(2); // next Tuesday — arbitrary valid date

    try {
      const slots = await this.apiClient.getSchedules(
        numericId,
        probeDate,
        probeAccount.document,
        probeToken,
      );

      // Endpoint responded → id is valid (even if no free slots today)
      const sample = slots[0];
      const info: CourtInfo = {
        courtId,
        parkId: numericId,
        parkName: userProvidedName || sample?.scenary_name || 'Parque IDRD',
        courtName: userProvidedName || (sample && extractCourtName(sample)) || `Cancha ${courtId}`,
      };
      this.cache.set(courtId, info);
      logger.info({ courtId, slots: slots.length, userProvidedName }, '✅ Cancha validada en IDRD');
      return info;
    } catch (err: any) {
      const status = err?.response?.status;
      logger.warn(
        { courtId, status, err: err.message },
        '⚠️ courtId no válido o endpoint falló',
      );
      return null;
    }
  }

  async resolveAll(
    courts: Array<{ id: string; name?: string }>,
    probeAccount: AccountConfig,
    probeToken: string,
  ): Promise<Array<CourtInfo | null>> {
    return Promise.all(courts.map((c) => this.resolve(c.id, probeAccount, probeToken, c.name)));
  }
}
