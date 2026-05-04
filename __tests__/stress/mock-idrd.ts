// =========================================================
// MOCK IDRD - In-process Node http server that emulates the
// four IDRD endpoints the bot calls. Zero traffic to real IDRD.
// =========================================================

import * as http from 'http';
import { URL } from 'url';

export interface MockKnobs {
  baseLatencyMs: number;
  latencyJitterMs: number;
  loginFailRate: number;
  scheduleFailRate: number;
  reserveFailRate: number;
  reserve401Rate: number;
  reserveTimeoutRate: number;
  pseFailRate: number;
  slotLockMs: number;
}

const DEFAULT_KNOBS: MockKnobs = {
  baseLatencyMs: 100,
  latencyJitterMs: 100,
  loginFailRate: 0,
  scheduleFailRate: 0,
  reserveFailRate: 0,
  reserve401Rate: 0,
  reserveTimeoutRate: 0,
  pseFailRate: 0,
  slotLockMs: 30_000,
};

interface EndpointStat {
  total: number;
  failures: number;
  latencies: number[];
}

export interface EndpointReport {
  total: number;
  failures: number;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
}

export interface MetricsSnapshot {
  endpoints: {
    login: EndpointReport;
    schedules: EndpointReport;
    reserve: EndpointReport;
    pse: EndpointReport;
  };
  reserveSuccess: number;
  reserve409: number;
  reserve401: number;
  reserve5xx: number;
  reserveTimeoutInjected: number;
  currentlyLockedSlots: number;
}

// (parkId|date|startHour) → release timeout handle. Presence == locked.
type SlotKey = string;

export class MockIdrd {
  private server: http.Server | null = null;
  private knobs: MockKnobs;
  private issuedTokens = new Set<string>();
  private lockedSlots = new Map<SlotKey, NodeJS.Timeout>();

  private statLogin: EndpointStat = { total: 0, failures: 0, latencies: [] };
  private statSchedules: EndpointStat = { total: 0, failures: 0, latencies: [] };
  private statReserve: EndpointStat = { total: 0, failures: 0, latencies: [] };
  private statPse: EndpointStat = { total: 0, failures: 0, latencies: [] };

  private reserveSuccess = 0;
  private reserve409 = 0;
  private reserve401 = 0;
  private reserve5xx = 0;
  private reserveTimeoutInjected = 0;

  constructor(knobs: Partial<MockKnobs> = {}) {
    this.knobs = { ...DEFAULT_KNOBS, ...knobs };
  }

  setKnobs(partial: Partial<MockKnobs>): void {
    this.knobs = { ...this.knobs, ...partial };
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    // Clear all pending slot-release timers so the process can exit
    for (const t of this.lockedSlots.values()) clearTimeout(t);
    this.lockedSlots.clear();

    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  getMetrics(): MetricsSnapshot {
    return {
      endpoints: {
        login: this.summarize(this.statLogin),
        schedules: this.summarize(this.statSchedules),
        reserve: this.summarize(this.statReserve),
        pse: this.summarize(this.statPse),
      },
      reserveSuccess: this.reserveSuccess,
      reserve409: this.reserve409,
      reserve401: this.reserve401,
      reserve5xx: this.reserve5xx,
      reserveTimeoutInjected: this.reserveTimeoutInjected,
      currentlyLockedSlots: this.lockedSlots.size,
    };
  }

  // ============== internals ==============

  private summarize(s: EndpointStat): EndpointReport {
    const sorted = [...s.latencies].sort((a, b) => a - b);
    const pct = (p: number) => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return Math.round(sorted[idx]);
    };
    const avg = sorted.length === 0 ? 0 : Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    return { total: s.total, failures: s.failures, p50: pct(50), p95: pct(95), p99: pct(99), avg };
  }

