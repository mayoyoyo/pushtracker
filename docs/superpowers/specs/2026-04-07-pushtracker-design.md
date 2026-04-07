# PushTracker — Design Spec

## Overview

A mobile-first web app that uses AI-powered pose estimation to count pushups via the device camera. Replaces the current workflow of recording and sharing pushup videos, which is unverifiable at scale and tedious.

All pose estimation runs client-side in the browser using MediaPipe PoseLandmarker. No video is uploaded or stored — only the final pushup count hits the server.

## Users

- Small team of 5–15 people
- Each user self-assigns a daily pushup target
- Missed pushups accrue as debt (simple rollover — no penalties, no expiry)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun |
| Server | TypeScript, Bun.serve() |
| Client | Vanilla JS, mobile-first CSS |
| Pose Estimation | MediaPipe PoseLandmarker (`@mediapipe/tasks-vision`) |
| Database | SQLite (Fly.io persistent volume) |
| Hosting | Fly.io |
| Auth | Per-user 4-digit passcode, bcrypt-hashed, session cookie |

## Architecture

```
┌──────────────────────────────────────────┐
│          Mobile / Desktop Browser         │
│                                          │
│  ┌─────────────────┐  ┌───────────────┐  │
│  │ MediaPipe Pose   │  │ Vanilla JS    │  │
│  │ Landmarker       │  │ App           │  │
│  │ (client-side)    │  │ (mobile-first)│  │
│  └─────────────────┘  └───────────────┘  │
└──────────────┬───────────────────────────┘
               │ REST API (JSON)
┌──────────────▼───────────────────────────┐
│          Bun Server (TypeScript)          │
│  Auth, API routes, static file serving   │
│  Notification hooks (future Slack)       │
├──────────────────────────────────────────┤
│          SQLite (persistent volume)       │
└──────────────────────────────────────────┘
```

**Key design decisions:**
- All AI runs client-side — zero server cost for pose detection
- Privacy by design — no video is uploaded or stored
- Single process deploy — one Bun server serves static files + API
- Notification hooks — server emits events that can be wired to Slack later

## Data Model

### users

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| username | TEXT UNIQUE | Display name, used for login |
| passcode | TEXT | Hashed 4-digit PIN (bcrypt), set at signup |
| daily_target | INTEGER | Self-assigned, default 0 |
| debt | INTEGER | Cumulative owed pushups, default 0 |
| timezone | TEXT | IANA timezone, e.g. "America/New_York" |
| next_day_boundary | TEXT | Next 7am local in UTC (ISO 8601) |
| created_at | DATETIME | |

### pushup_logs

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| user_id | INTEGER FK | References users.id |
| count | INTEGER | Pushups done in this entry |
| source | TEXT | `"camera"` or `"manual"` |
| logged_at | DATETIME | When they were done |

### Debt tracking

Debt is stored as a column on `users`. Updated in two places:

- **End of day:** A cron job runs every 15 minutes, checking `SELECT * FROM users WHERE next_day_boundary <= NOW()`. For matched users, if `SUM(logs for ended day) < daily_target`, the shortfall is added to `debt`. Then `next_day_boundary` is advanced to the next 7am in the user's IANA timezone.
- **When pushups are logged:** If a user has debt > 0 and exceeds their daily target, the surplus reduces their debt.

Simple, fast to query, no historical recomputation needed.

### Timezone handling

- **Day boundary:** Each user's "day" runs from 7am local to 7am local (not midnight).
- **Storage:** IANA timezone string (e.g., `America/New_York`) + pre-computed `next_day_boundary` in UTC.
- **Detection:** On app open, client reads `Intl.DateTimeFormat().resolvedOptions().timeZone` (no location permissions needed — reads OS timezone setting). If it differs from stored timezone, server automatically updates the timezone and recalculates `next_day_boundary`. A dismissable notification informs the user: "We noticed you changed time zones — your daily reset has been updated."
- **On timezone change:** Current in-progress day may extend or shorten.
- **DST:** Handled automatically by using IANA timezone IDs and a proper timezone library (Temporal or Luxon), never raw UTC offsets.

## Authentication

- **Signup:** User picks a username + creates a 4-digit passcode. Server stores bcrypt hash.
- **Login:** Username + passcode. Server verifies hash, issues a session cookie (httpOnly, 30-day expiry).
- **Persistent session:** On a returning device/browser, user stays logged in until cookie expires or they explicitly log out.
- **No email, no OAuth, no password reset.** If someone forgets their passcode, they need manual help (admin resets it or creates a new account).

