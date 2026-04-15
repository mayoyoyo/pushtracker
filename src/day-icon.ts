// Day icon selection — shared between the nightly cron rollup and the live
// in-progress computations in /api/me and /api/team/today. All three call
// sites MUST use this helper so the live icon and the rolled-up icon match
// the same semantics (otherwise the UI flips when the boundary rolls over).
//
// Rule: icon reflects the mode with the MOST reps (plurality, not majority).
// Ties break toward the harder mode: opm > situp > standard/manual. A missed
// target is 'I' regardless of per-mode counts. Matches the user-facing
// difficulty ranking: OPM fist > flex > fire.

export type DayIcon = 'S' | 'U' | 'F' | 'I';

interface PushupLogLike {
  mode: string;
  count: number;
}

export function pickDayIcon(logs: PushupLogLike[], dailyTarget: number): DayIcon {
  let total = 0;
  let opmTotal = 0;
  let situpTotal = 0;
  let otherTotal = 0;
  for (const log of logs) {
    total += log.count;
    if (log.mode === 'opm') opmTotal += log.count;
    else if (log.mode === 'situp') situpTotal += log.count;
    else otherTotal += log.count;
  }
  if (!(dailyTarget > 0 && total >= dailyTarget)) return 'I';
  const maxTotal = Math.max(opmTotal, situpTotal, otherTotal);
  return opmTotal === maxTotal ? 'S'
    : situpTotal === maxTotal ? 'U'
    : 'F';
}

// Mirror of the icon → mode-string mapping used when writing day_results and
// when shipping last5days to the frontend. Kept here so all call sites agree.
export function dayIconToMode(icon: DayIcon): 'opm' | 'situp' | 'standard' | 'manual' {
  switch (icon) {
    case 'S': return 'opm';
    case 'U': return 'situp';
    case 'F': return 'standard';
    case 'I': return 'manual';
  }
}

// Live "streak slot" display state for a member: what to render in the
// small space to the left of the debt label.
//
// Rules:
//   - If today met OR the stored streak is non-zero → 'hot' with a count.
//     The "met today" case covers fresh restarts after a miss (the chris
//     bug from PR #20): a 1-day streak beats the ice signal.
//   - Else if the previous boundary-advanced day was 'I' (ice) → 'ice'.
//     This surfaces a broken streak when the user is currently cold.
//   - Else → 'none'.
//
// Lives here (shared module) instead of in api.ts or the client so both
// /api/me and /api/team/today agree and it can be unit-tested in isolation.
export type StreakDisplay = { count: number; type: 'hot' | 'ice' | 'none' };

export function computeStreakDisplay(params: {
  stored_streak: number;
  last5: string;
  today_total: number;
  daily_target: number;
}): StreakDisplay {
  const todayMet = params.daily_target > 0 && params.today_total >= params.daily_target;
  let count = params.stored_streak;
  if (todayMet && count > 0) count++;
  else if (todayMet) count = 1;

  if (count > 0) return { count, type: 'hot' };

  const pastIcons = params.last5 ? params.last5.split(',') : [];
  const prevDayIcon = pastIcons.length > 0 ? pastIcons[pastIcons.length - 1] : null;
  if (prevDayIcon === 'I') return { count: 0, type: 'ice' };

  return { count: 0, type: 'none' };
}
