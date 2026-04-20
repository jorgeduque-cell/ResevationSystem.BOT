// =========================================================
// MISSION PLANNER - Dynamic court-based mission assignment
// 6 accounts per court_id, rotating target days per account
// =========================================================

import { AccountConfig, CourtInfo, Mission } from '../types';
import { getNextDateForDay } from '../utils/date';

// Días objetivo: Mar, Mié, Jue, Vie, Sáb, Lun (0=Dom ... 6=Sáb)
const TARGET_DAYS = [2, 3, 4, 5, 6, 1];

const ACCOUNTS_PER_COURT = 6;

export class MissionPlanner {
  /**
   * Distributes accounts across the supplied courts.
   * For N courts: first 6 accounts → courts[0], next 6 → courts[1], etc.
   * Within each group, accounts rotate through TARGET_DAYS.
   * If there are fewer accounts than 6×N, any remaining courts get fewer bots
   * (or, if length is 0, the court is skipped).
   */
  generateMissions(
    accounts: AccountConfig[],
    courts: CourtInfo[],
    tokenMap: Map<number, string>,
  ): Mission[] {
    const missions: Mission[] = [];
    if (courts.length === 0) return missions;

    for (let i = 0; i < accounts.length; i++) {
      const courtIndex = Math.floor(i / ACCOUNTS_PER_COURT);
      if (courtIndex >= courts.length) break; // no more courts to assign

      const account = accounts[i];
      const token = tokenMap.get(account.index);
      if (!token) continue;

      const court = courts[courtIndex];
      const dayIndex = i % ACCOUNTS_PER_COURT;
      const targetDayOfWeek = TARGET_DAYS[dayIndex];
      const targetDate = getNextDateForDay(targetDayOfWeek);

      missions.push({
        missionId: `Mision-${i + 1}`,
        account,
        targetCourtId: court.courtId,
        court,
        targetDate,
        token,
      });
    }

    return missions;
  }
}
