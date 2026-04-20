// =========================================================
// SOLDIER BOT - Reemplazo de "Soldados bots"
// Loop continuo: buscar → reservar → notificar
// Respeta señal de aborto y tiene circuit breaker
// =========================================================

import { Mission, BotExecutionResult, BotStatus } from '../types';
import { IdrdApiClient } from './IdrdApiClient';
import { AvailabilityEngine } from '../core/AvailabilityEngine';
import { TelegramNotifier } from './TelegramNotifier';
import { TokenManager } from './TokenManager';
import { extractPaymentLink, extractPaymentId } from './PaymentService';
import { createBotLogger } from '../utils/logger';
import { isWithinOperatingHours, sleepWithJitter, nowBogota } from '../utils/date';

const MAX_CONSECUTIVE_ERRORS = 10;
const CIRCUIT_BREAKER_PAUSE_MS = 60_000; // 60 seconds

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
    botStartHour: number,
    botStopHour: number,
    signal?: AbortSignal,
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

    log.info(
      `🪖 ${mission.missionId} ACTIVADO - ${mission.account.name} → ${mission.court.parkName}/${mission.court.courtName} (ID ${mission.targetCourtId}) fecha ${mission.targetDate}`
    );

    // ============================
    // MAIN LOOP
    // ============================
    while (isWithinOperatingHours(botStartHour, botStopHour)) {
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

        // 2. Pasar al AvailabilityEngine (Tetris)
        // El endpoint ya retorna solo la cancha objetivo — no hace falta filtrar
        const result = this.availabilityEngine.findSlot(schedules, mission.targetDate);

        if (!result.found) {
          // Log diagnosis every 10 attempts to keep logs readable
          if (slotsChecked === 1 || slotsChecked % 10 === 0) {
            log.info(`Intento #${slotsChecked} sin hueco → ${result.debugInfo}`);
          }
          await sleepWithJitter(1500, 3000);
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

        // 3a. Login JIT (token fresco para la reserva)
        log.info('Haciendo Login JIT para reserva...');
        let freshToken: string;
        try {
          freshToken = await this.tokenManager.refreshSingleToken(mission.account);
        } catch {
          log.error('Login JIT fallido, reintentando con token existente...');
          freshToken = mission.token;
        }

        // 3b. Crear reserva
        log.info('Creando reserva...');
        const reservation = await this.apiClient.createReservation(
          mission.court.parkId,
          mission.targetDate,
          result.startHourFormatted!,
          result.endHourFormatted!,
          mission.account.document,
          freshToken,
        );

        // 3c. Verificar respuesta
        if (reservation.code === 200 || (reservation as any).code === 200) {
          log.info('✅ Reserva exitosa! Generando link de pago...');

          // 3d. Generar link PSE
          try {
            const pseResponse = await this.apiClient.generatePaymentLink(
              reservation.data,
              freshToken,
              {
                name: mission.account.name,
                document: mission.account.document,
                email: mission.account.email,
              },
            );

            log.info({ rawPseResponse: pseResponse }, '🔬 Respuesta cruda del contractor PSE');
            paymentLink = extractPaymentLink(pseResponse);
            const paymentId = extractPaymentId(pseResponse);
            log.info({ paymentLink, paymentId }, '💳 Link de pago generado');
          } catch (pseError: any) {
            log.warn({ error: pseError.message }, 'Error generando link PSE, usando link por defecto');
            paymentLink = 'https://portalciudadano.idrd.gov.co/app/pagos';
          }

          // 3e. Notificar por Telegram (rich format, spec-compliant)
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
          log.info(`🏆 ${mission.missionId} RESERVA #${reservationCount} EXITOSA. Continuando búsqueda...`);
          await sleepWithJitter(3000, 5000);
        } else {
          log.warn({ code: reservation.code }, 'Reserva devolvió código != 200, reintentando...');
          await sleepWithJitter(1500, 3000);
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

    // Operating hours ended
    if (status === 'searching') {
      status = 'stopped';
      log.info(`⏰ ${mission.missionId} - Ventana de operación terminada (${botStopHour}:00). Total intentos: ${slotsChecked}`);
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
