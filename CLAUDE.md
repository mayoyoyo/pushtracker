
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

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
