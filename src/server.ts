import { join } from "path";
import { getDb } from "./db";
import { handleApiRequest } from "./api";
import { startCron } from "./cron";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PORT = parseInt(process.env.PORT || "3000");
const DB_PATH = process.env.DB_PATH || "pushtracker.db";

// Initialize database
getDb(DB_PATH);

// App shell = HTML/JS/CSS/JSON. Served no-store so installed iOS PWAs pick
// up new deploys on next open instead of sitting on stale cached assets
// for days. The total shell is ~80KB so re-downloading on every open is
// cheap compared to the "my fix didn't land, delete and reinstall" cost.
const NO_CACHE_EXTS = new Set(["html", "js", "mjs", "css", "json"]);
const LONG_CACHE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"]);

function cacheHeadersFor(filePath: string): HeadersInit {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (NO_CACHE_EXTS.has(ext)) {
    return { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" };
  }
  if (LONG_CACHE_EXTS.has(ext)) {
    return { "Cache-Control": "public, max-age=3600" };
  }
  return {};
}

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
      return new Response(file, { headers: cacheHeadersFor(filePath) });
    }

    // SPA fallback
    const fallback = join(PUBLIC_DIR, "index.html");
    return new Response(Bun.file(fallback), { headers: cacheHeadersFor(fallback) });
  },
});

startCron();
console.log(`PushTracker running on http://localhost:${server.port}`);
