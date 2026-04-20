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

/** Resolved court metadata — which park it belongs to and its human-readable name */
export interface CourtInfo {
  courtId: string;      // 4-5 digit IDRD scenary_id
  parkId: number;
  parkName: string;
  courtName: string;    // e.g. "Cancha Sintética 1"
}

/** Mission assigned by the Commander to a SoldierBot */
export interface Mission {
  missionId: string;
  account: AccountConfig;
  targetCourtId: string;      // filter schedules by this scenary_id
  court: CourtInfo;           // resolved court + park metadata
  targetDate: string;         // YYYY-MM-DD
  token: string;
}

/** Per-chat conversational state for Telegram bot */
export type SessionStatus = 'configuring' | 'awaiting_confirmation' | 'searching' | 'stopped';

export interface UserSession {
  chatId: number;
  status: SessionStatus;
  courtIds: string[];         // validated 3 court IDs
  courtInfos?: CourtInfo[];   // resolved after validation
  updatedAt: string;          // ISO timestamp
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
  /** Court identifier inside the park — used to filter by targetCourtId */
  scenary_id?: string | number;
  scenary_name?: string;
  /** Aliases seen in some IDRD responses */
  court_id?: string | number;
  court_name?: string;
  price?: number;
  amount?: number;
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
  matchedCourtId?: string;      // scenary_id of the slot that matched
  price?: number;               // slot price if returned by IDRD
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
export type BotStatus = 'idle' | 'searching' | 'found' | 'reserved' | 'completed' | 'stopped' | 'aborted' | 'error';

/** SoldierBot execution result */
export interface BotExecutionResult {
  missionId: string;
  status: BotStatus;
  account: string;
  park: string;
  courtId: string;
  courtName: string;
  targetDate: string;
  slotsChecked: number;
  reservationMade: boolean;
  reservationCount: number;
  paymentLink?: string;
  paymentLinks: string[];
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/** Environment configuration (validated by Zod) */
export interface AppConfig {
  accounts: AccountConfig[];
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
