# Hanson ↔ Mayo User Aliasing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mayo` a transparent DB-level alias of `hanson` so the two cross-org accounts share a single source of truth for pushups, debt, streak, settings, and calendar — while each org's Slack channel still fires its own day-end post.

**Architecture:** Add a nullable `users.source_user_id` self-reference column. A `resolveDataUserId` helper rewrites every data/settings read and write through the source row. Two "resolved" helpers (`getResolvedUserById`, `getResolvedTeamByGroup`) merge an alias's identity (id, username, invite_code) with the source's progress/settings so the API layer never has to know aliasing exists. `getUsersWithExpiredBoundary` is rewritten to JOIN on source so alias rows phase-lock to their source. Cron sorts non-aliases first, runs the rollup exactly once per source, and alias rows only fire their own org's Slack post.

**Tech Stack:** Bun, bun:sqlite, `bun test`. All DB logic lives in `src/db.ts`. Tests use in-memory DB via `getDb(":memory:")` in `beforeEach`.

**Spec:** `docs/superpowers/specs/2026-04-13-hanson-mayo-alias-design.md`

---

## File Map

- **Modify** `src/db.ts` — schema migration, `resolveDataUserId`, resolver-wrapped data functions, `getResolvedUserById`, `getResolvedTeamByGroup`, JOIN rewrite of `getUsersWithExpiredBoundary`, one-time link-and-wipe migration.
- **Modify** `src/auth.ts:36` — `getSessionUser` returns `getResolvedUserById(session.user_id)`.
- **Modify** `src/api.ts:154` — `/api/team/today` uses `getResolvedTeamByGroup` instead of `getTeamByGroup`.
- **Modify** `src/cron.ts` — sort users non-alias-first, skip rollup for alias rows, fire per-alias Slack fan-out using resolved source stats.
- **Modify** `CLAUDE.md` — append `## User Aliasing (IMPORTANT)` guardrail section.
- **Modify** `tests/db.test.ts` — unit tests for resolver, aliased reads/writes, resolved helpers, boundary JOIN.
- **Modify** `tests/cron.test.ts` — integration test for alias + cron day-end rollup + Slack fan-out.
- **Modify** `tests/api.test.ts` — integration tests for `/api/me`, `/api/pushups`, `/api/me/calendar`, `/api/team/today` on an aliased session.

---

## Task 1: Schema column and `resolveDataUserId` helper

**Files:**
- Modify: `src/db.ts:37-65` (migration block in `getDb`) and `src/db.ts` (new `resolveDataUserId` export)
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Write failing tests for the resolver**

Add to `tests/db.test.ts` after the existing `describe("createUser")` block:

```ts
describe("resolveDataUserId", () => {
  test("returns same id for a non-alias user", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    expect(resolveDataUserId(user.id)).toBe(user.id);
  });

  test("returns source id for an alias user", () => {
    const hanson = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "hash", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);
    expect(resolveDataUserId(mayo.id)).toBe(hanson.id);
    expect(resolveDataUserId(hanson.id)).toBe(hanson.id);
  });

  test("returns passed id for a nonexistent user id", () => {
    expect(resolveDataUserId(9999)).toBe(9999);
  });
});
```

Update the import at the top of `tests/db.test.ts:2` to include `resolveDataUserId` and `linkAlias`:

```ts
import { getDb, createUser, getUserByUsername, getUserById, logPushups, getTodayLogs, getTeamByGroup, updateTarget, updateDebt, getGroupName, getDayHistory, getSlackConfig, resolveDataUserId, linkAlias } from "../src/db";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts`
Expected: FAIL — `resolveDataUserId` and `linkAlias` are not exported from `src/db.ts`.

- [ ] **Step 3: Add schema migration in `getDb`**

In `src/db.ts`, inside `getDb()` after the existing `try { db.exec("ALTER TABLE invite_codes ADD COLUMN slack_channel TEXT"); } catch {}` line (currently `src/db.ts:49`), add:

```ts
try { db.exec("ALTER TABLE users ADD COLUMN source_user_id INTEGER REFERENCES users(id)"); } catch {}
```

- [ ] **Step 4: Add `resolveDataUserId` and `linkAlias` helpers**

Append these exports to `src/db.ts` (place near the other user-facing helpers, e.g. just above `createUser`):

```ts
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
```

Also add `source_user_id: number | null;` to the `User` interface at `src/db.ts:69-81`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: All `resolveDataUserId` tests pass. Existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(alias): add source_user_id column and resolveDataUserId helper

Adds the schema column and resolver primitive for user aliasing. Exports
linkAlias as a test/migration primitive. No callers yet.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Resolve data-read functions

