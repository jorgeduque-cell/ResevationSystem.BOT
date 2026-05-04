// =========================================================
// TESTS - MissionPlanner (dynamic court-based distribution)
// =========================================================

import { MissionPlanner } from '../src/core/MissionPlanner';
import { AccountConfig, CourtInfo } from '../src/types';

describe('MissionPlanner (dynamic)', () => {
  const courts: CourtInfo[] = [
    { courtId: '1234', parkId: 15982, parkName: 'San Andrés', courtName: 'Cancha A' },
    { courtId: '5678', parkId: 15980, parkName: 'Juan Amarillo', courtName: 'Cancha B' },
    { courtId: '9012', parkId: 1936, parkName: 'Florencia', courtName: 'Cancha C' },
  ];

  const accounts: AccountConfig[] = Array.from({ length: 18 }, (_, i) => ({
    index: i + 1,
    name: `Account ${i + 1}`,
    document: `10000000${i + 1}`,
    email: `account${i + 1}@test.com`,
    password: 'TestPass123*',
  }));

  const tokenMap = new Map<number, string>();
  accounts.forEach((a) => tokenMap.set(a.index, `token-${a.index}`));

  const planner = new MissionPlanner();

  test('generates 18 missions for 3 courts × 6 accounts', () => {
    const missions = planner.generateMissions(accounts, courts, tokenMap);
    expect(missions).toHaveLength(18);
  });

  test('assigns first 6 accounts to first court', () => {
    const missions = planner.generateMissions(accounts, courts, tokenMap);
    for (let i = 0; i < 6; i++) {
      expect(missions[i].targetCourtId).toBe('1234');
      expect(missions[i].court.parkName).toBe('San Andrés');
    }
  });

  test('assigns accounts 7-12 to second court', () => {
    const missions = planner.generateMissions(accounts, courts, tokenMap);
    for (let i = 6; i < 12; i++) {
      expect(missions[i].targetCourtId).toBe('5678');
      expect(missions[i].court.parkName).toBe('Juan Amarillo');
    }
  });

  test('assigns accounts 13-18 to third court', () => {
    const missions = planner.generateMissions(accounts, courts, tokenMap);
    for (let i = 12; i < 18; i++) {
      expect(missions[i].targetCourtId).toBe('9012');
      expect(missions[i].court.parkName).toBe('Florencia');
    }
  });

  test('date rotation within each 6-account group is identical across courts', () => {
    const missions = planner.generateMissions(accounts, courts, tokenMap);
    const g1 = missions.slice(0, 6).map((m) => m.targetDate);
    const g2 = missions.slice(6, 12).map((m) => m.targetDate);
    const g3 = missions.slice(12, 18).map((m) => m.targetDate);
    expect(g1).toEqual(g2);
    expect(g2).toEqual(g3);
  });

  test('skips accounts without tokens', () => {
    const partialTokenMap = new Map<number, string>();
    partialTokenMap.set(1, 'token-1');
    partialTokenMap.set(7, 'token-7');
    partialTokenMap.set(13, 'token-13');

    const missions = planner.generateMissions(accounts, courts, partialTokenMap);
    expect(missions).toHaveLength(3);
    expect(missions[0].targetCourtId).toBe('1234');
    expect(missions[1].targetCourtId).toBe('5678');
    expect(missions[2].targetCourtId).toBe('9012');
  });

  test('mission IDs are sequential', () => {
    const missions = planner.generateMissions(accounts, courts, tokenMap);
    missions.forEach((m, i) => {
      expect(m.missionId).toBe(`Mision-${i + 1}`);
    });
  });

  test('targetDate is YYYY-MM-DD', () => {
    const missions = planner.generateMissions(accounts, courts, tokenMap);
    missions.forEach((m) => expect(m.targetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  });

  test('returns empty when no courts supplied', () => {
    expect(planner.generateMissions(accounts, [], tokenMap)).toEqual([]);
  });

  test('handles fewer courts than expected (1 court → 6 missions)', () => {
    const missions = planner.generateMissions(accounts, [courts[0]], tokenMap);
    expect(missions).toHaveLength(6);
    missions.forEach((m) => expect(m.targetCourtId).toBe('1234'));
  });
});
