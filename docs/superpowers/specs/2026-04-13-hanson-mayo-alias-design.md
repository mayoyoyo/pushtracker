# User Aliasing: Hanson ↔ Mayo

**Date:** 2026-04-13
**Status:** Spec — awaiting plan
**Scope:** One admin user (the author) holds two accounts across two orgs: `hanson` in Frist (FRST) and `mayo` in MayoLab (DEV0). The two accounts must behave as a single person: identical progress, identical settings, a single source of truth, with no possibility of drift. Pushups logged under either account count toward both. This is a niche, hardcoded case — nobody else is expected to hold two accounts.

## Goal

Make `mayo` a transparent alias of `hanson` at the data layer, such that:

- Any read of mayo's progress returns hanson's data (today's total, debt, streak, last-5-day dots, calendar history).
- Any read of mayo's settings returns hanson's settings (daily target, timezone, next-day boundary).
- Any write initiated from mayo's session (logging pushups, changing target, changing timezone) is applied to hanson's row.
- The nightly day-end rollup (debt accrual, streak update, last5 shift, day_results insert) runs exactly once, against hanson's row.
- Each org's Slack channel still receives a day-end post whenever the day closes. Frist's post (the only configured channel today) shows "hanson …"; MayoLab's post (if ever configured) would show "mayo …" — both with the same numbers.
- The MayoLab org's team view shows `mayo`'s card with hanson's full stats (total, last5 dots, streak, debt, daily_target).
- The mechanism is robust against future edits: a new developer (or future LLM session) touching per-user data cannot accidentally bypass the alias.

## Non-goals

- No general-purpose multi-account / multi-org user model.
- No UI surfacing of the alias to other users.
- No preservation of mayo's existing independent history. Mayo's pre-aliasing `pushup_logs` and `day_results` are expendable and will be deleted.
- No generalized per-field override system (e.g., "mayo has the same progress but a different daily_target"). Everything is shared.

## Approach: alias resolution at the DB layer

A single nullable column on `users` declares the alias. Every DB function that touches per-user progress or settings first resolves the passed `user_id` through a helper. Alias rows remain in the `users` table only to carry `username`, `passcode`, `invite_code`, and `session` references — their own progress/settings columns become unused shadow state.

This approach beats dual-write mirroring because drift is structurally impossible: there is only one physical row holding the data. It beats a full `person_id` refactor because the blast radius is confined to `db.ts` for a feature that exists for exactly one user.

## Schema change

Add one column to `users` via the existing `try{}`-wrapped `ALTER TABLE` migration pattern in `getDb()`:

```sql
ALTER TABLE users ADD COLUMN source_user_id INTEGER REFERENCES users(id)
```

- `NULL` (default) → normal user, no aliasing.
- Non-null → row is an alias; all data and settings live under `source_user_id`.

No other schema changes. `pushup_logs`, `day_results`, `sessions`, and `invite_codes` are untouched.

## The resolver

A single helper in `db.ts`:

```ts
export function resolveDataUserId(userId: number): number {
  const row = db.prepare(
    "SELECT source_user_id FROM users WHERE id = ?"
  ).get(userId) as { source_user_id: number | null } | null;
  return row?.source_user_id ?? userId;
}
```

For the hardcoded two-user case, a per-call query against a tiny `users` table is negligible. If aliasing ever spreads, an in-memory cache keyed by `id` can be introduced without changing any callers.

## Functions that must call the resolver

Every function in `db.ts` that takes a `user_id` for progress data or settings is updated to resolve first. The list is fixed and auditable:

| Function | Behavior |
|---|---|
| `logPushups(userId, ...)` | Resolves → inserts `pushup_logs` under source id |
| `getTodayLogs(userId, ...)` | Resolves → reads source's logs |
| `getTodayTotal(userId, ...)` | Resolves → reads source's total |
| `getMonthResults(userId, ...)` | Resolves → reads source's `day_results` |
| `hasEverLoggedPushups(userId)` | Resolves → checks source's logs |
| `updateDebt(userId, ...)` | Resolves → writes to source row |
| `updateStreak(userId, ...)` | Resolves → writes to source row |
| `saveDayResult(userId, ...)` | Resolves → writes to source row |
| `updateTarget(userId, ...)` | Resolves → writes to source row |
| `updateTimezone(userId, ...)` | Resolves → writes to source row (timezone + `next_day_boundary`) |
| `updateNextDayBoundary(userId, ...)` | Stays raw — unchanged. Only ever called from cron, and cron never calls it on alias rows (see cron section). |
| `getUsersWithExpiredBoundary(now)` | **Rewritten** to JOIN on `source_user_id` and compare against the effective boundary: `COALESCE(source.next_day_boundary, self.next_day_boundary) <= ?`. An alias row is returned only if its source's boundary is expired. |

`getUserById` and `getUserByUsername` do **not** resolve. They remain raw, because authentication, session lookup, and per-org listing need the literal alias row. The resolution happens at the point where those raw rows are used for data purposes.

### Shadow columns on alias rows

Once a user is an alias, these columns on the alias row become **unused shadow state** and are never read by application code:

- `debt`, `last5`, `streak`, `daily_target` — always read from the source via the resolver.
- `timezone`, `next_day_boundary` — always read from the source via the resolver for API purposes, and via the JOIN in `getUsersWithExpiredBoundary` for cron.

Writes to these columns on the alias row never happen: the resolver redirects writes to the source, and `updateNextDayBoundary` is never called on alias rows. Whatever stale value the alias row carries is inert.

## Presenting resolved users to the API layer

Two new helpers in `db.ts` merge an alias row's identity (`id`, `username`, `invite_code`, `created_at`, `source_user_id`) with the source row's progress/settings fields (`debt`, `last5`, `streak`, `daily_target`, `timezone`, `next_day_boundary`):

- `getResolvedUserById(id: number): User` — used by `/api/me` via `getSessionUser`. For a non-alias user, it returns the row unchanged. For an alias, it returns the alias's identity + the source's progress/settings.
- `getResolvedTeamByGroup(inviteCode: string): User[]` — replaces `getTeamByGroup` for the leaderboard. Internally fetches each raw row, and for any row with `source_user_id` it fetches the source row once and merges.

Both helpers return objects that look exactly like a normal `User`, so the API and cron call sites don't need to know whether aliasing is happening.

## API layer

The `auth.ts` `getSessionUser(token)` helper is updated to return `getResolvedUserById(session.user_id)`. From the API's perspective, the authenticated `user` object already reflects resolution.

- `GET /api/me` — unchanged. Already builds its response from `user.*` fields and `getTodayTotal(user.id, ...)`. Both sources are now resolution-aware.
- `POST /api/pushups` — unchanged. `logPushups` resolves internally.
- `PUT /api/me/target`, `PUT /api/me/timezone` — unchanged. `updateTarget` / `updateTimezone` resolve internally.
- `GET /api/me/calendar` — unchanged. `getMonthResults` resolves internally.
- `GET /api/me/debt` — unchanged. `user.debt` is now the resolved source's debt.
- `GET /api/team/today` — replace `getTeamByGroup(user.invite_code)` with `getResolvedTeamByGroup(user.invite_code)`. The rest of the loop is unchanged; every `u.*` field on the returned rows, and every function call like `getTodayTotal(u.id, ...)`, already returns hanson's data for mayo's row.
- `POST /api/auth/logout` — unchanged.
- `POST /api/auth/signup`, `POST /api/auth/login` — unchanged. Signup/login operates on raw `users` rows; the first resolved lookup happens when a session exists.

## Cron (`processExpiredBoundaries`)

`getUsersWithExpiredBoundary(now)` is rewritten (as noted in the resolver table) to JOIN each row against its source and compare against the **effective** boundary. An alias row is only returned when its source's boundary is expired. This keeps alias and source always in phase with respect to cron scheduling.

**Ordering within a single cron pass:** sort the returned users in-memory so non-alias rows (`source_user_id IS NULL`) are processed first, then alias rows. This guarantees the source row's rollup has already committed and its boundary has already been advanced by the time any alias row runs its Slack post.

For each expired row:

1. **If the row is a normal user** (`source_user_id == null`):
   - Existing behavior exactly — compute shortfall, `updateDebt`, `updateStreak`, `saveDayResult`, post Slack to its own org, `updateNextDayBoundary` on its own row.

2. **If the row is an alias** (`source_user_id != null`):
   - Do **not** run the rollup. The source row has already applied the physical state update earlier in this same pass.
   - Do **not** call `updateNextDayBoundary`. The alias has no boundary of its own — its effective boundary comes from the source via the JOIN, and the source just advanced it.
   - Post to the alias's org Slack channel if `getSlackConfig(alias.invite_code)` returns a config. Build the payload from `getResolvedUserById(alias.id)`: the alias's `username` + source's fresh `debt`, `streak`, and recomputed day-end total (same `getPreviousDayBoundary` lookup as the non-alias branch, using the source's now-advanced boundary).

