import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, createUser, getUserById, logPushups, updateTarget } from "../src/db";
import { processExpiredBoundaries } from "../src/cron";

describe("cron", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  test("adds debt when user misses target", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 50);
    logPushups(user.id, 30, "camera", "manual", "2026-04-06T14:00:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(20);
    expect(updated.next_day_boundary).toBe("2026-04-08T11:00:00.000Z", "DEV0");
  });

  test("no debt when user meets target", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 50);
    logPushups(user.id, 60, "camera", "manual", "2026-04-06T14:00:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
  });

  test("skips users whose boundary has not expired", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 50);
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
    expect(updated.next_day_boundary).toBe("2026-04-08T11:00:00.000Z", "DEV0");
  });

  test("handles multiple expired boundaries (user offline for days)", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-05T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 50);
    processExpiredBoundaries("2026-04-08T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(150);
    expect(updated.next_day_boundary).toBe("2026-04-09T11:00:00.000Z");
  });

  test("no debt when target is 0", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 0);
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
  });
});
