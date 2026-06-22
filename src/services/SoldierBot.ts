// =========================================================
// SOLDIER BOT - Reemplazo de "Soldados bots"
// Loop continuo: buscar → reservar → notificar
// Respeta señal de aborto y tiene circuit breaker
// =========================================================

import { Mission, BotExecutionResult, BotStatus, IdrdScheduleSlot, IdrdReservationResponse } from '../types';
import { IdrdApiClient } from './IdrdApiClient';
import { AvailabilityEngine } from '../core/AvailabilityEngine';
import { TelegramNotifier } from './TelegramNotifier';
import { TokenManager } from './TokenManager';
import { extractPaymentLink, extractPaymentId } from './PaymentService';
import { createBotLogger } from '../utils/logger';
import { sleepWithJitter } from '../utils/date';

const MAX_CONSECUTIVE_ERRORS = 10;
const CIRCUIT_BREAKER_PAUSE_MS = 60_000; // 60 seconds
const LOGIN_STAGGER_MS = 200; // initial logins spaced by accountIndex * this

// Re-búsqueda tras reservar: el bot NO se detiene. IDRD libera el slot por
// tiempo (p. ej. si no se completa el pago), así que seguimos sondeando para
// re-reservarlo apenas reaparezca. Cadencia MODERADA (~3-5s) para no disparar
// 429 (Too Many Requests) desde una sola IP residencial; aun así la reacción
// queda por debajo de 10s cuando el slot reaparece.
const REPOLL_AFTER_RESERVE_MIN_MS = 3000;
const REPOLL_AFTER_RESERVE_MAX_MS = 5000;

// PERSISTENCIA del claim: cuando encontramos un slot, está libre AHORA. Si la
// reserva falla por saturación (5xx/timeout/contención momentánea — IDRD ahogado
// en el pico del lunes), reintentamos el POST RÁPIDO unas pocas veces antes de
// volver a sondear, en vez de esperar varios segundos y perder el slot.
const CLAIM_MAX_ATTEMPTS = 4;
const CLAIM_RETRY_MIN_MS = 150;
const CLAIM_RETRY_MAX_MS = 400;

// Cadencia REACTIVA por NIVELES (todas las misiones comparten el coordinador):
//  - BURST: una misión ACABA de ver subir un slot (cascada en curso, el día
//    cayó hace segundos) → sub-segundo para cazarlo al instante.
//  - RELEASE: la ventana de liberación del lunes sigue ABIERTA (los slots
//    suben goteando durante ~4h, día por día) → sondeo rápido SOSTENIBLE; NO
//    volvemos a la cadencia lenta mientras la cascada siga viva. Cada nuevo
//    movimiento RENUEVA la ventana.
//  - IDLE: nada se mueve (antes de las 9AM o ya terminó la cascada) → lento,
//    barato, sin machacar la IP.
// Ajustar los rangos con el resultado del recon de rate-limit.
const BURST_POLL_MIN_MS = 350;
const BURST_POLL_MAX_MS = 800;
const RELEASE_POLL_MIN_MS = 1000;
const RELEASE_POLL_MAX_MS = 1800;
const IDLE_POLL_MIN_MS = 3000;
const IDLE_POLL_MAX_MS = 5000;
// "Acaba de caer un slot": hubo movimiento en los últimos N ms → modo BURST.
const FRESH_MOVEMENT_MS = 20_000;
// La ventana RELEASE se mantiene abierta hasta este tiempo SIN ningún
// movimiento. Cubre las pausas entre día y día de la cascada (~4h totales);
// solo decae a IDLE cuando la cascada lleva rato totalmente quieta.
const RELEASE_WINDOW_MS = 30 * 60_000;

/**
 * Firma del estado reservable de una fecha objetivo. Si IDRD sube, libera o
 * cambia cualquier slot de esa fecha, la firma cambia — esa es la señal de
 * "movimiento" que dispara el sprint reactivo. Solo miramos la fecha objetivo
 * del bot (las otras fechas las vigilan los demás bots).
 */
function scheduleSignature(slots: IdrdScheduleSlot[], targetDate: string): string {
  return slots
    .filter((s) => s.start?.startsWith(targetDate))
    .map((s) => `${s.start}|${s.end}|${s.can}`)
    .sort()
    .join(',');
}

