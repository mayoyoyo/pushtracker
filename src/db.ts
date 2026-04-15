import { Database } from "bun:sqlite";


let db: Database;

/**
 * Schema + migration policy for getDb().
 *
 * This function runs on every server start. The block below is intentionally
 * restricted to operations that are SAFE to re-run every single boot:
 *
 *   - CREATE TABLE IF NOT EXISTS                 (idempotent by construction)
 *   - CREATE INDEX IF NOT EXISTS                 (idempotent by construction)
 *   - try { ALTER TABLE ... ADD COLUMN } catch {} (SQLite throws on duplicate
 *                                                  column; caught and ignored)
 *   - INSERT OR IGNORE ...                       (seeds, safe by construction)
 *   - UPDATE ... WHERE col = <sentinel>          (backfill of a newly-added
 *                                                  default; naturally no-op on
 *                                                  rerun because the WHERE
 *                                                  stops matching after first
 *                                                  pass)
 *
 * ANY OTHER UPDATE / DELETE / DATA-MUTATING INSERT MUST go through
 * runMigration(name, fn) below. Don't care how "obviously idempotent"
 * your rewrite seems — wrap it. PR #10 silently corrupted user mode data
 * for a week because a bare UPDATE in this block was claimed to be
 * idempotent in a comment and wasn't; see PR #17 postmortem.
 *
 * runMigration uses the _migrations marker table as a one-shot gate. Once
 * the marker row is inserted (by the PRIMARY KEY), the destructive block
 * is unreachable on subsequent boots. Tests in tests/db.test.ts enforce
 * this for both runMigration itself and the specific mode_rename_v1
 * migration.
 */
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
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  // Discord integration column on invite_codes
  try { db.exec("ALTER TABLE invite_codes ADD COLUMN discord_webhook_url TEXT"); } catch {}
  // Composite index for fast per-user + per-mode aggregates (lifetime totals,
  // today totals, has-ever-logged checks). Without this, pushup_logs does a
  // full table scan on every user-scoped read — fine at current scale, cheap
  // to fix preemptively.
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_pushup_logs_user_mode ON pushup_logs(user_id, mode)"); } catch {}
  // User aliasing: source_user_id for marking alias users
  try { db.exec("ALTER TABLE users ADD COLUMN source_user_id INTEGER REFERENCES users(id)"); } catch {}
  // Day results for calendar history
  db.exec(`CREATE TABLE IF NOT EXISTS day_results (
    user_id INTEGER NOT NULL REFERENCES users(id),
    day_date TEXT NOT NULL,
    met INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'manual',
    total INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day_date)
  )`);
  // Mode rename (one-shot, marker-gated via runMigration). See postmortem for
  // PR #17 for why this used to be a bare UPDATE and why it's never allowed
  // to be one again.
  runMigration('mode_rename_v1', () => {
    // Early exit for DBs that already went through the rename via the old
    // (buggy) bare-UPDATE path that predates the marker. Their surviving
    // 'noob' rows are zero, which is exactly the signal that the destructive
    // rewrite already happened and running it again would re-corrupt.
    const hasLegacyNoob = db.prepare(
      "SELECT 1 FROM pushup_logs WHERE mode = 'noob' " +
      "UNION ALL SELECT 1 FROM day_results WHERE mode = 'noob' LIMIT 1"
    ).get();
    if (!hasLegacyNoob) return;
    db.exec("UPDATE pushup_logs SET mode = 'opm'      WHERE mode = 'standard'");
    db.exec("UPDATE pushup_logs SET mode = 'standard' WHERE mode = 'noob'");
    db.exec("UPDATE day_results SET mode = 'opm'      WHERE mode = 'standard'");
    db.exec("UPDATE day_results SET mode = 'standard' WHERE mode = 'noob'");
  });
  // Seed invite codes
  db.prepare("INSERT OR IGNORE INTO invite_codes (code, group_name) VALUES ('DEV0', 'MayoLab')").run();
  db.prepare("INSERT OR IGNORE INTO invite_codes (code, group_name) VALUES ('FRST', 'Frist')").run();
  db.prepare("UPDATE invite_codes SET group_name = 'MayoLab' WHERE code = 'DEV0' AND group_name = ''").run();
  db.prepare("UPDATE invite_codes SET group_name = 'Frist' WHERE code = 'FRST' AND group_name = ''").run();
  // Migrate any old DEV users to DEV0
  db.prepare("UPDATE users SET invite_code = 'DEV0' WHERE invite_code = 'DEV'").run();
  linkMayoToHansonIfNeeded();
  return db;
}

