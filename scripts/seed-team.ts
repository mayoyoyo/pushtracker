// Local dev seed: populate the DEV0 group with 5 synthetic team members in
// varied states so the team-view accordion can be exercised end-to-end.
// Run with `bun scripts/seed-team.ts`. Safe to re-run — it wipes only the
// usernames it owns, leaving hanson/mayo and any other pre-existing users
// alone.

import { getDb, createUser, updateTarget, updateDebt, updateStreak, logPushups } from "../src/db";
import { getNextDayBoundary } from "../src/timezone";

const db = getDb("pushtracker.db");

const TZ = "America/New_York";
const nowUtc = new Date().toISOString();
const boundary = getNextDayBoundary(TZ, nowUtc);

const SEED_USERNAMES = ["alice", "bob", "carol", "dave", "erin", "max"] as const;

// Wipe any previous seed rows (and their logs) so this script is idempotent.
const placeholders = SEED_USERNAMES.map(() => "?").join(",");
db.prepare(
  `DELETE FROM pushup_logs WHERE user_id IN (SELECT id FROM users WHERE username IN (${placeholders}))`
).run(...SEED_USERNAMES);
db.prepare(
  `DELETE FROM day_results WHERE user_id IN (SELECT id FROM users WHERE username IN (${placeholders}))`
).run(...SEED_USERNAMES);
db.prepare(
  `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username IN (${placeholders}))`
).run(...SEED_USERNAMES);
db.prepare(`DELETE FROM users WHERE username IN (${placeholders})`).run(...SEED_USERNAMES);

const passcodeHash = await Bun.password.hash("1234");

interface Seed {
  username: string;
  target: number;
  last5: string;    // e.g. "S,F,U,I,F" — newest on the right
  streak: number;
  debt: number;
  logs: Array<{ count: number; mode: "opm" | "standard" | "situp" | "manual" }>;
}

const seeds: Seed[] = [
  // 1. Hit target today via opm, 3-day opm streak, no debt — plurality bar
  //    is solid orange, progress shows complete.
  {
    username: "alice",
    target: 50,
    last5: "S,S,S",
    streak: 3,
    debt: 0,
    logs: [{ count: 50, mode: "opm" }],
  },
  // 2. Partial today with all three modes mixed — segmented bar shows all
  //    three colors, none dominant, under target.
  {
    username: "bob",
    target: 50,
    last5: "F",
    streak: 1,
    debt: 0,
    logs: [
      { count: 10, mode: "opm" },
      { count: 8,  mode: "standard" },
      { count: 5,  mode: "situp" },
    ],
  },
  // 3. Never logged — card shows "not started", non-clickable, no expanded.
  {
    username: "carol",
    target: 50,
    last5: "",
    streak: 0,
    debt: 0,
    logs: [],
  },
  // 4. Sit-up only, hit target — bar is solid blue, streak of 1 (U).
  {
    username: "dave",
    target: 40,
    last5: "U",
    streak: 1,
    debt: 0,
    logs: [{ count: 40, mode: "situp" }],
  },
  // 5. Active debt, recovering — last5 has a miss, partial today via
  //    standard + manual mix, no streak, red debt label.
  {
    username: "erin",
    target: 50,
    last5: "F,F,I",
    streak: 0,
    debt: 25,
    logs: [
      { count: 12, mode: "standard" },
      { count: 4,  mode: "manual"   },
    ],
  },
  // 6. Three-mode athlete — 150 target, hits it exactly with a perfect
  //    50/50/50 split across opm + situp + standard so the expanded bar
  //    shows all three segments at equal width and the legend lists all
  //    three. 2-day streak (S, U) for visual variety in the last5 row.
  //    Uses "max" rather than "mayo" because `linkMayoToHansonIfNeeded()`
  //    in src/db.ts auto-wipes and aliases any local `mayo` row on every
  //    dev-server boot.
  {
    username: "max",
    target: 150,
    last5: "S,U",
    streak: 2,
    debt: 0,
    logs: [
      { count: 50, mode: "opm"      },
      { count: 50, mode: "situp"    },
      { count: 50, mode: "standard" },
    ],
  },
];

for (const s of seeds) {
  const user = createUser(s.username, passcodeHash, TZ, boundary, "DEV0");
  updateTarget(user.id, s.target);
  if (s.last5 || s.streak > 0) updateStreak(user.id, s.last5, s.streak);
  if (s.debt > 0) updateDebt(user.id, s.debt);
  for (const log of s.logs) {
    logPushups(user.id, log.count, log.mode === "manual" ? "manual" : "camera", log.mode);
  }
}

console.log(`Seeded ${seeds.length} team members in DEV0 group:`);
for (const s of seeds) {
  const todayTotal = s.logs.reduce((sum, l) => sum + l.count, 0);
  console.log(
    `  ${s.username.padEnd(6)} target=${s.target}  today=${todayTotal}  last5=${s.last5 || "(none)"}  streak=${s.streak}  debt=${s.debt}`
  );
}
console.log(`\nLogin: any seeded username with passcode 1234`);
console.log(`Team viewable from any DEV0 user (hanson, or a seeded one).`);
