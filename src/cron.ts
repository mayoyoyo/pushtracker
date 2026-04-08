import { getUsersWithExpiredBoundary, getUserById, getTodayTotal, getTodayLogs, updateDebt, updateNextDayBoundary, updateStreak, saveDayResult, getSlackConfig } from "./db";
import { advanceBoundary, getPreviousDayBoundary } from "./timezone";
import { postDayResult } from "./slack";
import { DateTime } from "luxon";

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

      // Update streak: S=standard, F=fire(noob/manual), I=ice(missed)
      const met = user.daily_target > 0 && todayTotal >= user.daily_target;
      let dayIcon = 'I';
      if (met) {
        const stdTotal = getTodayLogs(user.id, prevBoundary, user.next_day_boundary)
          .filter(l => l.mode === 'standard')
          .reduce((sum, l) => sum + l.count, 0);
        dayIcon = stdTotal >= user.daily_target ? 'S' : 'F';
      }
      // Shift last5: append new day, keep max 5
      const days = user.last5 ? user.last5.split(',') : [];
      days.push(dayIcon);
      if (days.length > 5) days.shift();
      const newLast5 = days.join(',');
      // Streak: count consecutive met days from the end
      let newStreak = 0;
      for (let j = days.length - 1; j >= 0; j--) {
        if (days[j] === 'S' || days[j] === 'F') newStreak++;
        else break;
      }
      updateStreak(user.id, newLast5, newStreak);

      // Save to day_results for calendar (date = the day that just ended)
      const dayDate = DateTime.fromISO(prevBoundary, { zone: 'utc' }).setZone(user.timezone).toISODate();
      saveDayResult(user.id, dayDate, met, dayIcon === 'S' ? 'standard' : dayIcon === 'F' ? 'noob' : 'manual', todayTotal);

      // Debt: add shortfall or reduce by surplus
      if (shortfall > 0 && (userWasActive || dayFullyElapsed)) {
        updateDebt(user.id, shortfall);
      } else if (met && user.debt > 0) {
        const surplus = todayTotal - user.daily_target;
        if (surplus > 0) {
          updateDebt(user.id, -Math.min(surplus, user.debt));
        }
      }

      // Post to Slack if team has it configured
      const slackConfig = getSlackConfig(user.invite_code);
      if (slackConfig) {
        const formattedDate = DateTime.fromISO(dayDate).toFormat("MMMM d, yyyy");
        const updatedUser = getUserById(user.id)!;
        postDayResult(slackConfig.slack_bot_token, slackConfig.slack_channel, user.username, formattedDate, todayTotal, user.daily_target, met, newStreak, updatedUser.debt)
          .catch(err => console.error(`Slack post failed for ${user.username}:`, err));
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
