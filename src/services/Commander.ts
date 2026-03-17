// =========================================================
// COMMANDER - Orquestador paralelo
// Reemplazo del workflow "Comandante"
// Lanza 12 SoldierBots en paralelo
// =========================================================

import { AppConfig, BotExecutionResult } from '../types';
import { IdrdApiClient } from './IdrdApiClient';
import { TokenManager } from './TokenManager';
import { TelegramNotifier } from './TelegramNotifier';
import { SoldierBot } from './SoldierBot';
import { AvailabilityEngine } from '../core/AvailabilityEngine';
import { MissionPlanner } from '../core/MissionPlanner';
import { logger } from '../utils/logger';

export class Commander {
  private config: AppConfig;
  private apiClient: IdrdApiClient;
  private tokenManager: TokenManager;
  private telegram: TelegramNotifier;
  private isDryRun: boolean;

  constructor(config: AppConfig, isDryRun: boolean = false) {
    this.config = config;
    this.isDryRun = isDryRun;

    // Initialize services
    this.apiClient = new IdrdApiClient(
      config.idrd.citizenUrl,
      config.idrd.contractorUrl,
    );

    this.tokenManager = new TokenManager(this.apiClient);

    this.telegram = new TelegramNotifier([
      config.telegram.bot901,
      config.telegram.botInv,
    ]);
  }

  /**
   * Full execution cycle:
   * 1. Login all accounts → refresh tokens
   * 2. Generate 12 missions (6 San Andrés + 6 Juan Amarillo)
   * 3. Launch 12 SoldierBots in parallel
   * 4. Wait for all to finish (either completed or stopped at 1PM)
   * 5. Report results via Telegram
   */
  async deploy(): Promise<BotExecutionResult[]> {
    logger.info('='.repeat(60));
    logger.info('🎖️  COMANDANTE ACTIVADO - Iniciando despliegue');
    logger.info('='.repeat(60));

    // === PHASE 1: Token refresh ===
    logger.info('📡 Fase 1: Refrescando tokens de todas las cuentas...');
    const tokenMap = await this.tokenManager.refreshAllTokens(this.config.accounts);

    if (tokenMap.size === 0) {
      logger.error('❌ No se obtuvo ningún token. Abortando.');
      await this.telegram.notifyBotStatus('❌ COMANDANTE: No se pudo hacer login a ninguna cuenta. Abortando misión.');
      return [];
    }

    // === PHASE 2: Generate missions ===
    logger.info('📋 Fase 2: Generando misiones...');
    const planner = new MissionPlanner(
      this.config.parks.sanAndres,
      this.config.parks.juanAmarillo,
    );

    const missions = planner.generateMissions(this.config.accounts, tokenMap);
    logger.info(`📋 ${missions.length} misiones generadas:`);

    for (const m of missions) {
      logger.info(`  → ${m.missionId}: ${m.account.name} → ${m.park.name} (${m.targetDate})`);
    }

    // Notify deployment
    const missionSummary = missions
      .map((m) => `${m.missionId}: ${m.account.name} → ${m.park.name} (${m.targetDate})`)
      .join('\n');

    await this.telegram.notifyBotStatus(
      `🎖️ COMANDANTE DESPLEGADO\n` +
      `${missions.length} bots activados\n` +
      `Modo: ${this.isDryRun ? '🧪 DRY RUN' : '🔴 PRODUCCIÓN'}\n\n` +
      missionSummary
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

    // Launch ALL bots simultaneously with Promise.allSettled
    // Each bot runs independently — if one fails, the others continue
    const botPromises = missions.map((mission) =>
      soldierBot.execute(
        mission,
        this.config.schedule.botStartHour,
        this.config.schedule.botStopHour,
      )
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

    // Summary
    const completed = executionResults.filter((r) => r.reservationMade).length;
    const stopped = executionResults.filter((r) => r.status === 'stopped').length;
    const errors = executionResults.filter((r) => r.status === 'error').length;

    logger.info('='.repeat(60));
    logger.info(`📊 RESUMEN: ${completed} reservadas | ${stopped} sin espacio | ${errors} errores`);
    logger.info('='.repeat(60));

    // Final Telegram report
    const reportLines = executionResults.map((r) => {
      const emoji = r.reservationMade ? '✅' : r.status === 'stopped' ? '⏰' : '❌';
      return `${emoji} ${r.missionId}: ${r.account} → ${r.park} (${r.targetDate}) [${r.slotsChecked} intentos]`;
    });

    await this.telegram.notifyBotStatus(
      `📊 REPORTE FINAL\n` +
      `✅ Reservadas: ${completed}\n` +
      `⏰ Sin espacio: ${stopped}\n` +
      `❌ Errores: ${errors}\n\n` +
      reportLines.join('\n')
    );

    return executionResults;
  }
}
