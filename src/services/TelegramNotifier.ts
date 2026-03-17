// =========================================================
// TELEGRAM NOTIFIER - Envío de notificaciones a Telegram
// =========================================================

import TelegramBot from 'node-telegram-bot-api';
import { TelegramTarget } from '../types';
import { logger } from '../utils/logger';

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
   * Sends a message to ALL configured targets
   */
  private async sendToAll(text: string): Promise<void> {
    const promises = this.targets.map(async (target) => {
      try {
        const bot = this.bots.get(target.botToken);
        if (!bot) {
          logger.error({ chatId: target.chatId }, 'Bot de Telegram no encontrado');
          return;
        }
        await bot.sendMessage(target.chatId, text);
        logger.info({ chatId: target.chatId }, 'Mensaje de Telegram enviado');
      } catch (error: any) {
        logger.error(
          { chatId: target.chatId, error: error.message },
          'Error enviando mensaje de Telegram'
        );
      }
    });

    await Promise.allSettled(promises);
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