/**
 * Coordinador de SPRINT compartido por TODAS las misiones. IDRD sube los
 * horarios en orden CRONOLÓGICO (primero martes, luego miércoles, ...). Apenas
 * UNA misión detecta que subió/cambió un espacio, TODAS deben pasar a sondeo
 * sub-segundo: el resto de días cae en cascada en segundos y todos los usuarios
 * ya están recargando. Esta es la única fuente de verdad del "hasta cuándo
 * sprintar", compartida entre los 18 SoldierBot.
 */
export class SprintCoordinator {
  private lastMovementAt = 0;
  private releaseUntil = 0;

  /**
   * Una misión detectó que IDRD subió/cambió un espacio. Marca el instante
   * (para el BURST sub-segundo) y EXTIENDE la ventana de liberación: mientras
   * sigan apareciendo slots (cascada del lunes), seguimos en modo rápido. La
   * ventana solo decae tras `releaseWindowMs` sin ningún movimiento.
   */
  noteMovement(releaseWindowMs: number): void {
    const now = Date.now();
    this.lastMovementAt = now;
    this.releaseUntil = now + releaseWindowMs;
  }

  /**
   * Nivel de cadencia actual:
   *  - 'burst'   → hubo movimiento hace < freshMs (un día acaba de caer)
   *  - 'release' → la ventana de liberación sigue abierta (cascada viva)
   *  - 'idle'    → todo quieto
   */
  tier(freshMs: number): 'burst' | 'release' | 'idle' {
    const now = Date.now();
    if (now - this.lastMovementAt < freshMs) return 'burst';
    if (now < this.releaseUntil) return 'release';
    return 'idle';
  }
}

export class SoldierBot {
  private apiClient: IdrdApiClient;
  private availabilityEngine: AvailabilityEngine;
  private telegram: TelegramNotifier;
  private tokenManager: TokenManager;
  private isDryRun: boolean;

  constructor(
    apiClient: IdrdApiClient,
    availabilityEngine: AvailabilityEngine,
    telegram: TelegramNotifier,
    tokenManager: TokenManager,
    isDryRun: boolean = false,
  ) {
    this.apiClient = apiClient;
    this.availabilityEngine = availabilityEngine;
    this.telegram = telegram;
    this.tokenManager = tokenManager;
    this.isDryRun = isDryRun;
  }

