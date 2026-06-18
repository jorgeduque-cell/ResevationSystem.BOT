// =========================================================
// TOKEN MANAGER - Reemplazo de "Acceso Maestro"
// Login masivo → cache local en data/tokens.json
// =========================================================

import fs from 'fs';
import path from 'path';
import { AccountConfig, TokenCache, TokenEntry } from '../types';
import { IdrdApiClient } from './IdrdApiClient';
import { logger } from '../utils/logger';
import { sleep } from '../utils/date';

const TOKENS_FILE = path.resolve(__dirname, '../../data/tokens.json');
const TOKENS_DIR = path.resolve(__dirname, '../../data');

// IDRD tokens last ~8h. Reuse a cached single-account token while it's
// comfortably within that window; beyond this, ensureToken() re-logs in.
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

export class TokenManager {
  private apiClient: IdrdApiClient;
  private cache: TokenCache;

  constructor(apiClient: IdrdApiClient) {
    this.apiClient = apiClient;
    this.cache = this.loadCache();
  }

  /**
   * Loads cached tokens from disk, or creates empty cache
   */
  private loadCache(): TokenCache {
    try {
      if (fs.existsSync(TOKENS_FILE)) {
        const raw = fs.readFileSync(TOKENS_FILE, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (error) {
      logger.warn('Cache de tokens corrupto, creando nuevo');
    }
    return { tokens: [], lastFullRefresh: '' };
  }

  /**
   * Persists token cache to disk
   */
  private saveCache(): void {
    if (!fs.existsSync(TOKENS_DIR)) {
      fs.mkdirSync(TOKENS_DIR, { recursive: true });
    }
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(this.cache, null, 2), 'utf-8');
  }

  /**
   * Refreshes tokens for ALL accounts (sequential, with throttle)
   * Replaces the entire "Acceso Maestro" workflow.
   * Reuses an in-memory cache if the last full refresh is recent enough — this
   * avoids the duplicate ~36s login loop between /empieza (validateCourts) and
   * /si (deploy), which both call this method back-to-back.
   */
  async refreshAllTokens(accounts: AccountConfig[]): Promise<Map<number, string>> {
    const FRESHNESS_MS = 5 * 60 * 1000;
    const ageMs = this.cache.lastFullRefresh
      ? Date.now() - new Date(this.cache.lastFullRefresh).getTime()
      : Infinity;
    const allCached = accounts.every((a) =>
      this.cache.tokens.some((t) => t.accountIndex === a.index),
    );
    if (ageMs < FRESHNESS_MS && allCached) {
      const tokenMap = new Map<number, string>();
      this.cache.tokens.forEach((t) => tokenMap.set(t.accountIndex, t.accessToken));
      logger.info(
        `🔑 Reutilizando tokens en caché (refrescados hace ${Math.round(ageMs / 1000)}s, ${tokenMap.size} cuentas)`,
      );
      return tokenMap;
    }

    const tokenMap = new Map<number, string>();
    const updatedEntries: TokenEntry[] = [];

    logger.info(`🔑 Iniciando login masivo de ${accounts.length} cuentas...`);

    for (const account of accounts) {
      try {
        logger.info({ account: account.index, email: account.email }, `Haciendo login cuenta ${account.index}...`);

        const loginResponse = await this.apiClient.login(account.email, account.password);
        const token = loginResponse.access_token;

        tokenMap.set(account.index, token);
        updatedEntries.push({
          accountIndex: account.index,
          email: account.email,
          accessToken: token,
          updatedAt: new Date().toISOString(),
        });

        logger.info({ account: account.index }, `✅ Login exitoso cuenta ${account.index} (${account.name})`);

        // Throttle: 2s between logins to avoid overwhelming IDRD
        await sleep(2000);
      } catch (error: any) {
        logger.error(
          { account: account.index, error: error.message },
          `❌ Login fallido cuenta ${account.index} (${account.name})`
        );

        // Try to use cached token if available
        const cached = this.cache.tokens.find((t) => t.accountIndex === account.index);
        if (cached) {
          logger.warn({ account: account.index }, `Usando token cacheado para cuenta ${account.index}`);
          tokenMap.set(account.index, cached.accessToken);
        }

        await sleep(2000);
      }
    }

    // Update cache
    this.cache = {
      tokens: updatedEntries,
      lastFullRefresh: new Date().toISOString(),
    };
    this.saveCache();

    logger.info(`🔑 Login completado: ${tokenMap.size}/${accounts.length} tokens activos`);
    return tokenMap;
  }

  /**
   * Ensures a SINGLE account has a usable token, without touching the rest of
   * the fleet. Reuses the cached token if it's fresh enough; otherwise logs in
   * only this account and persists it. The optional stagger spaces out the
   * initial logins so 18 bots don't all hit POST /login at the same instant.
   * This is the per-mission login path that keeps each SoldierBot independent.
   */
  async ensureToken(account: AccountConfig, staggerMs: number = 0): Promise<string> {
    const cached = this.cache.tokens.find((t) => t.accountIndex === account.index);
    if (cached?.accessToken) {
      const ageMs = Date.now() - new Date(cached.updatedAt).getTime();
      if (ageMs < TOKEN_TTL_MS) {
        logger.info(
          { account: account.index },
          `🔑 Reutilizando token cacheado cuenta ${account.index} (edad ${Math.round(ageMs / 1000)}s)`,
        );
        return cached.accessToken;
      }
    }
    // Only delay when we actually need to hit /login.
    if (staggerMs > 0) await sleep(staggerMs);
    logger.info({ account: account.index }, `🔑 Login inicial cuenta ${account.index} (${account.name})`);
    return this.refreshSingleToken(account);
  }

  /**
   * Gets a fresh token for a single account (recovery on 401 / circuit breaker,
   * and initial login via ensureToken). Persists the refreshed token so it
   * survives restarts and is visible to ensureToken()/getCachedToken().
   */
  async refreshSingleToken(account: AccountConfig): Promise<string> {
    try {
      const loginResponse = await this.apiClient.login(account.email, account.password);
      const token = loginResponse.access_token;
      this.upsertToken(account, token);
      return token;
    } catch (error: any) {
      logger.error({ account: account.index, error: error.message }, 'Login de cuenta individual fallido');
      throw error;
    }
  }

  /**
   * Inserts or updates a single account's token entry and persists to disk.
   * Safe under concurrent bots: the read-modify-write is synchronous (no await
   * between lookup and saveCache), so two bots can't interleave a partial write.
   */
  private upsertToken(account: AccountConfig, token: string): void {
    const existing = this.cache.tokens.find((t) => t.accountIndex === account.index);
    if (existing) {
      existing.email = account.email;
      existing.accessToken = token;
      existing.updatedAt = new Date().toISOString();
    } else {
      this.cache.tokens.push({
        accountIndex: account.index,
        email: account.email,
        accessToken: token,
        updatedAt: new Date().toISOString(),
      });
    }
    this.saveCache();
  }

  /**
   * Gets a token from cache (without refreshing)
   */
  getCachedToken(accountIndex: number): string | undefined {
    const entry = this.cache.tokens.find((t) => t.accountIndex === accountIndex);
    return entry?.accessToken;
  }
}
