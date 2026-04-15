import { describe, test, expect } from "bun:test";
import { pickDayIcon, dayIconToMode, computeStreakDisplay } from "../src/day-icon";

// Helper: build a logs array from (mode, count) pairs.
function logs(...pairs: [string, number][]): { mode: string; count: number }[] {
  return pairs.map(([mode, count]) => ({ mode, count }));
}

describe("pickDayIcon", () => {
  // ---- missed-target cases (always 'I') ----

  test("returns I when total is below target", () => {
    expect(pickDayIcon(logs(["opm", 30]), 50)).toBe("I");
  });

  test("returns I when target is 0", () => {
    expect(pickDayIcon(logs(["opm", 100]), 0)).toBe("I");
  });

  test("returns I when logs are empty", () => {
    expect(pickDayIcon([], 50)).toBe("I");
  });

  // ---- pure mode cases ----

  test("pure opm meeting target -> S", () => {
    expect(pickDayIcon(logs(["opm", 50]), 50)).toBe("S");
  });

  test("pure situp meeting target -> U", () => {
    expect(pickDayIcon(logs(["situp", 50]), 50)).toBe("U");
  });

  test("pure standard meeting target -> F", () => {
    expect(pickDayIcon(logs(["standard", 50]), 50)).toBe("F");
  });

  test("pure manual meeting target -> F", () => {
    expect(pickDayIcon(logs(["manual", 50]), 50)).toBe("F");
  });

  // ---- plurality cases (the headline change from PR #6) ----

  test("opm plurality with a sliver of standard -> S", () => {
    // 99 opm + 1 standard, total 100 >= target 100
    expect(pickDayIcon(logs(["opm", 99], ["standard", 1]), 100)).toBe("S");
  });

  test("situp plurality when opm is underweight -> U", () => {
    // 60 situp + 40 opm, neither subtotal hits target alone
    expect(pickDayIcon(logs(["situp", 60], ["opm", 40]), 100)).toBe("U");
  });

  test("standard plurality gets F even with hard-mode reps present", () => {
    // 40 standard > 30 opm = 30 situp; hard modes together (60) don't matter
    expect(pickDayIcon(logs(["opm", 30], ["situp", 30], ["standard", 40]), 100)).toBe("F");
  });

  // ---- tie-break cases (harder mode wins) ----

  test("tie opm/situp breaks toward opm", () => {
    expect(pickDayIcon(logs(["opm", 50], ["situp", 50]), 100)).toBe("S");
  });

  test("tie situp/standard breaks toward situp", () => {
    expect(pickDayIcon(logs(["situp", 50], ["standard", 50]), 100)).toBe("U");
  });

  test("tie opm/standard breaks toward opm", () => {
    expect(pickDayIcon(logs(["opm", 50], ["standard", 50]), 100)).toBe("S");
  });

  test("three-way tie breaks toward opm (hardest)", () => {
    // Force a clean tie: 34+33+33 where opm=34.
    expect(pickDayIcon(logs(["opm", 34], ["situp", 33], ["standard", 33]), 100)).toBe("S");
  });

  // ---- manual bucket ----

  test("manual counts as 'other' for plurality purposes", () => {
    // 51 manual > 49 opm → other has plurality → F
    expect(pickDayIcon(logs(["opm", 49], ["manual", 51]), 100)).toBe("F");
  });

  test("manual and standard are summed into the same 'other' bucket", () => {
    // 30 standard + 30 manual = 60 'other' > 50 opm → F
    expect(pickDayIcon(logs(["opm", 50], ["standard", 30], ["manual", 30]), 100)).toBe("F");
  });

  // ---- edge: exactly meeting target ----

  test("total exactly matching target still evaluates plurality correctly", () => {
    // 40 situp + 10 opm, total = target exactly. Evan's real case.
    expect(pickDayIcon(logs(["situp", 40], ["opm", 10]), 50)).toBe("U");
  });
});

describe("dayIconToMode", () => {
  test("maps S to opm", () => {
    expect(dayIconToMode("S")).toBe("opm");
  });
  test("maps U to situp", () => {
    expect(dayIconToMode("U")).toBe("situp");
  });
  test("maps F to standard", () => {
    expect(dayIconToMode("F")).toBe("standard");
  });
  test("maps I to manual", () => {
    expect(dayIconToMode("I")).toBe("manual");
  });
});

