import { describe, test, expect } from "bun:test";
import { formatDayResult } from "../src/slack";

describe("slack", () => {
  describe("formatDayResult", () => {
    test("formats a successful day with streak", () => {
      const msg = formatDayResult("hanson", "April 8, 2026", 25, 20, true, 3);
      expect(msg).toBe("📊 hanson — April 8, 2026\n25/20 ✅ | 🔥 streak: 3");
    });

    test("formats a failed day with no streak", () => {
      const msg = formatDayResult("alice", "April 8, 2026", 15, 20, false, 0);
      expect(msg).toBe("📊 alice — April 8, 2026\n15/20 ❌ | streak: 0");
    });

    test("formats a successful day with streak of 1", () => {
      const msg = formatDayResult("bob", "April 8, 2026", 20, 20, true, 1);
      expect(msg).toBe("📊 bob — April 8, 2026\n20/20 ✅ | 🔥 streak: 1");
    });
  });
});
