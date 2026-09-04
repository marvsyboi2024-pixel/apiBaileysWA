import type { LevelWithSilentOrString } from "pino";

const {
  NODE_ENV,
  HOST,
  PORT,
  LOG_LEVEL,
  AUTH_GLOBAL_TOKEN,
  REDIS_ENABLED,
  REDIS_URL,
  REDIS_PASSWORD,
  BAILEYS_LOG_LEVEL,
  BAILEYS_CLIENT_VERSION,
  MAX_RETRIES,
  RECONNECT_INTERVAL,
  IGNORE_GROUP_MESSAGES,
  IGNORE_STATUS_MESSAGES,
  IGNORE_BROADCAST_MESSAGES,
  IGNORE_NEWSLETTER_MESSAGES,
  IGNORE_BOT_MESSAGES,
  IGNORE_META_AI_MESSAGES,
  WEBHOOK_URL,
  WEBHOOK_ALLOWED_EVENTS,
  WEBHOOK_RETRY_MAX,
  WEBHOOK_RETRY_INTERVAL,
  WEBHOOK_BACKOFF_FACTOR,
  WEBHOOK_SIGNATURE_MODE,
  WEBHOOK_ALLOW_GLOBAL_TOKEN_FALLBACK,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_RETRY_HTTP_429,
  WEBHOOK_RETRYABLE_STATUSES,
  WEBHOOK_RATE_PER_MIN,
  WEBHOOK_RATE_MAX_WAIT_MS,
  WEBHOOK_DEAD_LETTER_ENABLED,
  WEBHOOK_DEAD_LETTER_DIR,
  WEBHOOK_BLOCK_INTERNAL,
  BROADCAST_MIN_DELAY_MS,
  BROADCAST_MAX_DELAY_MS,
  BROADCAST_BATCH_SIZE,
  BROADCAST_BATCH_PAUSE_MS,
  MEDIA_INCLUDE_BASE64,
  MEDIA_CLEANUP_ENABLED,
  MEDIA_CLEANUP_INTERVAL_MS,
  MEDIA_MAX_AGE_HOURS,
  CORS_ORIGIN,
  TRUST_PROXY,
  DASHBOARD_ENABLED,
  DASHBOARD_REGISTRATION_ENABLED,
  DASHBOARD_REGISTRATION_REQUIRE_APPROVAL,
  DASHBOARD_JWT_SECRET,
  DASHBOARD_PASSWORD_MIN_LENGTH,
  SIMULATE_TYPING_BEFORE_SEND,
  SIMULATE_TYPING_DELAY_MIN_MS,
  SIMULATE_TYPING_DELAY_MAX_MS,
  AUTO_READ_MESSAGES,
  AUTO_READ_DELAY_ENABLED,
  AUTO_READ_DELAY_MIN_MS,
  AUTO_READ_DELAY_MAX_MS,
  AUTO_MARK_ONLINE,
  MAX_SESSIONS,
  REJECT_CALLS,
  // Humanized interaction (WA-Web-like pacing)
  HUMANIZE_READ_BEFORE_REPLY,
  HUMANIZE_READ_DELAY_MIN_MS,
  HUMANIZE_READ_DELAY_MAX_MS,
  HUMANIZE_THINK_MIN_MS,
  HUMANIZE_THINK_MAX_MS,
  HUMANIZE_TYPING_PROPORTIONAL,
  HUMANIZE_PRESENCE_DEDUPE_MS,
  HUMANIZE_GLOBAL_PACING_MIN_MS,
  HUMANIZE_GLOBAL_PACING_MAX_MS,
  HUMANIZE_DELAY_DISTRIBUTION,
  BROADCAST_TYPING_SIMULATION,
  BROADCAST_DELAY_DISTRIBUTION,
  BROADCAST_BATCH_CHECK_WA,
  BROADCAST_CHECK_WA_BATCH_SIZE,
} = process.env;

/**
 * Parse an env min/max pair into a sane numeric range.
 * - Missing/blank values fall back to the given defaults.
 * - Non-numeric (NaN) values fall back to defaults.
 * - Inverted ranges (min > max) are swapped so downstream random delays never
 *   produce an empty/negative window (e.g. MIN above MAX).
 * - An explicit 0 is preserved — several knobs treat 0 as "off/legacy" and
 *   must be reachable via env (previous truthiness parsing silently ignored 0).
 */
