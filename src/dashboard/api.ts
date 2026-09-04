/**
 * Dashboard-specific API routes — SSE events, webhook config, stats.
 */

import fs from "node:fs";
import path from "node:path";
import type { proto, WAPresence } from "@whiskeysockets/baileys";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { updateSessionMetadata } from "@/baileys/authState";
import {
  buildWebhookHeaders,
  deliverWebhookOnce,
  validateWebhookTarget,
} from "@/baileys/connection";
import connectionManager from "@/baileys/connectionManager";
import config from "@/config";
import { dashboardAuthMiddleware, findDashboardUserById } from "@/dashboard/auth";
import eventBus, { type DashboardEvent } from "@/dashboard/eventBus";
import { isBun } from "@/lib/runtime";
import { addWebhookLog, clearWebhookLogs, getWebhookLogs } from "@/services/webhookLog";
import { type DeadLetterEntry } from "@/services/webhookDeadLetter";
import {
  clearDeadLetters,
  getDeadLetters,
  replayAllDeadLetters,
  replayDeadLetter,
} from "@/services/webhookDeadLetter";

const dashboardApi = new Hono();

type DashboardRole = "admin" | "manager" | "assistant";
type DashboardUserPayload = {
  sub: string;
  username: string;
  role: DashboardRole;
  exp: number;
  scope?: "stream";
};
type DashboardCapability =
  | "manageSessions"
  | "manageWebhooks"
  | "viewSessions"
  | "viewChats"
  | "sendOutbound"
  | "replyIncoming"
  | "manageGroups"
  | "manageEvents";

const ROLE_CAPABILITIES: Record<DashboardRole, Set<DashboardCapability>> = {
  admin: new Set([
    "manageSessions",
    "manageWebhooks",
    "viewSessions",
    "viewChats",
    "sendOutbound",
    "replyIncoming",
    "manageGroups",
    "manageEvents",
  ]),
  manager: new Set(["viewSessions", "viewChats", "sendOutbound", "replyIncoming", "manageGroups"]),
  assistant: new Set(["viewSessions", "viewChats", "replyIncoming"]),
};

function getDashboardRole(c: Context): DashboardRole {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  const role = userPayload?.role;
  if (role === "admin" || role === "manager" || role === "assistant") return role;
  return "assistant";
}

function isAdminUser(c: Context): boolean {
  return getDashboardRole(c) === "admin";
}

function requireCapability(c: Context, capability: DashboardCapability) {
  const role = getDashboardRole(c);
  if (ROLE_CAPABILITIES[role].has(capability)) return null;
  return c.json({ success: false, message: "Forbidden: insufficient permissions" }, 403);
}

function hasSessionAccess(c: Context, sessionId: string): boolean {
  const role = getDashboardRole(c);
  if (role === "admin") return true;

  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  const user = findDashboardUserById(String(userPayload?.sub || ""));
  const assignedSessions = user?.assignedSessions || [];
  if (assignedSessions.length === 0) return true;
  return assignedSessions.includes(sessionId);
}

function requireSessionAccess(c: Context, sessionId: string) {
  if (hasSessionAccess(c, sessionId)) return null;
  return c.json(
    { success: false, message: "Forbidden: session is not assigned to your account" },
    403,
  );
}

// Cache package.json at module load
const pkgPath = path.join(process.cwd(), "package.json");
let cachedPkg: Record<string, unknown>;
try {
  cachedPkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
} catch {
  cachedPkg = { name: "Baileys WA API", version: "1.0.0" };
}

dashboardApi.use("*", dashboardAuthMiddleware);

/**
 * GET /dashboard/api/about
 * Project metadata context.
 */
