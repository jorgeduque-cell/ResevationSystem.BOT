// =========================================================
// TESTS - MissionPlanner
// =========================================================

import { MissionPlanner } from '../src/core/MissionPlanner';
import { AccountConfig, ParkConfig } from '../src/types';

describe('MissionPlanner', () => {
  const sanAndres: ParkConfig = { id: 15982, name: 'San Andrés' };
  const juanAmarillo: ParkConfig = { id: 15980, name: 'Juan Amarillo' };
  const florencia: ParkConfig = { id: 1936, name: 'Florencia' };
  const planner = new MissionPlanner(sanAndres, juanAmarillo, florencia);

  // Generate 18 mock accounts
  const accounts: AccountConfig[] = Array.from({ length: 18 }, (_, i) => ({
    index: i + 1,
    name: `Account ${i + 1}`,
    document: `10000000${i + 1}`,
    email: `account${i + 1}@test.com`,
    password: 'TestPass123*',
  }));

  // Generate mock token map
  const tokenMap = new Map<number, string>();
  accounts.forEach((a) => tokenMap.set(a.index, `token-${a.index}`));

  test('generates exactly 18 missions', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    expect(missions).toHaveLength(18);
  });

  test('assigns accounts 1-6 to San Andrés', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    for (let i = 0; i < 6; i++) {
      expect(missions[i].park.name).toBe('San Andrés');
      expect(missions[i].park.id).toBe(15982);
    }
  });

  test('assigns accounts 7-12 to Juan Amarillo', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    for (let i = 6; i < 12; i++) {
      expect(missions[i].park.name).toBe('Juan Amarillo');
      expect(missions[i].park.id).toBe(15980);
    }
  });

  test('assigns accounts 13-18 to Florencia', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    for (let i = 12; i < 18; i++) {
      expect(missions[i].park.name).toBe('Florencia');
      expect(missions[i].park.id).toBe(1936);
    }
  });

  test('assigns unique dates to each mission within each park', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    // All three parks should have the same date pattern
    const sanAndresDates = missions.slice(0, 6).map((m) => m.targetDate);
    const juanAmarilloDates = missions.slice(6, 12).map((m) => m.targetDate);
    const florenciaDates = missions.slice(12, 18).map((m) => m.targetDate);

    expect(sanAndresDates).toEqual(juanAmarilloDates);
    expect(juanAmarilloDates).toEqual(florenciaDates);
  });

  test('skips accounts without tokens', () => {
    const partialTokenMap = new Map<number, string>();
    partialTokenMap.set(1, 'token-1');
    partialTokenMap.set(7, 'token-7');
    partialTokenMap.set(13, 'token-13');

    const missions = planner.generateMissions(accounts, partialTokenMap);
    expect(missions).toHaveLength(3);
  });

  test('mission IDs are sequential', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    missions.forEach((m, i) => {
      expect(m.missionId).toBe(`Mision-${i + 1}`);
    });
  });

  test('target dates are valid YYYY-MM-DD format', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    missions.forEach((m) => {
      expect(m.targetDate).toMatch(dateRegex);
    });
  });
});
