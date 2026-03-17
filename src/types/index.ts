// =========================================================
// TYPES - Interfaces del sistema de reservas IDRD
// =========================================================

/** Account credentials from .env */
export interface AccountConfig {
  index: number;
  name: string;
  document: string;
  email: string;
  password: string;
}

/** Park configuration */
export interface ParkConfig {
  id: number;
  name: string;
}

/** Mission assigned by the Commander to a SoldierBot */
export interface Mission {
  missionId: string;
  account: AccountConfig;
  park: ParkConfig;
  targetDate: string; // YYYY-MM-DD
  token: string;
}

/** Cached token entry in data/tokens.json */
export interface TokenEntry {
  accountIndex: number;
  email: string;
  accessToken: string;
  updatedAt: string;
}

/** Token cache file structure */
export interface TokenCache {
  tokens: TokenEntry[];
  lastFullRefresh: string;
}

/** IDRD Login response */
export interface IdrdLoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** IDRD schedule slot from the availability API */
export interface IdrdScheduleSlot {
  start: string;
  end: string;
  category: string;
  can: boolean;
  title?: string;
}

/** Result from the AvailabilityEngine */
export interface SlotResult {
  found: boolean;
  debugInfo: string;
  startTime?: Date;
  endTime?: Date;
  dateFormatted?: string;       // YYYY-MM-DD
  startHourFormatted?: string;  // "8:00 PM" (g:i A format)
  endHourFormatted?: string;    // "10:00 PM"
}

/** IDRD reservation/payment response */
export interface IdrdReservationResponse {
  code: number;
  data: {
    booking_id: number;
    amount: number;
    concept: string;
    name: string;
    surname: string;
    document: string;
    email: string;
    park_id: number;
    payment?: number;
  };
}

/** PSE payment link response */
export interface PsePaymentResponse {
  data: {
    bank_url?: string;
    bankUrl?: string;
    url?: string;
    processUrl?: string;
    redirect_url?: string;
    payment?: number;
    booking_id?: number;
  };
}

/** Telegram notification targets */
export interface TelegramTarget {
  botToken: string;
  chatId: string;
}

/** Bot execution status */
export type BotStatus = 'idle' | 'searching' | 'found' | 'reserved' | 'completed' | 'stopped' | 'error';

/** SoldierBot execution result */
export interface BotExecutionResult {
  missionId: string;
  status: BotStatus;
  account: string;
  park: string;
  targetDate: string;
  slotsChecked: number;
  reservationMade: boolean;
  paymentLink?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/** Environment configuration (validated by Zod) */
export interface AppConfig {
  accounts: AccountConfig[];
  parks: {
    sanAndres: ParkConfig;
    juanAmarillo: ParkConfig;
  };
  telegram: {
    bot901: TelegramTarget;
    botInv: TelegramTarget;
  };
  idrd: {
    citizenUrl: string;
    contractorUrl: string;
  };
  schedule: {
    botStartHour: number;
    botStopHour: number;
    slotStartHour: number;
    slotEndHour: number;
    minAnticipationHours: number;
  };
}
