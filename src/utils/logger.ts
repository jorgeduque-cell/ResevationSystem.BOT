// =========================================================
// LOGGER - Pino structured logger
// =========================================================

import pino from 'pino';

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
  level: process.env.LOG_LEVEL || 'info',
});

/**
 * Creates a child logger for a specific bot/module
 */
export function createBotLogger(missionId: string, parkName: string) {
  return logger.child({ bot: missionId, park: parkName });
}
