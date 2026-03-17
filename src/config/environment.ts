// =========================================================
// ENVIRONMENT CONFIG - Validación de .env con Zod
// =========================================================

import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import { AppConfig, AccountConfig } from '../types';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN_901: z.string().min(1),
  TELEGRAM_BOT_TOKEN_INV: z.string().min(1),
  TELEGRAM_CHAT_ADMIN: z.string().min(1),
  TELEGRAM_CHAT_NICOLAS: z.string().min(1),

  // Parks
  PARK_SAN_ANDRES_ID: z.string().transform(Number),
  PARK_JUAN_AMARILLO_ID: z.string().transform(Number),

  // IDRD URLs
  IDRD_CITIZEN_URL: z.string().url(),
  IDRD_CONTRACTOR_URL: z.string().url(),

  // Schedule
  BOT_START_HOUR: z.string().transform(Number).default('9'),
  BOT_STOP_HOUR: z.string().transform(Number).default('13'),
  SLOT_START_HOUR: z.string().transform(Number).default('20'),
  SLOT_END_HOUR: z.string().transform(Number).default('22'),
  MIN_ANTICIPATION_HOURS: z.string().transform(Number).default('24'),
});

function loadAccounts(): AccountConfig[] {
  const accounts: AccountConfig[] = [];

  for (let i = 1; i <= 12; i++) {
    const name = process.env[`ACCOUNT_${i}_NAME`];
    const document = process.env[`ACCOUNT_${i}_DOCUMENT`];
    const email = process.env[`ACCOUNT_${i}_EMAIL`];
    const password = process.env[`ACCOUNT_${i}_PASSWORD`];

    if (!name || !document || !email || !password) {
      throw new Error(`Cuenta ${i} incompleta en .env. Requiere: ACCOUNT_${i}_NAME, ACCOUNT_${i}_DOCUMENT, ACCOUNT_${i}_EMAIL, ACCOUNT_${i}_PASSWORD`);
    }

    accounts.push({ index: i, name, document, email, password });
  }

  return accounts;
}

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);
  const accounts = loadAccounts();

  return {
    accounts,
    parks: {
      sanAndres: { id: env.PARK_SAN_ANDRES_ID, name: 'San Andrés' },
      juanAmarillo: { id: env.PARK_JUAN_AMARILLO_ID, name: 'Juan Amarillo' },
    },
    telegram: {
      bot901: {
        botToken: env.TELEGRAM_BOT_TOKEN_901,
        chatId: env.TELEGRAM_CHAT_ADMIN,
      },
      botInv: {
        botToken: env.TELEGRAM_BOT_TOKEN_INV,
        chatId: env.TELEGRAM_CHAT_NICOLAS,
      },
    },
    idrd: {
      citizenUrl: env.IDRD_CITIZEN_URL,
      contractorUrl: env.IDRD_CONTRACTOR_URL,
    },
    schedule: {
      botStartHour: env.BOT_START_HOUR,
      botStopHour: env.BOT_STOP_HOUR,
      slotStartHour: env.SLOT_START_HOUR,
      slotEndHour: env.SLOT_END_HOUR,
      minAnticipationHours: env.MIN_ANTICIPATION_HOURS,
    },
  };
}
