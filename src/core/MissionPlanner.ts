// =========================================================
// MISSION PLANNER - Asignación parque + fecha por cuenta
// Extraído del nodo "Code in JavaScript" del Comandante
// =========================================================

import { AccountConfig, Mission, ParkConfig } from '../types';
import { getNextDateForDay } from '../utils/date';

// Días objetivo en orden: Mar, Mié, Jue, Vie, Sáb, Lun
// (0=Dom, 1=Lun, 2=Mar, 3=Mié, 4=Jue, 5=Vie, 6=Sáb)
const TARGET_DAYS = [2, 3, 4, 5, 6, 1];

export class MissionPlanner {
  private sanAndres: ParkConfig;
  private juanAmarillo: ParkConfig;

  constructor(sanAndres: ParkConfig, juanAmarillo: ParkConfig) {
    this.sanAndres = sanAndres;
    this.juanAmarillo = juanAmarillo;
  }

  /**
   * Generates missions for all accounts
   * Accounts 1-6 → San Andrés
   * Accounts 7-12 → Juan Amarillo
   * Each gets a day from TARGET_DAYS in order
   */
  generateMissions(accounts: AccountConfig[], tokenMap: Map<number, string>): Mission[] {
    const missions: Mission[] = [];

    for (let i = 0; i < accounts.length && i < 12; i++) {
      const account = accounts[i];
      const token = tokenMap.get(account.index);

      if (!token) {
        continue; // Skip accounts without valid tokens
      }

      let park: ParkConfig;
      let dayIndex: number;

      if (i < 6) {
        // Group 1: Accounts 1-6 → San Andrés
        park = this.sanAndres;
        dayIndex = i;
      } else {
        // Group 2: Accounts 7-12 → Juan Amarillo
        park = this.juanAmarillo;
        dayIndex = i - 6;
      }

      const targetDayOfWeek = TARGET_DAYS[dayIndex];
      const targetDate = getNextDateForDay(targetDayOfWeek);

      missions.push({
        missionId: `Mision-${i + 1}`,
        account,
        park,
        targetDate,
        token,
      });
    }

    return missions;
  }
}
