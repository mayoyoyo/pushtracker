import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, createUser, getUserByUsername, getUserById, logPushups, getTodayLogs, getTodayTotal, getMonthResults, hasEverLoggedPushups, getTeamByGroup, updateTarget, updateDebt, getGroupName, getSlackConfig, getDiscordConfig, getLifetimeTotals, resolveDataUserId, linkAlias, saveDayResult, updateStreak, updateTimezone, getResolvedUserById, getResolvedTeamByGroup, getUsersWithExpiredBoundary, linkMayoToHansonIfNeeded, runMigration } from "../src/db";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";

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

  describe("getDiscordConfig", () => {
    test("returns null when no discord config set", () => {
      expect(getDiscordConfig("DEV0")).toBeNull();
    });

    test("returns config when webhook url is set", () => {
      const db = getDb(":memory:");
      db.prepare("UPDATE invite_codes SET discord_webhook_url = 'https://discord.com/api/webhooks/123/abc' WHERE code = 'DEV0'").run();
      expect(getDiscordConfig("DEV0")).toEqual({
        discord_webhook_url: "https://discord.com/api/webhooks/123/abc",
      });
    });

    test("returns null when webhook url is empty string", () => {
      const db = getDb(":memory:");
      db.prepare("UPDATE invite_codes SET discord_webhook_url = '' WHERE code = 'DEV0'").run();
      expect(getDiscordConfig("DEV0")).toBeNull();
    });
  });

  describe("getLifetimeTotals", () => {
    test("returns zeros for a user with no logs", () => {
      const user = createUser("blank", "hash", "UTC", "2026-04-08T07:00:00Z", "DEV0");
      expect(getLifetimeTotals(user.id)).toEqual({ pushups: 0, situps: 0 });
    });

    test("sums situp reps into situps, everything else into pushups", () => {
      const user = createUser("mix", "hash", "UTC", "2026-04-08T07:00:00Z", "DEV0");
      logPushups(user.id, 20, "camera", "opm");
      logPushups(user.id, 15, "camera", "standard");
      logPushups(user.id, 5,  "manual", "manual");
      logPushups(user.id, 30, "camera", "situp");
      logPushups(user.id, 10, "camera", "situp");
      expect(getLifetimeTotals(user.id)).toEqual({ pushups: 40, situps: 40 });
    });

    test("includes in-progress reps (sums from pushup_logs, not day_results)", () => {
      // Target here: prove the helper reads the raw log table and returns
      // today's reps without depending on the cron having rolled up the day.
      const user = createUser("inprogress", "hash", "UTC", "2026-04-08T07:00:00Z", "DEV0");
      logPushups(user.id, 25, "camera", "opm", "2026-04-08T06:30:00Z");
      logPushups(user.id, 15, "camera", "situp",    "2026-04-08T06:45:00Z");
      // No processExpiredBoundaries call — day_results is empty, but the totals still land.
      expect(getLifetimeTotals(user.id)).toEqual({ pushups: 25, situps: 15 });
    });

    test("alias resolves to source's totals", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo   = createUser("mayo",   "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);
      // Log against hanson directly — all reps live under the source.
      logPushups(hanson.id, 50, "camera", "opm");
      logPushups(hanson.id, 20, "camera", "situp");
      const h = getLifetimeTotals(hanson.id);
      const m = getLifetimeTotals(mayo.id);
      expect(h).toEqual({ pushups: 50, situps: 20 });
      expect(m).toEqual(h); // alias sees identical totals
    });

    test("alias writes resolve to source for totals too", () => {
      // logPushups(mayo, ...) resolves to hanson via resolveDataUserId. So
      // getLifetimeTotals on either id should agree with that single row set.
      const hanson = createUser("hanson2", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo   = createUser("mayo2",   "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkAlias(mayo.id, hanson.id);
      logPushups(mayo.id, 100, "camera", "opm");
      logPushups(mayo.id, 40,  "camera", "situp");
      expect(getLifetimeTotals(mayo.id)).toEqual({ pushups: 100, situps: 40 });
      expect(getLifetimeTotals(hanson.id)).toEqual({ pushups: 100, situps: 40 });
    });
  });

  describe("logPushups with mode", () => {
    test("stores mode field", () => {
      const user = createUser("modetest", "hash", "UTC", "2026-04-08T07:00:00Z", "DEV0");
      const log = logPushups(user.id, 10, "camera", "opm");
      expect(log.mode).toBe("opm");
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

      saveDayResult(hanson.id, "2026-04-06", true, "opm", 30);
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
      saveDayResult(mayo.id, "2026-04-06", true, "opm", 30);
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

  describe("getUsersWithExpiredBoundary with alias", () => {
    test("returns alias only when source boundary is expired", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00.000Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-20T11:00:00.000Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      // Hanson's boundary (04-08) is in the past; mayo's raw boundary (04-20) is future.
      // Effective boundary for mayo = hanson's (04-08), so mayo SHOULD be returned.
      const expired = getUsersWithExpiredBoundary("2026-04-09T00:00:00.000Z");
      const ids = expired.map(u => u.id).sort();
      expect(ids).toContain(hanson.id);
      expect(ids).toContain(mayo.id);
    });

    test("does not return alias when source boundary is fresh", () => {
      const hanson = createUser("hanson", "h", "America/New_York", "2026-04-20T11:00:00.000Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00.000Z", "FRST");
      linkAlias(mayo.id, hanson.id);

      // Source (hanson) boundary is future; mayo's raw boundary is past.
      // Effective boundary for mayo = hanson's (future), so mayo must NOT be returned.
      const expired = getUsersWithExpiredBoundary("2026-04-09T00:00:00.000Z");
      expect(expired.find(u => u.id === mayo.id)).toBeUndefined();
      expect(expired.find(u => u.id === hanson.id)).toBeUndefined();
    });

    test("non-alias user behaves unchanged", () => {
      const solo = createUser("solo", "h", "America/New_York", "2026-04-05T11:00:00.000Z", "DEV0");
      const expired = getUsersWithExpiredBoundary("2026-04-09T00:00:00.000Z");
      expect(expired.find(u => u.id === solo.id)).toBeDefined();
    });
  });

  describe("one-time mayo→hanson migration", () => {
    test("links mayo to hanson if both exist", () => {
      // Fresh in-memory db, then create the two users and re-run the migration via linkMayoToHansonIfNeeded.
      createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      // Give mayo some shadow state that the migration should zero out.
      updateTarget(mayo.id, 30);
      updateDebt(mayo.id, 42);
      updateStreak(mayo.id, "S,F,I", 0);
      logPushups(mayo.id, 7, "manual");
      saveDayResult(mayo.id, "2026-04-06", false, "manual", 7);

      linkMayoToHansonIfNeeded();

      const m = getUserById(mayo.id)!;
      const h = getUserByUsername("hanson")!;
      expect(m.source_user_id).toBe(h.id);
      // Mayo's orphaned progress has been wiped
      const hMonth = getMonthResults(h.id, "2026-04");
      expect(hMonth.length).toBe(0);
      // Mayo's shadow columns on her own row have been zeroed out to avoid
      // forensic confusion — they're dead state, but leaving them populated
      // would be misleading.
      expect(m.daily_target).toBe(0);
      expect(m.debt).toBe(0);
      expect(m.last5).toBe("");
      expect(m.streak).toBe(0);
      // Re-running is a no-op
      linkMayoToHansonIfNeeded();
      expect(getUserById(mayo.id)!.source_user_id).toBe(h.id);
    });

    test("does nothing when hanson does not exist", () => {
      createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
      linkMayoToHansonIfNeeded();
      expect(getUserByUsername("mayo")!.source_user_id).toBeNull();
    });

    test("does nothing when mayo does not exist", () => {
      createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
      linkMayoToHansonIfNeeded();
      expect(getUserByUsername("hanson")!.source_user_id).toBeNull();
    });
  });

  // Guards against the class of bug from PR #10: a bare destructive UPDATE
  // in getDb() that runs on every boot and re-corrupts data each time.
  describe("migration framework", () => {
    describe("runMigration", () => {
      test("runs fn exactly once across multiple invocations", () => {
        let count = 0;
        runMigration("test_count_once", () => { count++; });
        runMigration("test_count_once", () => { count++; });
        runMigration("test_count_once", () => { count++; });
        expect(count).toBe(1);
      });

      test("records the marker even if fn is a no-op early-exit", () => {
        let called = false;
        runMigration("test_noop", () => { /* early exit */ });
        runMigration("test_noop", () => { called = true; });
        expect(called).toBe(false);
      });

      test("does NOT record the marker if fn throws (retryable)", () => {
        let attempts = 0;
        try {
          runMigration("test_fail_first", () => {
            attempts++;
            throw new Error("boom");
          });
        } catch {}
        // Second call should try again because the marker was never set
        runMigration("test_fail_first", () => { attempts++; });
        expect(attempts).toBe(2);
      });
    });

    describe("mode_rename_v1 specifically", () => {
      // Uses a temp file so getDb() can be called twice against the same
      // on-disk DB and we can observe state across re-initializations — the
      // exact scenario the PR #10 bug reproduced on every deploy.
      let dbPath: string;
      beforeEach(() => {
        dbPath = join(tmpdir(), `pt-mig-${randomBytes(8).toString("hex")}.db`);
      });

      test("calling getDb() twice against a seeded DB leaves mode counts unchanged", () => {
        // First init creates schema and records the migration marker for this
        // fresh DB (no 'noob' rows to migrate, but the marker is still set).
        getDb(dbPath);
        createUser("alice", "h", "UTC", "2026-04-15T00:00:00Z", "DEV0");
        // Write mode values that post-PR#10 code produces. The buggy boot-
        // time UPDATE would flatten 'standard' → 'opm' on the second getDb().
        logPushups(1, 10, "camera", "opm");
        logPushups(1, 20, "camera", "standard");
        logPushups(1,  5, "camera", "situp");
        logPushups(1,  3, "manual", "manual");

        const before = modeCounts(dbPath);
        // Second init: the bug would re-run the UPDATE block here. With the
        // marker-gated migration, nothing should happen.
        getDb(dbPath);
        const after = modeCounts(dbPath);

        expect(after).toEqual(before);
        expect(after).toEqual({ opm: 10, standard: 20, situp: 5, manual: 3 });
        if (existsSync(dbPath)) unlinkSync(dbPath);
      });

      test("pre-rename DB with 'noob' rows migrates correctly on first boot", () => {
        // Simulate a DB that was last touched by pre-PR#10 code by using a
        // raw Database handle to insert 'noob'/'standard' rows before our
        // init runs. getDb() should pick them up and rewrite on first call.
        {
          const raw = new Database(dbPath);
          raw.exec(`
            CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, passcode TEXT NOT NULL, daily_target INTEGER NOT NULL DEFAULT 20, debt INTEGER NOT NULL DEFAULT 0, timezone TEXT NOT NULL, next_day_boundary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE pushup_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), count INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('camera','manual')), mode TEXT NOT NULL DEFAULT 'manual', logged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
          `);
          raw.prepare("INSERT INTO users (username, passcode, timezone, next_day_boundary) VALUES ('chris', 'h', 'UTC', '2026-04-15T00:00:00Z')").run();
          raw.prepare("INSERT INTO pushup_logs (user_id, count, source, mode) VALUES (1, 15, 'camera', 'noob'), (1, 10, 'camera', 'noob'), (1, 20, 'camera', 'standard')").run();
          raw.close();
        }

        // First boot: should convert noob→standard, standard→opm, and set marker.
        getDb(dbPath);
        const afterFirst = modeCounts(dbPath);
        expect(afterFirst).toEqual({ opm: 20, standard: 25, situp: 0, manual: 0 });

        // Second boot: nothing should change, regardless of new 'standard'
        // rows that get created between boots (the exact failure mode from
        // PR #10 in prod).
        logPushups(1, 7, "camera", "standard");
        getDb(dbPath);
        const afterSecond = modeCounts(dbPath);
        expect(afterSecond).toEqual({ opm: 20, standard: 32, situp: 0, manual: 0 });

        if (existsSync(dbPath)) unlinkSync(dbPath);
      });
    });
  });
});

// Helper: read mode distribution directly from a DB file without going
// through the module-level `db` singleton (which the outer beforeEach may
// have reassigned to an unrelated :memory: instance).
function modeCounts(path: string): Record<string, number> {
  const raw = new Database(path);
  const rows = raw.prepare(
    "SELECT mode, COALESCE(SUM(count), 0) AS total FROM pushup_logs GROUP BY mode"
  ).all() as Array<{ mode: string; total: number }>;
  raw.close();
  const out: Record<string, number> = { opm: 0, standard: 0, situp: 0, manual: 0 };
  for (const r of rows) out[r.mode] = r.total;
  return out;
}
