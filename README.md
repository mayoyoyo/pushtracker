# PushTracker

A push-up challenge app with AI-powered rep counting. Track daily push-ups, compete with friends, and build streaks.

**Live:** https://pushtracker.fly.dev

## Features

- **AI Camera Tracking** -- Two detection modes using MediaPipe Pose:
  - **Noob Mode** -- Front-facing camera, tracks nose/shoulder movement. Easy setup, but can't detect knee push-ups.
  - **One Punch Mode** -- Side-view camera with full-body tracking. Detects kneeling, validates form, requires ankle visibility.
- **Ready Gate** -- Camera won't count until it confirms it can see you properly. Audio chime + green border when ready.
- **Manual Entry** -- Quick-log push-ups with a stepper or direct number input.
- **Daily Targets** -- Set a daily goal (minimum 20). Progress bar, completion celebration with sound.
- **Streak Tracking** -- Last 5 days shown as icons. One Punch days earn the fist, Noob/Manual days earn fire. Ice for missed days.
- **Team View** -- See your group's progress, streaks, and debt. Grouped by invite code.
- **Debt System** -- Miss your target and the shortfall accumulates. Surplus push-ups reduce debt.
- **Calendar** -- Month view showing your history with emoji indicators.
- **Timezone-Aware** -- 7am daily reset in your local timezone. Auto-detects on login.

## Tech Stack

- **Runtime:** Bun
- **Server:** Bun.serve()
- **Database:** SQLite (bun:sqlite)
- **Pose Detection:** MediaPipe PoseLandmarker (runs on-device)
- **Frontend:** Vanilla JS, shadcn/zinc design system, Lucide icons
- **Deploy:** Fly.io with GitHub Actions auto-deploy

## Getting Started

```bash
bun install
bun run src/server.ts
```

Open http://localhost:8080. Sign up with invite code `DEV0`.

## Testing

```bash
bun test
```

## Project Structure

```
src/
  server.ts    -- Bun.serve entry point
  db.ts        -- SQLite schema, queries, migrations
  api.ts       -- REST API endpoints
  auth.ts      -- Signup, login, sessions
  timezone.ts  -- Day boundary calculation (Luxon)
  cron.ts      -- 15-min job for debt calculation + streak snapshots
public/
  index.html   -- SPA shell
  app.js       -- Full client app (auth, dashboard, camera, team, settings)
  pose.js      -- MediaPipe pose detection (noob + one punch modes)
  styles.css   -- shadcn/zinc dark theme
tests/
  *.test.ts    -- Unit tests for DB, API, auth, timezone, cron
```
