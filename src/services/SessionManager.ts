// =========================================================
// SESSION MANAGER - Per-chat conversational state for Telegram
// Persists to data/user-session.json so a crash/restart keeps
// the current search going.
// =========================================================

import fs from 'fs';
import path from 'path';
import { UserSession, SessionStatus, CourtInfo } from '../types';
import { logger } from '../utils/logger';

const SESSION_FILE = path.resolve(__dirname, '../../data/user-session.json');
const INACTIVITY_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionFile {
  sessions: UserSession[];
}

export class SessionManager {
  private sessions: Map<number, UserSession> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(SESSION_FILE)) return;
      const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
      const data: SessionFile = JSON.parse(raw);
      const now = Date.now();
      for (const s of data.sessions) {
        if (now - new Date(s.updatedAt).getTime() < INACTIVITY_MS) {
          this.sessions.set(s.chatId, s);
        }
      }
      logger.info(`📂 ${this.sessions.size} sesión(es) cargada(s) desde disco`);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'No se pudo cargar user-session.json (arrancando vacío)');
    }
  }

  private persist(): void {
    try {
      const data: SessionFile = { sessions: Array.from(this.sessions.values()) };
      fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error guardando user-session.json');
    }
  }

  get(chatId: number): UserSession | undefined {
    const s = this.sessions.get(chatId);
    if (!s) return undefined;
    if (Date.now() - new Date(s.updatedAt).getTime() >= INACTIVITY_MS) {
      this.sessions.delete(chatId);
      this.persist();
      return undefined;
    }
    return s;
  }

  setCourtIds(chatId: number, courtIds: string[]): UserSession {
    const session: UserSession = {
      chatId,
      status: 'awaiting_confirmation',
      courtIds,
      updatedAt: new Date().toISOString(),
    };
    this.sessions.set(chatId, session);
    this.persist();
    return session;
  }

  setCourtInfos(chatId: number, courtInfos: CourtInfo[]): UserSession | undefined {
    const s = this.sessions.get(chatId);
    if (!s) return undefined;
    s.courtInfos = courtInfos;
    s.updatedAt = new Date().toISOString();
    this.persist();
    return s;
  }

  setStatus(chatId: number, status: SessionStatus): UserSession | undefined {
    const s = this.sessions.get(chatId);
    if (!s) return undefined;
    s.status = status;
    s.updatedAt = new Date().toISOString();
    this.persist();
    return s;
  }

  clear(chatId: number): void {
    this.sessions.delete(chatId);
    this.persist();
  }

  all(): UserSession[] {
    return Array.from(this.sessions.values());
  }
}
