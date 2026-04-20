// =========================================================
// INDEX.TS - Entry point del Bot de Reservas IDRD (dinámico)
// Flujo conversacional: /empieza → IDs → validar → /si → buscar
// =========================================================

import TelegramBot from 'node-telegram-bot-api';
import { z } from 'zod';
import { loadConfig } from './config/environment';
import { Commander } from './services/Commander';
import { SessionManager } from './services/SessionManager';
import { logger } from './utils/logger';
import { nowBogota } from './utils/date';
import { AppConfig, CourtInfo } from './types';

// CLI flags
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

// Authorized Telegram user IDs
const AUTHORIZED_USERS = new Set<number>([
  1406723103, // Admin
  659132607,  // Nicolas
]);

// --- Validation schema for the 3 court entries (ID or ID:Name) ---
const courtEntrySchema = z.object({
  id: z.string().regex(/^\d{4,5}$/, 'Cada ID debe ser un número de 4-5 dígitos'),
  name: z.string().min(1).optional(),
});

const courtEntriesSchema = z
  .array(courtEntrySchema)
  .length(3, 'Debes enviar exactamente 3 canchas');

interface CourtEntry {
  id: string;
  name?: string;
}

/**
 * Parses input like:
 *   "15980:San Andrés, 15981:Juan Amarillo, 15369:Florencia"
 *   "1234, 5678, 9012"   (legacy, no names)
 * Accepts commas and/or newlines as separators. Name may contain spaces.
 */
function parseCourtIdsInput(raw: string): CourtEntry[] {
  return raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((token) => {
      const idx = token.indexOf(':');
      if (idx === -1) return { id: token };
      const id = token.slice(0, idx).trim();
      const name = token.slice(idx + 1).trim();
      return name ? { id, name } : { id };
    });
}

// --- Per-chat runtime deployment state (runtime only, not persisted) ---
interface DeploymentState {
  chatId: number;
  abort: AbortController;
}
const deployments: Map<number, DeploymentState> = new Map();

async function runDeployment(
  config: AppConfig,
  bot: TelegramBot,
  chatId: number,
  sessions: SessionManager,
  courts: CourtInfo[],
): Promise<void> {
  if (deployments.has(chatId)) {
    await bot.sendMessage(chatId, '⚠️ Ya hay una búsqueda activa. Usa /termina para detenerla primero.');
    return;
  }

  const abort = new AbortController();
  deployments.set(chatId, { chatId, abort });
  sessions.setStatus(chatId, 'searching');

  try {
    const commander = new Commander(config, isDryRun);
    await commander.deploy(courts, abort.signal);
    await bot.sendMessage(chatId, '✅ Ejecución finalizada. Los bots se detuvieron.');
  } catch (err: any) {
    logger.error({ err: err.message }, '❌ Error en ejecución del Commander');
    await bot.sendMessage(chatId, `❌ Error en la búsqueda: ${err.message}`);
  } finally {
    deployments.delete(chatId);
    sessions.setStatus(chatId, 'stopped');
  }
}

