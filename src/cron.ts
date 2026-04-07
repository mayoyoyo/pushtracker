import { getUsersWithExpiredBoundary, getTodayTotal, updateDebt, updateNextDayBoundary } from "./db";
import { advanceBoundary, getPreviousDayBoundary } from "./timezone";

const CRON_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function processExpiredBoundaries(nowUtc: string): void {
  let users = getUsersWithExpiredBoundary(nowUtc);

  while (users.length > 0) {
    for (const user of users) {
      const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
      const todayTotal = getTodayTotal(user.id, prevBoundary, user.next_day_boundary);
      const shortfall = user.daily_target - todayTotal;
      const nextBoundary = advanceBoundary(user.timezone, user.next_day_boundary);
      const dayFullyElapsed = nextBoundary <= nowUtc;
      const userWasActive = todayTotal > 0;

      if (shortfall > 0 && (userWasActive || dayFullyElapsed)) {
        updateDebt(user.id, shortfall);
      }

      updateNextDayBoundary(user.id, nextBoundary);
    }

    // Re-check in case multiple days have passed (user offline)
    users = getUsersWithExpiredBoundary(nowUtc);
  }
}

export function startCron(): void {
  console.log("Day boundary cron started (every 15 minutes)");
  setInterval(() => {
    const now = new Date().toISOString();
    processExpiredBoundaries(now);
  }, CRON_INTERVAL_MS);

  // Run once on startup
  processExpiredBoundaries(new Date().toISOString());
}
