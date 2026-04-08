import { signup, login, logout, getSessionUser, parseSessionToken, sessionCookie, clearSessionCookie } from "./auth";
import { logPushups, getTodayLogs, getTodayTotal, getTeamByGroup, updateTarget, updateDebt, updateTimezone, getGroupName, getMonthResults, type User } from "./db";
import { getNextDayBoundary, getPreviousDayBoundary } from "./timezone";
import { processExpiredBoundaries } from "./cron";

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
      const { username, passcode, timezone, inviteCode } = await req.json();
      const result = await signup(username, passcode, timezone, inviteCode);
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

  if (path === "/api/cron" && (method === "POST" || method === "GET")) {
    processExpiredBoundaries(new Date().toISOString());
    return json({ ok: true });
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
    const groupName = getGroupName(user.invite_code);
    // Parse last5 from user row, prepend today's live status
    const todayMet = user.daily_target > 0 && todayTotal >= user.daily_target;
    let todayIcon = 'I';
    if (todayMet) {
      const stdTotal = getTodayLogs(user.id, prevBoundary, user.next_day_boundary)
        .filter((l: any) => l.mode === 'standard')
        .reduce((sum: number, l: any) => sum + l.count, 0);
      todayIcon = stdTotal >= user.daily_target ? 'S' : 'F';
    }
    const pastIcons = user.last5 ? user.last5.split(',') : [];
    const allIcons = [...pastIcons, todayIcon].slice(-5);
    const last5days = allIcons.map(i => ({ met: i === 'S' || i === 'F', mode: i === 'S' ? 'standard' : i === 'F' ? 'noob' : 'manual' }));

    // Streak: user.streak is from completed days, add 1 if today is met and streak was going
    let streakCount = user.streak;
    if (todayMet && streakCount > 0) streakCount++;
    else if (todayMet) streakCount = 1;

    return json({
      ...publicUserData(user),
      today_total: todayTotal,
      next_day_boundary: user.next_day_boundary,
      created_at: user.created_at,
      group_name: groupName,
      last5days,
      streak: { count: streakCount, type: streakCount > 0 ? 'hot' : 'none' },
    });
  }

  if (path === "/api/me/target" && method === "PUT") {
    const { target } = await req.json();
    if (typeof target !== "number" || target < 20) {
      return json({ error: "Target must be at least 20" }, 400);
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
    const { count, source, mode } = await req.json();
    if (typeof count !== "number" || count <= 0) {
      return json({ error: "Count must be a positive number" }, 400);
    }
    if (source !== "camera" && source !== "manual") {
      return json({ error: "Source must be 'camera' or 'manual'" }, 400);
    }
    const logMode = source === 'manual' ? 'manual' : (mode === 'standard' ? 'standard' : 'noob');
    const log = logPushups(user.id, count, source, logMode);

    return json(log);
  }

  if (path === "/api/pushups/today" && method === "GET") {
    const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
    const logs = getTodayLogs(user.id, prevBoundary, user.next_day_boundary);
    const total = logs.reduce((sum, l) => sum + l.count, 0);
    return json({ logs, total, daily_target: user.daily_target });
  }

  if (path === "/api/team/today" && method === "GET") {
    const allUsers = getTeamByGroup(user.invite_code);
    const groupName = getGroupName(user.invite_code);
    const team = allUsers.map((u) => {
      const prevBoundary = getPreviousDayBoundary(u.timezone, u.next_day_boundary);
      const todayTotal = getTodayTotal(u.id, prevBoundary, u.next_day_boundary);
      const todayMet = u.daily_target > 0 && todayTotal >= u.daily_target;
      let todayIcon = 'I';
      if (todayMet) {
        const stdTotal = getTodayLogs(u.id, prevBoundary, u.next_day_boundary)
          .filter((l: any) => l.mode === 'standard')
          .reduce((sum: number, l: any) => sum + l.count, 0);
        todayIcon = stdTotal >= u.daily_target ? 'S' : 'F';
      }
      const pastIcons = u.last5 ? u.last5.split(',') : [];
      const allIcons = [...pastIcons, todayIcon].slice(-5);
      const last5days = allIcons.map((i: string) => ({ met: i === 'S' || i === 'F', mode: i === 'S' ? 'standard' : i === 'F' ? 'noob' : 'manual' }));

      let streakCount = u.streak;
      if (todayMet && streakCount > 0) streakCount++;
      else if (todayMet) streakCount = 1;

      return {
        id: u.id,
        username: u.username,
        daily_target: u.daily_target,
        today_total: todayTotal,
        debt: u.debt,
        last5days,
        streak: { count: streakCount, type: streakCount > 0 ? 'hot' : 'none' },
      };
    });
    return json({ group_name: groupName, team });
  }

  if (path === "/api/me/calendar" && method === "GET") {
    const year = parseInt(url.searchParams.get("year") || "");
    const month = parseInt(url.searchParams.get("month") || "");
    if (!year || !month || month < 1 || month > 12) {
      return json({ error: "year and month required" }, 400);
    }

    const yearMonth = `${year}-${String(month).padStart(2, '0')}`;
    const results = getMonthResults(user.id, yearMonth);
    const days = results.map(r => {
      const day = parseInt(r.day_date.split('-')[2]);
      return { day, met: r.met, mode: r.mode };
    });
    return json({ year, month, days });
  }

  return json({ error: "Not found" }, 404);
}