Wire `resolveDataUserId` into every `db.ts` function that reads per-user progress data. Writes come in Task 3.

**Files:**
- Modify: `src/db.ts` — `logPushups`, `getTodayLogs`, `getTodayTotal`, `getMonthResults`, `hasEverLoggedPushups`
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/db.test.ts`:

```ts
describe("alias data reads", () => {
  test("logPushups from alias id inserts under source id", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    const log = logPushups(mayo.id, 15, "manual");
    expect(log.user_id).toBe(hanson.id);
  });

  test("getTodayTotal from alias id returns source's total", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    logPushups(hanson.id, 10, "manual", "manual", "2026-04-07T14:00:00Z");
    logPushups(mayo.id, 5, "manual", "manual", "2026-04-07T15:00:00Z");

    const hansonTotal = getTodayTotal(hanson.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
    const mayoTotal = getTodayTotal(mayo.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
    expect(hansonTotal).toBe(15);
    expect(mayoTotal).toBe(15);
  });

  test("getTodayLogs from alias id returns source's logs", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    logPushups(hanson.id, 10, "manual", "manual", "2026-04-07T14:00:00Z");
    const logs = getTodayLogs(mayo.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
    expect(logs.length).toBe(1);
    expect(logs[0].count).toBe(10);
  });

  test("hasEverLoggedPushups resolves through alias", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    expect(hasEverLoggedPushups(mayo.id)).toBe(false);
    logPushups(hanson.id, 10, "manual");
    expect(hasEverLoggedPushups(mayo.id)).toBe(true);
  });

  test("getMonthResults resolves through alias", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    saveDayResult(hanson.id, "2026-04-06", true, "standard", 30);
    const results = getMonthResults(mayo.id, "2026-04");
    expect(results.length).toBe(1);
    expect(results[0].total).toBe(30);
  });
});
```

Extend the import at `tests/db.test.ts:2` to include the symbols above: `getTodayTotal, hasEverLoggedPushups, getMonthResults, saveDayResult`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts -t "alias data reads"`
Expected: All 5 tests FAIL — alias reads still hit alias's raw row.

- [ ] **Step 3: Add `resolveDataUserId` to every read function in `src/db.ts`**

Replace each function body's first line to resolve the passed `userId` first.

`logPushups` (`src/db.ts:127-136`):

```ts
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
```

`getTodayLogs` (`src/db.ts:138-142`):

```ts
export function getTodayLogs(userId: number, dayStart: string, dayEnd: string): PushupLog[] {
  userId = resolveDataUserId(userId);
  return db.prepare(
    "SELECT * FROM pushup_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ? ORDER BY logged_at"
  ).all(userId, dayStart, dayEnd) as PushupLog[];
}
```

`getTodayTotal` (`src/db.ts:144-149`):

```ts
export function getTodayTotal(userId: number, dayStart: string, dayEnd: string): number {
  userId = resolveDataUserId(userId);
  const row = db.prepare(
    "SELECT COALESCE(SUM(count), 0) as total FROM pushup_logs WHERE user_id = ? AND logged_at >= ? AND logged_at < ?"
  ).get(userId, dayStart, dayEnd) as { total: number };
  return row.total;
}
```

`hasEverLoggedPushups` (`src/db.ts:178-181`):

```ts
export function hasEverLoggedPushups(userId: number): boolean {
  userId = resolveDataUserId(userId);
  const row = db.prepare("SELECT 1 FROM pushup_logs WHERE user_id = ? LIMIT 1").get(userId);
  return row !== null;
}
```

`getMonthResults` (`src/db.ts:161-166`):

```ts
export function getMonthResults(userId: number, yearMonth: string): Array<{ day_date: string; met: boolean; mode: string; total: number }> {
  userId = resolveDataUserId(userId);
  const rows = db.prepare(
    "SELECT * FROM day_results WHERE user_id = ? AND day_date LIKE ? ORDER BY day_date"
  ).all(userId, yearMonth + '%') as Array<{ day_date: string; met: number; mode: string; total: number }>;
  return rows.map(r => ({ ...r, met: r.met === 1 }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: All alias data-read tests pass. All pre-existing db tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(alias): resolve user id in read functions

logPushups, getTodayLogs, getTodayTotal, getMonthResults, and
hasEverLoggedPushups now route through resolveDataUserId so alias
reads/writes land on the source row's data.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Resolve data-write functions

Wire the resolver into every `db.ts` write function touching user-scoped state: debt, streak/last5, day_results, target, timezone. `updateNextDayBoundary` stays raw (cron is the only caller and it won't call it on alias rows).

**Files:**
- Modify: `src/db.ts` — `updateDebt`, `updateStreak`, `saveDayResult`, `updateTarget`, `updateTimezone`
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/db.test.ts`:

