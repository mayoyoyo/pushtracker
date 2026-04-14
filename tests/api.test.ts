import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, linkAlias, updateTarget, updateDebt, updateStreak, logPushups } from "../src/db";
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
});