dashboardApi.get("/about", (c) => {
  const isAdmin = isAdminUser(c);
  try {
    const pkg = cachedPkg;
    return c.json({
      success: true,
      data: {
        project: `${pkg.name || "Baileys WA API"}`,
        version: `v${pkg.version || "1.0.0"}`,
        ...(isAdmin
          ? {
              author: `${pkg.author || "KoiN CoDeveloper"}`,
              engine: `Baileys ${
                typeof pkg.dependencies === "object" && pkg.dependencies !== null
                  ? String(
                      (pkg.dependencies as Record<string, unknown>)["@whiskeysockets/baileys"] ||
                        "",
                    ).replace(/[\^~]/, "")
                  : ""
              }`,
              runtime: isBun ? "Bun + Hono" : "Node.js + Hono",
            }
          : {
              infoRestricted: true,
            }),
      },
    });
  } catch (_err) {
    return c.json({
      success: false,
      data: {
        project: "Baileys WA API",
        version: "Unknown",
        author: "KoiN CoDeveloper",
        engine: "Baileys",
        runtime: isBun ? "Bun" : "Node.js",
      },
    });
  }
});

/**
 * GET /dashboard/api/stats
 * Overview statistics.
 */
dashboardApi.get("/stats", (c) => {
  const isAdmin = isAdminUser(c);
  const pkg = cachedPkg;
  const sessions = connectionManager.listSessions();
  return c.json({
    success: true,
    data: {
      totalSessions: sessions.length,
      connectedSessions: sessions.filter((s) => s.connected).length,
      disconnectedSessions: sessions.filter((s) => !s.connected).length,
      version: `v${pkg.version || "1.0.0"}`,
      ...(isAdmin
        ? {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            environment: config.env,
            redisEnabled: config.redis.enabled,
          }
        : {
            infoRestricted: true,
          }),
    },
  });
});

/**
 * GET /dashboard/api/sessions
 * List all sessions with detailed status.
 */
dashboardApi.get("/sessions", (c) => {
  const denied = requireCapability(c, "viewSessions");
  if (denied) return denied;
  const sessions = connectionManager
    .listSessions()
    .filter((session) => hasSessionAccess(c, String(session.sessionId || "")));
  return c.json({ success: true, data: sessions });
});

/**
 * POST /dashboard/api/sessions/:sessionId
 * Create a new session.
 */
