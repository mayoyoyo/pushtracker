import { getUsersWithExpiredBoundary, getUserById, getTodayTotal, getTodayLogs, updateDebt, updateNextDayBoundary, updateStreak, saveDayResult, getSlackConfig, getDiscordConfig, hasEverLoggedPushups, getResolvedUserById } from "./db";
import { advanceBoundary, getPreviousDayBoundary } from "./timezone";
import { postDayResult } from "./slack";
import { postDayResult as postDiscordDayResult } from "./discord";
import { pickDayIcon, dayIconToMode } from "./day-icon";
import { DateTime } from "luxon";

const CRON_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function processExpiredBoundaries(nowUtc: string): void {
  let users = getUsersWithExpiredBoundary(nowUtc);

  while (users.length > 0) {
    // Process sources before aliases so each alias sees the fresh source state.
    users.sort((a, b) => {
      const aIsAlias = a.source_user_id != null ? 1 : 0;
      const bIsAlias = b.source_user_id != null ? 1 : 0;
      return aIsAlias - bIsAlias;
    });

    // Captures each source's pre-advance rollup results for this iteration.
    // Alias rows read from this map so their notifier posts reflect the day that
    // just ended, not the day the source just advanced into.
    const sourceRollup = new Map<number, {
      todayTotal: number;
      met: boolean;
      newStreak: number;
      newDebt: number;
      dayDate: string;
    }>();

    for (const user of users) {
      if (user.source_user_id != null) {
        // Alias branch: no rollup, no boundary advance — just fan out the org's
        // notifier posts using the source's rollup captured earlier this iteration.
        const slackConfig = getSlackConfig(user.invite_code);
        const discordConfig = getDiscordConfig(user.invite_code);
        if (!slackConfig && !discordConfig) continue;

        const result = sourceRollup.get(user.source_user_id);
        if (!result) continue; // Source wasn't rolled up this iteration (e.g. never-logged source).

        const resolved = getResolvedUserById(user.id);
        if (!resolved) continue;

        const formattedDate = DateTime.fromISO(result.dayDate).toFormat("MMMM d, yyyy");
        if (slackConfig) {
          postDayResult(
            slackConfig.slack_bot_token,
            slackConfig.slack_channel,
            user.username,
            formattedDate,
            result.todayTotal,
            resolved.daily_target,
            result.met,
            result.newStreak,
            result.newDebt,
          ).catch(err => console.error(`Slack post failed for ${user.username}:`, err));
        }
        if (discordConfig) {
          postDiscordDayResult(
            discordConfig.discord_webhook_url,
            user.username,
            formattedDate,
            result.todayTotal,
            resolved.daily_target,
            result.met,
            result.newStreak,
            result.newDebt,
          ).catch(err => console.error(`Discord post failed for ${user.username}:`, err));
        }
        continue;
      }

      // Non-alias branch: existing rollup behavior.
      const nextBoundary = advanceBoundary(user.timezone, user.next_day_boundary);

      // Skip users who have never logged a pushup — no debt, no streak, no calendar
      if (!hasEverLoggedPushups(user.id)) {
        updateNextDayBoundary(user.id, nextBoundary);
        continue;
      }

      const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
      const todayTotal = getTodayTotal(user.id, prevBoundary, user.next_day_boundary);
      const shortfall = user.daily_target - todayTotal;

      // Day icon via shared helper (see src/day-icon.ts) so the rolled-up icon
      // matches the live /api/me and /api/team/today computations.
      const met = user.daily_target > 0 && todayTotal >= user.daily_target;
      const logs = getTodayLogs(user.id, prevBoundary, user.next_day_boundary);
      const dayIcon = pickDayIcon(logs, user.daily_target);
      // Shift last5: append new day, keep max 5
      const days = user.last5 ? user.last5.split(',') : [];
      days.push(dayIcon);
      if (days.length > 5) days.shift();
      const newLast5 = days.join(',');
      // Streak: count consecutive met days from the end
      let newStreak = 0;
      for (let j = days.length - 1; j >= 0; j--) {
        if (days[j] === 'S' || days[j] === 'F' || days[j] === 'U') newStreak++;
        else break;
      }
      updateStreak(user.id, newLast5, newStreak);

      // Save to day_results for calendar (date = the day that just ended)
      const dayDate = DateTime.fromISO(prevBoundary, { zone: 'utc' }).setZone(user.timezone).toISODate();
      saveDayResult(user.id, dayDate!, met, dayIconToMode(dayIcon), todayTotal);

      // Debt: add shortfall or reduce by surplus
      if (shortfall > 0) {
        updateDebt(user.id, shortfall);
      } else if (met && user.debt > 0) {
        const surplus = todayTotal - user.daily_target;
        if (surplus > 0) {
          updateDebt(user.id, -Math.min(surplus, user.debt));
        }
      }

      // Capture pre-advance rollup results for any alias rows that fire their posts this iteration.
      const updatedUser = getUserById(user.id)!;
      sourceRollup.set(user.id, {
        todayTotal,
        met,
        newStreak,
        newDebt: updatedUser.debt,
        dayDate: dayDate!,
      });

      // Post to configured notifiers (Slack and/or Discord)
      const slackConfig = getSlackConfig(user.invite_code);
      const discordConfig = getDiscordConfig(user.invite_code);
      if (slackConfig || discordConfig) {
        const formattedDate = DateTime.fromISO(dayDate!).toFormat("MMMM d, yyyy");
        if (slackConfig) {
          postDayResult(slackConfig.slack_bot_token, slackConfig.slack_channel, user.username, formattedDate, todayTotal, user.daily_target, met, newStreak, updatedUser.debt)
            .catch(err => console.error(`Slack post failed for ${user.username}:`, err));
        }
        if (discordConfig) {
          postDiscordDayResult(discordConfig.discord_webhook_url, user.username, formattedDate, todayTotal, user.daily_target, met, newStreak, updatedUser.debt)
            .catch(err => console.error(`Discord post failed for ${user.username}:`, err));
        }
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
