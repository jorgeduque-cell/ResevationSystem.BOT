// =========================================================
// RECON: patrón de goteo (dribble) del lunes
//
// Observa /parks/schedules de una cancha y registra, CON TIMESTAMP, cada cambio:
// slots nuevos que aparecen, slots que pasan a disponibles, conteos. Déjalo
// corriendo un lunes 9AM-1PM y tendrás la línea de tiempo EXACTA de cuándo IDRD
// sube horarios → con eso afinamos la estrategia de sprint.
//
// Solo hace GET (lectura). NO reserva. Cadencia tranquila (no banea la IP).
//
// Uso:
//   RECON_COURT_ID=15980 npm run recon:dribble
//   (opcional, fija la fecha a vigilar)  RECON_COURT_ID=15980 RECON_DATE=2026-06-27 npm run recon:dribble
//   Ctrl+C para terminar.
// =========================================================

import '../../src/config/timezone';
import { loadConfig } from '../../src/config/environment';
import { IdrdApiClient } from '../../src/services/IdrdApiClient';
import { TokenManager } from '../../src/services/TokenManager';
import { getNextDateForDay } from '../../src/utils/date';
import { IdrdScheduleSlot } from '../../src/types';

const POLL_INTERVAL_MS = 5000; // tranquilo: aguanta 4h de observación sin banear

function stamp(): string {
  return new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
}

function isAvailable(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/** snapshot: clave "start|end" → disponible(boolean) */
function snapshot(slots: IdrdScheduleSlot[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const s of slots) {
    if (!s.start) continue;
    m.set(`${s.start}|${s.end}`, isAvailable(s.can));
  }
  return m;
}

async function main(): Promise<void> {
  const courtId = Number(process.env.RECON_COURT_ID || process.argv[2]);
  if (!Number.isFinite(courtId) || courtId <= 0) {
    console.error('❌ Falta el court id. Usa:  RECON_COURT_ID=15980 npm run recon:dribble');
    process.exit(1);
  }

  const config = loadConfig();
  const apiClient = new IdrdApiClient(config.idrd.citizenUrl, config.idrd.contractorUrl);
  const tokenManager = new TokenManager(apiClient);
  const account = config.accounts[0];
  let token = await tokenManager.ensureToken(account);

  // IDRD devuelve una ventana de fechas alrededor de la consultada; por defecto
  // anclamos al sábado próximo (día popular), pero el observador registra TODAS
  // las fechas que devuelva, así detecta las nuevas que vayan subiendo.
  const probeDate = process.env.RECON_DATE || getNextDateForDay(6);

  console.log(`[${stamp()}] 🟢 Observando goteo de court ${courtId} (ancla ${probeDate}, cada ${POLL_INTERVAL_MS / 1000}s). Ctrl+C para parar.`);

  let prev: Map<string, boolean> | null = null;

  for (;;) {
    try {
      const slots = await apiClient.getSchedules(courtId, probeDate, account.document, token);
      const cur = snapshot(slots);

      if (prev) {
        for (const [key, can] of cur) {
          if (!prev.has(key)) {
            console.log(`[${stamp()}] ➕ NUEVO slot: ${key}  (disponible=${can})`);
          } else if (prev.get(key) !== can) {
            console.log(`[${stamp()}] 🔁 CAMBIO disponibilidad: ${key}  ${prev.get(key)} → ${can}`);
          }
        }
        for (const key of prev.keys()) {
          if (!cur.has(key)) console.log(`[${stamp()}] ➖ slot desaparecido: ${key}`);
        }
      } else {
        const avail = [...cur.values()].filter(Boolean).length;
        console.log(`[${stamp()}] 📋 Estado inicial: ${cur.size} slots, ${avail} disponibles`);
      }
      prev = cur;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401) {
        console.log(`[${stamp()}] 🔑 401 → refrescando token...`);
        try {
          token = await tokenManager.refreshSingleToken(account);
        } catch {
          /* el próximo ciclo reintenta */
        }
      } else {
        console.log(`[${stamp()}] ⚠️ error ${status || ''}: ${err?.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error('Recon dribble falló:', err?.message || err);
  process.exit(1);
});