```ts
describe("alias data writes", () => {
  function pair() {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);
    return { hanson, mayo };
  }

  test("updateDebt on alias mutates source row", () => {
    const { hanson, mayo } = pair();
    updateDebt(mayo.id, 25);
    expect(getUserById(hanson.id)!.debt).toBe(25);
    expect(getUserById(mayo.id)!.debt).toBe(0);
  });

  test("updateTarget on alias mutates source row", () => {
    const { hanson, mayo } = pair();
    updateTarget(mayo.id, 40);
    expect(getUserById(hanson.id)!.daily_target).toBe(40);
    expect(getUserById(mayo.id)!.daily_target).toBe(20);
  });

  test("updateStreak on alias mutates source row", () => {
    const { hanson, mayo } = pair();
    updateStreak(mayo.id, "S,S,F", 3);
    expect(getUserById(hanson.id)!.streak).toBe(3);
    expect(getUserById(hanson.id)!.last5).toBe("S,S,F");
    expect(getUserById(mayo.id)!.streak).toBe(0);
  });

  test("saveDayResult on alias writes under source id", () => {
    const { hanson, mayo } = pair();
    saveDayResult(mayo.id, "2026-04-06", true, "standard", 30);
    const rows = getMonthResults(hanson.id, "2026-04");
    expect(rows.length).toBe(1);
    expect(rows[0].total).toBe(30);
  });

  test("updateTimezone on alias mutates source row (timezone + boundary)", () => {
    const { hanson, mayo } = pair();
    updateTimezone(mayo.id, "Europe/London", "2026-04-09T00:00:00.000Z");
    const h = getUserById(hanson.id)!;
    const m = getUserById(mayo.id)!;
    expect(h.timezone).toBe("Europe/London");
    expect(h.next_day_boundary).toBe("2026-04-09T00:00:00.000Z");
    expect(m.timezone).toBe("America/New_York");
  });
});
```

