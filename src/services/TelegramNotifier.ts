// =========================================================
// TELEGRAM NOTIFIER - Envío de notificaciones a Telegram
// =========================================================

import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger';

const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 1;

export class TelegramNotifier {
  private bot: TelegramBot;

  constructor(botToken: string, private chatIds: string[]) {
    this.bot = new TelegramBot(botToken, { polling: false });
  }

  /**
   * Rich "court found" notification (spec-format).
   */
  async notifyCourtFound(opts: {
    userName: string;
    courtName: string;
    courtId: string;
    parkName: string;
    date: string;
    timeSlot: string;        // "8:00 PM - 10:00 PM"
    price?: number;
    paymentLink: string;
  }): Promise<void> {
    const priceLine = opts.price !== undefined
      ? `💰 Valor: $${opts.price.toLocaleString('es-CO')}\n`
      : '';
    const message =
      `🎯 ¡CANCHA ENCONTRADA Y RESERVADA!\n` +
      `👤 Usuario: ${opts.userName}\n` +
      `📍 Cancha: ${opts.courtName} (ID: ${opts.courtId})\n` +
      `🏟️ Ubicación: ${opts.parkName}\n` +
      `📅 Fecha: ${opts.date}\n` +
      `⏰ Horario: ${opts.timeSlot}\n` +
      priceLine +
      `🔗 Link de pago PSE: ${opts.paymentLink}\n` +
      `⏳ Tienes 15 minutos para completar el pago.`;

    await this.sendToAll(message);
  }

  /**
   * Sends a bot status notification (started, stopped, error)
   */
  async notifyBotStatus(message: string): Promise<void> {
    await this.sendToAll(message);
  }

  /**
   * Sends a message to every configured chat with retry on transient errors.
   */
  private async sendToAll(text: string): Promise<void> {
    await Promise.allSettled(this.chatIds.map((chatId) => this.sendWithRetry(chatId, text)));
  }

  private async sendWithRetry(chatId: string, text: string): Promise<void> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.bot.sendMessage(chatId, text);
        logger.info({ chatId }, '✅ Mensaje de Telegram enviado');
        return;
      } catch (error: any) {
        const statusCode = error?.response?.statusCode || error?.response?.status || 'unknown';
        const errorBody = error?.response?.body?.description || error?.message || 'unknown error';

        logger.error(
          { chatId, statusCode, error: errorBody, attempt: attempt + 1 },
          `❌ Error enviando mensaje de Telegram (intento ${attempt + 1}/${MAX_RETRIES + 1})`,
        );

        // Don't retry on permanent errors (403 = bot blocked, 400 = bad request)
        if (statusCode === 403 || statusCode === 400) {
          logger.warn(
            { chatId, statusCode },
            '⚠️ Error permanente — el usuario debe enviar /start al bot o verificar el chatId',
          );
          return;
        }

        if (attempt < MAX_RETRIES) {
          logger.info({ chatId }, `🔄 Reintentando en ${RETRY_DELAY_MS}ms...`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
  }
}
