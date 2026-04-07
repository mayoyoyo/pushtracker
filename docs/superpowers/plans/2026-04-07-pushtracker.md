# PushTracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile-first pushup tracker with AI-powered camera counting via MediaPipe, user auth, debt tracking, and team visibility.

**Architecture:** Bun server with TypeScript serves a vanilla JS SPA. MediaPipe PoseLandmarker runs client-side for pushup detection. SQLite on Fly.io persistent volume stores users, sessions, and pushup logs. A 15-minute cron calculates debt at each user's timezone-aware day boundary.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), Luxon (timezone), MediaPipe PoseLandmarker (CDN), vanilla JS, mobile-first CSS, Fly.io

---

## File Structure

```
pushtracker/
├── package.json
├── tsconfig.json
├── fly.toml
├── Dockerfile
├── .gitignore
├── src/
│   ├── server.ts          # Bun.serve() entry, routing, static files
│   ├── db.ts              # SQLite schema + typed query wrappers
│   ├── auth.ts            # Signup, login, logout, session cookie mgmt
│   ├── api.ts             # Pushup logging, team, settings endpoints
│   ├── timezone.ts        # Next-7am-boundary calc using Luxon
│   └── cron.ts            # 15-min interval: debt calc + boundary advance
├── public/
│   ├── index.html         # SPA shell (loads app.js, pose.js, styles.css)
│   ├── app.js             # Client: screens, routing, state, API calls
│   ├── pose.js            # Client: MediaPipe + pushup counting state machine
│   └── styles.css         # Mobile-first styles
└── tests/
    ├── db.test.ts
    ├── auth.test.ts
    ├── api.test.ts
    ├── timezone.test.ts
    └── cron.test.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/server.ts`
- Create: `public/index.html`

- [ ] **Step 1: Initialize project**

```bash
cd /Users/hansonkang/Documents/GitHub/pushtracker
bun init -y
```

- [ ] **Step 2: Install dependencies**

```bash
bun add luxon
bun add -d @types/luxon
```

- [ ] **Step 3: Update package.json**

Replace the generated `package.json` with:

```json
{
  "name": "pushtracker",
  "version": "0.1.0",
  "scripts": {
    "dev": "bun run --watch src/server.ts",
    "start": "bun run src/server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "luxon": "^3.6.0"
  },
  "devDependencies": {
    "@types/luxon": "^3.4.0"
  }
}
```

- [ ] **Step 4: Update tsconfig.json**

Replace the generated `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 5: Write .gitignore**

```
node_modules/
dist/
*.db
.superpowers/
```

- [ ] **Step 6: Write minimal server**

Create `src/server.ts`:

```typescript
import { join } from "path";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PORT = parseInt(process.env.PORT || "3000");

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes will go here
    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // Static files
    const filePath = join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback
    return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
  },
});

console.log(`PushTracker running on http://localhost:${server.port}`);
```

- [ ] **Step 7: Write placeholder index.html**

Create `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>PushTracker</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app"></div>
  <script src="/app.js"></script>
</body>
</html>
```

Create `public/styles.css` (empty for now):

```css
/* Mobile-first styles */
```

Create `public/app.js` (empty for now):

```javascript
// PushTracker client
```

- [ ] **Step 8: Verify server starts**

Run: `bun run dev`
Expected: `PushTracker running on http://localhost:3000`
Visit `http://localhost:3000` — should serve the empty HTML page.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json .gitignore src/server.ts public/index.html public/styles.css public/app.js bun.lockb
git commit -m "feat: project scaffolding with Bun server and static file serving"
```

---

### Task 2: Database Layer

**Files:**
- Create: `src/db.ts`
- Create: `tests/db.test.ts`

- [ ] **Step 1: Write failing database tests**

Create `tests/db.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, createUser, getUserByUsername, getUserById, logPushups, getTodayLogs, getTeamToday, updateTarget, updateDebt } from "../src/db";