**Multi-day catchup.** The existing outer `while (users.length > 0)` loop in `processExpiredBoundaries` handles the case where several days have passed (server was down). On each pass, `getUsersWithExpiredBoundary` re-polls: if the source is still expired (catching up day 2), the alias is returned again and fires another Slack post for day 2. Once the source is fresh, the alias drops out of the query and the loop terminates.

## Slack fan-out

`postDayResult(token, channel, username, ...)` in `slack.ts` is unchanged. The fan-out happens naturally because each alias row iterates independently in cron with its own `invite_code` lookup via `getSlackConfig`. Frist sees `hanson: 30/20 ✅` (non-alias branch), MayoLab (if configured) would see `mayo: 30/20 ✅` (alias branch). Identical stats, different channel + username.

## One-time setup (migration)

Inside `getDb()`, appended to the existing migration block:

```ts
try {
  db.exec("ALTER TABLE users ADD COLUMN source_user_id INTEGER REFERENCES users(id)");
} catch {}

// Link mayo → hanson if both exist and not already linked.
// Idempotent: no-op on subsequent startups.
db.exec(`
  UPDATE users
  SET source_user_id = (SELECT id FROM users WHERE username = 'hanson')
  WHERE username = 'mayo'
    AND source_user_id IS NULL
    AND EXISTS (SELECT 1 FROM users WHERE username = 'hanson')
