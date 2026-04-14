import { describe, test, expect } from "bun:test";
import { pickDayIcon, dayIconToMode } from "../src/day-icon";

// Helper: build a logs array from (mode, count) pairs.
function logs(...pairs: [string, number][]): { mode: string; count: number }[] {
  return pairs.map(([mode, count]) => ({ mode, count }));
}

describe("pickDayIcon", () => {
  // ---- missed-target cases (always 'I') ----

  test("returns I when total is below target", () => {
    expect(pickDayIcon(logs(["standard", 30]), 50)).toBe("I");
  });

  test("returns I when target is 0", () => {
    expect(pickDayIcon(logs(["standard", 100]), 0)).toBe("I");
  });

  test("returns I when logs are empty", () => {
    expect(pickDayIcon([], 50)).toBe("I");
  });

  // ---- pure mode cases ----

  test("pure standard meeting target -> S", () => {
    expect(pickDayIcon(logs(["standard", 50]), 50)).toBe("S");
  });

  test("pure situp meeting target -> U", () => {
    expect(pickDayIcon(logs(["situp", 50]), 50)).toBe("U");
  });

  test("pure noob meeting target -> F", () => {
    expect(pickDayIcon(logs(["noob", 50]), 50)).toBe("F");
  });

  test("pure manual meeting target -> F", () => {
    expect(pickDayIcon(logs(["manual", 50]), 50)).toBe("F");
  });

  // ---- plurality cases (the headline change from PR #6) ----

  test("standard plurality with a sliver of noob -> S", () => {
    // 99 standard + 1 noob, total 100 >= target 100
    expect(pickDayIcon(logs(["standard", 99], ["noob", 1]), 100)).toBe("S");
  });

  test("situp plurality when standard is underweight -> U", () => {
    // 60 situp + 40 standard, neither subtotal hits target alone
    expect(pickDayIcon(logs(["situp", 60], ["standard", 40]), 100)).toBe("U");
  });

  test("noob plurality gets F even with hard-mode reps present", () => {
    // 40 noob > 30 std = 30 situp; hard modes together (60) don't matter
    expect(pickDayIcon(logs(["standard", 30], ["situp", 30], ["noob", 40]), 100)).toBe("F");
  });

  // ---- tie-break cases (harder mode wins) ----

  test("tie standard/situp breaks toward standard", () => {
    expect(pickDayIcon(logs(["standard", 50], ["situp", 50]), 100)).toBe("S");
  });

  test("tie situp/noob breaks toward situp", () => {
    expect(pickDayIcon(logs(["situp", 50], ["noob", 50]), 100)).toBe("U");
  });

  test("tie standard/noob breaks toward standard", () => {
    expect(pickDayIcon(logs(["standard", 50], ["noob", 50]), 100)).toBe("S");
  });

  test("three-way tie breaks toward standard (hardest)", () => {
    // 33+33+34 = 100 with noob=34 having plurality, not a three-way tie.
    // Force a clean tie: 34+33+33 where standard=34.
    expect(pickDayIcon(logs(["standard", 34], ["situp", 33], ["noob", 33]), 100)).toBe("S");
  });

  // ---- manual bucket ----

  test("manual counts as 'other' for plurality purposes", () => {
    // 51 manual > 49 standard → other has plurality → F
    expect(pickDayIcon(logs(["standard", 49], ["manual", 51]), 100)).toBe("F");
  });

  test("manual and noob are summed into the same 'other' bucket", () => {
    // 30 noob + 30 manual = 60 'other' > 50 standard → F
    expect(pickDayIcon(logs(["standard", 50], ["noob", 30], ["manual", 30]), 100)).toBe("F");
  });

  // ---- edge: exactly meeting target ----

  test("total exactly matching target still evaluates plurality correctly", () => {
    // 40 situp + 10 standard, total = target exactly. Evan's real case.
    expect(pickDayIcon(logs(["situp", 40], ["standard", 10]), 50)).toBe("U");
  });
});

describe("dayIconToMode", () => {
  test("maps S to standard", () => {
    expect(dayIconToMode("S")).toBe("standard");
  });
  test("maps U to situp", () => {
    expect(dayIconToMode("U")).toBe("situp");
  });
  test("maps F to noob", () => {
    expect(dayIconToMode("F")).toBe("noob");
  });
  test("maps I to manual", () => {
    expect(dayIconToMode("I")).toBe("manual");
  });
});