describe("database", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  describe("createUser", () => {
    test("creates a user and returns it", () => {
      const user = createUser("hanson", "hashedpass", "America/New_York", "2026-04-08T11:00:00Z");
      expect(user.id).toBe(1);
      expect(user.username).toBe("hanson");
      expect(user.daily_target).toBe(0);
      expect(user.debt).toBe(0);
      expect(user.timezone).toBe("America/New_York");
    });

    test("rejects duplicate username", () => {
      createUser("hanson", "hash1", "America/New_York", "2026-04-08T11:00:00Z");
      expect(() => createUser("hanson", "hash2", "America/New_York", "2026-04-08T11:00:00Z")).toThrow();
    });
  });

  describe("getUserByUsername", () => {
    test("returns user by username", () => {
      createUser("hanson", "hashedpass", "America/New_York", "2026-04-08T11:00:00Z");
      const user = getUserByUsername("hanson");
      expect(user).not.toBeNull();
      expect(user!.username).toBe("hanson");
    });

    test("returns null for unknown username", () => {
      expect(getUserByUsername("nobody")).toBeNull();
    });
  });

  describe("logPushups", () => {
    test("logs pushups for a user", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      const log = logPushups(user.id, 25, "camera");
      expect(log.count).toBe(25);
      expect(log.source).toBe("camera");
    });
  });

  describe("getTodayLogs", () => {
    test("returns logs between day boundaries", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      // Boundary is 2026-04-08T11:00:00Z, so "today" started at previous boundary
      // Previous boundary = 2026-04-07T11:00:00Z
      logPushups(user.id, 25, "camera", "2026-04-07T12:00:00Z");
      logPushups(user.id, 10, "manual", "2026-04-07T20:00:00Z");
      // This one is outside the current day (before previous boundary)
      logPushups(user.id, 50, "camera", "2026-04-07T05:00:00Z");

      const logs = getTodayLogs(user.id, "2026-04-07T11:00:00Z", "2026-04-08T11:00:00Z");
      expect(logs.length).toBe(2);
      expect(logs.reduce((sum, l) => sum + l.count, 0)).toBe(35);
    });
  });

  describe("getTeamToday", () => {
    test("returns all users with their today totals", () => {
      const u1 = createUser("hanson", "h1", "America/New_York", "2026-04-08T11:00:00Z");
      const u2 = createUser("jake", "h2", "America/New_York", "2026-04-08T11:00:00Z");
      updateTarget(u1.id, 50);
      updateTarget(u2.id, 75);
      logPushups(u1.id, 32, "camera", "2026-04-07T14:00:00Z");
      logPushups(u2.id, 75, "camera", "2026-04-07T14:00:00Z");

      const team = getTeamToday();
      expect(team.length).toBe(2);
    });
  });

  describe("updateTarget", () => {
    test("updates daily target", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      updateTarget(user.id, 50);
      const updated = getUserById(user.id);
      expect(updated!.daily_target).toBe(50);
    });
  });

  describe("updateDebt", () => {
    test("adds to debt", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      updateDebt(user.id, 15);
      const updated = getUserById(user.id);
      expect(updated!.debt).toBe(15);
    });

    test("reduces debt (never below 0)", () => {
      const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00Z");
      updateDebt(user.id, 20);
      updateDebt(user.id, -25);
      const updated = getUserById(user.id);
      expect(updated!.debt).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/db.test.ts`
Expected: FAIL — module `../src/db` not found

- [ ] **Step 3: Implement database layer**

Create `src/db.ts`:

```typescript
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
      logged_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    );
  `);
  return db;
}

export interface User {
  id: number;
  username: string;
  passcode: string;
  daily_target: number;
  debt: number;
  timezone: string;
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

export function createUser(username: string, passcode: string, timezone: string, nextDayBoundary: string): User {
  const stmt = db.prepare(
    "INSERT INTO users (username, passcode, timezone, next_day_boundary) VALUES (?, ?, ?, ?) RETURNING *"
  );
  return stmt.get(username, passcode, timezone, nextDayBoundary) as User;
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

export function getTeamToday(): User[] {
  return db.prepare("SELECT * FROM users ORDER BY username").all() as User[];
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/db.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: database layer with SQLite schema and query wrappers"
```

---

### Task 3: Timezone Utilities

**Files:**
- Create: `src/timezone.ts`
- Create: `tests/timezone.test.ts`

- [ ] **Step 1: Write failing timezone tests**

Create `tests/timezone.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { getNextDayBoundary, getPreviousDayBoundary, advanceBoundary } from "../src/timezone";

describe("timezone", () => {
  describe("getNextDayBoundary", () => {
    test("returns next 7am in given timezone as UTC ISO string", () => {
      // 2026-04-07 at noon in New York (EDT, UTC-4) → next 7am is 2026-04-08 07:00 EDT = 11:00 UTC
      const boundary = getNextDayBoundary("America/New_York", "2026-04-07T16:00:00Z");
      expect(boundary).toBe("2026-04-08T11:00:00.000Z");
    });

    test("if it is before 7am local, returns 7am today", () => {
      // 2026-04-07 at 5am EDT (09:00 UTC) → next 7am is today 07:00 EDT = 11:00 UTC
      const boundary = getNextDayBoundary("America/New_York", "2026-04-07T09:00:00Z");
      expect(boundary).toBe("2026-04-07T11:00:00.000Z");
    });

    test("handles Asia/Seoul (UTC+9)", () => {
      // 2026-04-07 at 10am KST (01:00 UTC) → next 7am is 2026-04-08 07:00 KST = 2026-04-07T22:00 UTC
      const boundary = getNextDayBoundary("Asia/Seoul", "2026-04-07T01:00:00Z");
      expect(boundary).toBe("2026-04-07T22:00:00.000Z");
    });

    test("handles DST transition (spring forward)", () => {
      // US spring forward 2026: March 8. Clocks jump 2am→3am EST→EDT.
      // 2026-03-08 at noon EDT (UTC-4, 16:00 UTC) → next 7am is 2026-03-09 07:00 EDT = 11:00 UTC
      const boundary = getNextDayBoundary("America/New_York", "2026-03-08T16:00:00Z");
      expect(boundary).toBe("2026-03-09T11:00:00.000Z");
    });
  });

  describe("getPreviousDayBoundary", () => {
    test("returns the 7am before the given boundary", () => {
      // next boundary is 2026-04-08T11:00:00Z (7am EDT), previous is 2026-04-07T11:00:00Z
      const prev = getPreviousDayBoundary("America/New_York", "2026-04-08T11:00:00.000Z");
      expect(prev).toBe("2026-04-07T11:00:00.000Z");
    });
  });

  describe("advanceBoundary", () => {
    test("advances to the next 7am from current boundary", () => {
      const next = advanceBoundary("America/New_York", "2026-04-07T11:00:00.000Z");
      expect(next).toBe("2026-04-08T11:00:00.000Z");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/timezone.test.ts`
Expected: FAIL — module `../src/timezone` not found

- [ ] **Step 3: Implement timezone utilities**

Create `src/timezone.ts`:

```typescript
import { DateTime } from "luxon";

const DAY_RESET_HOUR = 7;

export function getNextDayBoundary(timezone: string, nowUtc: string): string {
  const now = DateTime.fromISO(nowUtc, { zone: "utc" }).setZone(timezone);
  let boundary = now.set({ hour: DAY_RESET_HOUR, minute: 0, second: 0, millisecond: 0 });
  if (boundary <= now) {
    boundary = boundary.plus({ days: 1 });
  }
  return boundary.toUTC().toISO()!;
}

export function getPreviousDayBoundary(timezone: string, nextBoundaryUtc: string): string {
  const next = DateTime.fromISO(nextBoundaryUtc, { zone: "utc" }).setZone(timezone);
  const prev = next.minus({ days: 1 });
  return prev.toUTC().toISO()!;
}

export function advanceBoundary(timezone: string, currentBoundaryUtc: string): string {
  const current = DateTime.fromISO(currentBoundaryUtc, { zone: "utc" }).setZone(timezone);
  const next = current.plus({ days: 1 });
  return next.toUTC().toISO()!;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/timezone.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/timezone.ts tests/timezone.test.ts
git commit -m "feat: timezone utilities for day boundary calculation"
```

---

### Task 4: Authentication

**Files:**
- Create: `src/auth.ts`
- Create: `tests/auth.test.ts`

- [ ] **Step 1: Write failing auth tests**

Create `tests/auth.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { getDb } from "../src/db";
import { signup, login, getSessionUser, logout } from "../src/auth";

describe("auth", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  describe("signup", () => {
    test("creates user with hashed passcode and returns session token", async () => {
      const result = await signup("hanson", "1234", "America/New_York");
      expect(result.user.username).toBe("hanson");
      expect(result.token).toBeTruthy();
      expect(result.user.passcode).not.toBe("1234"); // should be hashed
    });

    test("rejects duplicate username", async () => {
      await signup("hanson", "1234", "America/New_York");
      expect(signup("hanson", "5678", "America/New_York")).rejects.toThrow();
    });

    test("rejects non-4-digit passcode", async () => {
      expect(signup("hanson", "12", "America/New_York")).rejects.toThrow();
      expect(signup("hanson", "abcd", "America/New_York")).rejects.toThrow();
      expect(signup("hanson", "12345", "America/New_York")).rejects.toThrow();
    });
  });

  describe("login", () => {
    test("returns session token for valid credentials", async () => {
      await signup("hanson", "1234", "America/New_York");
      const result = await login("hanson", "1234");
      expect(result.token).toBeTruthy();
      expect(result.user.username).toBe("hanson");
    });

    test("rejects wrong passcode", async () => {
      await signup("hanson", "1234", "America/New_York");
      expect(login("hanson", "9999")).rejects.toThrow();
    });

    test("rejects unknown username", async () => {
      expect(login("nobody", "1234")).rejects.toThrow();
    });
  });

  describe("getSessionUser", () => {
    test("returns user for valid token", async () => {
      const { token } = await signup("hanson", "1234", "America/New_York");
      const user = getSessionUser(token);
      expect(user).not.toBeNull();
      expect(user!.username).toBe("hanson");
    });

    test("returns null for invalid token", () => {
      expect(getSessionUser("invalid-token")).toBeNull();
    });
  });

  describe("logout", () => {
    test("invalidates session token", async () => {
      const { token } = await signup("hanson", "1234", "America/New_York");
      logout(token);
      expect(getSessionUser(token)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/auth.test.ts`
Expected: FAIL — module `../src/auth` not found

- [ ] **Step 3: Implement auth module**

Create `src/auth.ts`:

```typescript
import { createUser, getUserByUsername, getUserById, createSession, getSession, deleteSession, type User } from "./db";
import { getNextDayBoundary } from "./timezone";

export async function signup(username: string, passcode: string, timezone: string): Promise<{ user: User; token: string }> {
  if (!/^\d{4}$/.test(passcode)) {
    throw new Error("Passcode must be exactly 4 digits");
  }
  const hashedPasscode = await Bun.password.hash(passcode);
  const nowUtc = new Date().toISOString();
  const nextBoundary = getNextDayBoundary(timezone, nowUtc);
  const user = createUser(username, hashedPasscode, timezone, nextBoundary);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  createSession(token, user.id, expiresAt);
  return { user, token };
}

export async function login(username: string, passcode: string): Promise<{ user: User; token: string }> {
  const user = getUserByUsername(username);
  if (!user) throw new Error("Invalid username or passcode");
  const valid = await Bun.password.verify(passcode, user.passcode);
  if (!valid) throw new Error("Invalid username or passcode");
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  createSession(token, user.id, expiresAt);
  return { user, token };
}

export function getSessionUser(token: string): User | null {
  const session = getSession(token);
  if (!session) return null;
  return getUserById(session.user_id);
}

export function logout(token: string): void {
  deleteSession(token);
}

function generateToken(): string {
  return crypto.randomUUID();
}

export function parseSessionToken(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

export function sessionCookie(token: string): string {
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
  return `session=${token}; HttpOnly; SameSite=Strict; Path=/; Expires=${expires}`;
}

export function clearSessionCookie(): string {
  return "session=; HttpOnly; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/auth.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts tests/auth.test.ts
git commit -m "feat: authentication with signup, login, sessions"
```

---

### Task 5: API Routes

**Files:**
- Create: `src/api.ts`
- Create: `tests/api.test.ts`
- Modify: `src/server.ts` (wire up API routes)

- [ ] **Step 1: Write failing API tests**

Create `tests/api.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { getDb } from "../src/db";
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
    const result = await signup("hanson", "1234", "America/New_York");
    token = result.token;
  });

  describe("POST /api/auth/signup", () => {
    test("creates new user", async () => {
      const res = await handleApiRequest(new Request("http://localhost/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "jake", passcode: "5678", timezone: "America/Chicago" }),
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
      expect(data.daily_target).toBe(0);
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
      await signup("jake", "5678", "America/Chicago");
      const res = await authedRequest("GET", "/api/team/today", token);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/api.test.ts`
Expected: FAIL — module `../src/api` not found

- [ ] **Step 3: Implement API routes**

Create `src/api.ts`:

```typescript
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
```

- [ ] **Step 4: Wire API into server**

Update `src/server.ts` to:

```typescript
import { join } from "path";
import { getDb } from "./db";
import { handleApiRequest } from "./api";
import { startCron } from "./cron";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PORT = parseInt(process.env.PORT || "3000");
const DB_PATH = process.env.DB_PATH || "pushtracker.db";

// Initialize database
getDb(DB_PATH);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(req);
    }

    // Static files
    const filePath = join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback
    return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
  },
});

// Start cron job (implemented in Task 6)
// startCron();

console.log(`PushTracker running on http://localhost:${server.port}`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/api.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All tests across db, auth, api, timezone PASS

- [ ] **Step 7: Commit**

```bash
git add src/api.ts src/server.ts tests/api.test.ts
git commit -m "feat: API routes for auth, pushups, team, settings"
```

---

### Task 6: Day Boundary Cron Job

**Files:**
- Create: `src/cron.ts`
- Create: `tests/cron.test.ts`
- Modify: `src/server.ts` (uncomment startCron)

- [ ] **Step 1: Write failing cron tests**

Create `tests/cron.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { getDb, createUser, getUserById, logPushups, updateTarget } from "../src/db";
import { processExpiredBoundaries } from "../src/cron";

describe("cron", () => {
  beforeEach(() => {
    getDb(":memory:");
  });

  test("adds debt when user misses target", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-07T11:00:00.000Z");
    updateTarget(user.id, 50);
    // Log only 30 pushups during the day
    logPushups(user.id, 30, "camera", "2026-04-06T14:00:00Z");

    // Process at a time after the boundary
    processExpiredBoundaries("2026-04-07T12:00:00Z");

    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(20); // missed 20
    // Boundary should be advanced to next day
    expect(updated.next_day_boundary).toBe("2026-04-08T11:00:00.000Z");
  });

  test("no debt when user meets target", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-07T11:00:00.000Z");
    updateTarget(user.id, 50);
    logPushups(user.id, 60, "camera", "2026-04-06T14:00:00Z");

    processExpiredBoundaries("2026-04-07T12:00:00Z");

    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
  });

  test("skips users whose boundary has not expired", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-08T11:00:00.000Z");
    updateTarget(user.id, 50);

    // Process at a time before the boundary
    processExpiredBoundaries("2026-04-07T12:00:00Z");

    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
    expect(updated.next_day_boundary).toBe("2026-04-08T11:00:00.000Z"); // unchanged
  });

  test("handles multiple expired boundaries (user offline for days)", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-05T11:00:00.000Z");
    updateTarget(user.id, 50);
    // No pushups logged at all. 3 days have passed.

    processExpiredBoundaries("2026-04-08T12:00:00Z");

    const updated = getUserById(user.id)!;
    // Should have debt for 3 missed days = 150
    expect(updated.debt).toBe(150);
    // Boundary should be advanced past "now"
    expect(updated.next_day_boundary).toBe("2026-04-09T11:00:00.000Z");
  });

  test("no debt when target is 0", () => {
    const user = createUser("hanson", "hash", "America/New_York", "2026-04-07T11:00:00.000Z");
    // target defaults to 0, no pushups logged

    processExpiredBoundaries("2026-04-07T12:00:00Z");

    const updated = getUserById(user.id)!;
    expect(updated.debt).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cron.test.ts`
Expected: FAIL — module `../src/cron` not found

- [ ] **Step 3: Implement cron module**

Create `src/cron.ts`:

```typescript
import { getUsersWithExpiredBoundary, getTodayTotal, updateDebt, updateNextDayBoundary } from "./db";
import { advanceBoundary, getPreviousDayBoundary } from "./timezone";

const CRON_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function processExpiredBoundaries(nowUtc: string): void {
  let users = getUsersWithExpiredBoundary(nowUtc);

  while (users.length > 0) {
    for (const user of users) {
      const prevBoundary = getPreviousDayBoundary(user.timezone, user.next_day_boundary);
      const todayTotal = getTodayTotal(user.id, prevBoundary, user.next_day_boundary);
      const shortfall = user.daily_target - todayTotal;

      if (shortfall > 0) {
        updateDebt(user.id, shortfall);
      }

      const nextBoundary = advanceBoundary(user.timezone, user.next_day_boundary);
      updateNextDayBoundary(user.id, nextBoundary);
    }

    // Re-check in case multiple days have passed (user offline)
    users = getUsersWithExpiredBoundary(nowUtc);
  }
}

export function startCron(): void {
  console.log("Day boundary cron started (every 15 minutes)");
  setInterval(() => {
    const now = new Date().toISOString();
    processExpiredBoundaries(now);
  }, CRON_INTERVAL_MS);

  // Run once on startup
  processExpiredBoundaries(new Date().toISOString());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cron.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Wire cron into server**

In `src/server.ts`, uncomment the `startCron()` call:

```typescript
// Change this:
// startCron();

// To this:
startCron();
```

And add the import at the top:

```typescript
import { startCron } from "./cron";
```

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: All tests PASS across all test files

- [ ] **Step 7: Commit**

```bash
git add src/cron.ts tests/cron.test.ts src/server.ts
git commit -m "feat: day boundary cron job for debt calculation"
```

---

### Task 7: Client — App Shell, Styles, and Auth Screens

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`

- [ ] **Step 1: Write the HTML shell**

Update `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>PushTracker</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app"></div>
  <div id="toast" class="toast hidden"></div>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write mobile-first CSS**

Update `public/styles.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --bg: #0f0f1a;
  --surface: #1a1a2e;
  --surface-2: #2d3748;
  --text: #e2e8f0;
  --text-dim: #718096;
  --primary: #3182ce;
  --success: #48bb78;
  --warning: #ecc94b;
  --danger: #fc8181;
  --radius: 10px;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100dvh;
  -webkit-tap-highlight-color: transparent;
}

#app {
  max-width: 420px;
  margin: 0 auto;
  padding: 20px 16px;
  min-height: 100dvh;
}

