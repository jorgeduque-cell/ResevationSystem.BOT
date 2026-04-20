// =========================================================
// COMMANDER - Dynamic court-based orchestrator
// Validates user-supplied court IDs, then launches 18 soldiers
// distributed 6-per-court across the 3 targets.
// =========================================================

import { AppConfig, BotExecutionResult, CourtInfo } from '../types';
import { IdrdApiClient } from './IdrdApiClient';
import { TokenManager } from './TokenManager';
import { TelegramNotifier } from './TelegramNotifier';
import { SoldierBot } from './SoldierBot';
import { CourtCatalog } from './CourtCatalog';
import { AvailabilityEngine } from '../core/AvailabilityEngine';
import { MissionPlanner } from '../core/MissionPlanner';
import { logger } from '../utils/logger';

export interface CourtInput {
  id: string;
  name?: string;
}

export interface CourtValidationResult {
  courtIds: string[];
  courts: CourtInfo[];
  invalid: string[];
}

export class Commander {
  private config: AppConfig;
  private apiClient: IdrdApiClient;
  private tokenManager: TokenManager;
  private telegram: TelegramNotifier;
  private catalog: CourtCatalog;
  private isDryRun: boolean;

  constructor(config: AppConfig, isDryRun: boolean = false) {
    this.config = config;
    this.isDryRun = isDryRun;

    this.apiClient = new IdrdApiClient(
      config.idrd.citizenUrl,
      config.idrd.contractorUrl,
    );

    this.tokenManager = new TokenManager(this.apiClient);

    this.telegram = new TelegramNotifier([
      config.telegram.bot901,
      config.telegram.botInv,
    ]);

    this.catalog = new CourtCatalog(this.apiClient);
  }

  /**
   * Validates a list of court IDs against the IDRD catalog.
   * Uses the first available account to probe the schedule endpoint.
   * Call this BEFORE deploy() — the Telegram flow needs to report
   * invalid IDs to the user before committing to a search.
   */
  async validateCourts(inputs: CourtInput[]): Promise<CourtValidationResult> {
    // Need at least one token to probe
    const tokenMap = await this.tokenManager.refreshAllTokens(this.config.accounts);
    if (tokenMap.size === 0) {
      throw new Error('No se pudo hacer login a ninguna cuenta para validar las canchas.');
    }

    const probeAccount = this.config.accounts.find((a) => tokenMap.has(a.index))!;
    const probeToken = tokenMap.get(probeAccount.index)!;

    const resolved = await this.catalog.resolveAll(inputs, probeAccount, probeToken);

    const courtIds = inputs.map((c) => c.id);
    const courts: CourtInfo[] = [];
    const invalid: string[] = [];
    resolved.forEach((info, i) => {
      if (info) courts.push(info);
      else invalid.push(inputs[i].id);
    });

    return { courtIds, courts, invalid };
  }