Extend imports in `tests/db.test.ts:2` to include `updateStreak, saveDayResult, updateTimezone`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts -t "alias data writes"`
Expected: All 5 tests FAIL — writes still land on the alias's own row.

- [ ] **Step 3: Add `resolveDataUserId` to every write function**

`updateDebt` (`src/db.ts:115-117`):

```ts
export function updateDebt(userId: number, delta: number): void {
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET debt = MAX(0, debt + ?) WHERE id = ?").run(delta, userId);
}
```

`updateTarget` (`src/db.ts:111-113`):

```ts
export function updateTarget(userId: number, target: number): void {
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET daily_target = ? WHERE id = ?").run(target, userId);
}
```

`updateTimezone` (`src/db.ts:119-121`):

```ts
export function updateTimezone(userId: number, timezone: string, nextDayBoundary: string): void {
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET timezone = ?, next_day_boundary = ? WHERE id = ?").run(timezone, nextDayBoundary, userId);
}
```

`updateStreak` (`src/db.ts:168-170`):

```ts
export function updateStreak(userId: number, last5: string, streak: number): void {
  userId = resolveDataUserId(userId);
  db.prepare("UPDATE users SET last5 = ?, streak = ? WHERE id = ?").run(last5, streak, userId);
}
```

`saveDayResult` (`src/db.ts:155-159`):

```ts
export function saveDayResult(userId: number, dayDate: string, met: boolean, mode: string, total: number): void {
  userId = resolveDataUserId(userId);
  db.prepare(
    "INSERT OR REPLACE INTO day_results (user_id, day_date, met, mode, total) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, dayDate, met ? 1 : 0, mode, total);
}
```

Leave `updateNextDayBoundary` (`src/db.ts:123-125`) **unchanged** — it stays raw by design.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: All write tests pass. All pre-existing db tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(alias): resolve user id in write functions

updateDebt, updateTarget, updateTimezone, updateStreak, and saveDayResult
now route through resolveDataUserId. updateNextDayBoundary stays raw
because cron will not call it on alias rows.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `getResolvedUserById` and `getResolvedTeamByGroup`

Two helpers that merge an alias's identity (`id`, `username`, `invite_code`, `created_at`, `source_user_id`) with the source row's progress/settings fields (`debt`, `last5`, `streak`, `daily_target`, `timezone`, `next_day_boundary`, `passcode`). Non-alias callers return unchanged.

**Files:**
- Modify: `src/db.ts` — add two exports
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/db.test.ts`:

```ts
describe("getResolvedUserById", () => {
  test("returns row unchanged for non-alias user", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    updateTarget(hanson.id, 35);
    const resolved = getResolvedUserById(hanson.id)!;
    expect(resolved.id).toBe(hanson.id);
    expect(resolved.username).toBe("hanson");
    expect(resolved.daily_target).toBe(35);
    expect(resolved.source_user_id).toBeNull();
  });

  test("merges alias identity with source progress/settings", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    updateTarget(hanson.id, 50);
    updateDebt(hanson.id, 10);
    updateStreak(hanson.id, "S,S", 2);

    const resolved = getResolvedUserById(mayo.id)!;
    expect(resolved.id).toBe(mayo.id);
    expect(resolved.username).toBe("mayo");
    expect(resolved.invite_code).toBe("FRST");
    expect(resolved.daily_target).toBe(50);
    expect(resolved.debt).toBe(10);
    expect(resolved.last5).toBe("S,S");
    expect(resolved.streak).toBe(2);
    expect(resolved.source_user_id).toBe(hanson.id);
  });

  test("returns null for unknown id", () => {
    expect(getResolvedUserById(9999)).toBeNull();
  });
});

describe("getResolvedTeamByGroup", () => {
  test("returns Frist org with mayo carrying hanson's progress", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    const otherFrist = createUser("other", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    updateTarget(hanson.id, 40);
    updateDebt(hanson.id, 15);
    updateStreak(hanson.id, "S,F", 2);

    const frist = getResolvedTeamByGroup("FRST");
    expect(frist.length).toBe(2);

    const mayoRow = frist.find(u => u.username === "mayo")!;
    expect(mayoRow.id).toBe(mayo.id);
    expect(mayoRow.invite_code).toBe("FRST");
    expect(mayoRow.daily_target).toBe(40);
    expect(mayoRow.debt).toBe(15);
    expect(mayoRow.streak).toBe(2);
    expect(mayoRow.last5).toBe("S,F");

    const otherRow = frist.find(u => u.username === "other")!;
    expect(otherRow.daily_target).toBe(20);
    expect(otherRow.debt).toBe(0);
  });

  test("MayoLab org shows hanson normally (non-alias)", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    updateTarget(hanson.id, 25);
    const mayolab = getResolvedTeamByGroup("DEV0");
    expect(mayolab.length).toBe(1);
    expect(mayolab[0].username).toBe("hanson");
    expect(mayolab[0].daily_target).toBe(25);
  });
});
```

Extend imports in `tests/db.test.ts:2` to include `getResolvedUserById, getResolvedTeamByGroup`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts -t "getResolvedUserById|getResolvedTeamByGroup"`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Implement both helpers**

Append to `src/db.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: All resolved-helper tests pass. Pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(alias): add getResolvedUserById and getResolvedTeamByGroup

Merges an alias's identity with the source's progress/settings fields so
API callers get a single User-shaped object. Non-alias rows pass through
unchanged.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rewrite `getUsersWithExpiredBoundary` to JOIN on source

Cron must only return an alias row when its **source's** effective boundary is expired, so alias + source stay in phase.

**Files:**
- Modify: `src/db.ts:183-185`
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/db.test.ts`:

```ts
describe("getUsersWithExpiredBoundary with alias", () => {
  test("returns alias only when source boundary is expired", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00.000Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-20T11:00:00.000Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    // Hanson's boundary (04-08) is in the past; mayo's raw boundary (04-20) is future.
    // Effective boundary for mayo = hanson's (04-08), so mayo SHOULD be returned.
    const expired = getUsersWithExpiredBoundary("2026-04-09T00:00:00.000Z");
    const ids = expired.map(u => u.id).sort();
    expect(ids).toContain(hanson.id);
    expect(ids).toContain(mayo.id);
  });

  test("does not return alias when source boundary is fresh", () => {
    const hanson = createUser("hanson", "h", "America/New_York", "2026-04-20T11:00:00.000Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00.000Z", "FRST");
    linkAlias(mayo.id, hanson.id);

    // Source (hanson) boundary is future; mayo's raw boundary is past.
    // Effective boundary for mayo = hanson's (future), so mayo must NOT be returned.
    const expired = getUsersWithExpiredBoundary("2026-04-09T00:00:00.000Z");
    expect(expired.find(u => u.id === mayo.id)).toBeUndefined();
    expect(expired.find(u => u.id === hanson.id)).toBeUndefined();
  });

  test("non-alias user behaves unchanged", () => {
    const solo = createUser("solo", "h", "America/New_York", "2026-04-05T11:00:00.000Z", "DEV0");
    const expired = getUsersWithExpiredBoundary("2026-04-09T00:00:00.000Z");
    expect(expired.find(u => u.id === solo.id)).toBeDefined();
  });
});
```

Extend imports in `tests/db.test.ts:2` to include `getUsersWithExpiredBoundary`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts -t "getUsersWithExpiredBoundary with alias"`
Expected: The alias tests FAIL because the current implementation compares raw `next_day_boundary`.

