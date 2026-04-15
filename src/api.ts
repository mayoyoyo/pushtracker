import { signup, login, logout, getSessionUser, parseSessionToken, sessionCookie, clearSessionCookie } from "./auth";
import { logPushups, getTodayLogs, getTodayTotal, getResolvedTeamByGroup, updateTarget, updateDebt, updateTimezone, getGroupName, getMonthResults, hasEverLoggedPushups, getSlackConfig, getDiscordConfig, getLifetimeTotals, type User } from "./db";
import { getNextDayBoundary, getPreviousDayBoundary } from "./timezone";
import { processExpiredBoundaries } from "./cron";
import { pickDayIcon } from "./day-icon";

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
      if (e.message.includes("UNIQUE")) {
        return json({ error: "Username already taken" }, 409);
      }
      return json({ error: e.message }, 400);
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
    // Fetch today's logs once — used for both the icon and the mode breakdown.
    const todayLogs = getTodayLogs(user.id, prevBoundary, user.next_day_boundary);
    const todayMet = user.daily_target > 0 && todayTotal >= user.daily_target;
    const todayIcon = pickDayIcon(todayLogs, user.daily_target);
    // Per-mode breakdown for the segmented progress bar. Manual rolls into
    // standard, matching the day-icon "other" bucket in src/day-icon.ts.
    const today_by_mode = { opm: 0, situp: 0, standard: 0 };
    for (const log of todayLogs) {
      if (log.mode === 'opm') today_by_mode.opm += log.count;
      else if (log.mode === 'situp') today_by_mode.situp += log.count;
      else today_by_mode.standard += log.count;
    }
    const everLogged = hasEverLoggedPushups(user.id);
    const pastIcons = user.last5 ? user.last5.split(',') : [];
    const allIcons = everLogged ? (todayMet ? [...pastIcons, todayIcon] : pastIcons).slice(-5) : [];
    const last5days = allIcons.map(i => ({
      met: i === 'S' || i === 'F' || i === 'U',
      mode: i === 'S' ? 'opm' : i === 'U' ? 'situp' : i === 'F' ? 'standard' : 'manual',
    }));

    // Streak: user.streak is from completed days, add 1 if today is met and streak was going
    let streakCount = user.streak;
    if (todayMet && streakCount > 0) streakCount++;
    else if (todayMet) streakCount = 1;

    const hasSlack = getSlackConfig(user.invite_code) !== null;
    const hasDiscord = getDiscordConfig(user.invite_code) !== null;
    return json({
      ...publicUserData(user),
      today_total: todayTotal,
      today_by_mode,
      next_day_boundary: user.next_day_boundary,
      created_at: user.created_at,
      group_name: groupName,
      last5days,
      has_slack: hasSlack,
      has_discord: hasDiscord,
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

  if (path === "/api/me/lifetime" && method === "GET") {
    return json(getLifetimeTotals(user.id));
  }

  if (path === "/api/pushups" && method === "POST") {
    const { count, source, mode } = await req.json();
    if (typeof count !== "number" || count <= 0) {
      return json({ error: "Count must be a positive number" }, 400);
    }
    if (source !== "camera" && source !== "manual") {
      return json({ error: "Source must be 'camera' or 'manual'" }, 400);
    }
    const logMode = source === 'manual'
      ? 'manual'
      : mode === 'opm' ? 'opm'
      : mode === 'situp' ? 'situp'
      : 'standard';
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
    const allUsers = getResolvedTeamByGroup(user.invite_code);
    const groupName = getGroupName(user.invite_code);
    const team = allUsers.map((u) => {
      const prevBoundary = getPreviousDayBoundary(u.timezone, u.next_day_boundary);
      const todayTotal = getTodayTotal(u.id, prevBoundary, u.next_day_boundary);
      const todayMet = u.daily_target > 0 && todayTotal >= u.daily_target;
      // Fetch logs unconditionally now — the expanded team card needs the
      // per-mode breakdown even for partial (not-yet-met) days.
      const todayLogs = getTodayLogs(u.id, prevBoundary, u.next_day_boundary);
      const todayIcon = pickDayIcon(todayLogs, u.daily_target);
      const today_by_mode = { opm: 0, situp: 0, standard: 0 };
      for (const log of todayLogs) {
        if (log.mode === 'opm') today_by_mode.opm += log.count;
        else if (log.mode === 'situp') today_by_mode.situp += log.count;
        else today_by_mode.standard += log.count;
      }
      const everLogged = hasEverLoggedPushups(u.id);
      const pastIcons = u.last5 ? u.last5.split(',') : [];
      const allIcons = everLogged ? (todayMet ? [...pastIcons, todayIcon] : pastIcons).slice(-5) : [];
      const last5days = allIcons.map((i: string) => ({
        met: i === 'S' || i === 'F' || i === 'U',
        mode: i === 'S' ? 'opm' : i === 'U' ? 'situp' : i === 'F' ? 'standard' : 'manual',
      }));
      // The last day the boundary-advanced over (i.e. yesterday, or the most
      // recent past completed day). Null for users who've never had a day
      // roll up. Used by the team view to render 🧊 in the streak slot when
      // the previous day was a miss, overriding the hot-streak display.
      const prev_day_icon = pastIcons.length > 0 ? pastIcons[pastIcons.length - 1] : null;

      let streakCount = u.streak;
      if (todayMet && streakCount > 0) streakCount++;
      else if (todayMet) streakCount = 1;

      return {
        id: u.id,
        username: u.username,
        daily_target: u.daily_target,
        today_total: todayTotal,
        today_by_mode,
        debt: u.debt,
        last5days,
        ever_logged: everLogged,
        prev_day_icon,
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
