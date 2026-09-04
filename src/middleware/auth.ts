import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import config from "@/config";
import { error } from "@/lib/response";
import logger from "@/lib/logger";
import { getRedis, isRedisAvailable } from "@/lib/redis";

const REDIS_API_KEY_PREFIX = "@baileys-wa-api:api-keys";

export interface AuthData {
  role: "user" | "admin";
}

function normalizeToken(value?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^Bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^Bearer\s+/i, "").trim() || null;
  }
  return trimmed;
}

function collectAuthCandidates(c: Context): string[] {
  const candidates = [
    normalizeToken(c.req.header("Authorization")),
    normalizeToken(c.req.header("x-api-key")),
    normalizeToken(c.req.header("x-access-token")),
    normalizeToken(c.req.header("token")),
  ].filter((v): v is string => Boolean(v));

  return [...new Set(candidates)];
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
  } catch {
    return false;
  }
}

/**
 * Authentication middleware.
 * - Development: skips auth
 * - Simple mode (AUTH_GLOBAL_TOKEN): checks standard token headers
 *   (`Authorization`, `x-api-key`, `x-access-token`, `token`)
 * - Redis mode: checks the same header candidates against Redis-stored API keys
 */
export async function authMiddleware(c: Context, next: Next) {
  // Skip auth in development
  if (config.env === "development") {
    return next();
  }

  const authCandidates = collectAuthCandidates(c);

  // Try simple token auth first (timing-safe comparison)
  if (config.auth.globalToken) {
    for (const token of authCandidates) {
      if (safeCompare(token, config.auth.globalToken)) {
        return next();
      }
    }
  }

  // Try Redis API key auth
  if (isRedisAvailable()) {
    for (const apiKey of authCandidates) {
      try {
        const redis = getRedis();
        if (!redis) continue;
        const raw = await redis.get(`${REDIS_API_KEY_PREFIX}:${apiKey}`);

        if (raw) {
          const auth: AuthData = JSON.parse(raw);
          c.set("auth", auth);
          return next();
        }
      } catch (error) {
        logger.error("Auth middleware error: %s", (error as Error).message);
      }
    }
  }

  // No simple token and no Redis key → check if simple token was configured
  if (config.auth.globalToken) {
    return error(c, "Unauthorized: invalid token", 401);
  }

  return error(c, "Unauthorized: API key required", 401);
}

/**
 * Admin-only guard (requires Redis API key with admin role).
 */
export async function adminGuard(c: Context, next: Next) {
  await authMiddleware(c, async () => {});

  const auth = c.get("auth") as AuthData | undefined;
  if (auth?.role !== "admin" && config.env !== "development") {
    return error(c, "Forbidden: admin access required", 403);
  }

  return next();
}