- [ ] **Step 3: Rewrite the query with a JOIN**

Replace `src/db.ts:183-185`:

```ts
export function getUsersWithExpiredBoundary(now: string): User[] {
  return db.prepare(`
    SELECT u.*
    FROM users u
    LEFT JOIN users s ON s.id = u.source_user_id
    WHERE COALESCE(s.next_day_boundary, u.next_day_boundary) <= ?
  `).all(now) as User[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: All alias boundary tests pass. Pre-existing db tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(alias): resolve boundary via JOIN in getUsersWithExpiredBoundary

Alias rows are now returned only when their source's effective
next_day_boundary is expired, keeping alias and source phase-locked to
the same day-end tick.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `getSessionUser` returns a resolved user

`auth.getSessionUser` is the single entry point the API uses to hydrate the authenticated user. Switching it to `getResolvedUserById` means every existing `/api/me*` endpoint automatically reflects aliasing without further API changes.

**Files:**
- Modify: `src/auth.ts:36-40`
- Modify: `tests/auth.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/auth.test.ts` (inside the existing `describe("auth")` block, adjust import as needed):

```ts
test("getSessionUser on alias session returns source's progress/settings", async () => {
  const { user: hanson } = await signup("hanson", "1111", "America/New_York", "DEV0");
  const { token, user: mayo } = await signup("mayo", "2222", "America/New_York", "FRST");
  linkAlias(mayo.id, hanson.id);
  updateTarget(hanson.id, 45);
  updateDebt(hanson.id, 12);

  const resolved = getSessionUser(token)!;
  expect(resolved.id).toBe(mayo.id);
  expect(resolved.username).toBe("mayo");
  expect(resolved.invite_code).toBe("FRST");
  expect(resolved.daily_target).toBe(45);
  expect(resolved.debt).toBe(12);
});
```

Update imports in `tests/auth.test.ts` to include `linkAlias, updateTarget, updateDebt` from `../src/db`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/auth.test.ts -t "alias session"`
Expected: FAIL — `getSessionUser` returns raw mayo with `daily_target=20`, `debt=0`.

- [ ] **Step 3: Update `getSessionUser`**

Replace `src/auth.ts:36-40`:

```ts
export function getSessionUser(token: string): User | null {
  const session = getSession(token);
  if (!session) return null;
  return getResolvedUserById(session.user_id);
}
```

