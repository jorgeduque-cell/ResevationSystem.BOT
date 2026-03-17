// =========================================================
// TESTS - MissionPlanner
// =========================================================

import { MissionPlanner } from '../src/core/MissionPlanner';
import { AccountConfig, ParkConfig } from '../src/types';

describe('MissionPlanner', () => {
  const sanAndres: ParkConfig = { id: 15982, name: 'San Andrés' };
  const juanAmarillo: ParkConfig = { id: 15980, name: 'Juan Amarillo' };
  const planner = new MissionPlanner(sanAndres, juanAmarillo);

  // Generate 12 mock accounts
  const accounts: AccountConfig[] = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    name: `Account ${i + 1}`,
    document: `10000000${i + 1}`,
    email: `account${i + 1}@test.com`,
    password: 'TestPass123*',
  }));

  // Generate mock token map
  const tokenMap = new Map<number, string>();
  accounts.forEach((a) => tokenMap.set(a.index, `token-${a.index}`));

  test('generates exactly 12 missions', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    expect(missions).toHaveLength(12);
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

  test('assigns unique dates to each mission', () => {
    const missions = planner.generateMissions(accounts, tokenMap);
    // Missions 1-6 should have same date pattern as 7-12
    const sanAndresDates = missions.slice(0, 6).map((m) => m.targetDate);
    const juanAmarilloDates = missions.slice(6, 12).map((m) => m.targetDate);

    // Corresponding bots for each park should have the same dates
    expect(sanAndresDates).toEqual(juanAmarilloDates);
  });

  test('skips accounts without tokens', () => {
    const partialTokenMap = new Map<number, string>();
    partialTokenMap.set(1, 'token-1');
    partialTokenMap.set(7, 'token-7');

    const missions = planner.generateMissions(accounts, partialTokenMap);
    expect(missions).toHaveLength(2);
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