function rangePair(
  minRaw: string | undefined,
  maxRaw: string | undefined,
  defaultMin: number,
  defaultMax: number,
): { minMs: number; maxMs: number } {
  const parse = (v: string | undefined): number => {
    if (v === undefined || v === "") return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  let min = parse(minRaw);
  let max = parse(maxRaw);
  if (!Number.isFinite(min)) min = defaultMin;
  if (!Number.isFinite(max)) max = defaultMax;
  if (min > max) [min, max] = [max, min];
  return { minMs: min, maxMs: max };
}

// Normalized delay ranges (swap inverted env values, preserve explicit 0 = off)
const typingDelay = rangePair(
  SIMULATE_TYPING_DELAY_MIN_MS,
  SIMULATE_TYPING_DELAY_MAX_MS,
  1500,
  3000,
);
const autoReadDelay = rangePair(AUTO_READ_DELAY_MIN_MS, AUTO_READ_DELAY_MAX_MS, 1500, 4000);
const humanReadDelay = rangePair(HUMANIZE_READ_DELAY_MIN_MS, HUMANIZE_READ_DELAY_MAX_MS, 800, 2500);
const humanThinkDelay = rangePair(HUMANIZE_THINK_MIN_MS, HUMANIZE_THINK_MAX_MS, 800, 2000);
const humanPacing = rangePair(HUMANIZE_GLOBAL_PACING_MIN_MS, HUMANIZE_GLOBAL_PACING_MAX_MS, 0, 0);
const broadcastDelay = rangePair(BROADCAST_MIN_DELAY_MS, BROADCAST_MAX_DELAY_MS, 1500, 3000);

const config = {
  env: (NODE_ENV || "development") as "development" | "production",
  host: HOST || "0.0.0.0",
  port: PORT ? Number(PORT) : 3000,
  logLevel: (LOG_LEVEL || "info") as LevelWithSilentOrString,

  auth: {
    globalToken: AUTH_GLOBAL_TOKEN || "",
  },

  redis: {
    enabled: REDIS_ENABLED === "true",
    url: REDIS_URL || "redis://localhost:6379",
    password: REDIS_PASSWORD || "",
  },

  baileys: {
    logLevel: (BAILEYS_LOG_LEVEL || "warn") as LevelWithSilentOrString,
    clientVersion: BAILEYS_CLIENT_VERSION || "default",
    maxRetries: MAX_RETRIES ? Number(MAX_RETRIES) : 5,
    reconnectInterval: RECONNECT_INTERVAL ? Number(RECONNECT_INTERVAL) : 5000,
    ignoreGroupMessages: IGNORE_GROUP_MESSAGES === "true",
    ignoreStatusMessages: IGNORE_STATUS_MESSAGES ? IGNORE_STATUS_MESSAGES === "true" : true,
    ignoreBroadcastMessages: IGNORE_BROADCAST_MESSAGES
      ? IGNORE_BROADCAST_MESSAGES === "true"
      : true,
    ignoreNewsletterMessages: IGNORE_NEWSLETTER_MESSAGES
      ? IGNORE_NEWSLETTER_MESSAGES === "true"
      : true,
    ignoreBotMessages: IGNORE_BOT_MESSAGES ? IGNORE_BOT_MESSAGES === "true" : true,
    ignoreMetaAiMessages: IGNORE_META_AI_MESSAGES ? IGNORE_META_AI_MESSAGES === "true" : true,
  },

  webhook: {
    url: WEBHOOK_URL || "",
    allowedEvents: new Set(
      WEBHOOK_ALLOWED_EVENTS ? WEBHOOK_ALLOWED_EVENTS.split(",").map((e) => e.trim()) : ["ALL"],
    ),
    signatureMode: (WEBHOOK_SIGNATURE_MODE || "optional") as "off" | "optional" | "required",
    allowGlobalTokenFallback:
      WEBHOOK_ALLOW_GLOBAL_TOKEN_FALLBACK !== undefined
        ? WEBHOOK_ALLOW_GLOBAL_TOKEN_FALLBACK === "true"
        : (NODE_ENV || "development") !== "production",
    concurrency: WEBHOOK_CONCURRENCY ? Number(WEBHOOK_CONCURRENCY) : 20,
    retryPolicy: {
      maxRetries: WEBHOOK_RETRY_MAX ? Number(WEBHOOK_RETRY_MAX) : 3,
      retryInterval: WEBHOOK_RETRY_INTERVAL ? Number(WEBHOOK_RETRY_INTERVAL) : 5000,
      backoffFactor: WEBHOOK_BACKOFF_FACTOR ? Number(WEBHOOK_BACKOFF_FACTOR) : 3,
      /** Respect Retry-After on 429 (exponential backoff otherwise). */
      retryHttp429: WEBHOOK_RETRY_HTTP_429 !== "false",
      /**
       * HTTP statuses that are retryable. 4xx (bad request) is not — retrying
       * a malformed payload will never succeed and only burns quota.
       * Default: 408, 425, 429, 5xx. Can be overridden via env, e.g.
       * "408,425,429,500,502,503,504".
       */
      retryableStatuses: new Set(
        WEBHOOK_RETRYABLE_STATUSES
          ? WEBHOOK_RETRYABLE_STATUSES.split(",")
              .map((s) => Number(s.trim()))
              .filter((n) => Number.isInteger(n))
          : [408, 425, 429, 500, 502, 503, 504],
      ),
    },
    /**
     * Outbound rate limit per receiver URL (token bucket). 0 = disabled
     * (legacy). When > 0, at most N webhook requests per minute are sent to
     * the same endpoint; extra events wait (bounded by rateMaxWaitMs) instead
     * of being dropped.
     */
    ratePerMin: WEBHOOK_RATE_PER_MIN ? Number(WEBHOOK_RATE_PER_MIN) : 0,
    /** Max ms an event waits for a free per-URL slot before proceeding anyway. */
    rateMaxWaitMs: WEBHOOK_RATE_MAX_WAIT_MS ? Number(WEBHOOK_RATE_MAX_WAIT_MS) : 30000,
    /**
     * Dead-letter buffer for webhooks that exhausted all retries. When
     * enabled, failed deliveries are kept (and optionally persisted to disk)
     * instead of being dropped, so operators can replay them.
     * Default: disabled = legacy behavior (failed webhooks are dropped).
     */
    deadLetterEnabled: WEBHOOK_DEAD_LETTER_ENABLED === "true",
    deadLetterDir: WEBHOOK_DEAD_LETTER_DIR || "",
    /**
     * Block webhook URLs pointing at internal/private network targets
     * (localhost, 127.0.0.0/8, 10.x, 172.16-31.x, 192.168.x, link-local,
     * cloud metadata 169.254.169.254). Default false = allowed, so local
     * testing against http://localhost/127.0.0.1 receivers keeps working.
     * Enable in production when webhook URLs may be set by untrusted users.
     */
    blockInternal: WEBHOOK_BLOCK_INTERNAL === "true",
  },

  broadcast: {
    minDelayMs: broadcastDelay.minMs,
    maxDelayMs: broadcastDelay.maxMs,
    batchSize: BROADCAST_BATCH_SIZE ? Number(BROADCAST_BATCH_SIZE) : 10,
    batchPauseMs: BROADCAST_BATCH_PAUSE_MS ? Number(BROADCAST_BATCH_PAUSE_MS) : 5000,
    /** Show "composing…" bubble per recipient during broadcasts (default: false — safer). */
    typingSimulation:
      BROADCAST_TYPING_SIMULATION !== undefined ? BROADCAST_TYPING_SIMULATION === "true" : false,
    /** "uniform" (legacy) or "human" (mixed short/long gaps + jitter). */
    delayDistribution: (BROADCAST_DELAY_DISTRIBUTION || "uniform") as "uniform" | "human",
    /** Check WA registration in batches instead of 1-by-1 (fewer usync queries). */
    batchCheckWa: BROADCAST_BATCH_CHECK_WA === "true",
    checkWaBatchSize: BROADCAST_CHECK_WA_BATCH_SIZE ? Number(BROADCAST_CHECK_WA_BATCH_SIZE) : 50,
  },

  media: {
    includeBase64: MEDIA_INCLUDE_BASE64 === "true",
    cleanupEnabled: MEDIA_CLEANUP_ENABLED ? MEDIA_CLEANUP_ENABLED === "true" : true,
    cleanupIntervalMs: MEDIA_CLEANUP_INTERVAL_MS ? Number(MEDIA_CLEANUP_INTERVAL_MS) : 3600000,
    maxAgeHours: MEDIA_MAX_AGE_HOURS ? Number(MEDIA_MAX_AGE_HOURS) : 24,
  },

  corsOrigin: (() => {
    const raw = CORS_ORIGIN || "*";
    if (raw === "*") return "*";
    const origins = raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    return origins.length === 1 ? origins[0] : origins;
  })(),

  /**
   * Trust proxy headers (x-forwarded-for / x-real-ip / cf-connecting-ip)
   * for client IP detection. Enable ONLY when running behind a trusted
   * reverse proxy / load balancer. When false (default), the socket remote
   * address is used — spoofed XFF headers cannot bypass rate limits.
   */
  trustProxy: TRUST_PROXY === "true",

  /** Maximum concurrent sessions allowed */
  maxSessions: MAX_SESSIONS ? Number(MAX_SESSIONS) : 50,

  dashboard: {
    enabled: DASHBOARD_ENABLED ? DASHBOARD_ENABLED === "true" : true,
    registrationEnabled: DASHBOARD_REGISTRATION_ENABLED === "true",
    registrationRequireApproval: DASHBOARD_REGISTRATION_REQUIRE_APPROVAL === "true",
    /**
     * JWT secret for dashboard auth. In production a missing/default secret is
     * treated as a misconfiguration (jwtMisconfigured=true) so the dashboard
     * fails closed instead of silently signing tokens with a publicly-known
     * default. In development the built-in default stays for local convenience.
     */
    jwtSecret: DASHBOARD_JWT_SECRET || "baileys-wa-api-dashboard-secret-change-me",
    jwtMisconfigured:
      (NODE_ENV || "development") === "production" &&
      (!DASHBOARD_JWT_SECRET ||
        !DASHBOARD_JWT_SECRET.trim() ||
        DASHBOARD_JWT_SECRET.includes("change-me") ||
        DASHBOARD_JWT_SECRET.includes("change_me")),
    passwordMinLength: DASHBOARD_PASSWORD_MIN_LENGTH ? Number(DASHBOARD_PASSWORD_MIN_LENGTH) : 6,
  },

  simulation: {
    typingBeforeSend: SIMULATE_TYPING_BEFORE_SEND !== "false",
    typingDelayMinMs: typingDelay.minMs,
    typingDelayMaxMs: typingDelay.maxMs,
    autoReadMessages: AUTO_READ_MESSAGES === "true",
    /** Jeda "buka chat" sebelum mark read saat auto-read ON (0 = instan, seperti lama). */
    autoReadDelayEnabled: AUTO_READ_DELAY_ENABLED !== "false",
    autoReadDelayMinMs: autoReadDelay.minMs,
    autoReadDelayMaxMs: autoReadDelay.maxMs,
    autoMarkOnline: AUTO_MARK_ONLINE !== "false",
    rejectCalls: REJECT_CALLS === "true",
  },

  /**
   * Humanized interaction — WA-Web-like pacing before reads/replies.
   * All knobs default to the legacy behavior (0 / false) unless enabled.
   */
  humanize: {
    /** Mark incoming as read before sending an auto-reply (like opening WA Web). */
    readBeforeReply: HUMANIZE_READ_BEFORE_REPLY === "true",
    /** Random "reading" gap before read receipts (ms). */
    readDelayMinMs: humanReadDelay.minMs,
    readDelayMaxMs: humanReadDelay.maxMs,
    /** Random "thinking" gap before typing starts (ms). */
    thinkMinMs: humanThinkDelay.minMs,
    thinkMaxMs: humanThinkDelay.maxMs,
    /** Typing duration proportional to reply length when true. */
    typingProportional: HUMANIZE_TYPING_PROPORTIONAL === "true",
    /** Min gap between repeated composing/paused to same chat (0 = send every time). */
    presenceDedupeMs: HUMANIZE_PRESENCE_DEDUPE_MS ? Number(HUMANIZE_PRESENCE_DEDUPE_MS) : 0,
    /** Global min/max gap between ANY outbound action within a session (0 = off). */
    globalPacingMinMs: humanPacing.minMs,
    globalPacingMaxMs: humanPacing.maxMs,
    /** Delay pattern for read/think gaps: `uniform` (legacy) or `human`. */
    delayDistribution: (HUMANIZE_DELAY_DISTRIBUTION || "uniform") as "uniform" | "human",
  },

  autoReply: {
    enabled: process.env.AUTO_REPLY_ENABLED === "true",
    message:
      process.env.AUTO_REPLY_MESSAGE ||
      "Hello, we're currently away.\nWe'll reply to your message soon.",
    type: (process.env.AUTO_REPLY_TYPE || "always") as "always" | "time_range" | "on_webhook_fail",
    timeStart: process.env.AUTO_REPLY_TIME_START || "18:00",
    timeEnd: process.env.AUTO_REPLY_TIME_END || "08:00",
  },
};

export default config;
export type Config = typeof config;