/* --- Auth Screen --- */
.auth-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 80dvh;
  gap: 24px;
}

.auth-screen .logo {
  font-size: 28px;
  font-weight: bold;
  text-align: center;
}

.auth-screen .subtitle {
  font-size: 13px;
  color: var(--text-dim);
  margin-top: -16px;
}

.auth-form {
  width: 100%;
  max-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.input-group label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 6px;
  letter-spacing: 0.5px;
}

.input-group input {
  width: 100%;
  padding: 12px 14px;
  background: var(--surface-2);
  border: none;
  border-radius: var(--radius);
  color: var(--text);
  font-size: 16px;
  outline: none;
}

.input-group input:focus {
  box-shadow: 0 0 0 2px var(--primary);
}

.passcode-boxes {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.passcode-boxes input {
  width: 48px;
  height: 52px;
  text-align: center;
  font-size: 22px;
  background: var(--surface-2);
  border: none;
  border-radius: var(--radius);
  color: var(--text);
  outline: none;
  -moz-appearance: textfield;
}

.passcode-boxes input::-webkit-outer-spin-button,
.passcode-boxes input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.passcode-boxes input:focus {
  box-shadow: 0 0 0 2px var(--primary);
}

.btn {
  padding: 14px;
  border: none;
  border-radius: var(--radius);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  transition: opacity 0.15s;
}

.btn:active { opacity: 0.8; }

.btn-primary {
  background: var(--primary);
  color: white;
}

.btn-danger {
  background: var(--danger);
  color: #1a1a2e;
}

.btn-surface {
  background: var(--surface-2);
  color: var(--text);
}

.auth-toggle {
  font-size: 13px;
  color: var(--text-dim);
  text-align: center;
}

.auth-toggle a {
  color: var(--primary);
  cursor: pointer;
  text-decoration: none;
}

.error-msg {
  color: var(--danger);
  font-size: 13px;
  text-align: center;
  min-height: 20px;
}

/* --- Dashboard --- */
.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.greeting-sub {
  font-size: 13px;
  color: var(--text-dim);
}

.greeting-name {
  font-size: 20px;
  font-weight: bold;
}

.settings-btn {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 18px;
  cursor: pointer;
  padding: 8px;
}

.progress-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 20px;
  text-align: center;
  margin-bottom: 12px;
}

