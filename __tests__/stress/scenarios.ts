// =========================================================
// SCENARIOS - Pre-canned MockKnobs profiles for stress runs
// =========================================================

import { MockKnobs } from './mock-idrd';

export const SCENARIOS: Record<string, MockKnobs> = {
  baseline: {
    baseLatencyMs: 50,
    latencyJitterMs: 50,
    loginFailRate: 0,
    scheduleFailRate: 0,
    reserveFailRate: 0,
    reserve401Rate: 0,
    reserveTimeoutRate: 0,
    pseFailRate: 0,
    slotLockMs: 30_000,
  },

  'monday-9am': {
    baseLatencyMs: 800,
    latencyJitterMs: 1500,
    loginFailRate: 0.02,
    scheduleFailRate: 0.05,
    reserveFailRate: 0.05,
    reserve401Rate: 0,
    reserveTimeoutRate: 0.02,
    pseFailRate: 0.03,
    slotLockMs: 30_000,
  },

  chaos: {
    baseLatencyMs: 500,
    latencyJitterMs: 2000,
    loginFailRate: 0.3,
    scheduleFailRate: 0.3,
    reserveFailRate: 0.3,
    reserve401Rate: 0.15,
    reserveTimeoutRate: 0.10,
    pseFailRate: 0.3,
    slotLockMs: 30_000,
  },

  'slot-rush': {
    baseLatencyMs: 100,
    latencyJitterMs: 100,
    loginFailRate: 0,
    scheduleFailRate: 0.02,
    reserveFailRate: 0.02,
    reserve401Rate: 0,
    reserveTimeoutRate: 0,
    pseFailRate: 0.02,
    slotLockMs: 5_000,
  },
};
