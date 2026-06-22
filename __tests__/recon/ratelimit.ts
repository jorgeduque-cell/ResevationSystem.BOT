// =========================================================
// RECON: límite de tasa por IP (encuentra el umbral de 429) — CONCURRENTE
//
// Dispara GET /parks/schedules de forma CONCURRENTE (sin esperar a que vuelva
// cada uno), igual que lo hacen los 18 bots juntos. Sube la tasa de disparo
// nivel por nivel hasta que IDRD devuelve 429. Reporta a qué req/s y a qué
// CONCURRENCIA (requests simultáneos en vuelo) empieza el rate-limit.
//
// Por qué concurrente: IDRD tarda ~2s en responder; en secuencia el ritmo se
// topa en ~0.5 req/s y nunca se alcanza el límite real. La carga real del
// sistema viene de muchos requests solapados, no de uno tras otro.
//
// Solo hace GET (lectura). NO reserva nada.
//
// ⚠️ Estresa tu IP a propósito: NO lo corras en la ventana de batalla
//    (lunes 9AM-1PM) ni con el bot principal encendido.
//
// Uso:
//   $env:RECON_COURT_ID='15980'; npm run recon:rate
// =========================================================

import '../../src/config/timezone';
import { loadConfig } from '../../src/config/environment';
import { IdrdApiClient } from '../../src/services/IdrdApiClient';
import { TokenManager } from '../../src/services/TokenManager';
import { getNextDateForDay } from '../../src/utils/date';

// Espaciado entre DISPAROS (ms), de LENTO a RÁPIDO. No esperamos la respuesta:
// a 28ms = ~36 disparos/s, que es el peor caso (18 bots disparando cada ~0.5s).
const INTERVALS_MS = [2000, 1000, 500, 250, 150, 100, 70, 50, 35, 28];
const SECONDS_PER_LEVEL = 6;

interface Limit { intervalMs: number; reqPerSec: number; concurrency: number; }

async function main(): Promise<void> {
  const courtId = Number(process.env.RECON_COURT_ID || process.argv[2]);
  if (!Number.isFinite(courtId) || courtId <= 0) {
    console.error('❌ Falta el court id. Usa:  $env:RECON_COURT_ID=\'15980\'; npm run recon:rate');
    process.exit(1);
  }

  const config = loadConfig();
  const apiClient = new IdrdApiClient(config.idrd.citizenUrl, config.idrd.contractorUrl);
  const tokenManager = new TokenManager(apiClient);

  const account = config.accounts[0];
  console.log(`🔑 Obteniendo token (cuenta ${account.index})...`);
  const token = await tokenManager.ensureToken(account);

  const probeDate = getNextDateForDay(2); // martes próximo: fecha válida cualquiera
  console.log(`\n🎯 Recon CONCURRENTE → court ${courtId}, fecha ${probeDate}`);
  console.log(`   Cada nivel dura ${SECONDS_PER_LEVEL}s. Disparo concurrente (no espero respuesta). Busco el 429.\n`);

  let firstLimit: Limit | null = null;

  for (const intervalMs of INTERVALS_MS) {
    const targetRps = 1000 / intervalMs;
    let launched = 0;
    let ok = 0;
    let rl = 0; // 429
    let other = 0;
    let latSum = 0;
    let inflight = 0;
    let maxInflight = 0;
    const pending: Promise<void>[] = [];
    const levelStart = Date.now();
    const deadline = levelStart + SECONDS_PER_LEVEL * 1000;

    while (Date.now() < deadline) {
      const t0 = Date.now();
      launched++;
      inflight++;
      if (inflight > maxInflight) maxInflight = inflight;
      pending.push(
        apiClient
          .getSchedules(courtId, probeDate, account.document, token)
          .then(() => {
            ok++;
            latSum += Date.now() - t0;
          })
          .catch((err: any) => {
            const s = err?.response?.status;
            if (s === 429) rl++;
            else other++;
          })
          .finally(() => {
            inflight--;
          }),
      );
      // Próximo disparo a espaciado FIJO de reloj (no dependemos de la respuesta).
      const wait = levelStart + launched * intervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    await Promise.allSettled(pending);

    const avgLat = ok > 0 ? Math.round(latSum / ok) : 0;
    const flag = rl > 0 ? '🚫 429' : '✅    ';
    console.log(
      `${flag} ~${targetRps.toFixed(1).padStart(4)} req/s (cada ${String(intervalMs).padStart(4)}ms): ` +
        `lanzadas=${launched} ok=${ok} 429=${rl} otros=${other} | máx en vuelo=${maxInflight} | lat media ${avgLat}ms`,
    );

    if (rl > 0 && !firstLimit) firstLimit = { intervalMs, reqPerSec: targetRps, concurrency: maxInflight };
    if (firstLimit && intervalMs < firstLimit.intervalMs) break; // un nivel más y paramos
  }

  console.log('\n==================== RESULTADO ====================');
  if (firstLimit) {
    console.log(`🚫 El 429 empieza a ~${firstLimit.reqPerSec.toFixed(1)} req/s (≈ ${firstLimit.concurrency} requests simultáneos).`);
    const safeBots = Math.max(1, Math.floor(firstLimit.concurrency * 0.6));
    console.log(`✅ Bots concurrentes SEGUROS por IP (margen 0.6x): ~${safeBots}.`);
    if (safeBots < 18) {
      const ips = Math.ceil(18 / safeBots);
      console.log(`   → 18 bots NO caben en 1 IP. Necesitas ~${ips} conexiones (multi-IP) o concentrar combos.`);
    } else {
      console.log(`   → 18 bots caben en 1 IP. 🎉`);
    }
  } else {
    console.log('✅ No hubo 429 ni al disparo máximo del test (~36 req/s). Tu IP aguanta los 18 bots concurrentes.');
    console.log('   El cuello de botella es la latencia de IDRD (~2s/req), no el rate-limit.');
  }
  console.log('===================================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Recon rate-limit falló:', err?.message || err);
  process.exit(1);
});
