import fs from "node:fs";
import path from "node:path";
import { swaggerUI } from "@hono/swagger-ui";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import config from "@/config";
import { loadDashboard } from "@/dashboard/loader";
import { generateOpenApiSpec } from "@/docs/openapi";
import appLogger from "@/lib/logger";
import { success } from "@/lib/response";
import { authMiddleware } from "@/middleware/auth";
import { generalRateLimit } from "@/middleware/rateLimit";
import chatRoutes from "@/routes/chat";
import groupRoutes from "@/routes/group";
import mediaRoutes from "@/routes/media";
import profileRoutes from "@/routes/profile";
import sessionRoutes from "@/routes/session";
import statusRoutes from "@/routes/status";
import storyRoutes from "@/routes/story";

const app = new Hono();

// ── Global Middleware ───────────────────────────────
app.use("*", cors({ origin: config.corsOrigin }));

app.use("*", async (c, next) => {
  await next();
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

// Body size limit: 10MB max to prevent DoS
app.use("*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// General rate limit: 100 req/min per IP (production only)
if (config.env === "production") {
  app.use("*", generalRateLimit);
}

if (config.env === "development") {
  app.use("*", honoLogger());
}

// ── Error Handler ───────────────────────────────────
app.onError((err, c) => {
  appLogger.error("Unhandled error: %s", err.stack || err.message);
  const message = config.env === "development" ? err.message : "Internal server error";
  return c.json({ success: false, message }, 500);
});

// ── OpenAPI / Swagger Documentation ─────────────────

// Cache package.json at startup instead of reading on every request
const pkgPath = path.join(process.cwd(), "package.json");
let cachedPkg: Record<string, unknown>;
try {
  cachedPkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
} catch {
  cachedPkg = { name: "Baileys WA API", version: "1.0.0", description: "" };
}

app.get("/docs", swaggerUI({ url: "/openapi.json" }));

app.get("/openapi.json", (_c) => {
  const pkg = cachedPkg;
  const spec = generateOpenApiSpec(pkg, config.port);
  return new Response(JSON.stringify(spec, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
});

// ── Routes ──────────────────────────────────────────
app.route("/status", statusRoutes);
app.route("/sessions", sessionRoutes);
app.route("/chats", chatRoutes);
app.route("/groups", groupRoutes);
app.route("/profile", profileRoutes);
app.route("/media", mediaRoutes);
app.route("/story", storyRoutes);

// ── Config Endpoints ────────────────────────────────
app.get("/config/simulation", authMiddleware, (c) => {
  return success(c, {
    typingBeforeSend: config.simulation.typingBeforeSend,
    typingDelayMinMs: config.simulation.typingDelayMinMs,
    typingDelayMaxMs: config.simulation.typingDelayMaxMs,
    autoReadMessages: config.simulation.autoReadMessages,
    autoMarkOnline: config.simulation.autoMarkOnline,
    rejectCalls: config.simulation.rejectCalls,
  });
});

// ── Dashboard (modular — never breaks main API) ────
try {
  loadDashboard(app);
} catch (err) {
  appLogger.warn("Dashboard failed to load: %s", (err as Error).message);
}

// ── 404 Handler ─────────────────────────────────────
app.notFound((c) => {
  return c.json({ success: false, message: "Route not found" }, 404);
});

export default app;
