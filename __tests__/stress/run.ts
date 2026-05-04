// =========================================================
// STRESS RUNNER - Boots a MockIdrd, builds a fake AppConfig,
// invokes Commander.deploy() against it, and prints a report.
// =========================================================

import { MockIdrd, MetricsSnapshot, EndpointReport } from './mock-idrd';
import { SCENARIOS } from './scenarios';
import { Commander } from '../../src/services/Commander';
import { AppConfig, AccountConfig, CourtInfo, BotExecutionResult } from '../../src/types';
import { logger } from '../../src/utils/logger';

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function buildAccounts(): AccountConfig[] {
  return Array.from({ length: 18 }, (_, i) => ({
    index: i + 1,
    name: `Test-${i + 1}`,
    document: `9000000${String(i + 1).padStart(2, '0')}`,
    email: `test${i + 1}@stress.local`,
    password: 'StressPass!',
  }));
}

function buildCourts(): CourtInfo[] {
  return [
    { courtId: '1001', parkId: 1, parkName: 'MockPark 1', courtName: 'MockCourt 1' },
    { courtId: '1002', parkId: 2, parkName: 'MockPark 2', courtName: 'MockCourt 2' },
    { courtId: '1003', parkId: 3, parkName: 'MockPark 3', courtName: 'MockCourt 3' },
  ];
}

function buildConfig(port: number): AppConfig {
  return {
    accounts: buildAccounts(),
    telegram: {
      botToken: 'fake_stress_token',
      notifyChatIds: ['0'],
    },
    idrd: {
      citizenUrl: `http://127.0.0.1:${port}`,
      contractorUrl: `http://127.0.0.1:${port}`,
    },
    schedule: {
      slotStartHour: 20,
      slotEndHour: 22,
      // 1 hour anticipation so today's evening slots qualify.
      minAnticipationHours: 1,
    },
  };
}

function fmtBytes(n: number): string {
  const sign = n < 0 ? '-' : '+';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs}B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`;
  return `${sign}${(abs / 1024 / 1024).toFixed(1)}MB`;
}

function endpointLine(name: string, r: EndpointReport): string {
  return (
    `  ${name.padEnd(10)} total=${String(r.total).padStart(5)}  ` +
    `fail=${String(r.failures).padStart(4)}  ` +
    `avg=${String(r.avg).padStart(5)}ms  ` +
    `p50=${String(r.p50).padStart(5)}ms  ` +
    `p95=${String(r.p95).padStart(5)}ms  ` +
    `p99=${String(r.p99).padStart(5)}ms`
  );
}

function deltaMem(start: NodeJS.MemoryUsage, end: NodeJS.MemoryUsage): string {
  return (
    `rss ${fmtBytes(end.rss - start.rss)}  ` +
    `heapUsed ${fmtBytes(end.heapUsed - start.heapUsed)}  ` +
    `external ${fmtBytes(end.external - start.external)}`
  );
}

async function main(): Promise<void> {
  const scenarioName = process.env.STRESS_SCENARIO || 'baseline';
  const durationMs = parseInt(process.env.STRESS_DURATION_MS || '60000', 10);
  const port = parseInt(process.env.STRESS_PORT || '4001', 10);

  const knobs = SCENARIOS[scenarioName];
  if (!knobs) {
    console.error(`Unknown scenario: ${scenarioName}. Valid: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  console.log(`${BOLD}=== STRESS HARNESS ===${RESET}`);
  console.log(`scenario:  ${scenarioName}`);
  console.log(`duration:  ${durationMs}ms`);
  console.log(`port:      ${port}`);
  console.log(`knobs:     ${JSON.stringify(knobs)}`);
  console.log('');

  const mock = new MockIdrd(knobs);
  await mock.start(port);
  console.log(`${GREEN}MockIdrd listening on http://127.0.0.1:${port}${RESET}\n`);

  const config = buildConfig(port);
  const courts = buildCourts();
  const commander = new Commander(config, false);

  const abort = new AbortController();
  const startedAt = Date.now();
  const memStart = process.memoryUsage();

  // Periodic snapshot — one line so logs stay readable.
  const snapshotTimer = setInterval(() => {
    const m = mock.getMetrics();
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    process.stdout.write(
      `${YELLOW}[snap +${elapsed}s]${RESET} ` +
        `reserves=${m.reserveSuccess} ` +
        `409=${m.reserve409} ` +
        `401=${m.reserve401} ` +
        `5xx=${m.reserve5xx} ` +
        `timeouts=${m.reserveTimeoutInjected} ` +
        `reserve_p95=${m.endpoints.reserve.p95}ms ` +
        `locked=${m.currentlyLockedSlots}\n`,
    );
  }, 5_000);

  // Abort timer
  const abortTimer = setTimeout(() => {
    console.log(`\n${YELLOW}>>> Duration reached. Sending abort...${RESET}\n`);
    abort.abort();
  }, durationMs);

  let results: BotExecutionResult[] = [];
  try {
    results = await commander.deploy(courts, abort.signal);
  } catch (err: any) {
    logger.error({ err: err.message }, 'commander.deploy threw');
  } finally {
    clearTimeout(abortTimer);
    clearInterval(snapshotTimer);
  }

  const memEnd = process.memoryUsage();
  const totalRuntimeMs = Date.now() - startedAt;
  const finalMetrics = mock.getMetrics();

  printReport(scenarioName, knobs, finalMetrics, results, memStart, memEnd, totalRuntimeMs);

  await mock.stop();
  // Force exit — pino transports + node-telegram-bot-api occasionally hold the loop open.
  setTimeout(() => process.exit(0), 200).unref();
}