function setupTelegramCommands(config: AppConfig): void {
  const bot = new TelegramBot(config.telegram.botInv.botToken, { polling: true });
  const sessions = new SessionManager();

  logger.info('📱 Telegram Bot activo (modo dinámico). Comandos:');
  logger.info('   /empieza /canchas /ids /cambiar /estado /termina /cancelar /si /no');

  const authorize = async (msg: TelegramBot.Message): Promise<boolean> => {
    const userId = msg.from?.id;
    if (!userId || !AUTHORIZED_USERS.has(userId)) {
      await bot.sendMessage(msg.chat.id, '🚫 No tienes autorización para controlar este sistema.');
      return false;
    }
    return true;
  };

  // === /empieza ===
  bot.onText(/^\/empieza$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);

    if (session && (session.status === 'searching' || deployments.has(chatId))) {
      await bot.sendMessage(
        chatId,
        '⚠️ Ya hay una búsqueda activa con estas canchas:\n' +
          (session.courtInfos?.map((c, i) => `${i + 1}. ${c.courtName} (${c.courtId}) - ${c.parkName}`).join('\n') ||
            session.courtIds.map((id, i) => `${i + 1}. ID ${id}`).join('\n')) +
          '\n\n¿Deseas reiniciar con nuevas canchas? /si para reiniciar, /no para mantener.',
      );
      sessions.setStatus(chatId, 'awaiting_confirmation');
      return;
    }

    sessions.clear(chatId);
    sessions.setCourtIds(chatId, []); // placeholder, status will be overwritten
    sessions.setStatus(chatId, 'configuring');

    await bot.sendMessage(
      chatId,
      `🤖 Bot de Reservas IDRD - Modo Dinámico\n\n` +
        `Bienvenido. Este sistema busca automáticamente disponibilidad en los parques del IDRD.\n\n` +
        `Para comenzar, necesito que me indiques 3 canchas específicas.\n\n` +
        `📋 Instrucciones:\n` +
        `1. Consulta los IDs en la app IDRD o web oficial\n` +
        `2. Envíame 3 canchas en formato ID:Nombre separadas por comas\n` +
        `3. Ejemplo: 15980:San Andrés, 15981:Juan Amarillo, 15369:Florencia\n\n` +
        `(Si no quieres asignar nombre, manda solo los IDs: 1234, 5678, 9012)\n\n` +
        `¿Listo? Envía las 3 canchas ahora:`,
    );
  });

  // === /termina ===
  bot.onText(/^\/termina$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    const deployment = deployments.get(chatId);

    if (!deployment) {
      await bot.sendMessage(chatId, '💤 No hay búsqueda activa para este chat.');
      return;
    }

    deployment.abort.abort();
    sessions.clear(chatId);
    await bot.sendMessage(chatId, '🛑 Señal de parada enviada. Sesión limpiada. Usa /empieza para iniciar de nuevo.');
  });

  // === /estado ===
  bot.onText(/^\/estado$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);
    const now = nowBogota();
    const modeText = isDryRun ? '🧪 DRY RUN' : '🔴 PRODUCCIÓN';
    const statusEmoji = deployments.has(chatId) ? '🟢' : '💤';

    const courtsLine = session?.courtInfos?.length
      ? '\n\n🎯 Canchas activas:\n' +
        session.courtInfos.map((c, i) => `${i + 1}. ${c.courtName} (ID ${c.courtId}) - ${c.parkName}`).join('\n')
      : session?.courtIds?.length
      ? `\n\n🎯 Canchas: ${session.courtIds.join(', ')}`
      : '';

    await bot.sendMessage(
      chatId,
      `${statusEmoji} Estado del Sistema\n\n` +
        `📅 Fecha: ${now.toLocaleDateString('es-CO')}\n` +
        `🕐 Hora: ${now.toLocaleTimeString('es-CO')}\n` +
        `📡 Modo: ${modeText}\n` +
        `🤖 Estado: ${deployments.has(chatId) ? 'BUSCANDO' : session?.status || 'En espera'}` +
        courtsLine,
    );
  });

  // === /canchas  &  /ids  (consultar IDs activos) ===
  bot.onText(/^\/(canchas|ids)$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);
    if (!session || session.courtIds.length === 0) {
      await bot.sendMessage(chatId, '💤 No hay canchas configuradas. Usa /empieza para iniciar.');
      return;
    }
    const lines = session.courtInfos?.length
      ? session.courtInfos.map((c, i) => `${i + 1}. ${c.courtName} (ID ${c.courtId}) - ${c.parkName}`)
      : session.courtIds.map((id, i) => `${i + 1}. ID ${id}`);
    await bot.sendMessage(chatId, `🎯 Canchas activas:\n${lines.join('\n')}`);
  });

  // === /cambiar  (detener bots, limpiar sesión, volver al paso 1) ===
  bot.onText(/^\/cambiar$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    const deployment = deployments.get(chatId);
    if (deployment) deployment.abort.abort();
    sessions.clear(chatId);
    sessions.setCourtIds(chatId, []);
    sessions.setStatus(chatId, 'configuring');
    await bot.sendMessage(
      chatId,
      '🔄 Sesión reiniciada.\n\nEnvía las 3 canchas nuevas (formato ID:Nombre separadas por comas).\nEjemplo: 15980:San Andrés, 15981:Juan Amarillo, 15369:Florencia',
    );
  });

  // === /cancelar  (abortar configuración sin iniciar búsqueda) ===
  bot.onText(/^\/cancelar$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    sessions.clear(chatId);
    await bot.sendMessage(chatId, '❌ Configuración cancelada. Usa /empieza cuando quieras intentar de nuevo.');
  });

  // === /si  (confirmar arranque / reinicio) ===
  bot.onText(/^\/si$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);

    if (!session) {
      await bot.sendMessage(chatId, '💤 No hay nada que confirmar. Usa /empieza.');
      return;
    }

    // Restart flow triggered from /empieza while searching
    if (session.status === 'awaiting_confirmation' && deployments.has(chatId)) {
      const deployment = deployments.get(chatId)!;
      deployment.abort.abort();
      sessions.clear(chatId);
      sessions.setCourtIds(chatId, []);
      sessions.setStatus(chatId, 'configuring');
      await bot.sendMessage(chatId, '🔄 Búsqueda detenida.\n\nEnvía las 3 canchas nuevas (formato ID:Nombre).\nEjemplo: 15980:San Andrés, 15981:Juan Amarillo, 15369:Florencia');
      return;
    }

    // Normal confirm → start
    if (session.status !== 'awaiting_confirmation' || !session.courtInfos?.length) {
      await bot.sendMessage(chatId, '⚠️ No hay una configuración pendiente de confirmar. Usa /empieza.');
      return;
    }

    const courts = session.courtInfos;
    await bot.sendMessage(
      chatId,
      `✅ Configuración completa:\n\n` +
        courts.map((c, i) => `🎯 Objetivo ${i + 1}: ${c.courtName} (ID ${c.courtId}) en ${c.parkName}`).join('\n') +
        `\n\n⚔️ Desplegando 18 agentes de búsqueda...\n` +
        `📍 6 cuentas buscando cada ID simultáneamente\n` +
        `🔍 Horario objetivo: ${config.schedule.slotStartHour}:00 - ${config.schedule.slotEndHour}:00\n\n` +
        `Usa /estado para ver progreso o /termina para detener.`,
    );

    // Fire and forget
    runDeployment(config, bot, chatId, sessions, courts).catch((err) =>
      logger.error({ err: err.message }, 'runDeployment failed'),
    );
  });

  // === /no  (declinar reinicio) ===
  bot.onText(/^\/no$/, async (msg) => {
    if (!(await authorize(msg))) return;
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);
    if (session?.status === 'awaiting_confirmation' && deployments.has(chatId)) {
      sessions.setStatus(chatId, 'searching');
      await bot.sendMessage(chatId, '👍 Sigo buscando con las canchas actuales.');
    } else {
      await bot.sendMessage(chatId, 'OK.');
    }
  });

  // === free-text handler: capture 3 court IDs while status = 'configuring' ===
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith('/')) return; // commands handled above
    if (!(await authorize(msg))) return;

    const chatId = msg.chat.id;
    const session = sessions.get(chatId);
    if (!session || session.status !== 'configuring') return;

    const entries = parseCourtIdsInput(msg.text);
    const parsed = courtEntriesSchema.safeParse(entries);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      let hint = firstIssue?.message || 'Formato inválido';
      if (entries.length !== 3) {
        hint = `Debes enviar exactamente 3 canchas (recibidas ${entries.length}).`;
      }
      await bot.sendMessage(
        chatId,
        `⚠️ ${hint}\nEjemplo: 15980:San Andrés, 15981:Juan Amarillo, 15369:Florencia\n\nIntenta de nuevo o usa /cancelar.`,
      );
      return;
    }

    const courtEntries = parsed.data;
    const courtIds = courtEntries.map((c) => c.id);
    await bot.sendMessage(chatId, '🔎 Validando IDs contra el catálogo IDRD... (puede tomar unos segundos)');

    try {
      const commander = new Commander(config, isDryRun);
      const result = await commander.validateCourts(courtEntries);

      if (result.invalid.length > 0) {
        await bot.sendMessage(
          chatId,
          `⚠️ Los siguientes IDs no existen en el catálogo IDRD: ${result.invalid.join(', ')}\n\n` +
            `Verifica los IDs e intenta de nuevo, o usa /cancelar.`,
        );
        return;
      }

      sessions.setCourtIds(chatId, courtIds);
      sessions.setCourtInfos(chatId, result.courts);
      sessions.setStatus(chatId, 'awaiting_confirmation');

      await bot.sendMessage(
        chatId,
        `✅ Canchas registradas:\n` +
          result.courts.map((c, i) => `${i + 1}. ${c.courtName} (ID ${c.courtId}) - ${c.parkName}`).join('\n') +
          `\n\n¿Iniciar búsqueda?\n/si para confirmar\n/cancelar para cambiar`,
      );
    } catch (err: any) {
      logger.error({ err: err.message }, 'Validación de canchas falló');
      await bot.sendMessage(
        chatId,
        `❌ No pude validar los IDs: ${err.message}\n\nIntenta de nuevo o usa /cancelar.`,
      );
    }
  });

  bot.on('polling_error', (error: any) => {
    if (error.code !== 'ETELEGRAM' || !error.message?.includes('terminated')) {
      logger.warn({ error: error.message }, 'Telegram polling error');
    }
  });
}

async function main() {
  logger.info('='.repeat(60));
  logger.info('🤖 SISTEMA DE RESERVAS IDRD - DINÁMICO');
  logger.info(`📅 Fecha: ${nowBogota().toISOString()}`);
  logger.info(`🧪 Modo: ${isDryRun ? 'DRY RUN' : 'PRODUCCIÓN'}`);
  logger.info('='.repeat(60));

  let config: AppConfig;
  try {
    config = loadConfig();
    logger.info(`✅ Configuración cargada: ${config.accounts.length} cuentas`);
  } catch (error: any) {
    logger.fatal({ error: error.message }, '❌ Error cargando configuración');
    process.exit(1);
  }

  setupTelegramCommands(config);

  process.on('SIGINT', () => {
    logger.info('🛑 SIGINT recibido. Deteniendo sistema...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('🛑 SIGTERM recibido. Deteniendo sistema...');
    process.exit(0);
  });

  logger.info('🟢 Sistema activo. Telegram escuchando.');
  logger.info('📱 Envía /empieza desde Telegram para configurar canchas.');
}

main().catch((error) => {
  logger.fatal({ error: error.message }, '💀 Error fatal no controlado');
  process.exit(1);
});
