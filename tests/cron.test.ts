import { describe, test, expect, beforeEach, mock } from "bun:test";
import { getDb, createUser, getUserById, logPushups, updateTarget, updateDebt, linkAlias } from "../src/db";
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

  test("alias row does not double-roll and fires its own org's slack post", async () => {
    const db = getDb(":memory:");
    // Configure slack ONLY on Frist so we can assert exactly one post.
    db.exec("UPDATE invite_codes SET slack_bot_token = 'xoxb-fake', slack_channel = '#frist' WHERE code = 'FRST'");

    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-07T11:00:00.000Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    updateTarget(hanson.id, 50);
    logPushups(hanson.id, 60, "camera", "standard", "2026-04-06T14:00:00Z");

    const calls: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as any;

    try {
      processExpiredBoundaries("2026-04-07T12:00:00.000Z");
      // postDayResult is fire-and-forget in cron; flush microtasks so the
      // stubbed fetch's promise chain completes before we assert.
      await new Promise(r => setTimeout(r, 0));
    } finally {
      globalThis.fetch = realFetch;
    }

    // Source row has rollup applied exactly once
    const h = getUserById(hanson.id)!;
    expect(h.debt).toBe(0);
    expect(h.streak).toBe(1);
    expect(h.next_day_boundary).toBe("2026-04-08T11:00:00.000Z");

    // Alias row is untouched in debt/streak/last5/next_day_boundary
    const m = getUserById(mayo.id)!;
    expect(m.debt).toBe(0);
    expect(m.streak).toBe(0);
    expect(m.last5).toBe("");
    expect(m.next_day_boundary).toBe("2026-04-07T11:00:00.000Z");

    // Slack fired exactly once, with mayo's username, to Frist's channel
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("chat.postMessage");
    expect(calls[0].body.channel).toBe("#frist");
    const blob = JSON.stringify(calls[0].body);
    expect(blob).toContain("mayo");
    expect(blob).not.toContain("\"hanson\"");
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