  /**
   * Executes a mission in a continuous loop until:
   * - Slot is found and reserved → exits with 'completed'
   * - Operating hours end → exits with 'stopped'
   * - AbortSignal fires → exits with 'aborted'
   * - Circuit breaker trips after too many consecutive errors
   */
  async execute(
    mission: Mission,
    signal?: AbortSignal,
    sprint: SprintCoordinator = new SprintCoordinator(),
  ): Promise<BotExecutionResult> {
    const log = createBotLogger(mission.missionId, `${mission.court.parkName}/${mission.court.courtName}`);
    const startedAt = new Date().toISOString();
    let status: BotStatus = 'searching';
    let slotsChecked = 0;
    let consecutiveErrors = 0;
    let reservationCount = 0;
    let paymentLink: string | undefined;
    const paymentLinks: string[] = [];
    let errorMsg: string | undefined;
    // Cadencia reactiva: firma del último horario visto por ESTA misión (la
    // detección de movimiento es por-fecha). El "hasta cuándo sprintar" es
    // GLOBAL (lo comparte el SprintCoordinator entre las 18 misiones).
    let lastSignature = '';

    log.info(
      `🪖 ${mission.missionId} ACTIVADO - ${mission.account.name} → ${mission.court.parkName}/${mission.court.courtName} (ID ${mission.targetCourtId}) fecha ${mission.targetDate}`
    );

    // ============================
    // STARTUP: cada bot asegura su PROPIO token, independiente del resto.
    // Usa caché si sirve; si no, loguea solo esta cuenta (escalonado por índice
    // para no disparar 18 POST /login simultáneos). Si falla, NO abortamos: el
    // loop recupera vía el manejo de 401 más abajo. Una cuenta caída nunca
    // bloquea ni reinicia a las otras 17.
    // ============================
    if (!signal?.aborted) {
      try {
        const staggerMs = (mission.account.index - 1) * LOGIN_STAGGER_MS;
        mission.token = await this.tokenManager.ensureToken(mission.account, staggerMs);
      } catch (err: any) {
        log.warn(
          { err: err.message },
          'No se pudo obtener token inicial; el loop intentará recuperar vía 401',
        );
      }
    }

    // ============================
    // MAIN LOOP
    // ============================
    while (true) {
      // === CHECK ABORT SIGNAL ===
      if (signal?.aborted) {
        status = 'aborted';
        log.info(`🛑 ${mission.missionId} - Señal de aborto recibida. Deteniendo bot.`);
        break;
      }

      try {
        // 1. Consultar disponibilidad
        log.info(`Consultando disponibilidad para ${mission.targetDate}...`);

        const schedules = await this.apiClient.getSchedules(
          mission.court.parkId,
          mission.targetDate,
          mission.account.document,
          mission.token,
        );

        slotsChecked++;
        consecutiveErrors = 0; // Reset on success

        // On the first attempt always dump a sample of the raw response so the
        // operator can verify field names / shape without needing env vars.
        if (slotsChecked === 1) {
          const sampleForDate = schedules.filter((s) => s.start?.startsWith(mission.targetDate));
          const uniqueDates = Array.from(
            new Set(schedules.map((s) => s.start?.slice(0, 10)).filter(Boolean)),
          ).sort();
          log.info(
            {
              totalSlots: schedules.length,
              targetDate: mission.targetDate,
              slotsForTargetDate: sampleForDate.length,
              datesReturnedByIdrd: uniqueDates,
              sampleKeys: schedules[0] ? Object.keys(schedules[0]) : [],
              first3Any: schedules.slice(0, 3),
            },
            '🔍 Muestra de slots crudos IDRD (primer intento)',
          );
        }

        // === Detección de MOVIMIENTO → SPRINT GLOBAL (cadencia reactiva) ===
        // Si la firma del horario de ESTA fecha cambió respecto al sondeo
        // anterior, IDRD acaba de subir/cambiar slots. Como sube en cascada
        // cronológica, encendemos el sprint GLOBAL: TODAS las misiones pasan a
        // sub-segundo para cazar los días que están por caer en los segundos
        // siguientes, no solo la de esta fecha.
        const signature = scheduleSignature(schedules, mission.targetDate);
        if (lastSignature !== '' && signature !== lastSignature) {
          sprint.noteMovement(RELEASE_WINDOW_MS);
          log.info(
            `👀 ¡Movimiento en el horario de ${mission.targetDate}! → modo RÁPIDO global (cascada en curso; ventana renovada ${RELEASE_WINDOW_MS / 60000}min)`,
          );
        }
        lastSignature = signature;

        // 2. Pasar al AvailabilityEngine (Tetris)
        // El endpoint ya retorna solo la cancha objetivo — no hace falta filtrar
        const result = this.availabilityEngine.findSlot(schedules, mission.targetDate);

        if (!result.found) {
          // Log diagnosis every 10 attempts to keep logs readable
          if (slotsChecked === 1 || slotsChecked % 10 === 0) {
            const mode = reservationCount > 0 ? '🔁 re-búsqueda activa' : 'búsqueda';
            log.info(
              `Intento #${slotsChecked} sin hueco (${mode}, ${reservationCount} reservas previas) → ${result.debugInfo}`,
            );
          }
          // Cadencia REACTIVA por nivel GLOBAL: BURST (un slot acaba de caer),
          // RELEASE (cascada del lunes aún abierta — NO bajamos a lento), o IDLE
          // (todo quieto). Apenas sube el primer espacio, TODAS las misiones se
          // mantienen rápidas durante toda la cascada, no solo 90s.
          const tier = sprint.tier(FRESH_MOVEMENT_MS);
          const [pollMin, pollMax] =
            tier === 'burst'
              ? [BURST_POLL_MIN_MS, BURST_POLL_MAX_MS]
              : tier === 'release'
                ? [RELEASE_POLL_MIN_MS, RELEASE_POLL_MAX_MS]
                : [IDLE_POLL_MIN_MS, IDLE_POLL_MAX_MS];
          await sleepWithJitter(pollMin, pollMax);
          continue;
        }

        // ============================
        // 3. ¡ENCONTRÓ SLOT!
        // ============================
        log.info(
          `🎯 ¡SLOT ENCONTRADO! ${result.startHourFormatted} - ${result.endHourFormatted} (${result.dateFormatted})`
        );

        if (this.isDryRun) {
          reservationCount++;
          log.info(`🧪 DRY RUN - Slot #${reservationCount} encontrado. Continuando búsqueda...`);
          await sleepWithJitter(3000, 5000);
          continue;
        }

        // 3a. Crear reserva inmediatamente con el token de la misión.
        // El token IDRD vale 8h, así que reutilizarlo es seguro durante toda
        // la sesión. El antiguo "Login JIT" agregaba un POST /login en el hot
        // path crítico de la reserva, justo al mismo endpoint que se satura
        // los lunes 9 AM — perdíamos segundos a manos de usuarios humanos
        // mientras esperábamos un token "fresco" innecesario. Si el token
        // realmente expira, el catch de 401 más abajo lo refresca y reintenta.
        // PERSISTENCIA: el slot está libre AHORA. Reintentamos el claim rápido
        // ante 5xx/timeout/contención (IDRD ahogado en el pico) antes de rendirnos.
        log.info('Creando reserva (con persistencia)...');
        let reservation: IdrdReservationResponse | null = null;
        for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt++) {
          try {
            const r = await this.apiClient.createReservation(
              mission.court.parkId,
              mission.targetDate,
              result.startHourFormatted!,
              result.endHourFormatted!,
              mission.account.document,
              mission.token,
            );
            if (r.code === 200) {
              reservation = r;
              break;
            }
            log.warn({ code: r.code, attempt }, 'Reserva != 200; reintentando claim rápido...');
          } catch (claimErr: any) {
            const status = claimErr?.response?.status;
            // Un 401 lo maneja el catch externo (refresca token y reintenta).
            if (status === 401) throw claimErr;
            log.warn({ attempt, status, err: claimErr.message }, 'Claim falló; reintentando rápido...');
          }
          if (attempt < CLAIM_MAX_ATTEMPTS) await sleepWithJitter(CLAIM_RETRY_MIN_MS, CLAIM_RETRY_MAX_MS);
        }

        // 3b. Verificar respuesta
        if (reservation) {
          log.info('✅ Reserva exitosa! Generando link de pago...');

          // 3c. Generar link PSE con reintentos.
          // Bajo carga alta, el contractor PSE a veces responde 200 con body
          // vacío/malformado, o tira 5xx/timeout. Reintentamos hasta 5 veces
          // exigiendo una URL real (no el fallback genérico de extractPaymentLink).
          // Si igual no logramos una URL útil, devolvemos un mensaje accionable
          // con el booking_id en vez del link genérico que llevaría al usuario
          // a una página donde no puede pagar.
          const FALLBACK_PORTAL_URL = 'https://portalciudadano.idrd.gov.co/app/pagos';
          const PSE_MAX_ATTEMPTS = 5;
          let realPseLink: string | undefined;
          for (let attempt = 1; attempt <= PSE_MAX_ATTEMPTS; attempt++) {
            try {
              const pseResponse = await this.apiClient.generatePaymentLink(
                reservation.data,
                mission.token,
                {
                  name: mission.account.name,
                  document: mission.account.document,
                  email: mission.account.email,
                },
              );
              const candidate = extractPaymentLink(pseResponse);
              if (candidate && candidate !== FALLBACK_PORTAL_URL) {
                realPseLink = candidate;
                const paymentId = extractPaymentId(pseResponse);
                log.info({ paymentLink: realPseLink, paymentId, attempt }, '💳 Link de pago generado');
                break;
              }
              log.warn({ attempt }, 'PSE respondió sin URL útil, reintentando...');
            } catch (pseError: any) {
              log.warn({ attempt, error: pseError.message }, 'Error generando link PSE');
            }
            if (attempt < PSE_MAX_ATTEMPTS) await sleepWithJitter(400, 900);
          }

          if (realPseLink) {
            paymentLink = realPseLink;
          } else {
            const bookingId = reservation.data?.booking_id ?? 'desconocido';
            log.error({ bookingId }, '❌ PSE falló tras 5 intentos — enviando link manual con booking_id');
            paymentLink = `${FALLBACK_PORTAL_URL} — busca tu reserva #${bookingId} en "Mis reservas"`;
          }

          // 3d. Notificar por Telegram (rich format, spec-compliant)
          const price = reservation.data?.amount ?? result.price;
          await this.telegram.notifyCourtFound({
            userName: mission.account.name,
            courtName: mission.court.courtName,
            courtId: mission.targetCourtId,
            parkName: mission.court.parkName,
            date: mission.targetDate,
            timeSlot: `${result.startHourFormatted} - ${result.endHourFormatted}`,
            price,
            paymentLink: paymentLink!,
          });

          reservationCount++;
          paymentLinks.push(paymentLink!);
          log.info(
            `🏆 ${mission.missionId} RESERVA #${reservationCount} EXITOSA (${result.startHourFormatted} - ${result.endHourFormatted}). ` +
              `Re-búsqueda activa: NO paramos. Si IDRD libera el slot por tiempo, lo re-reservamos en segundos.`,
          );
          // El bot NUNCA se detiene tras reservar. IDRD mantiene el slot bloqueado
          // un rato y luego lo libera por tiempo (si no se completa el pago).
          // Seguimos sondeando a cadencia moderada (~3-5s) para volver a tomarlo
          // apenas reaparezca en getSchedules — reacción por debajo de los 10s.
          await sleepWithJitter(REPOLL_AFTER_RESERVE_MIN_MS, REPOLL_AFTER_RESERVE_MAX_MS);
          continue;
        } else {
          // No concretamos el claim tras los reintentos rápidos (slot tomado o
          // IDRD ahogado). Volvemos a sondear de inmediato: si el slot sigue o
          // queda libre, lo reintentamos. No lo contamos como error de ciclo.
          log.warn(`No se concretó la reserva tras ${CLAIM_MAX_ATTEMPTS} intentos rápidos; vuelvo a sondear.`);
          await sleepWithJitter(BURST_POLL_MIN_MS, BURST_POLL_MAX_MS);
          continue;
        }
      } catch (error: any) {
        slotsChecked++;
        consecutiveErrors++;
        log.error(
          {
            error: error.message,
            consecutiveErrors,
            httpStatus: error?.response?.status,
            apiResponse: error?.response?.data,
            requestUrl: error?.config?.url,
            requestPayload: error?.config?.data,
          },
          `Error en intento #${slotsChecked}`,
        );

        // If it's a 401, try to refresh the token
        if (error?.response?.status === 401) {
          log.warn('Token expirado, refrescando...');
          try {
            mission.token = await this.tokenManager.refreshSingleToken(mission.account);
            log.info('Token refrescado exitosamente');
            consecutiveErrors = 0; // Token refreshed, reset counter
          } catch {
            log.error('No se pudo refrescar el token');
          }
        }

        // === CIRCUIT BREAKER ===
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log.warn(
            `⚡ Circuit breaker: ${consecutiveErrors} errores consecutivos. Pausando ${CIRCUIT_BREAKER_PAUSE_MS / 1000}s...`
          );
          await sleepWithJitter(CIRCUIT_BREAKER_PAUSE_MS, CIRCUIT_BREAKER_PAUSE_MS + 5000);
          consecutiveErrors = 0; // Reset after pause

          // Try a fresh token after circuit breaker pause
          try {
            mission.token = await this.tokenManager.refreshSingleToken(mission.account);
            log.info('Token refrescado después de pausa del circuit breaker');
          } catch {
            log.error('No se pudo refrescar el token después del circuit breaker');
          }
        } else {
          await sleepWithJitter(2000, 5000);
        }
      }
    }

    return {
      missionId: mission.missionId,
      status,
      account: mission.account.name,
      park: mission.court.parkName,
      courtId: mission.targetCourtId,
      courtName: mission.court.courtName,
      targetDate: mission.targetDate,
      slotsChecked,
      reservationMade: reservationCount > 0,
      reservationCount,
      paymentLink,
      paymentLinks,
      error: errorMsg,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}
