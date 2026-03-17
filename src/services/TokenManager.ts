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
   * Replaces the entire "Acceso Maestro" workflow
   */
  async refreshAllTokens(accounts: AccountConfig[]): Promise<Map<number, string>> {
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
   * Gets a fresh token for a single account (for JIT login during reservation)
   */
  async refreshSingleToken(account: AccountConfig): Promise<string> {
    try {
      const loginResponse = await this.apiClient.login(account.email, account.password);
      return loginResponse.access_token;
    } catch (error: any) {
      logger.error({ account: account.index, error: error.message }, 'JIT Login fallido');
      throw error;
    }
  }

  /**
   * Gets a token from cache (without refreshing)
   */
  getCachedToken(accountIndex: number): string | undefined {
    const entry = this.cache.tokens.find((t) => t.accountIndex === accountIndex);
    return entry?.accessToken;
  }
}