.progress-label {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 8px;
}

.progress-count {
  font-size: 42px;
  font-weight: bold;
  line-height: 1;
}

.progress-target {
  font-size: 18px;
  color: var(--text-dim);
}

.progress-bar {
  background: var(--surface-2);
  border-radius: 4px;
  height: 6px;
  margin-top: 12px;
  overflow: hidden;
}

.progress-fill {
  background: var(--success);
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}

.debt-card {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 14px 18px;
  margin-bottom: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.debt-count {
  font-size: 24px;
  font-weight: bold;
  color: var(--danger);
}

.debt-label {
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
}

.action-buttons {
  display: flex;
  gap: 10px;
}

.action-btn {
  flex: 1;
  background: var(--surface);
  border: none;
  border-radius: var(--radius);
  padding: 16px 8px;
  text-align: center;
  cursor: pointer;
  color: var(--text);
  transition: background 0.15s;
}

.action-btn:active { background: var(--surface-2); }

.action-btn.primary { background: var(--primary); }

.action-btn .icon { font-size: 22px; display: block; margin-bottom: 4px; }
.action-btn .label { font-size: 12px; }

/* --- Camera Session --- */
.camera-screen {
  position: fixed;
  inset: 0;
  background: #000;
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.camera-feed {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.camera-feed video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.camera-feed canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.tracking-badge {
  position: absolute;
  top: 12px;
  right: 12px;
  background: var(--success);
  color: #000;
  font-size: 10px;
  font-weight: bold;
  padding: 3px 8px;
  border-radius: 4px;
  text-transform: uppercase;
}

.camera-counter {
  text-align: center;
  padding: 16px;
  background: rgba(0,0,0,0.8);
}

.camera-counter .count {
  font-size: 64px;
  font-weight: 900;
  letter-spacing: -2px;
  line-height: 1;
}

.camera-counter .count-label {
  font-size: 13px;
  color: var(--text-dim);
  margin-top: 2px;
}

.camera-controls {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: rgba(0,0,0,0.8);
}

.camera-controls .btn { flex: 1; }
.camera-controls .btn-flip {
  flex: 0 0 48px;
  font-size: 18px;
  background: var(--surface-2);
  color: var(--text);
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
}

/* --- Manual Entry --- */
.manual-entry {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.manual-card {
  background: var(--surface);
  border-radius: 16px;
  padding: 24px;
  width: 280px;
  text-align: center;
}

.manual-card h3 { margin-bottom: 16px; }

.stepper {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
  margin-bottom: 20px;
}

.stepper button {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: var(--surface-2);
  color: var(--text);
  font-size: 22px;
  cursor: pointer;
}

.stepper .value {
  font-size: 36px;
  font-weight: bold;
  min-width: 60px;
}

/* --- Team View --- */
.team-screen { padding-top: 8px; }

.team-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.team-header h2 { font-size: 18px; }

.back-btn {
  background: none;
  border: none;
  color: var(--primary);
  font-size: 14px;
  cursor: pointer;
}

.team-member {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.member-name { font-size: 14px; font-weight: 600; }
.member-target { font-size: 12px; color: var(--text-dim); }
.member-debt { font-size: 12px; color: var(--danger); }

.member-progress {
  font-size: 16px;
  font-weight: bold;
}

.member-progress.complete { color: var(--success); }
.member-progress.in-progress { color: var(--warning); }
.member-progress.not-started { color: var(--danger); }

/* --- Settings --- */
.settings-panel {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.7);
  z-index: 100;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.settings-card {
  background: var(--surface);
  border-radius: 16px 16px 0 0;
  padding: 24px;
  width: 100%;
  max-width: 420px;
}

.settings-card h3 { margin-bottom: 16px; }

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--surface-2);
}

.setting-row:last-child { border-bottom: none; }
.setting-label { font-size: 14px; }

.setting-value input {
  width: 70px;
  padding: 8px;
  background: var(--surface-2);
  border: none;
  border-radius: 6px;
  color: var(--text);
  font-size: 16px;
  text-align: center;
  outline: none;
}

/* --- Toast --- */
.toast {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface);
  color: var(--text);
  padding: 12px 20px;
  border-radius: var(--radius);
  font-size: 14px;
  z-index: 200;
  transition: opacity 0.3s;
  box-shadow: 0 4px 20px rgba(0,0,0,0.5);
}

.toast.hidden { opacity: 0; pointer-events: none; }

/* --- Utilities --- */
.hidden { display: none !important; }
```

- [ ] **Step 3: Write client app.js — auth screens and routing**

Update `public/app.js`:

```javascript
const API = '';
let currentUser = null;
let currentScreen = 'loading';

// --- API helpers ---
async function api(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' }, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), duration);
}

// --- Screen router ---
function showScreen(name, data) {
  currentScreen = name;
  const app = document.getElementById('app');
  switch (name) {
    case 'auth': renderAuth(app); break;
    case 'dashboard': renderDashboard(app, data); break;
    case 'camera': renderCamera(app); break;
    case 'team': renderTeam(app); break;
    default: app.innerHTML = '<p>Loading...</p>';
  }
}

// --- Auth screen ---
function renderAuth(app) {
  let mode = 'login';

  function render() {
    app.innerHTML = `
      <div class="auth-screen">
        <div class="logo">PushTracker</div>
        <div class="subtitle">Hold each other accountable</div>
        <form class="auth-form" id="auth-form">
          <div class="input-group">
            <label>Username</label>
            <input type="text" id="auth-username" autocomplete="username" autocapitalize="none" required>
          </div>
          <div class="input-group">
            <label>4-Digit Passcode</label>
            <div class="passcode-boxes">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="0">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="1">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="2">
              <input type="number" inputmode="numeric" maxlength="1" class="pin" data-idx="3">
            </div>
          </div>
          <div class="error-msg" id="auth-error"></div>
          <button type="submit" class="btn btn-primary">${mode === 'login' ? 'Log In' : 'Sign Up'}</button>
        </form>
        <div class="auth-toggle">
          ${mode === 'login'
            ? 'New here? <a id="toggle-auth">Sign up</a>'
            : 'Have an account? <a id="toggle-auth">Log in</a>'}
        </div>
      </div>
    `;

    // Pin box auto-advance
    const pins = app.querySelectorAll('.pin');
    pins.forEach((pin, i) => {
      pin.addEventListener('input', () => {
        pin.value = pin.value.slice(-1);
        if (pin.value && i < 3) pins[i + 1].focus();
      });
      pin.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !pin.value && i > 0) pins[i - 1].focus();
      });
    });

    app.querySelector('#toggle-auth').addEventListener('click', () => {
      mode = mode === 'login' ? 'signup' : 'login';
      render();
    });

    app.querySelector('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = app.querySelector('#auth-username').value.trim();
      const passcode = Array.from(pins).map(p => p.value).join('');
      const errEl = app.querySelector('#auth-error');

      if (passcode.length !== 4) {
        errEl.textContent = 'Enter a 4-digit passcode';
        return;
      }

      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (mode === 'signup') {
          const data = await api('POST', '/api/auth/signup', { username, passcode, timezone: tz });
          currentUser = data.user;
        } else {
          const data = await api('POST', '/api/auth/login', { username, passcode });
          currentUser = data.user;
        }
        // Check timezone change
        await checkTimezone();
        await loadDashboard();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  }

  render();
}

