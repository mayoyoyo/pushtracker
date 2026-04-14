import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, createUser, getUserByUsername, getUserById, logPushups, getTodayLogs, getTodayTotal, getMonthResults, hasEverLoggedPushups, getTeamByGroup, updateTarget, updateDebt, getGroupName, getSlackConfig, resolveDataUserId, linkAlias, saveDayResult, updateStreak, updateTimezone, getResolvedUserById, getResolvedTeamByGroup } from "../src/db";

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

  describe("resolveDataUserId", () => {
    test("returns same id for a non-alias user", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      expect(resolveDataUserId(user.id)).toBe(user.id);
    });

    test("returns source id for an alias user", () => {
      const hanson = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "hash", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);
      expect(resolveDataUserId(mayo.id)).toBe(hanson.id);
      expect(resolveDataUserId(hanson.id)).toBe(hanson.id);
    });

    test("returns passed id for a nonexistent user id", () => {
      expect(resolveDataUserId(9999)).toBe(9999);
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

  describe("alias data reads", () => {
    test("logPushups from alias id inserts under source id", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      const log = logPushups(mayo.id, 15, "manual");
      expect(log.user_id).toBe(hanson.id);
    });

    test("getTodayTotal from alias id returns source's total", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      logPushups(hanson.id, 10, "manual", "manual", "2026-04-07T14:00:00Z");
      logPushups(mayo.id, 5, "manual", "manual", "2026-04-07T15:00:00Z");

      const hansonTotal = getTodayTotal(hanson.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
      const mayoTotal = getTodayTotal(mayo.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
      expect(hansonTotal).toBe(15);
      expect(mayoTotal).toBe(15);
    });

    test("getTodayLogs from alias id returns source's logs", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      logPushups(hanson.id, 10, "manual", "manual", "2026-04-07T14:00:00Z");
      const logs = getTodayLogs(mayo.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
      expect(logs.length).toBe(1);
      expect(logs[0].count).toBe(10);
    });

    test("hasEverLoggedPushups resolves through alias", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      expect(hasEverLoggedPushups(mayo.id)).toBe(false);
      logPushups(hanson.id, 10, "manual");
      expect(hasEverLoggedPushups(mayo.id)).toBe(true);
    });

    test("getMonthResults resolves through alias", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      saveDayResult(hanson.id, "2026-04-06", true, "standard", 30);
      const results = getMonthResults(mayo.id, "2026-04");
      expect(results.length).toBe(1);
      expect(results[0].total).toBe(30);
    });
  });

  describe("alias data writes", () => {
    function pair() {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);
      return { hanson, mayo };
    }

    test("updateDebt on alias mutates source row", () => {
      const { hanson, mayo } = pair();
      updateDebt(mayo.id, 25);
      expect(getUserById(hanson.id)!.debt).toBe(25);
      expect(getUserById(mayo.id)!.debt).toBe(0);
    });

    test("updateTarget on alias mutates source row", () => {
      const { hanson, mayo } = pair();
      updateTarget(mayo.id, 40);
      expect(getUserById(hanson.id)!.daily_target).toBe(40);
      expect(getUserById(mayo.id)!.daily_target).toBe(20);
    });

    test("updateStreak on alias mutates source row", () => {
      const { hanson, mayo } = pair();
      updateStreak(mayo.id, "S,S,F", 3);
      expect(getUserById(hanson.id)!.streak).toBe(3);
      expect(getUserById(hanson.id)!.last5).toBe("S,S,F");
      expect(getUserById(mayo.id)!.streak).toBe(0);
    });

    test("saveDayResult on alias writes under source id", () => {
      const { hanson, mayo } = pair();
      saveDayResult(mayo.id, "2026-04-06", true, "standard", 30);
      const rows = getMonthResults(hanson.id, "2026-04");
      expect(rows.length).toBe(1);
      expect(rows[0].total).toBe(30);
    });

    test("updateTimezone on alias mutates source row (timezone + boundary)", () => {
      const { hanson, mayo } = pair();
      updateTimezone(mayo.id, "Europe/London", "2026-04-09T00:00:00.000Z");
      const h = getUserById(hanson.id)!;
      const m = getUserById(mayo.id)!;
      expect(h.timezone).toBe("Europe/London");
      expect(h.next_day_boundary).toBe("2026-04-09T00:00:00.000Z");
      expect(m.timezone).toBe("America/New_York");
    });
  });

  describe("getResolvedUserById", () => {
    test("returns row unchanged for non-alias user", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      updateTarget(hanson.id, 35);
      const resolved = getResolvedUserById(hanson.id)!;
      expect(resolved.id).toBe(hanson.id);
      expect(resolved.username).toBe("hanson");
      expect(resolved.daily_target).toBe(35);
      expect(resolved.source_user_id).toBeNull();
    });

    test("merges alias identity with source progress/settings", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      updateTarget(hanson.id, 50);
      updateDebt(hanson.id, 10);
      updateStreak(hanson.id, "S,S", 2);

      const resolved = getResolvedUserById(mayo.id)!;
      expect(resolved.id).toBe(mayo.id);
      expect(resolved.username).toBe("mayo");
      expect(resolved.invite_code).toBe("FRST");
      expect(resolved.daily_target).toBe(50);
      expect(resolved.debt).toBe(10);
      expect(resolved.last5).toBe("S,S");
      expect(resolved.streak).toBe(2);
      expect(resolved.source_user_id).toBe(hanson.id);
    });

    test("returns null for unknown id", () => {
      expect(getResolvedUserById(9999)).toBeNull();
    });
  });

  describe("getResolvedTeamByGroup", () => {
    test("returns Frist org with mayo carrying hanson's progress", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      const otherFrist = createUser("other", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      updateTarget(hanson.id, 40);
      updateDebt(hanson.id, 15);
      updateStreak(hanson.id, "S,F", 2);

      const frist = getResolvedTeamByGroup("FRST");
      expect(frist.length).toBe(2);

      const mayoRow = frist.find(u => u.username === "mayo")!;
      expect(mayoRow.id).toBe(mayo.id);
      expect(mayoRow.invite_code).toBe("FRST");
      expect(mayoRow.daily_target).toBe(40);
      expect(mayoRow.debt).toBe(15);
      expect(mayoRow.streak).toBe(2);
      expect(mayoRow.last5).toBe("S,F");

      const otherRow = frist.find(u => u.username === "other")!;
      expect(otherRow.daily_target).toBe(20);
      expect(otherRow.debt).toBe(0);
    });

    test("MayoLab org shows hanson normally (non-alias)", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      updateTarget(hanson.id, 25);
      const mayolab = getResolvedTeamByGroup("DEV0");
      expect(mayolab.length).toBe(1);
      expect(mayolab[0].username).toBe("hanson");
      expect(mayolab[0].daily_target).toBe(25);
    });
  });
});