/**
 * One-shot migration gate. If `name` is recorded in _migrations, return
 * immediately. Otherwise run `fn()` inside a transaction and insert the
 * marker row. If `fn` throws, the transaction rolls back and the marker
 * is NOT recorded, so the migration will be retried on the next boot.
 *
 * The marker is inserted even if `fn` is a no-op (e.g., an early-exit
 * when the migration detects it has nothing to do). That's intentional:
 * we want a definitive "this migration has been seen" record so the
 * destructive branch never re-enters on subsequent boots.
 *
 * Use this for any UPDATE / DELETE / data-mutating INSERT that isn't
 * trivially safe to re-run. See the policy comment on getDb().
 */
export function runMigration(name: string, fn: () => void): void {
  const existing = db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get(name);
  if (existing) return;
  db.transaction(() => {
    fn();
    db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
  })();
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
  source_user_id: number | null;
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

export function resolveDataUserId(userId: number): number {
  const row = db.prepare(
    "SELECT source_user_id FROM users WHERE id = ?"
  ).get(userId) as { source_user_id: number | null } | null;
  return row?.source_user_id ?? userId;
}

// Test helper and migration primitive: mark `aliasId` as an alias of `sourceId`.
// Callers in production code go through the one-time username-based migration.
export function linkAlias(aliasId: number, sourceId: number): void {
  db.prepare("UPDATE users SET source_user_id = ? WHERE id = ?").run(sourceId, aliasId);
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
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET daily_target = ? WHERE id = ?").run(target, userId);
}

export function updateDebt(userId: number, delta: number): void {
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET debt = MAX(0, debt + ?) WHERE id = ?").run(delta, userId);
}

export function updateTimezone(userId: number, timezone: string, nextDayBoundary: string): void {
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET timezone = ?, next_day_boundary = ? WHERE id = ?").run(timezone, nextDayBoundary, userId);
}

export function updateNextDayBoundary(userId: number, nextDayBoundary: string): void {
  db.prepare("UPDATE users SET next_day_boundary = ? WHERE id = ?").run(nextDayBoundary, userId);
}

export function logPushups(userId: number, count: number, source: string, mode: string = 'manual', loggedAt?: string): PushupLog {
  userId = resolveDataUserId(userId);
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
  userId = resolveDataUserId(userId);
  return db.prepare(
    "SELECT * FROM pushup_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ? ORDER BY logged_at"
  ).all(userId, dayStart, dayEnd) as PushupLog[];
}

export function getTodayTotal(userId: number, dayStart: string, dayEnd: string): number {
  userId = resolveDataUserId(userId);
  const row = db.prepare(
    "SELECT COALESCE(SUM(count), 0) as total FROM pushup_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ?"
  ).get(userId, dayStart, dayEnd) as { total: number };
  return row.total;
}

export function getTeamByGroup(inviteCode: string): User[] {
  return db.prepare("SELECT * FROM users WHERE invite_code = ? ORDER BY username").all(inviteCode) as User[];
}

export function saveDayResult(userId: number, dayDate: string, met: boolean, mode: string, total: number): void {
  userId = resolveDataUserId(userId);
  db.prepare(
    "INSERT OR REPLACE INTO day_results (user_id, day_date, met, mode, total) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, dayDate, met ? 1 : 0, mode, total);
}

export function getMonthResults(userId: number, yearMonth: string): Array<{ day_date: string; met: boolean; mode: string; total: number }> {
  userId = resolveDataUserId(userId);
  const rows = db.prepare(
    "SELECT * FROM day_results WHERE user_id = ? AND day_date LIKE ? ORDER BY day_date"
  ).all(userId, yearMonth + '%') as Array<{ day_date: string; met: number; mode: string; total: number }>;
  return rows.map(r => ({ ...r, met: r.met === 1 }));
}

export function updateStreak(userId: number, last5: string, streak: number): void {
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET last5 = ?, streak = ? WHERE id = ?").run(last5, streak, userId);
}

export function getGroupName(inviteCode: string): string {
  const row = db.prepare("SELECT group_name FROM invite_codes WHERE code = ?").get(inviteCode) as { group_name: string } | null;
  return row?.group_name || inviteCode;
}


export function hasEverLoggedPushups(userId: number): boolean {
  userId = resolveDataUserId(userId);
  const row = db.prepare("SELECT 1 FROM pushup_logs WHERE user_id = ? LIMIT 1").get(userId);
  return row !== null;
}

export function getUsersWithExpiredBoundary(now: string): User[] {
  return db.prepare(`
    SELECT u.*
    FROM users u
    LEFT JOIN users s ON s.id = u.source_user_id
    WHERE COALESCE(s.next_day_boundary, u.next_day_boundary) <= ?
  `).all(now) as User[];
}

export function getSlackConfig(inviteCode: string): { slack_bot_token: string; slack_channel: string } | null {
  const row = db.prepare("SELECT slack_bot_token, slack_channel FROM invite_codes WHERE code = ?").get(inviteCode) as { slack_bot_token: string | null; slack_channel: string | null } | null;
  if (!row || !row.slack_bot_token || !row.slack_channel) return null;
  return { slack_bot_token: row.slack_bot_token, slack_channel: row.slack_channel };
}

export function getDiscordConfig(inviteCode: string): { discord_webhook_url: string } | null {
  const row = db.prepare("SELECT discord_webhook_url FROM invite_codes WHERE code = ?").get(inviteCode) as { discord_webhook_url: string | null } | null;
  if (!row || !row.discord_webhook_url) return null;
  return { discord_webhook_url: row.discord_webhook_url };
}

// Lifetime totals across all of the user's pushup_logs, with today's
// in-progress reps included (we sum from the raw log table, not day_results,
// so anything logged before the next rollup still counts). Sit-ups are a
// single mode; pushups bucket opm + standard + manual together (any non-situp
// rep). Alias-aware via resolveDataUserId — mayo and hanson see the same row.
export function getLifetimeTotals(userId: number): { pushups: number; situps: number } {
  userId = resolveDataUserId(userId);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN mode = 'situp'  THEN count ELSE 0 END), 0) AS situps,
      COALESCE(SUM(CASE WHEN mode <> 'situp' THEN count ELSE 0 END), 0) AS pushups
    FROM pushup_logs
    WHERE user_id = ?
  `).get(userId) as { situps: number; pushups: number };
  return { pushups: row.pushups, situps: row.situps };
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

export function getResolvedUserById(id: number): User | null {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | null;
  if (!row) return null;
  if (row.source_user_id == null) return row;
  const source = db.prepare("SELECT * FROM users WHERE id = ?").get(row.source_user_id) as User | null;
  if (!source) return row;
  return {
    // identity from alias
    id: row.id,
    username: row.username,
    passcode: row.passcode,
    invite_code: row.invite_code,
    created_at: row.created_at,
    source_user_id: row.source_user_id,
    // progress/settings from source
    daily_target: source.daily_target,
    debt: source.debt,
    timezone: source.timezone,
    next_day_boundary: source.next_day_boundary,
    last5: source.last5,
    streak: source.streak,
  };
}

export function getResolvedTeamByGroup(inviteCode: string): User[] {
  const rows = db.prepare("SELECT * FROM users WHERE invite_code = ? ORDER BY username").all(inviteCode) as User[];
  return rows.map(row => {
    if (row.source_user_id == null) return row;
    const source = db.prepare("SELECT * FROM users WHERE id = ?").get(row.source_user_id) as User | null;
    if (!source) return row;
    return {
      id: row.id,
      username: row.username,
      passcode: row.passcode,
      invite_code: row.invite_code,
      created_at: row.created_at,
      source_user_id: row.source_user_id,
      daily_target: source.daily_target,
      debt: source.debt,
      timezone: source.timezone,
      next_day_boundary: source.next_day_boundary,
      last5: source.last5,
      streak: source.streak,
    };
  });
}

export function linkMayoToHansonIfNeeded(): void {
  db.exec(`
    UPDATE users
    SET source_user_id = (SELECT id FROM users WHERE username = 'hanson')
    WHERE username = 'mayo'
      AND source_user_id IS NULL
      AND EXISTS (SELECT 1 FROM users WHERE username = 'hanson')
  `);
  db.exec(`
    DELETE FROM pushup_logs
    WHERE user_id IN (
      SELECT id FROM users
      WHERE username = 'mayo'
        AND source_user_id = (SELECT id FROM users WHERE username = 'hanson')
    )
  `);
  db.exec(`
    DELETE FROM day_results
    WHERE user_id IN (
      SELECT id FROM users
      WHERE username = 'mayo'
        AND source_user_id = (SELECT id FROM users WHERE username = 'hanson')
    )
  `);
  db.exec(`
    UPDATE users
    SET daily_target = 0, debt = 0, last5 = '', streak = 0
    WHERE username = 'mayo'
      AND source_user_id = (SELECT id FROM users WHERE username = 'hanson')
  `);
}