// --- Timezone check ---
async function checkTimezone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (currentUser && currentUser.timezone !== tz) {
    const res = await api('PUT', '/api/me/timezone', { timezone: tz });
    if (res.changed) {
      currentUser.timezone = tz;
      showToast('We noticed you changed time zones — your daily reset has been updated.');
    }
  }
}

// --- Dashboard ---
async function loadDashboard() {
  const data = await api('GET', '/api/me');
  currentUser = { ...currentUser, ...data };
  showScreen('dashboard', data);
}

function renderDashboard(app, data) {
  const pct = data.daily_target > 0 ? Math.min(100, (data.today_total / data.daily_target) * 100) : 0;

  app.innerHTML = `
    <div class="dashboard-header">
      <div>
        <div class="greeting-sub">Hey,</div>
        <div class="greeting-name">${data.username}</div>
      </div>
      <button class="settings-btn" id="settings-btn">&#9881;</button>
    </div>

    <div class="progress-card">
      <div class="progress-label">Today</div>
      <div class="progress-count">${data.today_total} <span class="progress-target">/ ${data.daily_target}</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>

    ${data.debt > 0 ? `
    <div class="debt-card">
      <div><div style="font-size:11px;text-transform:uppercase;color:var(--text-dim)">Debt</div><div class="debt-count">${data.debt}</div></div>
      <div class="debt-label">pushups<br>owed</div>
    </div>` : ''}

    <div class="action-buttons">
      <button class="action-btn primary" id="btn-camera">
        <span class="icon">&#128247;</span><span class="label">Camera</span>
      </button>
      <button class="action-btn" id="btn-manual">
        <span class="icon">&#9998;</span><span class="label">Manual</span>
      </button>
      <button class="action-btn" id="btn-team">
        <span class="icon">&#128101;</span><span class="label">Team</span>
      </button>
    </div>
  `;

  app.querySelector('#btn-camera').addEventListener('click', () => showScreen('camera'));
  app.querySelector('#btn-manual').addEventListener('click', () => showManualEntry());
  app.querySelector('#btn-team').addEventListener('click', () => showScreen('team'));
  app.querySelector('#settings-btn').addEventListener('click', () => showSettings());
}