  /**
   * Deploys 18 soldiers against the 3 supplied courts (6 per court).
   * Requires courts to already be validated via validateCourts().
   */
  async deploy(courts: CourtInfo[], signal?: AbortSignal): Promise<BotExecutionResult[]> {
    logger.info('='.repeat(60));
    logger.info('🎖️  COMANDANTE ACTIVADO - Iniciando despliegue dinámico');
    logger.info(`🎯 Canchas objetivo: ${courts.map((c) => `${c.courtName}(${c.courtId})`).join(', ')}`);
    logger.info('='.repeat(60));

    if (signal?.aborted) {
      logger.info('🛑 Señal de aborto recibida antes de iniciar. Cancelando despliegue.');
      return [];
    }

    if (courts.length === 0) {
      logger.error('❌ No hay canchas validadas. Abortando.');
      return [];
    }

    // === PHASE 1: Token refresh ===
    logger.info('📡 Fase 1: Refrescando tokens de todas las cuentas...');
    const tokenMap = await this.tokenManager.refreshAllTokens(this.config.accounts);

    if (tokenMap.size === 0) {
      logger.error('❌ No se obtuvo ningún token. Abortando.');
      await this.telegram.notifyBotStatus('❌ COMANDANTE: No se pudo hacer login a ninguna cuenta. Abortando misión.');
      return [];
    }

    if (signal?.aborted) {
      logger.info('🛑 Señal de aborto recibida después de token refresh.');
      return [];
    }

    // === PHASE 2: Generate missions (dynamic) ===
    logger.info('📋 Fase 2: Generando misiones dinámicas (6 cuentas por cancha)...');
    const planner = new MissionPlanner();
    const missions = planner.generateMissions(this.config.accounts, courts, tokenMap);

    logger.info(`📋 ${missions.length} misiones generadas:`);
    for (const m of missions) {
      logger.info(`  → ${m.missionId}: ${m.account.name} → ${m.court.parkName}/${m.court.courtName} (${m.targetDate})`);
    }

    const courtSummary = courts
      .map((c, i) => `🎯 Objetivo ${i + 1}: ${c.courtName} (ID ${c.courtId}) en ${c.parkName}`)
      .join('\n');

    await this.telegram.notifyBotStatus(
      `🎖️ COMANDANTE DESPLEGADO\n` +
      `${missions.length} bots activados (${courts.length} cancha${courts.length === 1 ? '' : 's'})\n` +
      `Modo: ${this.isDryRun ? '🧪 DRY RUN' : '🔴 PRODUCCIÓN'}\n\n` +
      courtSummary
    );

    // === PHASE 3: Deploy all soldiers IN PARALLEL ===
    logger.info('🪖 Fase 3: Desplegando soldados en PARALELO...');

    const availabilityEngine = new AvailabilityEngine({
      slotStartHour: this.config.schedule.slotStartHour,
      slotEndHour: this.config.schedule.slotEndHour,
      minAnticipationHours: this.config.schedule.minAnticipationHours,
      preferredDurations: [2, 1],
    });

    const soldierBot = new SoldierBot(
      this.apiClient,
      availabilityEngine,
      this.telegram,
      this.tokenManager,
      this.isDryRun,
    );

    const botPromises = missions.map((mission) =>
      soldierBot.execute(mission, 0, 24, signal),
    );

    const results = await Promise.allSettled(botPromises);

    // === PHASE 4: Collect and report results ===
    const executionResults: BotExecutionResult[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        executionResults.push(result.value);
      } else {
        logger.error({ reason: result.reason }, 'Bot falló con excepción no controlada');
      }
    }

    const totalReservations = executionResults.reduce((sum, r) => sum + r.reservationCount, 0);
    const botsWithReservations = executionResults.filter((r) => r.reservationMade).length;
    const stopped = executionResults.filter((r) => r.status === 'stopped').length;
    const aborted = executionResults.filter((r) => r.status === 'aborted').length;
    const errors = executionResults.filter((r) => r.status === 'error').length;

    logger.info('='.repeat(60));
    logger.info(`📊 RESUMEN: ${totalReservations} reservas | ${stopped} sin espacio | ${aborted} abortados | ${errors} errores`);
    logger.info('='.repeat(60));

    const reportLines = executionResults.map((r) => {
      const emoji = r.reservationMade ? '✅' : r.status === 'stopped' ? '⏰' : r.status === 'aborted' ? '🛑' : '❌';
      const countLabel = r.reservationCount > 0 ? ` [${r.reservationCount} reservas]` : '';
      return `${emoji} ${r.missionId}: ${r.account} → ${r.park}/${r.courtName} (${r.targetDate}) [${r.slotsChecked} intentos]${countLabel}`;
    });

    await this.telegram.notifyBotStatus(
      `📊 REPORTE FINAL\n` +
      `✅ Total reservas: ${totalReservations} (por ${botsWithReservations} bots)\n` +
      `⏰ Sin espacio: ${stopped}\n` +
      `🛑 Abortados: ${aborted}\n` +
      `❌ Errores: ${errors}\n\n` +
      reportLines.join('\n')
    );

    return executionResults;
  }
}