`);

// Wipe mayo's now-orphaned progress data. Runs at most once per row lifetime:
// once mayo's rows are deleted, the deletes become no-ops on every subsequent boot.
db.exec(`
  DELETE FROM pushup_logs
  WHERE user_id IN (SELECT id FROM users WHERE username = 'mayo' AND source_user_id IS NOT NULL)
`);
db.exec(`
  DELETE FROM day_results
  WHERE user_id IN (SELECT id FROM users WHERE username = 'mayo' AND source_user_id IS NOT NULL)
`);
```

Linking is by username at migration time only. Once `source_user_id` is set, the code operates off that integer FK, so renaming either account later has no effect.

The migration runs on every server boot (as do all existing migrations in `getDb()`), but each step is idempotent by construction.

## CLAUDE.md guardrail

Append a new section to `/Users/hansonkang/Documents/GitHub/pushtracker/CLAUDE.md`:

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

This section is load-bearing: it is the mechanism that keeps future edits from accidentally bypassing the alias and reintroducing the drift this design exists to prevent.

## Testing

Unit tests in `tests/` covering `db.ts`:

- `resolveDataUserId` returns the source id for an alias row and the same id for a normal row.
- `logPushups(mayo.id, ...)` inserts into `pushup_logs` under hanson's id.
- `getTodayTotal(mayo.id, ...)` returns hanson's total.
- `getMonthResults(mayo.id, ...)` returns hanson's day_results rows.
- `updateTarget(mayo.id, 30)` mutates hanson's row, not mayo's.
- `updateDebt(mayo.id, 5)` mutates hanson's row.
- `updateTimezone(mayo.id, 'Europe/London')` mutates hanson's row (timezone + next_day_boundary).
- `getResolvedUserById(mayo.id)` returns mayo's `id`/`username`/`invite_code` with hanson's `debt`/`streak`/`last5`/`daily_target`/`timezone`/`next_day_boundary`.
- `getResolvedTeamByGroup('FRST')` returns mayo's row with hanson's progress fields.
- `getUsersWithExpiredBoundary` returns mayo's alias row only when hanson's `next_day_boundary` is expired (not mayo's raw column).

Integration tests covering the API:

- `GET /api/me` on a mayo session returns identical `today_total`, `debt`, `streak`, `last5days`, `daily_target` as `GET /api/me` on a hanson session.
- `POST /api/pushups` from mayo's session causes hanson's `GET /api/me` `today_total` to increase.
- `GET /api/me/calendar` on mayo's session returns hanson's full history.
- `GET /api/team/today` on a Frist member's session shows mayo's card with hanson's full stats.

Integration test covering cron:

- Set up hanson + mayo (aliased) with hanson's `next_day_boundary` expired, with Slack configured on Frist (stub `postDayResult`). Run `processExpiredBoundaries`. Assert: hanson's row has exactly one debt/streak update applied; mayo's raw `debt`/`streak`/`last5` columns are untouched; hanson's `next_day_boundary` has advanced one day; mayo's raw `next_day_boundary` is unchanged; `postDayResult` was called exactly once with username `mayo`, Frist's channel, and the same numeric payload as hanson's computed day-end stats. Then re-run `processExpiredBoundaries` with unchanged clock: assert no side effects (idempotent — source is no longer expired, so neither is returned).

## Rollout & rollback

- **Rollout:** the migration is idempotent and safe to deploy in a single boot. The first boot after deploy links mayo → hanson and wipes mayo's progress data.
- **Rollback:** remove `source_user_id` on mayo's row (`UPDATE users SET source_user_id = NULL WHERE username = 'mayo'`). Mayo becomes a normal user again with empty progress (since her data was wiped). Code rollback to the pre-alias version is independent and safe.

## Open questions

None at spec time. All design decisions have been confirmed with the user:
- Settings are shared (not just progress) → approach A with settings-resolving updates.
- Slack fans out to both orgs with the alias's username → cron ordering + per-alias post.
- Mayo's existing progress data is expendable → one-time DELETE in migration.
- Must survive future feature work → CLAUDE.md guardrail section.
