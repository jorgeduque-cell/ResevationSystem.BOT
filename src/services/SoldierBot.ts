// =========================================================
// SOLDIER BOT - Reemplazo de "Soldados bots"
// Loop continuo: buscar → reservar → notificar
// Corre de 9AM a 1PM sin límite de intentos
// =========================================================

import { Mission, BotExecutionResult, BotStatus } from '../types';
import { IdrdApiClient } from './IdrdApiClient';
import { AvailabilityEngine } from '../core/AvailabilityEngine';
import { TelegramNotifier } from './TelegramNotifier';
import { TokenManager } from './TokenManager';
import { extractPaymentLink, extractPaymentId } from './PaymentService';
import { createBotLogger } from '../utils/logger';
import { isWithinOperatingHours, sleepWithJitter, nowBogota } from '../utils/date';

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
   * - Operating hours end (1PM) → exits with 'stopped'
   */
  async execute(
    mission: Mission,
    botStartHour: number,
    botStopHour: number,
  ): Promise<BotExecutionResult> {
    const log = createBotLogger(mission.missionId, mission.park.name);
    const startedAt = new Date().toISOString();
    let status: BotStatus = 'searching';
    let slotsChecked = 0;
    let paymentLink: string | undefined;
    let errorMsg: string | undefined;

    log.info(
      `🪖 ${mission.missionId} ACTIVADO - ${mission.account.name} → ${mission.park.name} (${mission.targetDate})`
    );

    // ============================
    // MAIN LOOP: 9AM → 1PM
    // ============================
    while (isWithinOperatingHours(botStartHour, botStopHour)) {
      try {
        // 1. Consultar disponibilidad
        log.info(`Consultando disponibilidad para ${mission.targetDate}...`);

        const schedules = await this.apiClient.getSchedules(
          mission.park.id,
          mission.targetDate,
          mission.account.document,
          mission.token,
        );

        slotsChecked++;

        // 2. Pasar al AvailabilityEngine (Tetris)
        const result = this.availabilityEngine.findSlot(schedules, mission.targetDate);

        if (!result.found) {
          log.debug(`Intento #${slotsChecked}: ${result.debugInfo}`);
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
          log.info('🧪 DRY RUN - No se realizará la reserva');
          status = 'found';
          break;
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
          mission.park.id,
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

            paymentLink = extractPaymentLink(pseResponse);
            const paymentId = extractPaymentId(pseResponse);
            log.info({ paymentLink, paymentId }, '💳 Link de pago generado');
          } catch (pseError: any) {
            log.warn({ error: pseError.message }, 'Error generando link PSE, usando link por defecto');
            paymentLink = 'https://portalciudadano.idrd.gov.co/app/pagos';
          }

          // 3e. Notificar por Telegram
          const concept = reservation.data?.concept || `${mission.park.name} - ${result.startHourFormatted} a ${result.endHourFormatted}`;
          await this.telegram.notifyReservationSuccess(
            `${mission.account.name}`,
            mission.park.name,
            concept,
            paymentLink!,
          );

          status = 'completed';
          log.info(`🏆 ${mission.missionId} COMPLETADA EXITOSAMENTE`);
          break;
        } else {
          log.warn({ code: reservation.code }, 'Reserva devolvió código != 200, reintentando...');
          await sleepWithJitter(1500, 3000);
          continue;
        }
      } catch (error: any) {
        slotsChecked++;
        log.error({ error: error.message }, `Error en intento #${slotsChecked}`);

        // If it's a 401, try to refresh the token
        if (error?.response?.status === 401) {
          log.warn('Token expirado, refrescando...');
          try {
            mission.token = await this.tokenManager.refreshSingleToken(mission.account);
            log.info('Token refrescado exitosamente');
          } catch {
            log.error('No se pudo refrescar el token');
          }
        }

        await sleepWithJitter(2000, 5000);
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
      park: mission.park.name,
      targetDate: mission.targetDate,
      slotsChecked,
      reservationMade: status === 'completed',
      paymentLink,
      error: errorMsg,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}