dashboardApi.post("/sessions/:sessionId", async (c) => {
  const denied = requireCapability(c, "manageSessions");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const body = await c.req.json().catch(() => ({}));

  try {
    if (body.freshAuth === true) {
      // Force-create with new auth state when requested from dashboard.
      await connectionManager.deleteSession(sessionId);
    }

    const result = await connectionManager.createSession(sessionId, {
      clientName: body.clientName,
      webhookUrl: body.webhookUrl,
      webhookSecret: body.webhookSecret,
      usePairingCode: body.usePairingCode ?? false,
      phoneNumber: body.phoneNumber,
      includeMedia: body.includeMedia,
      syncFullHistory: body.syncFullHistory ?? false,
      autoReply: body.autoReply,
    });

    return c.json({
      success: true,
      message: result.pairingCode ? "Pairing code generated" : "Session created — scan QR code",
      data: result,
    });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * GET /dashboard/api/sessions/:sessionId
 * Get session status.
 */
dashboardApi.get("/sessions/:sessionId", (c) => {
  const denied = requireCapability(c, "viewSessions");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const status = connectionManager.getSessionStatus(sessionId);
  return c.json({ success: true, data: status });
});

/**
 * DELETE /dashboard/api/sessions/:sessionId
 * Delete a session.
 */
dashboardApi.delete("/sessions/:sessionId", async (c) => {
  const denied = requireCapability(c, "manageSessions");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  try {
    await connectionManager.deleteSession(sessionId);
    return c.json({ success: true, message: "Session deleted" });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * PUT /dashboard/api/sessions/:sessionId/webhook
 * Update webhook config for a session.
 */
dashboardApi.put("/sessions/:sessionId/webhook", async (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const body = await c.req.json().catch(() => ({}));
  const webhookUrl = String(body.webhookUrl || "").trim();
  // Use undefined (not empty string) when secret is blank so sendToWebhook
  // falls back to AUTH_GLOBAL_TOKEN.
  const rawSecret = String(body.webhookSecret ?? "").trim();
  const webhookSecret = rawSecret || undefined;
  const events = Array.isArray(body.events)
    ? body.events.map((e: unknown) => String(e).trim()).filter(Boolean)
    : [];

  try {
    const session = connectionManager.getSession(sessionId);
    const nextMetadata = {
      ...session.getSessionMetadata(),
      webhookUrl,
      webhookSecret,
      webhookEvents: events,
    };

    session.updateOptions({ webhookUrl, webhookSecret, webhookEvents: events });
    await updateSessionMetadata(sessionId, nextMetadata);

    return c.json({ success: true, message: "Webhook config updated" });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * POST /dashboard/api/sessions/:sessionId/webhook/test
 * Send a test ping to target webhook URL.
 */
dashboardApi.post("/sessions/:sessionId/webhook/test", async (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const body = await c.req.json().catch(() => ({}));

  try {
    const session = connectionManager.getSession(sessionId);
    const configuredUrl = session.getOptions().webhookUrl || "";
    const configuredSecret = session.getOptions().webhookSecret || config.auth.globalToken || "";
    const webhookUrl = String(body.webhookUrl || configuredUrl).trim();
    const webhookSecret = String(body.webhookSecret || configuredSecret).trim();

    if (!webhookUrl) {
      return c.json({ success: false, message: "Webhook URL is empty" }, 400);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      return c.json(
        {
          success: false,
          message: "Webhook URL is invalid. Use a full URL such as http://127.0.0.1:3001/webhook",
        },
        400,
      );
    }

    // SSRF guard (same policy as live webhook delivery).
    const targetError = validateWebhookTarget(webhookUrl);
    if (targetError) {
      return c.json({ success: false, message: targetError }, 400);
    }

    const payload = {
      type: "dashboard.webhook.test",
      sessionId,
      timestamp: Date.now(),
      connected: session.isConnected,
      user: session.user,
      source: "dashboard",
    };

    const startedAt = Date.now();
    try {
      const rawBody = JSON.stringify(payload);
      const { headers, error: headerError } = buildWebhookHeaders(webhookSecret, rawBody);
      if (headerError) {
        return c.json(
          {
            success: false,
            message:
              "Webhook signature mode is required, but no secret is available (session secret or AUTH_GLOBAL_TOKEN)",
          },
          400,
        );
      }

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(15000), // 15s timeout for test
      });

      if (!response.ok) {
        const latencyMs = Date.now() - startedAt;
        addWebhookLog({
          sessionId,
          event: "dashboard.webhook.test",
          webhookUrl,
          status: "test-fail",
          attempt: 1,
          httpStatus: response.status,
          latencyMs,
          error: `HTTP ${response.status}`,
        });
        return c.json(
          {
            success: false,
            message: `Webhook test failed: HTTP ${response.status} from ${parsedUrl.origin}${parsedUrl.pathname}`,
          },
          502,
        );
      }

      const latencyMs = Date.now() - startedAt;
      addWebhookLog({
        sessionId,
        event: "dashboard.webhook.test",
        webhookUrl,
        status: "test-success",
        attempt: 1,
        httpStatus: response.status,
        latencyMs,
      });

      return c.json({
        success: true,
        message: "Webhook test succeeded",
        data: { status: response.status },
      });
    } catch (err) {
      const errMessage = (err as Error).message;
      const looksLikeTlsCertIssue = /certificate|tls|ssl/i.test(errMessage);
      const looksLikeSocketClosed =
        /socket connection was closed unexpectedly|socket.*closed/i.test(errMessage);

      const hints: string[] = [];
      if (looksLikeTlsCertIssue) {
        hints.push(
          "TLS certificate issue detected. Use a valid certificate chain or HTTP on trusted local network.",
        );
      }
      if (looksLikeSocketClosed) {
        hints.push(
          "Target endpoint closed the connection. Check protocol mismatch (http vs https), server listener, and reverse-proxy upstream settings.",
        );
      }
      if (
        parsedUrl.protocol === "https:" &&
        (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost")
      ) {
        hints.push(
          "For local testing, verify your local server actually serves HTTPS. If not, switch URL to http://...",
        );
      }

      const latencyMs = Date.now() - startedAt;
      const hintText = hints.length ? ` ${hints.join(" ")}` : "";

      addWebhookLog({
        sessionId,
        event: "dashboard.webhook.test",
        webhookUrl,
        status: "test-fail",
        attempt: 1,
        latencyMs,
        error: errMessage,
      });
      return c.json(
        {
          success: false,
          message:
            `Webhook test failed: ${errMessage}. Target: ${parsedUrl.origin}${parsedUrl.pathname}.${hintText}`.trim(),
        },
        502,
      );
    }
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * GET /dashboard/api/webhooks/logs
 * Read webhook delivery logs.
 */
dashboardApi.get("/webhooks/logs", (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  const limit = Number(c.req.query("limit") || "100");
  const sessionId = c.req.query("sessionId") || undefined;
  return c.json({ success: true, data: getWebhookLogs(limit, sessionId) });
});

/**
 * GET /dashboard/api/webhooks/meta
 * Read-only webhook delivery metadata for admin UI.
 */
dashboardApi.get("/webhooks/meta", (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;

  return c.json({
    success: true,
    data: {
      signatureMode: config.webhook.signatureMode,
      authFallback: ["session webhook secret", "AUTH_GLOBAL_TOKEN"],
    },
  });
});

/**
 * POST /dashboard/api/webhooks/logs/clear
 * Clear webhook delivery logs.
 */
dashboardApi.post("/webhooks/logs/clear", (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  clearWebhookLogs();
  return c.json({ success: true, message: "Webhook logs cleared" });
});

/**
 * GET /dashboard/api/webhooks/dead-letter
 * Read dead-letter entries (webhooks that exhausted all retries).
 */
dashboardApi.get("/webhooks/dead-letter", (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  const limit = Number(c.req.query("limit") || "50");
  const sessionId = c.req.query("sessionId") || undefined;
  return c.json({ success: true, data: getDeadLetters(limit, sessionId) });
});

/**
 * POST /dashboard/api/webhooks/dead-letter/:id/retry
 * Replay a single dead-letter delivery.
 */
dashboardApi.post("/webhooks/dead-letter/:id/retry", async (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  const id = c.req.param("id");
  const deliver = async (entry: DeadLetterEntry) => {
    const res = await deliverWebhookOnce(
      entry.webhookUrl,
      entry.payload,
      entry.webhookSecret || "",
      15000,
    );
    return res.ok ? "success" : "failed";
  };
  const result = await replayDeadLetter(id, deliver);
  if (result === "not-found") {
    return c.json({ success: false, message: "Dead-letter entry not found" }, 404);
  }
  return c.json({
    success: result === "success",
    message: result === "success" ? "Dead-letter replayed successfully" : "Replay failed",
  });
});

/**
 * POST /dashboard/api/webhooks/dead-letter/retry-all
 * Replay all queued dead-letters (best-effort).
 */
dashboardApi.post("/webhooks/dead-letter/retry-all", async (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  const { replayed, succeeded } = await replayAllDeadLetters(async (entry: DeadLetterEntry) => {
    const res = await deliverWebhookOnce(
      entry.webhookUrl,
      entry.payload,
      entry.webhookSecret || "",
      15000,
    );
    return res.ok ? "success" : "failed";
  });
  return c.json({
    success: true,
    data: { replayed, succeeded },
    message: `Replayed ${succeeded}/${replayed} dead-letter entries`,
  });
});

/**
 * POST /dashboard/api/webhooks/dead-letter/clear
 * Clear the dead-letter buffer.
 */
dashboardApi.post("/webhooks/dead-letter/clear", (c) => {
  const denied = requireCapability(c, "manageWebhooks");
  if (denied) return denied;
  clearDeadLetters();
  return c.json({ success: true, message: "Dead-letter buffer cleared" });
});

/**
 * POST /dashboard/api/sessions/:sessionId/send
 * Send a message from dashboard.
 */
dashboardApi.post("/sessions/:sessionId/send", async (c) => {
  const denied = requireCapability(c, "sendOutbound");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const body = await c.req.json();
  const { receiver, message, isGroup } = body;

  try {
    const session = connectionManager.getSession(sessionId);
    const { formatPhone, formatGroup } = await import("@/utils/phone");
    const jid = isGroup ? formatGroup(receiver) : formatPhone(receiver);
    const result = await session.sendMessage(jid, message);
    return c.json({
      success: true,
      message: "Message sent",
      data: { key: result?.key },
    });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * GET /dashboard/api/sessions/:sessionId/chats
 * Get chat list from store (default: 1-on-1 only).
 */
dashboardApi.get("/sessions/:sessionId/chats", (c) => {
  const denied = requireCapability(c, "viewChats");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const isGroup = c.req.query("isGroup") === "true";

  try {
    const session = connectionManager.getSession(sessionId);
    const chats = session.getStore().getChatList(isGroup);
    return c.json({ success: true, data: chats });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * GET /dashboard/api/sessions/:sessionId/chats/:jid/messages
 * Get messages from specific chat conversation.
 */
dashboardApi.get("/sessions/:sessionId/chats/:jid/messages", (c) => {
  const denied = requireCapability(c, "viewChats");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const encodedJid = c.req.param("jid");
  const jid = decodeURIComponent(encodedJid);
  const limit = Math.min(Math.max(Number(c.req.query("limit") || "50"), 1), 500);

  try {
    const session = connectionManager.getSession(sessionId);
    const messages = session.getStore().loadMessages(jid, limit);
    return c.json({ success: true, data: messages });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * POST /dashboard/api/sessions/:sessionId/chats/send-text
 * Send a text message to 1-on-1 chat.
 */
dashboardApi.post("/sessions/:sessionId/chats/send-text", async (c) => {
  const denied = requireCapability(c, "replyIncoming");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const role = getDashboardRole(c);
  const body = await c.req.json().catch(() => ({}));
  const receiver = String(body.receiver || "").trim();
  const text = String(body.text || "").trim();
  const isGroup = body.isGroup === true;
  const mentions = Array.isArray(body.mentions)
    ? body.mentions.filter((m: unknown) => typeof m === "string")
    : [];

  if (!receiver) {
    return c.json({ success: false, message: "Receiver is required" }, 400);
  }
  if (!text) {
    return c.json({ success: false, message: "Text message is required" }, 400);
  }

  try {
    const session = connectionManager.getSession(sessionId);
    const { formatPhone, formatGroup } = await import("@/utils/phone");
    const jid = receiver.includes("@")
      ? receiver
      : isGroup
        ? formatGroup(receiver)
        : formatPhone(receiver);

    if (role === "assistant") {
      if (isGroup) {
        return c.json(
          {
            success: false,
            message: "Forbidden: assistant role is limited to reply-only 1-on-1 chats",
          },
          403,
        );
      }

      const recentMessages = session.getStore().loadMessages(jid, 50);
      const hasInboundContext = recentMessages.some((message) => !message.key.fromMe);
      if (!hasInboundContext) {
        return c.json(
          {
            success: false,
            message: "Forbidden: assistant role may only reply to an existing inbound conversation",
          },
          403,
        );
      }
    }

    const result = await session.sendMessage(
      jid,
      {
        text,
        mentions: mentions.length > 0 ? mentions : undefined,
      },
      {
        simulateTyping: false,
      },
    );
    return c.json({
      success: true,
      message: "Message sent",
      data: { key: result?.key, messageTimestamp: result?.messageTimestamp },
    });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * POST /dashboard/api/sessions/:sessionId/chats/presence
 * Send presence update for a chat target (typing, recording, paused, etc.).
 */
dashboardApi.post("/sessions/:sessionId/chats/presence", async (c) => {
  const denied = requireCapability(c, "replyIncoming");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const body = await c.req.json().catch(() => ({}));
  const type = String(body.type || "").trim();
  const rawJid = String(body.jid || "").trim();

  const allowedTypes = new Set(["available", "unavailable", "composing", "recording", "paused"]);
  if (!allowedTypes.has(type)) {
    return c.json({ success: false, message: "Invalid presence type" }, 400);
  }

  if (["composing", "recording", "paused"].includes(type) && !rawJid) {
    return c.json({ success: false, message: "jid is required for chat presence type" }, 400);
  }

  try {
    const session = connectionManager.getSession(sessionId);
    let targetJid: string | undefined;
    if (rawJid) {
      const { formatPhone, formatGroup } = await import("@/utils/phone");
      targetJid = rawJid.includes("@")
        ? rawJid
        : body.isGroup === true
          ? formatGroup(rawJid)
          : formatPhone(rawJid);
    }

    await session.sendPresenceUpdate(type as WAPresence, targetJid);
    return c.json({ success: true, message: "Presence updated" });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * POST /dashboard/api/sessions/:sessionId/chats/:jid/read
 * Mark unread messages in the chat as read (dashboard safety helper).
 */
dashboardApi.post("/sessions/:sessionId/chats/:jid/read", async (c) => {
  const denied = requireCapability(c, "viewChats");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const jid = decodeURIComponent(c.req.param("jid"));
  const limit = Math.min(Math.max(Number(c.req.query("limit") || "120"), 1), 500);

  try {
    const session = connectionManager.getSession(sessionId);
    const messages = session.getStore().loadMessages(jid, limit);
    const unreadKeys = messages
      .filter((m) => !m.key.fromMe && m.key.id)
      .map((m) => ({
        remoteJid: m.key.remoteJid,
        id: m.key.id,
        participant: m.key.participant,
        fromMe: false,
      }));

    if (unreadKeys.length > 0) {
      await session.readMessages(unreadKeys as proto.IMessageKey[]);
    }

    return c.json({
      success: true,
      message: unreadKeys.length > 0 ? "Messages marked as read" : "No unread messages",
      data: { readCount: unreadKeys.length },
    });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * GET /dashboard/api/sessions/:sessionId/groups/:jid/members
 * Get basic group members metadata.
 */
dashboardApi.get("/sessions/:sessionId/groups/:jid/members", async (c) => {
  const denied = requireCapability(c, "viewChats");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const jid = decodeURIComponent(c.req.param("jid"));

  try {
    const session = connectionManager.getSession(sessionId);
    const metadata = await session.groupMetadata(jid);

    return c.json({
      success: true,
      data: {
        id: metadata.id,
        subject: metadata.subject,
        participants: (metadata.participants || []).map((p) => ({
          id: p.id,
          admin: p.admin || null,
        })),
      },
    });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * GET /dashboard/api/groups/:sessionId/list
 * List groups for dashboard Groups page.
 */
dashboardApi.get("/groups/:sessionId/list", async (c) => {
  const denied = requireCapability(c, "viewChats");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;

  try {
    const session = connectionManager.getSession(sessionId);
    const groups = await session.groupFetchAllParticipating();
    const groupList = Object.values(groups || {}).map((group) => {
      const g = group as { id?: string; subject?: string; participants?: unknown[] };
      return {
        id: g.id,
        subject: g.subject,
        participants: g.participants || [],
        size: Array.isArray(g.participants) ? g.participants.length : undefined,
      };
    });

    return c.json({ success: true, data: groupList });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * POST /dashboard/api/groups/:sessionId/create
 * Create a group for dashboard Groups page.
 */
dashboardApi.post("/groups/:sessionId/create", async (c) => {
  const denied = requireCapability(c, "manageGroups");
  if (denied) return denied;
  const sessionId = c.req.param("sessionId");
  const sessionDenied = requireSessionAccess(c, sessionId);
  if (sessionDenied) return sessionDenied;
  const body = await c.req.json().catch(() => ({}));
  const groupName = String(body.groupName || "").trim();
  const participants = Array.isArray(body.participants)
    ? body.participants.map((p: unknown) => String(p).trim()).filter(Boolean)
    : [];

  if (!groupName) {
    return c.json({ success: false, message: "Group name is required" }, 400);
  }
  if (participants.length === 0) {
    return c.json({ success: false, message: "At least one participant is required" }, 400);
  }

  try {
    const session = connectionManager.getSession(sessionId);
    const { formatPhone } = await import("@/utils/phone");
    const normalizedParticipants = participants.map((p: string) => formatPhone(p));
    const result = await session.groupCreate(groupName, normalizedParticipants);

    return c.json({
      success: true,
      message: "Group created",
      data: {
        id: result.id,
        subject: result.subject,
        participants: result.participants || [],
      },
    });
  } catch (err) {
    return c.json({ success: false, message: (err as Error).message }, 500);
  }
});

/**
 * GET /dashboard/api/events/stream
 * SSE endpoint for real-time event monitoring.
 */
dashboardApi.get("/events/stream", (c) => {
  const denied = requireCapability(c, "viewChats");
  if (denied) return denied;
  return streamSSE(c, async (stream) => {
    const sessionFilter = c.req.query("session");
    const eventFilter = c.req.query("event");

    const handler = (ev: DashboardEvent) => {
      if (sessionFilter && ev.sessionId !== sessionFilter) return;
      if (eventFilter && !ev.event.includes(eventFilter)) return;

      stream.writeSSE({
        event: "baileys-event",
        data: JSON.stringify(ev),
        id: `${ev.timestamp}`,
      });
    };

    eventBus.on("baileys-event", handler);

    // Send heartbeat
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: "heartbeat", data: new Date().toISOString() });
    }, 30000);

    // Keep alive until client disconnects
    stream.onAbort(() => {
      eventBus.off("baileys-event", handler);
      clearInterval(heartbeat);
    });

    // Wait indefinitely (stream stays open)
    await new Promise(() => {});
  });
});

/**
 * GET /dashboard/api/events/recent
 * Get recent events (non-SSE).
 */
dashboardApi.get("/events/recent", (c) => {
  const denied = requireCapability(c, "viewChats");
  if (denied) return denied;
  const limit = Number(c.req.query("limit") || 50);
  const events = eventBus.getRecentEvents(limit);
  return c.json({ success: true, data: events });
});

/**
 * POST /dashboard/api/events/clear
 * Clear event buffer.
 */
dashboardApi.post("/events/clear", (c) => {
  const denied = requireCapability(c, "manageEvents");
  if (denied) return denied;
  eventBus.clearEvents();
  return c.json({ success: true, message: "Events cleared" });
});

/**
 * GET /dashboard/api/config/simulation
 * Get WA Web behavior simulation settings (read-only).
 */
dashboardApi.get("/config/simulation", (c) => {
  if (!isAdminUser(c)) {
    return c.json({ success: false, message: "Forbidden: admin access required" }, 403);
  }
  return c.json({
    success: true,
    data: {
      typingBeforeSend: config.simulation.typingBeforeSend,
      typingDelayMinMs: config.simulation.typingDelayMinMs,
      typingDelayMaxMs: config.simulation.typingDelayMaxMs,
      autoReadMessages: config.simulation.autoReadMessages,
      autoMarkOnline: config.simulation.autoMarkOnline,
      rejectCalls: config.simulation.rejectCalls,
    },
  });
});

export default dashboardApi;
