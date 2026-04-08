import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, createUser, getUserByUsername, getUserById, logPushups, getTodayLogs, getTeamByGroup, updateTarget, updateDebt, getGroupName, getDayHistory, getSlackConfig } from "../src/db";

describe("database", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  describe("createUser", () => {
    test("creates a user and returns it", () => {
      const user = createUser("hanson", "hashedpass", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      expect(user.id).toBe(1);
      expect(user.username).toBe("hanson");
      expect(user.daily_target).toBe(20);
      expect(user.debt).toBe(0);
      expect(user.timezone).toBe("America/New_York");
    });

    test("rejects duplicate username", () => {
      createUser("hanson", "hash1", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      expect(() => createUser("hanson", "hash2", "America/New_York", "2026-04-08T11:00:00Z", "DEV0")).toThrow();
    });
  });

  describe("getUserByUsername", () => {
    test("returns user by username", () => {
      createUser("hanson", "hashedpass", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const user = getUserByUsername("hanson");
      expect(user).not.toBeNull();
      expect(user!.username).toBe("hanson");
    });

    test("returns null for unknown username", () => {
      expect(getUserByUsername("nobody")).toBeNull();
    });
  });

  describe("logPushups", () => {
    test("logs pushups for a user", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const log = logPushups(user.id, 25, "camera");
      expect(log.count).toBe(25);
      expect(log.source).toBe("camera");
    });
  });

  describe("getTodayLogs", () => {
    test("returns logs between day boundaries", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      logPushups(user.id, 25, "camera", "manual", "2026-04-07T12:00:00Z");
      logPushups(user.id, 10, "manual", "manual", "2026-04-07T20:00:00Z");
      logPushups(user.id, 50, "camera", "manual", "2026-04-07T05:00:00Z");

      const logs = getTodayLogs(user.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
      expect(logs.length).toBe(2);
      expect(logs.reduce((sum, l) => sum + l.count, 0)).toBe(35);
    });
  });

  describe("getTeamToday", () => {
    test("returns all users with their today totals", () => {
      const u1 = createUser("hanson", "h1", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const u2 = createUser("jake", "h2", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      updateTarget(u1.id, 50);
      updateTarget(u2.id, 75);
      logPushups(u1.id, 32, "camera", "manual", "2026-04-07T14:00:00Z");
      logPushups(u2.id, 75, "camera", "manual", "2026-04-07T14:00:00Z");

      const team = getTeamByGroup("DEV0");
      expect(team.length).toBe(2);
    });
  });

  describe("updateTarget", () => {
    test("updates daily target", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      updateTarget(user.id, 50);
      const updated = getUserById(user.id);
      expect(updated!.daily_target).toBe(50);
    });
  });

  describe("updateDebt", () => {
    test("adds to debt", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      updateDebt(user.id, 15);
      const updated = getUserById(user.id);
      expect(updated!.debt).toBe(15);
    });

    test("reduces debt (never below 0)", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      updateDebt(user.id, 20);
      updateDebt(user.id, -25);
      const updated = getUserById(user.id);
      expect(updated!.debt).toBe(0);
    });
  });

  describe("getGroupName", () => {
    test("returns group name for known code", () => {
      expect(getGroupName("DEV0")).toBe("MayoLab");
    });

    test("returns code itself for unknown code", () => {
      expect(getGroupName("ZZZZ")).toBe("ZZZZ");
    });
  });

  describe("getSlackConfig", () => {
    test("returns null when no slack config set", () => {
      expect(getSlackConfig("DEV0")).toBeNull();
    });

    test("returns config when both token and channel are set", () => {
      const db = getDb(":memory:");
      db.prepare("UPDATE invite_codes SET slack_bot_token = 'xoxb-test', slack_channel = 'C123' WHERE code = 'DEV0'").run();
      const config = getSlackConfig("DEV0");
      expect(config).toEqual({ slack_bot_token: "xoxb-test", slack_channel: "C123" });
    });

    test("returns null when only token is set", () => {
      const db = getDb(":memory:");
      db.prepare("UPDATE invite_codes SET slack_bot_token = 'xoxb-test' WHERE code = 'DEV0'").run();
      expect(getSlackConfig("DEV0")).toBeNull();
    });
  });

  describe("logPushups with mode", () => {
    test("stores mode field", () => {
      const user = createUser("modetest", "hash", "UTC", "2026-04-08T07:00:00Z", "DEV0");
      const log = logPushups(user.id, 10, "camera", "standard");
      expect(log.mode).toBe("standard");
    });

    test("defaults mode to manual", () => {
      const user = createUser("modetest2", "hash", "UTC", "2026-04-08T07:00:00Z", "DEV0");
      const log = logPushups(user.id, 10, "manual");
      expect(log.mode).toBe("manual");
    });
  });
});