function printReport(
  scenarioName: string,
  knobs: any,
  metrics: MetricsSnapshot,
  results: BotExecutionResult[],
  memStart: NodeJS.MemoryUsage,
  memEnd: NodeJS.MemoryUsage,
  totalRuntimeMs: number,
): void {
  const totalReservations = results.reduce((s, r) => s + r.reservationCount, 0);
  const successRate = metrics.endpoints.reserve.total === 0
    ? 0
    : (metrics.reserveSuccess / metrics.endpoints.reserve.total) * 100;

  const issues: string[] = [];
  if (metrics.reserve401 > 0) {
    issues.push(`reserve401 count = ${metrics.reserve401} (token-expired path exercised)`);
  }
  if (metrics.endpoints.reserve.avg > 5000) {
    issues.push(`avg reserve latency ${metrics.endpoints.reserve.avg}ms > 5000ms`);
  }
  if (metrics.endpoints.reserve.total > 0 && successRate < 50) {
    issues.push(`reserve success rate ${successRate.toFixed(1)}% < 50%`);
  }
  if (metrics.reserveTimeoutInjected > 0) {
    issues.push(`reserveTimeoutInjected = ${metrics.reserveTimeoutInjected} (axios timeouts triggered)`);
  }

  const lines: string[] = [];
  lines.push('');
  lines.push('='.repeat(70));
  lines.push(`${BOLD}STRESS REPORT — scenario "${scenarioName}"${RESET}`);
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(`runtime:        ${(totalRuntimeMs / 1000).toFixed(1)}s`);
  lines.push(`mem delta:      ${deltaMem(memStart, memEnd)}`);
  lines.push('');

  lines.push(`${BOLD}Mock endpoints:${RESET}`);
  lines.push(endpointLine('login', metrics.endpoints.login));
  lines.push(endpointLine('schedules', metrics.endpoints.schedules));
  lines.push(endpointLine('reserve', metrics.endpoints.reserve));
  lines.push(endpointLine('pse', metrics.endpoints.pse));
  lines.push('');

  lines.push(`${BOLD}Reserve breakdown:${RESET}`);
  lines.push(`  success            = ${metrics.reserveSuccess}`);
  lines.push(`  409 (taken)        = ${metrics.reserve409}`);
  lines.push(`  401 (auth)         = ${metrics.reserve401}`);
  lines.push(`  5xx                = ${metrics.reserve5xx}`);
  lines.push(`  timeouts injected  = ${metrics.reserveTimeoutInjected}`);
  lines.push(`  currently locked   = ${metrics.currentlyLockedSlots}`);
  lines.push(`  success rate       = ${successRate.toFixed(1)}%`);
  lines.push('');

  lines.push(`${BOLD}Bot results:${RESET}`);
  lines.push(`  total reservations made by bots = ${totalReservations}`);
  lines.push(`  missions executed               = ${results.length}`);
  if (results.length > 0) {
    const byStatus: Record<string, number> = {};
    for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    lines.push(`  status breakdown                = ${JSON.stringify(byStatus)}`);
    lines.push('');
    lines.push('  per-mission:');
    for (const r of results) {
      const tag = r.reservationCount > 0 ? `${GREEN}OK${RESET}` : r.status === 'aborted' ? 'AB' : '..';
      lines.push(
        `    [${tag}] ${r.missionId.padEnd(11)} ${r.account.padEnd(10)} → ` +
          `${r.park}/${r.courtName} (${r.targetDate}) ` +
          `attempts=${r.slotsChecked} reservations=${r.reservationCount} status=${r.status}`,
      );
    }
  }
  lines.push('');

  lines.push(`${BOLD}Notable issues:${RESET}`);
  if (issues.length === 0) {
    lines.push(`  ${GREEN}(none)${RESET}`);
  } else {
    for (const i of issues) lines.push(`  ${RED}! ${i}${RESET}`);
  }
  lines.push('');
  lines.push('='.repeat(70));

  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error('Stress runner crashed:', err);
  process.exit(1);
});