// Exhaustive matrix for the streak/ice slot displayed on team cards and
// the dashboard header. Each case is framed as the user state the API
// sees at request time: the stored streak (updated by cron at day end),
// the last5 history, the running today total, and the daily target.
// Existence of this suite is the guarantee that the chris bug (PR #20:
// ice showing for a user with a 1-day hot streak after a prior miss)
// cannot silently regress.
describe("computeStreakDisplay", () => {
  // --- fresh / no-history cases ---

  test("fresh user, target not yet met → none", () => {
    expect(computeStreakDisplay({ stored_streak: 0, last5: "", today_total: 5, daily_target: 20 }))
      .toEqual({ count: 0, type: "none" });
  });

  test("fresh user, target met on day 1 → 1-day hot streak", () => {
    expect(computeStreakDisplay({ stored_streak: 0, last5: "", today_total: 20, daily_target: 20 }))
      .toEqual({ count: 1, type: "hot" });
  });

  test("fresh user, target is zero (never-met sentinel) → none", () => {
    // daily_target=0 is the "not yet set" sentinel; pickDayIcon already
    // treats it as missed. computeStreakDisplay must match.
    expect(computeStreakDisplay({ stored_streak: 0, last5: "", today_total: 100, daily_target: 0 }))
      .toEqual({ count: 0, type: "none" });
  });

  // --- active streak, no previous miss ---

  test("active streak, met again today → count incremented, hot", () => {
    expect(computeStreakDisplay({ stored_streak: 3, last5: "F,F,F", today_total: 25, daily_target: 20 }))
      .toEqual({ count: 4, type: "hot" });
  });

  test("active streak, not yet met today → count unchanged, still hot", () => {
    // Mid-day: user has a 3-day streak but hasn't yet hit today. The UI
    // should still show the existing streak (the streak doesn't reset
    // until cron runs at day end).
    expect(computeStreakDisplay({ stored_streak: 3, last5: "F,F,F", today_total: 10, daily_target: 20 }))
      .toEqual({ count: 3, type: "hot" });
  });

  // --- chris's exact bug (the regression guard) ---

  test("previous day ice, met today → 1-day hot streak (CHRIS BUG)", () => {
    // Chris's state on prod: last5 ended in 'I' (Apr 13 missed), stored
    // streak was 0, today he hit 61/50. Old code showed 🧊 because it
    // checked prev_day_icon first. New logic: met-today wins, so hot.
    expect(computeStreakDisplay({ stored_streak: 0, last5: "F,F,I", today_total: 61, daily_target: 50 }))
      .toEqual({ count: 1, type: "hot" });
  });

  test("previous day ice, not met today → ice", () => {
    // Same state as the chris case but without hitting target yet —
    // this is where the ice signal is meant to show.
    expect(computeStreakDisplay({ stored_streak: 0, last5: "F,F,I", today_total: 10, daily_target: 50 }))
      .toEqual({ count: 0, type: "ice" });
  });

  // --- multiple misses ---

  test("multiple consecutive ice days, not met today → ice", () => {
    expect(computeStreakDisplay({ stored_streak: 0, last5: "F,I,I,I", today_total: 5, daily_target: 50 }))
      .toEqual({ count: 0, type: "ice" });
  });

  test("multiple consecutive ice days, met today → 1-day hot streak", () => {
    expect(computeStreakDisplay({ stored_streak: 0, last5: "F,I,I,I", today_total: 50, daily_target: 50 }))
      .toEqual({ count: 1, type: "hot" });
  });

  // --- edge: last5 rightmost is not ice but streak is somehow 0 ---

  test("last5 ends in F with stored streak 0 (shouldn't happen, but falls through to none)", () => {
    // In practice cron would have bumped the streak if the latest day
    // was met — this is a safety-net case for defensive rendering.
    expect(computeStreakDisplay({ stored_streak: 0, last5: "I,I,F", today_total: 10, daily_target: 50 }))
      .toEqual({ count: 0, type: "none" });
  });

  // --- edge: exact boundary, today_total === daily_target ---

  test("today_total exactly equals daily_target → met → hot 1d", () => {
    expect(computeStreakDisplay({ stored_streak: 0, last5: "I", today_total: 50, daily_target: 50 }))
      .toEqual({ count: 1, type: "hot" });
  });

  // --- long-term streak, previous day ice is impossible (streak would be 0) ---

  test("stored_streak > 0 and last5 ends with met icon → hot with stored count", () => {
    expect(computeStreakDisplay({ stored_streak: 7, last5: "F,F,F,S,F", today_total: 0, daily_target: 50 }))
      .toEqual({ count: 7, type: "hot" });
  });
});
