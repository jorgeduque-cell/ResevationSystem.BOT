// =========================================================
// DATE UTILS - Timezone Bogotá helpers
// =========================================================

const TIMEZONE = 'America/Bogota';

/**
 * Returns the current Date adjusted to Bogotá timezone
 */
export function nowBogota(): Date {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: TIMEZONE })
  );
}

/**
 * Formats a Date into "g:i A" format (PHP-style) for IDRD API
 * Example: 8:00 PM (no leading zero on hour)
 */
export function formatHourPhp(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';

  hours = hours % 12;
  hours = hours ? hours : 12; // hour 0 = 12

  return `${hours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

/**
 * Returns YYYY-MM-DD for a given Date *in Bogotá local time*.
 * MUST NOT use toISOString() — that emits UTC, which silently shifts the
 * date forward when the bot runs after 7 PM Bogotá (UTC-5).
 */
export function toIsoDate(date: Date): string {
  // en-CA's locale format is natively YYYY-MM-DD
  return date.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/**
 * Calculates the next occurrence of a given day of the week
 * @param targetDay 0=Sun, 1=Mon, ..., 6=Sat
 * @param fromDate Base date (defaults to now in Bogotá)
 */
export function getNextDateForDay(targetDay: number, fromDate?: Date): string {
  const now = fromDate || nowBogota();
  const currentDay = now.getDay();
  let daysUntil = targetDay - currentDay;

  if (daysUntil <= 0) {
    daysUntil += 7;
  }

  const nextDate = new Date(now);
  nextDate.setDate(now.getDate() + daysUntil);
  return toIsoDate(nextDate);
}

/**
 * Checks if current time is within the bot operating window
 */
export function isWithinOperatingHours(startHour: number, stopHour: number): boolean {
  const now = nowBogota();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // Convert to comparable number (e.g., 9:30 = 9.5)
  const currentTime = currentHour + currentMinute / 60;
  return currentTime >= startHour && currentTime < stopHour;
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep with random jitter (for anti-DDoS desynchronization)
 * @param minMs Minimum milliseconds
 * @param maxMs Maximum milliseconds
 */
export function sleepWithJitter(minMs: number = 1500, maxMs: number = 3000): Promise<void> {
  const jitter = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return sleep(jitter);
}