// --- Manual Entry ---
function showManualEntry() {
  let count = 10;
  const overlay = document.createElement('div');
  overlay.className = 'manual-entry';
  overlay.innerHTML = `
    <div class="manual-card">
      <h3>Log Pushups</h3>
      <div class="stepper">
        <button id="step-down">-</button>
        <div class="value" id="step-val">${count}</div>
        <button id="step-up">+</button>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-bottom:10px" id="step-save">Save</button>
      <button class="btn btn-surface" style="width:100%" id="step-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const valEl = overlay.querySelector('#step-val');
  overlay.querySelector('#step-down').addEventListener('click', () => { count = Math.max(1, count - 5); valEl.textContent = count; });
  overlay.querySelector('#step-up').addEventListener('click', () => { count += 5; valEl.textContent = count; });
  overlay.querySelector('#step-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#step-save').addEventListener('click', async () => {
    await api('POST', '/api/pushups', { count, source: 'manual' });
    overlay.remove();
    showToast(`Logged ${count} pushups`);
    await loadDashboard();
  });
}

// --- Settings ---
function showSettings() {
  const overlay = document.createElement('div');
  overlay.className = 'settings-panel';
  overlay.innerHTML = `
    <div class="settings-card">
      <h3>Settings</h3>
      <div class="setting-row">
        <span class="setting-label">Daily Target</span>
        <div class="setting-value"><input type="number" id="set-target" value="${currentUser.daily_target}" inputmode="numeric"></div>
      </div>
      <div class="setting-row">
        <span class="setting-label">Timezone</span>
        <span style="font-size:13px;color:var(--text-dim)">${currentUser.timezone}</span>
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:16px;margin-bottom:10px" id="set-save">Save</button>
      <button class="btn btn-danger" style="width:100%;margin-bottom:10px" id="set-logout">Log Out</button>
      <button class="btn btn-surface" style="width:100%" id="set-close">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#set-save').addEventListener('click', async () => {
    const target = parseInt(overlay.querySelector('#set-target').value) || 0;
    await api('PUT', '/api/me/target', { target });
    currentUser.daily_target = target;
    overlay.remove();
    showToast('Target updated');
    await loadDashboard();
  });
  overlay.querySelector('#set-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    currentUser = null;
    overlay.remove();
    showScreen('auth');
  });
  overlay.querySelector('#set-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// --- Team View ---
async function renderTeam(app) {
  const team = await api('GET', '/api/team/today');

  // Sort: incomplete first, then complete
  team.sort((a, b) => {
    const aDone = a.daily_target > 0 && a.today_total >= a.daily_target;
    const bDone = b.daily_target > 0 && b.today_total >= b.daily_target;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return a.username.localeCompare(b.username);
  });

  app.innerHTML = `
    <div class="team-screen">
      <div class="team-header">
        <h2>Team</h2>
        <button class="back-btn" id="back-dash">&larr; Back</button>
      </div>
      ${team.map(m => {
        let statusClass = 'not-started';
        let display = `${m.today_total} / ${m.daily_target}`;
        if (m.daily_target > 0 && m.today_total >= m.daily_target) {
          statusClass = 'complete';
          display = `${m.today_total} &#10004;`;
        } else if (m.today_total > 0) {
          statusClass = 'in-progress';
        }
        return `
          <div class="team-member">
            <div>
              <div class="member-name">${m.username}</div>
              <div class="member-target">Target: ${m.daily_target}</div>
              ${m.debt > 0 ? `<div class="member-debt">Debt: ${m.debt}</div>` : ''}
            </div>
            <div class="member-progress ${statusClass}">${display}</div>
          </div>`;
      }).join('')}
    </div>
  `;

  app.querySelector('#back-dash').addEventListener('click', () => loadDashboard());
}

// --- Camera Screen (placeholder, implemented in Task 8) ---
function renderCamera(app) {
  app.innerHTML = '<p>Camera screen - implemented in next task</p>';
}

// --- Init ---
async function init() {
  try {
    const data = await api('GET', '/api/me');
    currentUser = data;
    await checkTimezone();
    showScreen('dashboard', data);
  } catch {
    showScreen('auth');
  }
}

init();
```