  private latency(): number {
    return this.knobs.baseLatencyMs + Math.random() * this.knobs.latencyJitterMs;
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private send(res: http.ServerResponse, status: number, body: any): void {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
    });
    res.end(payload);
  }

  private extractToken(req: http.IncomingMessage): string | null {
    const auth = req.headers['authorization'];
    if (!auth || Array.isArray(auth)) return null;
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    return m ? m[1] : null;
  }

  private slotKey(parkId: string | number, date: string, startHour: number): SlotKey {
    return `${parkId}|${date}|${startHour}`;
  }

  private parseStartHour(startHourFmt: string): number {
    // "8:00 PM" → 20
    const m = /^(\d{1,2}):(\d{2})\s+(AM|PM)$/i.exec(startHourFmt.trim());
    if (!m) return NaN;
    let h = parseInt(m[1], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';

    try {
      if (method === 'POST' && path === '/login') {
        return await this.handleLogin(req, res, started);
      }
      if (method === 'GET' && /^\/parks\/schedules\/\d+$/.test(path)) {
        return await this.handleSchedules(req, res, url, path, started);
      }
      if (method === 'POST' && /^\/parks\/schedules\/\d+\/payment$/.test(path)) {
        return await this.handleReserve(req, res, path, started);
      }
      if (method === 'POST' && path === '/payment-gateway/transferBank') {
        return await this.handlePse(req, res, started);
      }

      this.send(res, 404, { error: 'not_found', path });
    } catch (err: any) {
      this.send(res, 500, { error: 'mock_internal', message: err?.message });
    }
  }

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse, started: number) {
    const body = await this.readJsonBody(req).catch(() => ({}));
    await new Promise((r) => setTimeout(r, this.latency()));

    this.statLogin.total++;

    if (Math.random() < this.knobs.loginFailRate) {
      this.statLogin.failures++;
      this.statLogin.latencies.push(Date.now() - started);
      return this.send(res, 500, { error: 'login_simulated_failure' });
    }

    const email = body?.email;
    const password = body?.password;
    if (!email || !password) {
      this.statLogin.failures++;
      this.statLogin.latencies.push(Date.now() - started);
      return this.send(res, 401, { error: 'invalid_credentials' });
    }

    const token = `tok_${email}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    this.issuedTokens.add(token);
    this.statLogin.latencies.push(Date.now() - started);

    this.send(res, 200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }

  private async handleSchedules(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    path: string,
    started: number,
  ) {
    await new Promise((r) => setTimeout(r, this.latency()));
    this.statSchedules.total++;

    const token = this.extractToken(req);
    if (!token || !this.issuedTokens.has(token)) {
      this.statSchedules.failures++;
      this.statSchedules.latencies.push(Date.now() - started);
      return this.send(res, 401, { error: 'unauthorized' });
    }

    if (Math.random() < this.knobs.scheduleFailRate) {
      this.statSchedules.failures++;
      this.statSchedules.latencies.push(Date.now() - started);
      return this.send(res, 503, { error: 'schedule_simulated_failure' });
    }

    const parkId = parseInt(path.split('/').pop()!, 10);
    const date = url.searchParams.get('date') || '';

    // Build hourly slots 18..23 for the requested date.
    const hours = [18, 19, 20, 21, 22, 23];
    const slots = hours.map((h) => {
      const startHourStr = String(h).padStart(2, '0');
      const endH = (h + 1) % 24;
      const endHourStr = String(endH).padStart(2, '0');
      const endDate = endH === 0
        // crosses midnight — increment the date
        ? this.addDay(date)
        : date;
      const locked = this.lockedSlots.has(this.slotKey(parkId, date, h));
      return {
        start: `${date}T${startHourStr}:00:00-05:00`,
        end: `${endDate}T${endHourStr}:00:00-05:00`,
        category: 'tenis',
        can: !locked,
        scenary_id: parkId,
        scenary_name: `MockPark ${parkId}`,
        court_name: `MockCourt ${parkId}`,
        title: `Mock slot ${h}:00`,
        price: 50000,
      };
    });

    this.statSchedules.latencies.push(Date.now() - started);
    this.send(res, 200, { data: slots });
  }

  private addDay(yyyymmdd: string): string {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  private async handleReserve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    started: number,
  ) {
    // Inject a stall (35s) BEFORE reading body so axios (30s) times out.
    if (Math.random() < this.knobs.reserveTimeoutRate) {
      this.reserveTimeoutInjected++;
      this.statReserve.total++;
      this.statReserve.failures++;
      // Hold the connection open for 35s, then close it.
      await new Promise((r) => setTimeout(r, 35_000));
      this.statReserve.latencies.push(Date.now() - started);
      try {
        return this.send(res, 504, { error: 'simulated_stall' });
      } catch {
        return; // socket likely already gone
      }
    }

    const body = await this.readJsonBody(req).catch(() => ({}));
    await new Promise((r) => setTimeout(r, this.latency()));
    this.statReserve.total++;

    const token = this.extractToken(req);
    if (!token || !this.issuedTokens.has(token)) {
      this.reserve401++;
      this.statReserve.failures++;
      this.statReserve.latencies.push(Date.now() - started);
      return this.send(res, 401, { error: 'unauthorized' });
    }

    if (Math.random() < this.knobs.reserve401Rate) {
      // Simulate token-expired mid-flight: drop the token from issued set.
      this.issuedTokens.delete(token);
      this.reserve401++;
      this.statReserve.failures++;
      this.statReserve.latencies.push(Date.now() - started);
      return this.send(res, 401, { error: 'token_expired_simulated' });
    }

    if (Math.random() < this.knobs.reserveFailRate) {
      this.reserve5xx++;
      this.statReserve.failures++;
      this.statReserve.latencies.push(Date.now() - started);
      return this.send(res, 503, { error: 'reserve_simulated_failure' });
    }

    const parkId = parseInt(path.split('/')[3], 10);
    const date = body?.date || '';
    const startHourFmt = body?.start_hour || '';
    const document = String(body?.document || '');
    const startHour = this.parseStartHour(startHourFmt);

    if (!date || !Number.isFinite(startHour)) {
      this.reserve5xx++;
      this.statReserve.failures++;
      this.statReserve.latencies.push(Date.now() - started);
      return this.send(res, 400, { error: 'bad_payload' });
    }

    const key = this.slotKey(parkId, date, startHour);
    if (this.lockedSlots.has(key)) {
      this.reserve409++;
      this.statReserve.failures++;
      this.statReserve.latencies.push(Date.now() - started);
      return this.send(res, 200, { code: 409, message: 'Slot ya tomado' });
    }

    const releaseTimer = setTimeout(() => {
      this.lockedSlots.delete(key);
    }, this.knobs.slotLockMs);
    // Don't keep the event loop alive just for slot locks.
    if (typeof releaseTimer.unref === 'function') releaseTimer.unref();
    this.lockedSlots.set(key, releaseTimer);

    const bookingId = Math.floor(Math.random() * 1e9);
    this.reserveSuccess++;
    this.statReserve.latencies.push(Date.now() - started);

    this.send(res, 200, {
      code: 200,
      data: {
        booking_id: bookingId,
        amount: 50000,
        concept: 'Reserva',
        name: 'Test',
        surname: 'Bot',
        document,
        email: 'test@test.co',
        park_id: parkId,
      },
    });
  }

  private async handlePse(req: http.IncomingMessage, res: http.ServerResponse, started: number) {
    const body = await this.readJsonBody(req).catch(() => ({}));
    await new Promise((r) => setTimeout(r, this.latency()));
    this.statPse.total++;

    const token = this.extractToken(req);
    if (!token) {
      this.statPse.failures++;
      this.statPse.latencies.push(Date.now() - started);
      return this.send(res, 401, { error: 'unauthorized' });
    }

    if (Math.random() < this.knobs.pseFailRate) {
      this.statPse.failures++;
      this.statPse.latencies.push(Date.now() - started);
      return this.send(res, 500, { error: 'pse_simulated_failure' });
    }

    const bookingId = body?.reservationId ?? Math.floor(Math.random() * 1e9);
    this.statPse.latencies.push(Date.now() - started);

    this.send(res, 200, {
      data: {
        url: `https://mock.local/pay/${bookingId}`,
        payment: bookingId,
        booking_id: bookingId,
      },
    });
  }
}
