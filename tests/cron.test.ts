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
    logPushups(user.id, 35, "camera", "opm", "2026-04-06T14:00:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(15); // 30 - min(15 surplus, 30 debt) = 15
  });

  test("reduces debt fully when surplus exceeds debt", () => {
    const user = createUser("debtuser2", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    updateDebt(user.id, 10);
    logPushups(user.id, 50, "camera", "opm", "2026-04-06T14:00:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0); // 10 - min(30 surplus, 10 debt) = 0
  });

  // --- day icon plurality rule ---
  //
  // The day's icon (S/U/F) reflects the mode with the MOST reps that day.
  // Ties break toward the harder mode: opm > situp > standard/manual.
  // A missed target is still 'I' regardless of per-mode counts.

  test("day icon: opm plurality wins even with standard reps mixed in", () => {
    // Was 'F' under the old all-or-nothing rule; now 'S' because opm has the plurality.
    const user = createUser("std_mix", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 100);
    logPushups(user.id, 99, "camera", "opm", "2026-04-06T14:00:00Z");
    logPushups(user.id, 1, "camera", "standard", "2026-04-06T14:05:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(getUserById(user.id)!.last5).toBe("S");
  });

  test("day icon: situp plurality wins when opm is underweight", () => {
    // Was 'F' under the old rule (neither subtotal hit 100); now 'U' because situp > opm.
    const user = createUser("situp_maj", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 100);
    logPushups(user.id, 60, "camera", "situp", "2026-04-06T14:00:00Z");
    logPushups(user.id, 40, "camera", "opm", "2026-04-06T14:05:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(getUserById(user.id)!.last5).toBe("U");
  });

  test("day icon: tie between opm and situp breaks toward opm", () => {
    const user = createUser("tie_std_situp", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 100);
    logPushups(user.id, 50, "camera", "opm", "2026-04-06T14:00:00Z");
    logPushups(user.id, 50, "camera", "situp", "2026-04-06T14:05:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(getUserById(user.id)!.last5).toBe("S");
  });

  test("day icon: tie between situp and standard breaks toward situp", () => {
    const user = createUser("tie_situp_std", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 100);
    logPushups(user.id, 50, "camera", "situp", "2026-04-06T14:00:00Z");
    logPushups(user.id, 50, "camera", "standard", "2026-04-06T14:05:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(getUserById(user.id)!.last5).toBe("U");
  });

  test("day icon: tie between opm and standard breaks toward opm", () => {
    const user = createUser("tie_opm_std", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 100);
    logPushups(user.id, 50, "camera", "opm", "2026-04-06T14:00:00Z");
    logPushups(user.id, 50, "camera", "standard", "2026-04-06T14:05:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(getUserById(user.id)!.last5).toBe("S");
  });

  test("day icon: standard plurality still gets fire despite hard-mode reps", () => {
    // standard=40 is the single largest bucket, even though opm+situp combined > standard.
    const user = createUser("std_maj", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 100);
    logPushups(user.id, 30, "camera", "opm", "2026-04-06T14:00:00Z");
    logPushups(user.id, 30, "camera", "situp", "2026-04-06T14:05:00Z");
    logPushups(user.id, 40, "camera", "standard", "2026-04-06T14:10:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(getUserById(user.id)!.last5).toBe("F");
  });

  test("day icon: manual reps are bucketed with standard for plurality purposes", () => {
    // 49 opm + 51 manual. other=51 > opm=49, so the plurality is manual → F.
    const user = createUser("manual_bucket", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 100);
    logPushups(user.id, 49, "camera", "opm", "2026-04-06T14:00:00Z");
    logPushups(user.id, 51, "manual", "manual", "2026-04-06T14:05:00Z");
    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(getUserById(user.id)!.last5).toBe("F");
  });

  test("calls Slack when team has slack config", () => {
    const db = getDb(":memory:");
    db.prepare("UPDATE invite_codes SET slack_bot_token = 'xoxb-test', slack_channel = 'C123' WHERE code = 'DEV0'").run();
    const user = createUser("slackuser", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    logPushups(user.id, 25, "camera", "opm", "2026-04-06T14:00:00Z");

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
    logPushups(hanson.id, 60, "camera", "opm", "2026-04-06T14:00:00Z");

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

    // Regression guard for C1: the alias Slack post must use the day that just
    // ended (April 6), not the day the source advanced into (April 7), and must
    // reflect the source's actual rollup stats (60/50 ✅).
    expect(blob).toContain("April 6");
    expect(blob).not.toContain("April 7");
    expect(blob).toContain("60/50");
    expect(blob).toContain("✅");
  });

  test("does not call Slack when team has no slack config", () => {
    getDb(":memory:");
    const user = createUser("noslack", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    logPushups(user.id, 25, "camera", "opm", "2026-04-06T14:00:00Z");

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

  test("calls Discord when team has discord config", () => {
    const db = getDb(":memory:");
    db.prepare("UPDATE invite_codes SET discord_webhook_url = 'https://discord.com/api/webhooks/123/abc' WHERE code = 'DEV0'").run();
    const user = createUser("discorduser", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    logPushups(user.id, 25, "camera", "opm", "2026-04-06T14:00:00Z");

    const originalFetch = globalThis.fetch;
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = mock(async (url: any, opts: any) => {
      calls.push({ url: url as string, body: JSON.parse(opts.body) });
      return new Response(null, { status: 204 });
    }) as any;

    processExpiredBoundaries("2026-04-07T12:00:00Z");

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/123/abc");
    expect(calls[0].body.embeds).toBeDefined();
    expect(calls[0].body.embeds[0].title).toContain("discorduser");
    expect(calls[0].body.embeds[0].fields[0].value).toContain("25 / 20");
    expect(calls[0].body.embeds[0].fields[0].value).toContain("✅");
    expect(calls[0].body.allowed_mentions).toEqual({ parse: [] });

    globalThis.fetch = originalFetch;
  });

  test("does not call Discord when team has no discord config", () => {
    getDb(":memory:");
    const user = createUser("nodiscord", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    logPushups(user.id, 25, "camera", "opm", "2026-04-06T14:00:00Z");

    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response(null, { status: 204 });
    }) as any;

    processExpiredBoundaries("2026-04-07T12:00:00Z");
    expect(called).toBe(false);

    globalThis.fetch = originalFetch;
  });

  test("alias row fires Discord using source's pre-advance rollup", async () => {
    const db = getDb(":memory:");
    // Configure Discord ONLY on Frist so we can assert exactly one post.
    db.exec("UPDATE invite_codes SET discord_webhook_url = 'https://discord.com/api/webhooks/frist/abc' WHERE code = 'FRST'");

    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-07T11:00:00.000Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    updateTarget(hanson.id, 50);
    logPushups(hanson.id, 60, "camera", "opm", "2026-04-06T14:00:00Z");

    const calls: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
      return new Response(null, { status: 204 });
    }) as any;

    try {
      processExpiredBoundaries("2026-04-07T12:00:00.000Z");
      await new Promise(r => setTimeout(r, 0));
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/frist/abc");
    const embed = calls[0].body.embeds[0];
    expect(embed.title).toContain("mayo");
    expect(embed.title).not.toContain("hanson");
    expect(embed.title).toContain("April 6");
    expect(embed.fields[0].value).toContain("60 / 50");
    expect(embed.fields[0].value).toContain("✅");
    expect(calls[0].body.allowed_mentions).toEqual({ parse: [] });
  });

  test("calls both Slack and Discord when both are configured", () => {
    const db = getDb(":memory:");
    db.prepare("UPDATE invite_codes SET slack_bot_token = 'xoxb-test', slack_channel = 'C123', discord_webhook_url = 'https://discord.com/api/webhooks/1/a' WHERE code = 'DEV0'").run();
    const user = createUser("bothuser", "hash", "America/New_York", "2026-04-07T11:00:00.000Z", "DEV0");
    updateTarget(user.id, 20);
    logPushups(user.id, 25, "camera", "opm", "2026-04-06T14:00:00Z");

    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: any, opts: any) => {
      urls.push(url as string);
      if ((url as string).includes("slack.com")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as any;

    processExpiredBoundaries("2026-04-07T12:00:00Z");

    expect(urls.length).toBe(2);
    expect(urls.some(u => u.includes("slack.com"))).toBe(true);
    expect(urls.some(u => u.includes("discord.com"))).toBe(true);

    globalThis.fetch = originalFetch;
  });
});
