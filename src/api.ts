import { signup, login, logout, getSessionUser, parseSessionToken, sessionCookie, clearSessionCookie } from "./auth";
import { logPushups, getTodayLogs, getTodayTotal, getTeamToday, updateTarget, updateDebt, updateTimezone, type User } from "./db";
import { getNextDayBoundary, getPreviousDayBoundary } from "./timezone";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function publicUserData(user: User) {
  return {
    id: user.id,
    username: user.username,
    daily_target: user.daily_target,
    debt: user.debt,
    timezone: user.timezone,
  };
}

export async function handleApiRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // --- Public routes ---
  if (path === "/api/auth/signup" && method === "POST") {
    try {
      const { username, passcode, timezone } = await req.json();
      const result = await signup(username, passcode, timezone);
      return json({ user: publicUserData(result.user) }, 200, {
        "set-cookie": sessionCookie(result.token),
      });
    } catch (e: any) {
      const status = e.message.includes("UNIQUE") ? 409 : 400;
      return json({ error: e.message }, status);
    }
  }

  if (path === "/api/auth/login" && method === "POST") {
    try {
      const { username, passcode } = await req.json();
      const result = await login(username, passcode);
      return json({ user: publicUserData(result.user) }, 200, {
        "set-cookie": sessionCookie(result.token),
      });
    } catch (e: any) {
      return json({ error: "Invalid username or passcode" }, 401);
    }
  }

  // --- Authenticated routes ---
  const token = parseSessionToken(req);
  if (!token) return json({ error: "Unauthorized" }, 401);
  const user = getSessionUser(token);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (path === "/api/auth/logout" && method === "POST") {
    logout(token);
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }

  if (path === "/api/me" && method === "GET") {
    const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
    const todayTotal = getTodayTotal(user.id, prevBoundary, user.next_day_boundary);
    return json({
      ...publicUserData(user),
      today_total: todayTotal,
      next_day_boundary: user.next_day_boundary,
    });
  }

  if (path === "/api/me/target" && method === "PUT") {
    const { target } = await req.json();
    if (typeof target !== "number" || target < 0) {
      return json({ error: "Target must be a non-negative number" }, 400);
    }
    updateTarget(user.id, target);
    return json({ ok: true, daily_target: target });
  }

  if (path === "/api/me/timezone" && method === "PUT") {
    const { timezone } = await req.json();
    if (user.timezone !== timezone) {
      const nowUtc = new Date().toISOString();
      const newBoundary = getNextDayBoundary(timezone, nowUtc);
      updateTimezone(user.id, timezone, newBoundary);
      return json({ ok: true, timezone, next_day_boundary: newBoundary, changed: true });
    }
    return json({ ok: true, timezone: user.timezone, changed: false });
  }

  if (path === "/api/me/debt" && method === "GET") {
    return json({ debt: user.debt });
  }

  if (path === "/api/pushups" && method === "POST") {
    const { count, source } = await req.json();
    if (typeof count !== "number" || count <= 0) {
      return json({ error: "Count must be a positive number" }, 400);
    }
    if (source !== "camera" && source !== "manual") {
      return json({ error: "Source must be 'camera' or 'manual'" }, 400);
    }
    const log = logPushups(user.id, count, source);

    // Check if surplus pushups should reduce debt
    if (user.debt > 0 && user.daily_target > 0) {
      const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
      const todayTotal = getTodayTotal(user.id, prevBoundary, user.next_day_boundary);
      const previousTotal = todayTotal - count;
      // Only reduce debt by the NEW surplus from this specific log, not total surplus
      const newSurplus = Math.max(0, todayTotal - user.daily_target) - Math.max(0, previousTotal - user.daily_target);
      if (newSurplus > 0) {
        const debtReduction = Math.min(newSurplus, user.debt);
        updateDebt(user.id, -debtReduction);
      }
    }

    return json(log);
  }

  if (path === "/api/pushups/today" && method === "GET") {
    const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
    const logs = getTodayLogs(user.id, prevBoundary, user.next_day_boundary);
    const total = logs.reduce((sum, l) => sum + l.count, 0);
    return json({ logs, total, daily_target: user.daily_target });
  }

  if (path === "/api/team/today" && method === "GET") {
    const allUsers = getTeamToday();
    const team = allUsers.map((u) => {
      const prevBoundary = getPreviousDayBoundary(u.timezone, u.next_day_boundary);
      const todayTotal = getTodayTotal(u.id, prevBoundary, u.next_day_boundary);
      return {
        id: u.id,
        username: u.username,
        daily_target: u.daily_target,
        today_total: todayTotal,
        debt: u.debt,
      };
    });
    return json(team);
  }

  return json({ error: "Not found" }, 404);
}
