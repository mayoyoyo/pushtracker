import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, linkAlias, updateTarget, updateDebt, updateStreak, logPushups, saveDayResult } from "../src/db";
import { signup } from "../src/auth";
import { handleApiRequest } from "../src/api";

async function authedRequest(method: string, path: string, token: string, body?: object): Promise<Response> {
  const opts: RequestInit = {
    method,
    headers: { cookie: `session=${token}`, "content-type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return handleApiRequest(new Request(`http://localhost${path}`, opts));
}

describe("api", () => {
  let token: string;

  beforeEach(async () => {
    getDb(":memory:");
    const result = await signup("hanson", "1234", "America/New_York", "DEV0");
    token = result.token;
  });

  describe("POST /api/auth/signup", () => {
    test("creates new user", async () => {
      const res = await handleApiRequest(new Request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "jake", passcode: "5678", timezone: "America/Chicago", inviteCode: "DEV0" }),
      }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user.username).toBe("jake");
    });
  });

  describe("POST /api/auth/login", () => {
    test("logs in existing user", async () => {
      const res = await handleApiRequest(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "hanson", passcode: "1234" }),
      }));
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("session=");
    });

    test("rejects wrong passcode", async () => {
      const res = await handleApiRequest(new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "hanson", passcode: "9999" }),
      }));
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/me", () => {
    test("returns current user profile", async () => {
      const res = await authedRequest("GET", "/api/me", token);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.username).toBe("hanson");
      expect(data.daily_target).toBe(20);
      expect(data.debt).toBe(0);
    });

    test("returns 401 without auth", async () => {
      const res = await handleApiRequest(new Request("http://localhost/api/me"));
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/me/target", () => {
    test("updates daily target", async () => {
      const res = await authedRequest("PUT", "/api/me/target", token, { target: 50 });
      expect(res.status).toBe(200);
      const me = await (await authedRequest("GET", "/api/me", token)).json();
      expect(me.daily_target).toBe(50);
    });
  });

  describe("GET /api/me/lifetime", () => {
    test("returns zero totals for a user with no logs", async () => {
      const res = await authedRequest("GET", "/api/me/lifetime", token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pushups: 0, situps: 0 });
    });

    test("sums reps into pushups vs situps, including in-progress reps", async () => {
      await authedRequest("POST", "/api/pushups", token, { count: 40, source: "camera", mode: "standard" });
      await authedRequest("POST", "/api/pushups", token, { count: 10, source: "camera", mode: "noob" });
      await authedRequest("POST", "/api/pushups", token, { count: 5,  source: "manual" });
      await authedRequest("POST", "/api/pushups", token, { count: 25, source: "camera", mode: "situp" });
      const res = await authedRequest("GET", "/api/me/lifetime", token);
      expect(await res.json()).toEqual({ pushups: 55, situps: 25 });
    });

    test("returns 401 without auth", async () => {
      const res = await handleApiRequest(new Request("http://localhost/api/me/lifetime"));
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/pushups", () => {
    test("logs pushups", async () => {
      const res = await authedRequest("POST", "/api/pushups", token, { count: 25, source: "camera" });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.count).toBe(25);
    });

    test("rejects invalid source", async () => {
      const res = await authedRequest("POST", "/api/pushups", token, { count: 25, source: "magic" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/pushups/today", () => {
    test("returns today's logs and total", async () => {
      await authedRequest("POST", "/api/pushups", token, { count: 25, source: "camera" });
      await authedRequest("POST", "/api/pushups", token, { count: 10, source: "manual" });
      const res = await authedRequest("GET", "/api/pushups/today", token);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.total).toBe(35);
      expect(data.logs.length).toBe(2);
    });
  });

  describe("GET /api/team/today", () => {
    test("returns all team members", async () => {
      await signup("jake", "5678", "America/Chicago", "DEV0");
      const res = await authedRequest("GET", "/api/team/today", token);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.team.length).toBe(2);
    });

    test("GET /api/team/today on Frist shows mayo with hanson's progress", async () => {
      const { user: hanson } = await signup("hanson2", "1111", "America/New_York", "DEV0");
      const { token: mayoTok, user: mayo } = await signup("mayo", "2222", "America/New_York", "FRST");
      linkAlias(mayo.id, hanson.id);

      updateTarget(hanson.id, 40);
      updateDebt(hanson.id, 15);
      updateStreak(hanson.id, "S,S,F", 3);
      logPushups(hanson.id, 25, "camera", "standard");

      const res = await handleApiRequest(new Request("http://x/api/team/today", {
        headers: { cookie: `session=${mayoTok}` },
      }));
      const body = await res.json();
      expect(body.group_name).toBe("Frist");

      const mayoRow = body.team.find((u: any) => u.username === "mayo");
      expect(mayoRow).toBeDefined();
      expect(mayoRow.daily_target).toBe(40);
      expect(mayoRow.debt).toBe(15);
      expect(mayoRow.streak.count).toBeGreaterThanOrEqual(3);
      expect(mayoRow.today_total).toBe(25);
    });
  });

  describe("alias parity across /api/me*", () => {
    test("/api/me returns identical progress for hanson and mayo sessions", async () => {
      const { token: hTok, user: hanson } = await signup("hanson3", "1111", "America/New_York", "DEV0");
      const { token: mTok, user: mayo } = await signup("mayo3", "2222", "America/New_York", "FRST");
      linkAlias(mayo.id, hanson.id);

      updateTarget(hanson.id, 40);
      updateDebt(hanson.id, 7);
      logPushups(hanson.id, 25, "camera", "standard");

      const hRes = await handleApiRequest(new Request("http://x/api/me", {
        headers: { cookie: `session=${hTok}` },
      }));
      const mRes = await handleApiRequest(new Request("http://x/api/me", {
        headers: { cookie: `session=${mTok}` },
      }));
      const hBody = await hRes.json();
      const mBody = await mRes.json();

      expect(mBody.today_total).toBe(hBody.today_total);
      expect(mBody.debt).toBe(hBody.debt);
      expect(mBody.daily_target).toBe(hBody.daily_target);
      expect(mBody.streak.count).toBe(hBody.streak.count);
      expect(mBody.last5days).toEqual(hBody.last5days);

      // But identity fields stay distinct
      expect(mBody.username).toBe("mayo3");
      expect(hBody.username).toBe("hanson3");
      expect(mBody.group_name).toBe("Frist");
      expect(hBody.group_name).toBe("MayoLab");
    });

    test("POST /api/pushups from mayo session increases hanson's total", async () => {
      const { token: hTok, user: hanson } = await signup("hanson4", "1111", "America/New_York", "DEV0");
      const { token: mTok, user: mayo } = await signup("mayo4", "2222", "America/New_York", "FRST");
      linkAlias(mayo.id, hanson.id);

      await handleApiRequest(new Request("http://x/api/pushups", {
        method: "POST",
        headers: { cookie: `session=${mTok}`, "content-type": "application/json" },
        body: JSON.stringify({ count: 12, source: "manual" }),
      }));

      const hRes = await handleApiRequest(new Request("http://x/api/me", {
        headers: { cookie: `session=${hTok}` },
      }));
      const hBody = await hRes.json();
      expect(hBody.today_total).toBe(12);
    });

    test("/api/me/calendar on mayo returns hanson's day_results", async () => {
      const { user: hanson } = await signup("hanson5", "1111", "America/New_York", "DEV0");
      const { token: mTok, user: mayo } = await signup("mayo5", "2222", "America/New_York", "FRST");
      linkAlias(mayo.id, hanson.id);

      saveDayResult(hanson.id, "2026-04-06", true, "standard", 30);
      saveDayResult(hanson.id, "2026-04-05", false, "manual", 10);

      const res = await handleApiRequest(new Request("http://x/api/me/calendar?year=2026&month=4", {
        headers: { cookie: `session=${mTok}` },
      }));
      const body = await res.json();
      expect(body.days.length).toBe(2);
      expect(body.days.map((d: any) => d.day).sort()).toEqual([5, 6]);
    });
  });
});
