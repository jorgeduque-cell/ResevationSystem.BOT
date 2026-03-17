// =========================================================
// INDEX.TS - Entry point del Bot de Reservas IDRD
// Cron diario + Control por Telegram (/empieza, /termina)
// =========================================================

import cron from 'node-cron';
import TelegramBot from 'node-telegram-bot-api';
import { loadConfig } from './config/environment';
import { Commander } from './services/Commander';
import { logger } from './utils/logger';
import { nowBogota } from './utils/date';
import { AppConfig } from './types';

// Parse CLI flags
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const runNow = args.includes('--now');

// Authorized Telegram user IDs (only these can control the bot)
const AUTHORIZED_USERS = new Set<number>([
  1406723103,  // Admin
  659132607,   // Nicolas
]);

// Global state
let isRunning = false;
let activeAbortController: AbortController | null = null;

async function runDeployment(config: AppConfig): Promise<void> {
  if (isRunning) {
    logger.warn('⚠️ Ya hay una ejecución en curso. Ignorando.');
    return;
  }

  isRunning = true;
  activeAbortController = new AbortController();

  try {
    const commander = new Commander(config, isDryRun);
    await commander.deploy();
  } catch (error: any) {
    logger.error({ error: error.message }, '❌ Error en ejecución del Commander');
  } finally {
    isRunning = false;
    activeAbortController = null;
  }
}

function setupTelegramCommands(config: AppConfig): void {
  // Use the InventarioRiosol bot for commands (the one that's working)
  const bot = new TelegramBot(config.telegram.botInv.botToken, { polling: true });

  logger.info('📱 Telegram Bot activo. Comandos disponibles:');
  logger.info('   /empieza  → Activa los 12 bots ahora');
  logger.info('   /termina  → Detiene los bots');
  logger.info('   /estado   → Muestra el estado del sistema');

  // === /empieza ===
  bot.onText(/\/empieza/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !AUTHORIZED_USERS.has(userId)) {
      await bot.sendMessage(chatId, '🚫 No tienes autorización para controlar este sistema.');
      return;
    }

    if (isRunning) {
      await bot.sendMessage(chatId, '⚠️ Los bots ya están corriendo. Usa /termina para detenerlos primero.');
      return;
    }

    await bot.sendMessage(chatId, '🚀 ¡Activando 12 bots en paralelo! Te notificaré cuando encuentren disponibilidad.');
    logger.info(`📱 Comando /empieza recibido de usuario ${userId}`);

    // Run in background (don't await - let Telegram respond immediately)
    runDeployment(config).then(() => {
      bot.sendMessage(chatId, '✅ Ejecución finalizada. Los bots se detuvieron.');
    });
  });

  // === /termina ===
  bot.onText(/\/termina/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !AUTHORIZED_USERS.has(userId)) {
      await bot.sendMessage(chatId, '🚫 No tienes autorización.');
      return;
    }

    if (!isRunning) {
      await bot.sendMessage(chatId, '💤 Los bots no están corriendo.');
      return;
    }

    logger.info(`📱 Comando /termina recibido de usuario ${userId}`);

    // Signal abort and force stop
    if (activeAbortController) {
      activeAbortController.abort();
    }

    // Force exit the current execution by terminating the process and restarting
    // PM2 will auto-restart the process
    await bot.sendMessage(chatId, '🛑 Deteniendo bots... El sistema se reiniciará en modo espera.');
    
    setTimeout(() => {
      process.exit(0); // PM2 will restart, cron will be re-scheduled
    }, 1000);
  });

  // === /estado ===
  bot.onText(/\/estado/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !AUTHORIZED_USERS.has(userId)) {
      await bot.sendMessage(chatId, '🚫 No tienes autorización.');
      return;
    }

    const now = nowBogota();
    const statusEmoji = isRunning ? '🟢' : '💤';
    const modeText = isDryRun ? '🧪 DRY RUN' : '🔴 PRODUCCIÓN';

    const message =
      `${statusEmoji} Estado del Sistema\n\n` +
      `📅 Fecha: ${now.toLocaleDateString('es-CO')}\n` +
      `🕐 Hora: ${now.toLocaleTimeString('es-CO')}\n` +
      `📡 Modo: ${modeText}\n` +
      `🤖 Bots: ${isRunning ? 'ACTIVOS (buscando...)' : 'En espera'}\n\n` +
      `Comandos:\n` +
      `/empieza - Activar bots ahora\n` +
      `/termina - Detener bots`;

    await bot.sendMessage(chatId, message);
  });

  // Handle polling errors gracefully
  bot.on('polling_error', (error: any) => {
    if (error.code !== 'ETELEGRAM' || !error.message?.includes('terminated')) {
      logger.warn({ error: error.message }, 'Telegram polling error');
    }
  });
}

async function main() {
  logger.info('='.repeat(60));
  logger.info('🤖 SISTEMA DE RESERVAS IDRD - STANDALONE');
  logger.info(`📅 Fecha: ${nowBogota().toISOString()}`);
  logger.info(`🧪 Modo: ${isDryRun ? 'DRY RUN' : 'PRODUCCIÓN'}`);
  logger.info('='.repeat(60));

  // Load and validate config
  let config: AppConfig;
  try {
    config = loadConfig();
    logger.info(`✅ Configuración cargada: ${config.accounts.length} cuentas`);
  } catch (error: any) {
    logger.fatal({ error: error.message }, '❌ Error cargando configuración');
    process.exit(1);
  }

  // === TELEGRAM COMMAND LISTENER (always active) ===
  setupTelegramCommands(config);

  // If --now flag, execute immediately AND keep listening
  if (runNow) {
    logger.info('🚀 Flag --now detectado. Ejecutando AHORA...');
    runDeployment(config);
    // Don't return - keep the process alive for Telegram commands
  }

  // === CRON JOB (always active) ===
  const cronExpression = '0 9 * * 1'; // 9:00 AM every Monday
  logger.info(`⏰ Cron programado: "${cronExpression}" (Lunes a las 9:00 AM Bogotá)`);

  cron.schedule(
    cronExpression,
    async () => {
      logger.info(`⏰ Cron disparado: ${nowBogota().toISOString()}`);
      await runDeployment(config);
    },
    { timezone: 'America/Bogota' }
  );

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('🛑 SIGINT recibido. Deteniendo sistema...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('🛑 SIGTERM recibido. Deteniendo sistema...');
    process.exit(0);
  });

  logger.info('🟢 Sistema activo. Cron + Telegram escuchando.');
  logger.info('📱 Envía /empieza desde Telegram para activar los bots manualmente.');
}

main().catch((error) => {
  logger.fatal({ error: error.message }, '💀 Error fatal no controlado');
  process.exit(1);
});
