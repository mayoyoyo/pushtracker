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
      daily_target INTEGER NOT NULL DEFAULT 0,
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
  // Seed invite codes
  db.prepare("INSERT OR IGNORE INTO invite_codes (code) VALUES ('DEV0')").run();
  db.prepare("INSERT OR IGNORE INTO invite_codes (code) VALUES ('FRST')").run();
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
}

export interface PushupLog {
  id: number;
  user_id: number;
  count: number;
  source: string;
  logged_at: string;
}

export function validateInviteCode(code: string): boolean {
  return db.prepare("SELECT 1 FROM invite_codes WHERE code = ?").get(code) !== null;
}

export function createUser(username: string, passcode: string, timezone: string, nextDayBoundary: string, inviteCode: string): User {
  const stmt = db.prepare(
    "INSERT INTO users (username, passcode, timezone, next_day_boundary, invite_code) VALUES (?, ?, ?, ?, ?) RETURNING *"
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

export function logPushups(userId: number, count: number, source: string, loggedAt?: string): PushupLog {
  if (loggedAt) {
    return db.prepare(
      "INSERT INTO pushup_logs (user_id, count, source, logged_at) VALUES (?, ?, ?, ?) RETURNING *"
    ).get(userId, count, source, loggedAt) as PushupLog;
  }
  return db.prepare(
    "INSERT INTO pushup_logs (user_id, count, source) VALUES (?, ?, ?) RETURNING *"
  ).get(userId, count, source) as PushupLog;
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

export function getUsersWithExpiredBoundary(now: string): User[] {
  return db.prepare("SELECT * FROM users WHERE next_day_boundary <= ?").all(now) as User[];
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
