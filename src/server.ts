import { join } from "path";
import { getDb } from "./db";
import { handleApiRequest } from "./api";

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

console.log(`PushTracker running on http://localhost:${server.port}`);
