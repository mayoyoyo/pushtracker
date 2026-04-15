import { describe, test, expect } from "bun:test";
import { buildDayResultEmbed } from "../src/discord";

describe("discord", () => {
  describe("buildDayResultEmbed", () => {
    test("builds a successful-day embed with streak", () => {
      const embed = buildDayResultEmbed("hanson", "April 8, 2026", 25, 20, true, 3);
      expect(embed.title).toBe("📊 hanson — April 8, 2026");
      expect(embed.color).toBe(0x57F287);
      expect(embed.fields).toEqual([
        { name: "Pushups", value: "✅ 25 / 20", inline: true },
        { name: "Streak", value: "🔥 3 days", inline: true },
      ]);
    });

    test("builds a failed-day embed with no streak", () => {
      const embed = buildDayResultEmbed("alice", "April 8, 2026", 15, 20, false, 0);
      expect(embed.title).toBe("📊 alice — April 8, 2026");
      expect(embed.color).toBe(0xED4245);
      expect(embed.fields).toEqual([
        { name: "Pushups", value: "❌ 15 / 20", inline: true },
        { name: "Streak", value: "0 days", inline: true },
      ]);
    });

    test("uses singular 'day' when streak is 1", () => {
      const embed = buildDayResultEmbed("bob", "April 8, 2026", 20, 20, true, 1);
      expect(embed.fields[1]).toEqual({ name: "Streak", value: "🔥 1 day", inline: true });
    });

    test("inlines debt into the Pushups field value when debt > 0", () => {
      const embed = buildDayResultEmbed("alice", "April 8, 2026", 15, 20, false, 0, 40);
      expect(embed.fields).toEqual([
        { name: "Pushups", value: "❌ 15 / 20 (40 debt)", inline: true },
        { name: "Streak", value: "0 days", inline: true },
      ]);
    });

    test("omits the debt suffix when debt is 0", () => {
      const embed = buildDayResultEmbed("bob", "April 8, 2026", 25, 20, true, 3, 0);
      expect(embed.fields.length).toBe(2);
      expect(embed.fields[0].value).toBe("✅ 25 / 20");
    });

    test("omits the debt suffix when debt is omitted", () => {
      const embed = buildDayResultEmbed("bob", "April 8, 2026", 25, 20, true, 3);
      expect(embed.fields.length).toBe(2);
      expect(embed.fields[0].value).toBe("✅ 25 / 20");
    });
  });
});
