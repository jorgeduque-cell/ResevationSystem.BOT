// =========================================================
// TELEGRAM NOTIFIER - Envío de notificaciones a Telegram
// =========================================================

import TelegramBot from 'node-telegram-bot-api';
import { TelegramTarget } from '../types';
import { logger } from '../utils/logger';

const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 1;

export class TelegramNotifier {
  private bots: Map<string, TelegramBot> = new Map();

  constructor(private targets: TelegramTarget[]) {
    // Create one bot instance per unique token
    const uniqueTokens = new Set(targets.map((t) => t.botToken));
    for (const token of uniqueTokens) {
      this.bots.set(token, new TelegramBot(token, { polling: false }));
    }
  }

  /**
   * Sends a reservation success notification to ALL configured chats
   */
  async notifyReservationSuccess(
    userName: string,
    parkName: string,
    concept: string,
    paymentLink: string,
  ): Promise<void> {
    const message =
      `🎯 RESERVA LISTA PARA PAGO.\n` +
      `USUARIO: ${userName}\n` +
      `Parque ${parkName}:\n` +
      `${concept}\n` +
      `\nLink:\n${paymentLink}`;

    await this.sendToAll(message);
  }

  /**
   * Sends a bot status notification (started, stopped, error)
   */
  async notifyBotStatus(message: string): Promise<void> {
    await this.sendToAll(message);
  }

  /**
   * Sends a message to ALL configured targets with retry
   */
  private async sendToAll(text: string): Promise<void> {
    const promises = this.targets.map(async (target) => {
      await this.sendWithRetry(target, text);
    });

    await Promise.allSettled(promises);
  }

  /**
   * Sends a message to a single target, retrying once on transient errors
   */
  private async sendWithRetry(target: TelegramTarget, text: string): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const bot = this.bots.get(target.botToken);
        if (!bot) {
          logger.error(
            { chatId: target.chatId, botToken: target.botToken.slice(0, 10) + '...' },
            '❌ Bot de Telegram no encontrado para este token',
          );
          return;
        }

        await bot.sendMessage(target.chatId, text);
        logger.info({ chatId: target.chatId }, '✅ Mensaje de Telegram enviado');
        return; // Success — exit retry loop
      } catch (error: any) {
        const statusCode = error?.response?.statusCode || error?.response?.status || 'unknown';
        const errorBody = error?.response?.body?.description || error?.message || 'unknown error';

        logger.error(
          {
            chatId: target.chatId,
            botToken: target.botToken.slice(0, 10) + '...',
            statusCode,
            error: errorBody,
            attempt: attempt + 1,
          },
          `❌ Error enviando mensaje de Telegram (intento ${attempt + 1}/${MAX_RETRIES + 1})`,
        );

        // Don't retry on permanent errors (403 = bot blocked, 400 = bad request)
        if (statusCode === 403 || statusCode === 400) {
          logger.warn(
            { chatId: target.chatId, statusCode },
            '⚠️ Error permanente — el usuario debe enviar /start al bot o verificar el chatId',
          );
          return;
        }

        // Retry on transient errors
        if (attempt < MAX_RETRIES) {
          logger.info({ chatId: target.chatId }, `🔄 Reintentando en ${RETRY_DELAY_MS}ms...`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
  }

  /**
   * Sends a test message to verify connectivity
   */
  async sendTestMessage(): Promise<boolean> {
    try {
      await this.sendToAll('✅ Bot de Reservas IDRD - Conexión verificada');
      return true;
    } catch {
      return false;
    }
  }
}
