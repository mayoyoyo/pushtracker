import { Database } from "bun:sqlite";


let db: Database;

export function getDb(path: string = "pushtracker.db"): Database {
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      passcode TEXT NOT NULL,
      daily_target INTEGER NOT NULL DEFAULT 20,
      debt INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL,
      next_day_boundary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pushup_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      count INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('camera', 'manual')),
      logged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Add invite_code column if missing (migration for existing DBs)
  try { db.exec("ALTER TABLE users ADD COLUMN invite_code TEXT NOT NULL DEFAULT 'DEV0'"); } catch {}
  // Add group_name to invite_codes
  try { db.exec("ALTER TABLE invite_codes ADD COLUMN group_name TEXT NOT NULL DEFAULT ''"); } catch {}
  // Add mode to pushup_logs
  try { db.exec("ALTER TABLE pushup_logs ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'"); } catch {}
  // Streak columns on users: last5 = comma-separated day results (S/F/I), streak = hot streak count
  try { db.exec("ALTER TABLE users ADD COLUMN last5 TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN streak INTEGER NOT NULL DEFAULT 0"); } catch {}
  // Slack integration columns on invite_codes
  try { db.exec("ALTER TABLE invite_codes ADD COLUMN slack_bot_token TEXT"); } catch {}
  try { db.exec("ALTER TABLE invite_codes ADD COLUMN slack_channel TEXT"); } catch {}
  // Day results for calendar history
  db.exec(`CREATE TABLE IF NOT EXISTS day_results (
    user_id INTEGER NOT NULL REFERENCES users(id),
    day_date TEXT NOT NULL,
    met INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'manual',
    total INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day_date)
  )`);
  // Seed invite codes
  db.prepare("INSERT OR IGNORE INTO invite_codes (code, group_name) VALUES ('DEV0', 'MayoLab')").run();
  db.prepare("INSERT OR IGNORE INTO invite_codes (code, group_name) VALUES ('FRST', 'Frist')").run();
  db.prepare("UPDATE invite_codes SET group_name = 'MayoLab' WHERE code = 'DEV0' AND group_name = ''").run();
  db.prepare("UPDATE invite_codes SET group_name = 'Frist' WHERE code = 'FRST' AND group_name = ''").run();
  // Migrate any old DEV users to DEV0
  db.prepare("UPDATE users SET invite_code = 'DEV0' WHERE invite_code = 'DEV'").run();
  return db;
}

export interface User {
  id: number;
  username: string;
  passcode: string;
  daily_target: number;
  debt: number;
  timezone: string;
  invite_code: string;
  next_day_boundary: string;
  created_at: string;
  last5: string;
  streak: number;
}

export interface PushupLog {
  id: number;
  user_id: number;
  count: number;
  source: string;
  mode: string;
  logged_at: string;
}

export function validateInviteCode(code: string): boolean {
  return db.prepare("SELECT 1 FROM invite_codes WHERE code = ?").get(code) !== null;
}

export function createUser(username: string, passcode: string, timezone: string, nextDayBoundary: string, inviteCode: string): User {
  const stmt = db.prepare(
    "INSERT INTO users (username, passcode, daily_target, timezone, next_day_boundary, invite_code) VALUES (?, ?, 20, ?, ?, ?) RETURNING *"
  );
  return stmt.get(username, passcode, timezone, nextDayBoundary, inviteCode) as User;
}

export function getUserByUsername(username: string): User | null {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as User | null;
}

export function getUserById(id: number): User | null {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function updateTarget(userId: number, target: number): void {
  db.prepare("UPDATE users SET daily_target = ? WHERE id = ?").run(target, userId);
}

export function updateDebt(userId: number, delta: number): void {
  db.prepare("UPDATE users SET debt = MAX(0, debt + ?) WHERE id = ?").run(delta, userId);
}

export function updateTimezone(userId: number, timezone: string, nextDayBoundary: string): void {
  db.prepare("UPDATE users SET timezone = ?, next_day_boundary = ? WHERE id = ?").run(timezone, nextDayBoundary, userId);
}

export function updateNextDayBoundary(userId: number, nextDayBoundary: string): void {
  db.prepare("UPDATE users SET next_day_boundary = ? WHERE id = ?").run(nextDayBoundary, userId);
}

export function logPushups(userId: number, count: number, source: string, mode: string = 'manual', loggedAt?: string): PushupLog {
  if (loggedAt) {
    return db.prepare(
      "INSERT INTO pushup_logs (user_id, count, source, mode, logged_at) VALUES (?, ?, ?, ?, ?) RETURNING *"
    ).get(userId, count, source, mode, loggedAt) as PushupLog;
  }
  return db.prepare(
    "INSERT INTO pushup_logs (user_id, count, source, mode) VALUES (?, ?, ?, ?) RETURNING *"
  ).get(userId, count, source, mode) as PushupLog;
}

export function getTodayLogs(userId: number, dayStart: string, dayEnd: string): PushupLog[] {
  return db.prepare(
    "SELECT * FROM pushup_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ? ORDER BY logged_at"
  ).all(userId, dayStart, dayEnd) as PushupLog[];
}

export function getTodayTotal(userId: number, dayStart: string, dayEnd: string): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(count), 0) as total FROM pushup_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ?"
  ).get(userId, dayStart, dayEnd) as { total: number };
  return row.total;
}

export function getTeamByGroup(inviteCode: string): User[] {
  return db.prepare("SELECT * FROM users WHERE invite_code = ? ORDER BY username").all(inviteCode) as User[];
}

export function saveDayResult(userId: number, dayDate: string, met: boolean, mode: string, total: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO day_results (user_id, day_date, met, mode, total) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, dayDate, met ? 1 : 0, mode, total);
}

export function getMonthResults(userId: number, yearMonth: string): Array<{ day_date: string; met: boolean; mode: string; total: number }> {
  const rows = db.prepare(
    "SELECT * FROM day_results WHERE user_id = ? AND day_date LIKE ? ORDER BY day_date"
  ).all(userId, yearMonth + '%') as Array<{ day_date: string; met: number; mode: string; total: number }>;
  return rows.map(r => ({ ...r, met: r.met === 1 }));
}

export function updateStreak(userId: number, last5: string, streak: number): void {
  db.prepare("UPDATE users SET last5 = ?, streak = ? WHERE id = ?").run(last5, streak, userId);
}

export function getGroupName(inviteCode: string): string {
  const row = db.prepare("SELECT group_name FROM invite_codes WHERE code = ?").get(inviteCode) as { group_name: string } | null;
  return row?.group_name || inviteCode;
}


export function getUsersWithExpiredBoundary(now: string): User[] {
  return db.prepare("SELECT * FROM users WHERE next_day_boundary <= ?").all(now) as User[];
}

export function getSlackConfig(inviteCode: string): { slack_bot_token: string; slack_channel: string } | null {
  const row = db.prepare("SELECT slack_bot_token, slack_channel FROM invite_codes WHERE code = ?").get(inviteCode) as { slack_bot_token: string | null; slack_channel: string | null } | null;
  if (!row || !row.slack_bot_token || !row.slack_channel) return null;
  return { slack_bot_token: row.slack_bot_token, slack_channel: row.slack_channel };
}

// Session management
export function createSession(token: string, userId: number, expiresAt: string): void {
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expiresAt);
}

export function getSession(token: string): { token: string; user_id: number; expires_at: string } | null {
  return db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token) as any;
}

export function deleteSession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}
