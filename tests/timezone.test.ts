import { describe, test, expect } from "bun:test";
import { getNextDayBoundary, getPreviousDayBoundary, advanceBoundary } from "../src/timezone";

describe("timezone", () => {
  describe("getNextDayBoundary", () => {
    test("returns next 7am in given timezone as UTC ISO string", () => {
      // 2026-04-07 at noon in New York (EDT, UTC-4) → next 7am is 2026-04-08 07:00 EDT = 11:00 UTC
      const boundary = getNextDayBoundary("America/New_York", "2026-04-07T16:00:00Z");
      expect(boundary).toBe("2026-04-08T11:00:00.000Z");
    });

    test("if it is before 7am local, returns 7am today", () => {
      // 2026-04-07 at 5am EDT (09:00 UTC) → next 7am is today 07:00 EDT = 11:00 UTC
      const boundary = getNextDayBoundary("America/New_York", "2026-04-07T09:00:00Z");
      expect(boundary).toBe("2026-04-07T11:00:00.000Z");
    });

    test("handles Asia/Seoul (UTC+9)", () => {
      // 2026-04-07 at 10am KST (01:00 UTC) → next 7am is 2026-04-08 07:00 KST = 2026-04-07T22:00 UTC
      const boundary = getNextDayBoundary("Asia/Seoul", "2026-04-07T01:00:00Z");
      expect(boundary).toBe("2026-04-07T22:00:00.000Z");
    });

    test("handles DST transition (spring forward)", () => {
      // US spring forward 2026: March 8. Clocks jump 2am→3am EST→EDT.
      // 2026-03-08 at noon EDT (UTC-4, 16:00 UTC) → next 7am is 2026-03-09 07:00 EDT = 11:00 UTC
      const boundary = getNextDayBoundary("America/New_York", "2026-03-08T16:00:00Z");
      expect(boundary).toBe("2026-03-09T11:00:00.000Z");
    });
  });

  describe("getPreviousDayBoundary", () => {
    test("returns the 7am before the given boundary", () => {
      const prev = getPreviousDayBoundary("America/New_York", "2026-04-08T11:00:00.000Z");
      expect(prev).toBe("2026-04-07T11:00:00.000Z");
    });
  });

  describe("advanceBoundary", () => {
    test("advances to the next 7am from current boundary", () => {
      const next = advanceBoundary("America/New_York", "2026-04-07T11:00:00.000Z");
      expect(next).toBe("2026-04-08T11:00:00.000Z");
    });
  });
});
