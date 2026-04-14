import { describe, test, expect } from "bun:test";
import { pickDayIcon, dayIconToMode } from "../src/day-icon";

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