- [ ] **Step 4: Verify manually**

Run: `bun run dev`
Open `http://localhost:3000` on desktop and mobile (or DevTools mobile emulator).
- Should see auth screen
- Sign up with a username + 4-digit pin
- Should redirect to dashboard
- Refresh the page — should stay logged in (persistent cookie)
- Test manual entry, settings (change target), team view, log out

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "feat: client app shell with auth, dashboard, manual entry, team view, settings"
```

---

### Task 8: Client — Camera Session with MediaPipe Pushup Detection

**Files:**
- Create: `public/pose.js`
- Modify: `public/app.js` (replace renderCamera placeholder)

- [ ] **Step 1: Write the pose detection module**

Create `public/pose.js`:

```javascript
import { FilesetResolver, PoseLandmarker, DrawingUtils } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/vision_bundle.mjs';

let poseLandmarker = null;
let animationFrameId = null;

const UP_ANGLE = 160;
const DOWN_ANGLE = 90;

export async function initPoseDetection() {
  if (poseLandmarker) return poseLandmarker;
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.34/wasm'
  );
  poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  return poseLandmarker;
}

export function calculateAngle(a, b, c) {
  const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let angle = Math.abs(radians * 180 / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}

function pickVisibleSide(landmarks) {
  const leftVis = (landmarks[11].visibility + landmarks[13].visibility + landmarks[15].visibility) / 3;
  const rightVis = (landmarks[12].visibility + landmarks[14].visibility + landmarks[16].visibility) / 3;
  if (leftVis >= rightVis) {
    return { shoulder: landmarks[11], elbow: landmarks[13], wrist: landmarks[15] };
  }
  return { shoulder: landmarks[12], elbow: landmarks[14], wrist: landmarks[16] };
}

export function startTracking(video, canvas, onCount) {
  const ctx = canvas.getContext('2d');
  let state = 'UP';
  let count = 0;
  let tracking = false;

  function processFrame() {
    if (!poseLandmarker || video.paused || video.ended) {
      animationFrameId = requestAnimationFrame(processFrame);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const result = poseLandmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result.landmarks && result.landmarks.length > 0) {
      const landmarks = result.landmarks[0];
      tracking = true;

      // Draw skeleton
      const drawingUtils = new DrawingUtils(ctx);
      drawingUtils.drawLandmarks(landmarks, { radius: 3, color: '#48bb78', fillColor: '#48bb78' });
      drawingUtils.drawConnectors(landmarks, PoseLandmarker.POSE_CONNECTIONS, { color: '#3182ce', lineWidth: 2 });

      // Calculate elbow angle on most visible side
      const { shoulder, elbow, wrist } = pickVisibleSide(landmarks);
      const angle = calculateAngle(shoulder, elbow, wrist);

      if (angle < DOWN_ANGLE && state === 'UP') {
        state = 'DOWN';
      }
      if (angle > UP_ANGLE && state === 'DOWN') {
        state = 'UP';
        count++;
        onCount(count);
      }
    } else {
      tracking = false;
    }

    animationFrameId = requestAnimationFrame(processFrame);
  }

  animationFrameId = requestAnimationFrame(processFrame);

  return {
    getCount: () => count,
    isTracking: () => tracking,
    stop: () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    },
  };
}

