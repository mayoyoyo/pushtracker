import { describe, test, expect, beforeEach, mock } from "bun:test";
import { getDb, createUser, getUserById, logPushups, updateTarget, updateDebt } from "../src/db";
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
    // Must have logged at least once to accrue debt (before any boundary window)
    logPushups(user.id, 1, "manual", "manual", "2026-03-01T14:00:00Z");
    processExpiredBoundaries("2026-04-08T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(200); // 4 days * 50 = 200
    expect(updated.next_day_boundary).toBe("2026-04-09T11:00:00.000Z");
  });

  test("skips users who have never logged a pushup", () => {
    const user = createUser("newbie", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
    expect(updated.last5).toBe("");
    expect(updated.next_day_boundary).toBe("2026-04-08T11:00:00.000Z");
  });

  test("no debt when target is 0", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 0);
    logPushups(user.id, 1, "manual", "manual", "2026-04-06T14:00:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
  });

  test("reduces debt by surplus when user exceeds target", () => {
    const user = createUser("debtuser", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    updateDebt(user.id, 30);
    logPushups(user.id, 35, "camera", "standard", "2026-04-06T14:00:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(15); // 30 - min(15 surplus, 30 debt) = 15
  });

  test("reduces debt fully when surplus exceeds debt", () => {
    const user = createUser("debtuser2", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    updateDebt(user.id, 10);
    logPushups(user.id, 50, "camera", "standard", "2026-04-06T14:00:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0); // 10 - min(30 surplus, 10 debt) = 0
  });

  test("calls Slack when team has slack config", () => {
    const db = getDb(":memory:");
    db.prepare("UPDATE invite_codes SET slack_bot_token = 'xoxb-test', slack_channel = 'C123' WHERE code = 'DEV0'").run();
    const user = createUser("slackuser", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    logPushups(user.id, 25, "camera", "standard", "2026-04-06T14:00:00Z");

    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: any, opts: any) => {
      calls.push({ url: url as string, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    processExpiredBoundaries("2026-04-07T12:00:00Z");

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0].body.channel).toBe("C123");
    expect(calls[0].body.text).toContain("slackuser");
    expect(calls[0].body.text).toContain("25/20");
    expect(calls[0].body.text).toContain("✅");

    globalThis.fetch = originalFetch;
  });

  test("does not call Slack when team has no slack config", () => {
    getDb(":memory:");
    const user = createUser("noslack", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    logPushups(user.id, 25, "camera", "standard", "2026-04-06T14:00:00Z");

    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(called).toBe(false);

    globalThis.fetch = originalFetch;
  });
});
