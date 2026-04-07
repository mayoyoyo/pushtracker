import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, createUser, getUserByUsername, getUserById, logPushups, getTodayLogs, getTeamToday, updateTarget, updateDebt } from "../src/db";

describe("database", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  describe("createUser", () => {
    test("creates a user and returns it", () => {
      const user = createUser("hanson", "hashedpass", "America/New_York", "2026-04-08T11:00:00Z");
      expect(user.id).toBe(1);
      expect(user.username).toBe("hanson");
      expect(user.daily_target).toBe(0);
      expect(user.debt).toBe(0);
      expect(user.timezone).toBe("America/New_York");
    });

    test("rejects duplicate username", () => {
      createUser("hanson", "hash1", "America/New_York", "2026-04-08T11:00:00Z");
      expect(() => createUser("hanson", "hash2", "America/New_York", "2026-04-08T11:00:00Z")).toThrow();
    });
  });

  describe("getUserByUsername", () => {
    test("returns user by username", () => {
      createUser("hanson", "hashedpass", "America/New_York", "2026-04-08T11:00:00Z");
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
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      const log = logPushups(user.id, 25, "camera");
      expect(log.count).toBe(25);
      expect(log.source).toBe("camera");
    });
  });

  describe("getTodayLogs", () => {
    test("returns logs between day boundaries", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      logPushups(user.id, 25, "camera", "2026-04-07T12:00:00Z");
      logPushups(user.id, 10, "manual", "2026-04-07T20:00:00Z");
      logPushups(user.id, 50, "camera", "2026-04-07T05:00:00Z");

      const logs = getTodayLogs(user.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
      expect(logs.length).toBe(2);
      expect(logs.reduce((sum, l) => sum + l.count, 0)).toBe(35);
    });
  });

  describe("getTeamToday", () => {
    test("returns all users with their today totals", () => {
      const u1 = createUser("hanson", "h1", "America/New_York", "2026-04-08T11:00:00Z");
      const u2 = createUser("jake", "h2", "America/New_York", "2026-04-08T11:00:00Z");
      updateTarget(u1.id, 50);
      updateTarget(u2.id, 75);
      logPushups(u1.id, 32, "camera", "2026-04-07T14:00:00Z");
      logPushups(u2.id, 75, "camera", "2026-04-07T14:00:00Z");

      const team = getTeamToday();
      expect(team.length).toBe(2);
    });
  });

  describe("updateTarget", () => {
    test("updates daily target", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      updateTarget(user.id, 50);
      const updated = getUserById(user.id);
      expect(updated!.daily_target).toBe(50);
    });
  });

  describe("updateDebt", () => {
    test("adds to debt", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      updateDebt(user.id, 15);
      const updated = getUserById(user.id);
      expect(updated!.debt).toBe(15);
    });

    test("reduces debt (never below 0)", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      updateDebt(user.id, 20);
      updateDebt(user.id, -25);
      const updated = getUserById(user.id);
      expect(updated!.debt).toBe(0);
    });
  });
});