## Screens

### 1. Login / Signup

- Username text input
- 4-digit passcode input (individual digit boxes)
- Toggle between login and signup modes
- Error messaging for wrong passcode or duplicate username

### 2. Dashboard (Home)

- Greeting with username
- Today's progress: large count vs target with progress bar
- Cumulative debt display (highlighted in red if > 0)
- Three action buttons:
  - **Camera** — start AI-counted pushup session
  - **Manual** — log pushups done without the camera
  - **Team** — view everyone's progress
- Settings accessible (change target, change passcode, log out)

### 3. Camera Session

- Live camera feed with optional pose skeleton overlay
- Large pushup counter (prominent, readable mid-exercise)
- "Stop & Save" button to end session and log count
- Flip camera button (front/back)
- HTTPS required for camera access on all platforms
- Handles WebGL context loss gracefully (mobile tab backgrounding)

### 4. Manual Entry

- Simple number input or +/- stepper
- Submit to log pushups with `source: "manual"`
- Quick and minimal — for logging gym pushups done without the camera

### 5. Team View

- List of all team members with today's progress
- Color-coded status: green (complete), yellow (in progress), red (not started)
- Shows each person's target and debt if they have any
- Sorted: incomplete first, then completed

### Navigation

Dashboard is home base. All other screens are one tap away. Settings is accessible from the dashboard. No complex routing — login → dashboard → actions.

## Pushup Detection Algorithm

All client-side using MediaPipe PoseLandmarker (`@mediapipe/tasks-vision`):

### Pipeline

1. Camera feed streams to a `<video>` element
2. MediaPipe PoseLandmarker processes each frame, extracting 33 landmarks with x, y, z coordinates and visibility scores
3. The app selects the body side with higher visibility scores (handles different camera angles)
4. Elbow angle is calculated from shoulder (landmark 11/12), elbow (13/14), and wrist (15/16)

### Angle calculation

```javascript
function calculateAngle(shoulder, elbow, wrist) {
  const radians = Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x)
                - Math.atan2(shoulder.y - elbow.y, shoulder.x - elbow.x);
  let angle = Math.abs(radians * 180 / Math.PI);
  if (angle > 180) angle = 360 - angle;
  return angle;
}
```

### State machine

```
State: UP (elbow angle > 160°)
  → angle drops below 90° → transition to DOWN

State: DOWN (elbow angle < 90°)
  → angle rises above 160° → transition to UP, count += 1
```

The 90°–160° dead zone (hysteresis) prevents double-counting from jitter or partial movements.

### Performance targets

- 720p camera input at 30 FPS
- WebGL backend for GPU acceleration
- ~30 FPS pose detection on mobile, 60+ FPS on desktop
- Model loaded once on session start, reused across frames

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/signup` | Create user (username + hashed passcode) |
| POST | `/api/auth/login` | Authenticate, return session cookie |
| POST | `/api/auth/logout` | Clear session cookie |
| GET | `/api/me` | Current user profile + daily target |
| PUT | `/api/me/target` | Update daily target |
| POST | `/api/pushups` | Log pushups (`{ count, source }`) |
| GET | `/api/pushups/today` | Current user's logs for today |
| GET | `/api/me/debt` | Current user's debt (from users.debt column) |
| GET | `/api/team/today` | Everyone's progress for today |

All endpoints except signup/login require a valid session cookie.

## Future: Slack Integration

Not in v1. Architecture supports it via notification hooks:

- Server emits events on key actions (daily target completed, daily summary trigger)
- A notification module subscribes to these events
- Adding Slack = loading bot tokens from env vars + implementing the notification methods
- Minimal code change when the time comes

## Future: Form Validation

MediaPipe's 33 landmarks already provide the data needed for:

- Hip sag detection (shoulder-hip-ankle angle should stay near 180°)
- Depth validation (shoulders should drop below elbows at bottom)
- Knee-on-floor rejection

These can be added as optional "strict mode" features without changing the core architecture.

## Deployment

- Fly.io with a persistent volume for SQLite
- Single `fly.toml` config
- HTTPS provided by Fly.io (required for camera access)
- `main` branch auto-deploys to production
- Single environment for v1 (no staging). Can add staging promotion later if needed.