Update imports at the top of `src/auth.ts` to import `getResolvedUserById` from `./db` instead of (or in addition to) `getUserById`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/auth.test.ts`
Expected: All auth tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts tests/auth.test.ts
git commit -m "feat(alias): resolve session user at auth layer

getSessionUser now returns getResolvedUserById so every /api/me endpoint
automatically sees the source's progress/settings for alias sessions.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `/api/team/today` uses `getResolvedTeamByGroup`

Frist's leaderboard must show mayo's row with hanson's progress. Because Task 2 already resolved `getTodayTotal`/`getTodayLogs`/`hasEverLoggedPushups`, the only remaining gap is the scalar fields (`u.last5`, `u.streak`, `u.debt`, `u.daily_target`) read off the raw row. Swapping `getTeamByGroup` → `getResolvedTeamByGroup` fixes it.

**Files:**
- Modify: `src/api.ts:2` and `src/api.ts:154`
- Modify: `tests/api.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/api.test.ts` (inside the existing API describe block):

```ts
test("GET /api/team/today on Frist shows mayo with hanson's progress", async () => {
  const { user: hanson } = await signup("hanson", "1111", "America/New_York", "DEV0");
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
```

Update imports in `tests/api.test.ts` to include `linkAlias, updateTarget, updateDebt, updateStreak, logPushups` from `../src/db`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api.test.ts -t "mayo with hanson"`
Expected: FAIL — `mayoRow.daily_target` comes back as `20`, `debt` as `0`, `streak.count` as `0`.

- [ ] **Step 3: Swap the call**

In `src/api.ts:2`, change the import:

```ts
import { logPushups, getTodayLogs, getTodayTotal, getResolvedTeamByGroup, updateTarget, updateDebt, updateTimezone, getGroupName, getMonthResults, hasEverLoggedPushups, getSlackConfig, type User } from "./db";
```

(Replacing `getTeamByGroup` with `getResolvedTeamByGroup`.)

Then change `src/api.ts:154`:

```ts
const allUsers = getResolvedTeamByGroup(user.invite_code);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/api.test.ts`
Expected: All API tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts tests/api.test.ts
git commit -m "feat(alias): team endpoint uses resolved members

/api/team/today now calls getResolvedTeamByGroup so alias rows carry
the source's daily_target, debt, streak, and last5 alongside the alias's
own username and org.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Cron alias branch

Process non-alias rows first (so the source's rollup commits), then handle alias rows by only firing their own org's Slack post. Alias rows never call the rollup mutators and never call `updateNextDayBoundary`.

**Files:**
- Modify: `src/cron.ts`
- Modify: `tests/cron.test.ts`

- [ ] **Step 1: Write failing integration test**

Add to `tests/cron.test.ts`:

```ts
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
```

Update imports in `tests/cron.test.ts` to include `linkAlias` and `getDb`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cron.test.ts -t "alias row"`
Expected: FAIL — current cron runs the rollup on the alias row too.

- [ ] **Step 3: Update `processExpiredBoundaries`**

Replace the body of `processExpiredBoundaries` in `src/cron.ts:8-76`:

```ts
export function processExpiredBoundaries(nowUtc: string): void {
  let users = getUsersWithExpiredBoundary(nowUtc);

  while (users.length > 0) {
    // Process sources before aliases so each alias sees the fresh source state.
    users.sort((a, b) => {
      const aIsAlias = a.source_user_id != null ? 1 : 0;
      const bIsAlias = b.source_user_id != null ? 1 : 0;
      return aIsAlias - bIsAlias;
    });

    for (const user of users) {
      if (user.source_user_id != null) {
        // Alias branch: no rollup, no boundary advance — just fan out the org's Slack post.
        const slackConfig = getSlackConfig(user.invite_code);
        if (!slackConfig) continue;

        const resolved = getResolvedUserById(user.id);
        if (!resolved) continue;
        if (!hasEverLoggedPushups(resolved.id)) continue;

        const prevBoundary = getPreviousDayBoundary(resolved.timezone, resolved.next_day_boundary);
        const todayTotal = getTodayTotal(resolved.id, prevBoundary, resolved.next_day_boundary);
        const met = resolved.daily_target > 0 && todayTotal >= resolved.daily_target;
        const dayDate = DateTime.fromISO(prevBoundary, { zone: 'utc' }).setZone(resolved.timezone).toISODate();
        const formattedDate = DateTime.fromISO(dayDate!).toFormat("MMMM d, yyyy");
        postDayResult(
          slackConfig.slack_bot_token,
          slackConfig.slack_channel,
          user.username,
          formattedDate,
          todayTotal,
          resolved.daily_target,
          met,
          resolved.streak,
          resolved.debt,
        ).catch(err => console.error(`Slack post failed for ${user.username}:`, err));
        continue;
      }

      // Non-alias branch: existing rollup behavior.
      const nextBoundary = advanceBoundary(user.timezone, user.next_day_boundary);

      if (!hasEverLoggedPushups(user.id)) {
        updateNextDayBoundary(user.id, nextBoundary);
        continue;
      }

      const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
      const todayTotal = getTodayTotal(user.id, prevBoundary, user.next_day_boundary);
      const shortfall = user.daily_target - todayTotal;

      const met = user.daily_target > 0 && todayTotal >= user.daily_target;
      let dayIcon = 'I';
      if (met) {
        const stdTotal = getTodayLogs(user.id, prevBoundary, user.next_day_boundary)
          .filter(l => l.mode === 'standard')
          .reduce((sum, l) => sum + l.count, 0);
        dayIcon = stdTotal >= user.daily_target ? 'S' : 'F';
      }
      const days = user.last5 ? user.last5.split(',') : [];
      days.push(dayIcon);
      if (days.length > 5) days.shift();
      const newLast5 = days.join(',');
      let newStreak = 0;
      for (let j = days.length - 1; j >= 0; j--) {
        if (days[j] === 'S' || days[j] === 'F') newStreak++;
        else break;
      }
      updateStreak(user.id, newLast5, newStreak);

      const dayDate = DateTime.fromISO(prevBoundary, { zone: 'utc' }).setZone(user.timezone).toISODate();
      saveDayResult(user.id, dayDate!, met, dayIcon === 'S' ? 'standard' : dayIcon === 'F' ? 'noob' : 'manual', todayTotal);

      if (shortfall > 0) {
        updateDebt(user.id, shortfall);
      } else if (met && user.debt > 0) {
        const surplus = todayTotal - user.daily_target;
        if (surplus > 0) {
          updateDebt(user.id, -Math.min(surplus, user.debt));
        }
      }

      const slackConfig = getSlackConfig(user.invite_code);
      if (slackConfig) {
        const formattedDate = DateTime.fromISO(dayDate!).toFormat("MMMM d, yyyy");
        const updatedUser = getUserById(user.id)!;
        postDayResult(slackConfig.slack_bot_token, slackConfig.slack_channel, user.username, formattedDate, todayTotal, user.daily_target, met, newStreak, updatedUser.debt)
          .catch(err => console.error(`Slack post failed for ${user.username}:`, err));
      }

      updateNextDayBoundary(user.id, nextBoundary);
    }

    users = getUsersWithExpiredBoundary(nowUtc);
  }
}
```

Update imports at the top of `src/cron.ts` to include `getResolvedUserById`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cron.test.ts`
Expected: The new alias test passes. All pre-existing cron tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/cron.ts tests/cron.test.ts
git commit -m "feat(alias): cron skips alias rollup and fans out slack

processExpiredBoundaries now sorts sources before aliases, runs the
rollup exactly once per source row, and alias rows only fire their own
org's slack post using resolved source stats.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: One-time link-and-wipe migration

The production migration links `mayo` → `hanson` by username on first boot and deletes mayo's orphaned progress rows. Idempotent: re-running does nothing after the first run.

**Files:**
- Modify: `src/db.ts` (inside `getDb`, after existing migrations)
- Modify: `tests/db.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/db.test.ts`:

```ts
describe("one-time mayo→hanson migration", () => {
  test("links mayo to hanson if both exist", () => {
    // Fresh in-memory db, then create the two users and re-run the migration via linkMayoToHansonIfNeeded.
    createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    const mayo = createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    logPushups(mayo.id, 7, "manual");
    saveDayResult(mayo.id, "2026-04-06", false, "manual", 7);

    linkMayoToHansonIfNeeded();

    const m = getUserById(mayo.id)!;
    const h = getUserByUsername("hanson")!;
    expect(m.source_user_id).toBe(h.id);
    // Mayo's orphaned progress has been wiped
    const hMonth = getMonthResults(h.id, "2026-04");
    expect(hMonth.length).toBe(0);
    // Re-running is a no-op
    linkMayoToHansonIfNeeded();
    expect(getUserById(mayo.id)!.source_user_id).toBe(h.id);
  });

  test("does nothing when hanson does not exist", () => {
    createUser("mayo", "h", "America/New_York", "2026-04-08T11:00:00Z", "FRST");
    linkMayoToHansonIfNeeded();
    expect(getUserByUsername("mayo")!.source_user_id).toBeNull();
  });

  test("does nothing when mayo does not exist", () => {
    createUser("hanson", "h", "America/New_York", "2026-04-08T11:00:00Z", "DEV0");
    linkMayoToHansonIfNeeded();
    expect(getUserByUsername("hanson")!.source_user_id).toBeNull();
  });
});
```

Extend imports in `tests/db.test.ts:2` to include `linkMayoToHansonIfNeeded`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts -t "one-time mayo"`
Expected: FAIL — `linkMayoToHansonIfNeeded` is not exported.

- [ ] **Step 3: Implement the migration**

Append to `src/db.ts`:

```ts
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
    WHERE user_id IN (SELECT id FROM users WHERE username = 'mayo' AND source_user_id IS NOT NULL)
  `);
  db.exec(`
    DELETE FROM day_results
    WHERE user_id IN (SELECT id FROM users WHERE username = 'mayo' AND source_user_id IS NOT NULL)
  `);
}
```

Then wire it into `getDb()` just before the `return db` at the bottom:

```ts
  linkMayoToHansonIfNeeded();
  return db;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: All migration tests pass. Pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat(alias): one-time mayo→hanson link-and-wipe migration

Runs on every getDb() call; links mayo.source_user_id to hanson.id and
deletes mayo's orphaned pushup_logs and day_results. Idempotent: becomes
a no-op on every subsequent boot.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: API-level alias parity tests

Tighten the net: a session-level end-to-end test showing the mayo session returns identical `/api/me` progress and `/api/me/calendar` history as the hanson session, and that pushups logged through mayo's session show up under hanson. No new production code — this is confidence-building.

**Files:**
- Modify: `tests/api.test.ts`

- [ ] **Step 1: Write the tests**

Add to `tests/api.test.ts`:

```ts
describe("alias parity across /api/me*", () => {
  test("/api/me returns identical progress for hanson and mayo sessions", async () => {
    const { token: hTok, user: hanson } = await signup("hanson", "1111", "America/New_York", "DEV0");
    const { token: mTok, user: mayo } = await signup("mayo", "2222", "America/New_York", "FRST");
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
    expect(mBody.username).toBe("mayo");
    expect(hBody.username).toBe("hanson");
    expect(mBody.group_name).toBe("Frist");
    expect(hBody.group_name).toBe("MayoLab");
  });

  test("POST /api/pushups from mayo session increases hanson's total", async () => {
    const { token: hTok, user: hanson } = await signup("hanson", "1111", "America/New_York", "DEV0");
    const { token: mTok, user: mayo } = await signup("mayo", "2222", "America/New_York", "FRST");
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
    const { user: hanson } = await signup("hanson", "1111", "America/New_York", "DEV0");
    const { token: mTok, user: mayo } = await signup("mayo", "2222", "America/New_York", "FRST");
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
```

Make sure `tests/api.test.ts` imports include `linkAlias, updateTarget, updateDebt, logPushups, saveDayResult`.

- [ ] **Step 2: Run the tests**

Run: `bun test tests/api.test.ts -t "alias parity"`
Expected: All three pass on the first try (the production code already handles everything via earlier tasks).

- [ ] **Step 3: Commit**

```bash
git add tests/api.test.ts
git commit -m "test(alias): end-to-end parity across /api/me, pushups, calendar

Asserts a mayo session and a hanson session see identical progress via
/api/me, that POST /api/pushups from mayo increases hanson's total, and
that /api/me/calendar on mayo returns hanson's day_results.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: CLAUDE.md guardrail

Append the alias guardrail section to the project CLAUDE.md so future edits cannot silently reintroduce drift.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append the guardrail section**

Append the following to the end of `/Users/hansonkang/Documents/GitHub/pushtracker/CLAUDE.md`:

```markdown

## User Aliasing (IMPORTANT)

This app has a user-alias mechanism: `users.source_user_id` (nullable, self-ref).
When set, that user is an alias — all progress data and settings live under
the source user. Currently only `mayo` → `hanson` (same person, two orgs).

**Rules for any future DB function that takes a `user_id`:**
- If it reads or writes `pushup_logs`, `day_results`, or any progress/settings
  column on `users` (`debt`, `streak`, `last5`, `daily_target`, `timezone`),
  it MUST call `resolveDataUserId(userId)` first. See existing functions in
  `src/db.ts` for the pattern.
- `getUserById` / `getUserByUsername` / session / auth code are the only
  intentional exceptions — they need the raw alias row.
- `updateNextDayBoundary` stays raw, but MUST NOT be called on alias rows.
  Cron is the only caller and it skips alias rows for boundary advancement.
- `getUsersWithExpiredBoundary` resolves via JOIN on `source_user_id` so an
  alias row is only returned when its source's boundary is expired.
- Cron's day-end rollup MUST skip alias rows for debt/streak/day_results
  updates — only the source row runs the rollup. Alias rows still fire their
  own org's Slack post using the source row's stats.
- API endpoints that return user data should use `getResolvedUserById` /
  `getResolvedTeamByGroup` rather than raw `getUserById` / `getTeamByGroup`,
  so the response reflects the source's progress/settings.
- Never hardcode usernames in application code. The resolver is the authority.

If you're adding a feature that touches per-user data, grep for
`resolveDataUserId` and `getResolvedUserById` to find the existing resolution
points and match them.
```

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: All tests pass across `db.test.ts`, `auth.test.ts`, `api.test.ts`, `cron.test.ts`, `slack.test.ts`, `timezone.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document user-aliasing guardrail in CLAUDE.md

Adds the ## User Aliasing (IMPORTANT) section so any future DB function
touching per-user data is required to route through resolveDataUserId,
preventing accidental drift between mayo and hanson.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite one more time**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 2: Smoke test locally**

Run: `bun run dev`
In a browser:
1. Sign in as hanson → log 5 pushups → observe today_total = 5.
2. Sign in as mayo (second window) → observe today_total = 5 (not 0), same debt/streak/target.
3. Log 3 more pushups as mayo → go back to hanson window → refresh → observe today_total = 8.
4. Open the Frist team view as any Frist user (mayo) → mayo's card shows the same numbers as hanson's card in MayoLab view.
5. Change daily target from mayo's settings → confirm it reflects under hanson.

- [ ] **Step 3: Push**

Run: `git log --oneline -15` to verify the commit chain, then inform the user so they can decide whether to push to origin.