export async function getCamera(facingMode = 'user') {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
}
```

- [ ] **Step 2: Update app.js to use pose.js for camera screen**

In `public/app.js`, replace the `renderCamera` function and add the import at the top of the file.

Add to the very top of `app.js` (before `const API`):

```javascript
let poseModule = null;
async function loadPose() {
  if (!poseModule) poseModule = await import('/pose.js');
  return poseModule;
}
```

Replace `renderCamera`:

```javascript
async function renderCamera(app) {
  let facingMode = 'user';
  let stream = null;
  let tracker = null;

  app.innerHTML = `
    <div class="camera-screen">
      <div class="camera-feed">
        <video id="cam-video" playsinline autoplay muted></video>
        <canvas id="cam-canvas"></canvas>
        <div class="tracking-badge hidden" id="cam-tracking">TRACKING</div>
      </div>
      <div class="camera-counter">
        <div class="count" id="cam-count">0</div>
        <div class="count-label">pushups detected</div>
      </div>
      <div class="camera-controls">
        <button class="btn btn-danger" id="cam-stop">Stop &amp; Save</button>
        <button class="btn-flip" id="cam-flip">&#128260;</button>
      </div>
    </div>
  `;

  const video = document.getElementById('cam-video');
  const canvas = document.getElementById('cam-canvas');
  const countEl = document.getElementById('cam-count');
  const trackingBadge = document.getElementById('cam-tracking');

  async function startCamera() {
    const pose = await loadPose();
    await pose.initPoseDetection();
    stream = await pose.getCamera(facingMode);
    video.srcObject = stream;
    await video.play();

    tracker = pose.startTracking(video, canvas, (count) => {
      countEl.textContent = count;
    });

    // Update tracking badge
    setInterval(() => {
      if (tracker && tracker.isTracking()) {
        trackingBadge.classList.remove('hidden');
      } else {
        trackingBadge.classList.add('hidden');
      }
    }, 500);
  }

  function stopCamera() {
    if (tracker) tracker.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
  }

  document.getElementById('cam-stop').addEventListener('click', async () => {
    const count = tracker ? tracker.getCount() : 0;
    stopCamera();
    if (count > 0) {
      await api('POST', '/api/pushups', { count, source: 'camera' });
      showToast(`Saved ${count} pushups`);
    }
    await loadDashboard();
  });

  document.getElementById('cam-flip').addEventListener('click', async () => {
    stopCamera();
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    await startCamera();
  });

  try {
    await startCamera();
  } catch (err) {
    showToast('Camera access denied. Please allow camera permissions.');
    await loadDashboard();
  }
}
```

- [ ] **Step 3: Verify manually**

Run: `bun run dev`
Open `https://localhost:3000` (camera requires HTTPS in production, but localhost is exempt).
- Log in and tap Camera
- Allow camera permissions
- Should see live feed with skeleton overlay
- Do pushups in front of camera — counter should increment
- Test flip camera button
- Test Stop & Save — count should appear on dashboard

- [ ] **Step 4: Commit**

```bash
git add public/pose.js public/app.js
git commit -m "feat: camera session with MediaPipe pushup detection"
```

---

### Task 9: Deployment

**Files:**
- Create: `Dockerfile`
- Create: `fly.toml`

- [ ] **Step 1: Write Dockerfile**

Create `Dockerfile`:

```dockerfile
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --production --frozen-lockfile

COPY src/ ./src/
COPY public/ ./public/

ENV PORT=8080
ENV DB_PATH=/data/pushtracker.db

EXPOSE 8080

CMD ["bun", "run", "src/server.ts"]
```

- [ ] **Step 2: Write fly.toml**

Create `fly.toml`:

```toml
app = "pushtracker"
primary_region = "iad"

[build]

[env]
  PORT = "8080"
  DB_PATH = "/data/pushtracker.db"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[mounts]
  source = "pushtracker_data"
  destination = "/data"
```

- [ ] **Step 3: Deploy to Fly.io**

```bash
fly launch --no-deploy --name pushtracker --region iad
fly volumes create pushtracker_data --region iad --size 1
fly deploy
```

Expected: App deploys and is accessible at `https://pushtracker.fly.dev`

- [ ] **Step 4: Verify production**

Open `https://pushtracker.fly.dev` on mobile.
- Sign up, set target, do pushups with camera, check team view
- Verify persistent login (close and reopen browser)

- [ ] **Step 5: Commit deployment config**

```bash
git add Dockerfile fly.toml
git commit -m "feat: Fly.io deployment with persistent SQLite volume"
```

- [ ] **Step 6: Push to GitHub**

```bash
git push origin main
```
