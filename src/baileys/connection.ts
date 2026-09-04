import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Boom } from "@hapi/boom";
import { humanizeReadBeforeReply, resolveHumanizeOptions } from "@/baileys/replyEngine";
import makeWASocket, {
  type AnyMessageContent,
  type BaileysEventMap,
  Browsers,
  type ChatModification,
  type ConnectionState,
  DisconnectReason,
  delay,
  fetchLatestBaileysVersion,
  type MessageReceiptType,
  makeCacheableSignalKeyStore,
  type ParticipantAction,
  type proto,
  type WAMessage,
  WAMessageStatus,
  type WAPresence,
} from "@whiskeysockets/baileys";
import { LRUCache } from "lru-cache";
import NodeCache from "node-cache";
import { toDataURL } from "qrcode";
import { type AuthStateResult, useAuthState } from "@/baileys/authState";
import { downloadMediaFromMessages } from "@/baileys/helpers/downloadMedia";
import { shouldIgnoreJid } from "@/baileys/helpers/shouldIgnoreJid";
import { MemoryStore } from "@/baileys/store/memoryStore";
import type { SessionMetadata, SessionOptions, WebhookPayload } from "@/baileys/types";
import config from "@/config";
import eventBus from "@/dashboard/eventBus";
import logger, { baileysLogger, deepSanitizeObject } from "@/lib/logger";
import { addWebhookLog } from "@/services/webhookLog";
import { addToDeadLetter } from "@/services/webhookDeadLetter";
import { webhookQueue, webhookRateLimiter, webhookCircuitBreaker } from "@/services/webhookQueue";
import { asyncSleep } from "@/utils/asyncSleep";
import { errorToString } from "@/utils/validation";

const msgRetryCounterCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
});

const autoReplyCooldownCache = new NodeCache({
  stdTTL: 300,
  checkperiod: 60,
});

const autoReplyBurstCache = new NodeCache({
  stdTTL: 30,
  checkperiod: 30,
});

export class BaileysNotConnectedError extends Error {
  constructor() {
    super("Session is not connected");
  }
}

const LOGGER_OMIT_KEYS = [
  "qr",
  "qrDataUrl",
  "fileSha256",
  "jpegThumbnail",
  "fileEncSha256",
  "scansSidecar",
  "midQualityFileSha256",
  "mediaKey",
  "senderKeyHash",
  "recipientKeyHash",
  "messageSecret",
  "thumbnailSha256",
  "thumbnailEncSha256",
  "appStateSyncKeyShare",
];

/**
 * Parse an HTTP Retry-After header (seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent/unparseable so callers fall back to their
 * own backoff schedule.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    // Cap at 5 minutes so a misbehaving server can't stall the queue forever.
    return Math.min(Math.round(seconds * 1000), 300000);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    const ms = parsed - Date.now();
    return ms > 0 ? Math.min(ms, 300000) : undefined;
  }
  return undefined;
}

/**
 * Validate an outbound webhook target before fetching it (SSRF guard).
 * - Non-http(s) schemes are always rejected (file:, ftp:, gopher:, ...).
 * - Internal/private-network targets (localhost, RFC1918, link-local, cloud
 *   metadata 169.254.169.254) are rejected only when WEBHOOK_BLOCK_INTERNAL
 *   is enabled — default allows them so local receivers keep working.
 * Returns an error message when the URL must be rejected, else null.
 */
export function validateWebhookTarget(webhookUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return "Invalid webhook URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported webhook URL scheme: ${url.protocol}`;
  }
  if (!config.webhook.blockInternal) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isInternal =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    host.startsWith("0.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal";
  return isInternal ? `Blocked internal/private webhook target: ${host}` : null;
}

export class BaileysConnection {
  public sessionId: string;
  private options: SessionOptions;
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private authResult: AuthStateResult | null = null;
  private store: MemoryStore;
  private reconnectCount = 0;
  private clearOnlinePresenceTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Last time a "composing" presence was sent per chat (for presence dedupe). */
  private lastComposingAt = new Map<string, number>();
  private _isConnected = false;
  private _qrCode: string | null = null;
  private _pairingCode: string | null = null;

  constructor(sessionId: string, options: SessionOptions) {
    this.sessionId = sessionId;
    this.options = options;
    this.store = new MemoryStore({ sessionId });
  }

  get isConnected(): boolean {
    return this._isConnected && this.socket !== null;
  }

  get qrCode(): string | null {
    return this._qrCode;
  }

  get pairingCode(): string | null {
    return this._pairingCode;
  }

  get user() {
    return this.socket?.user ?? null;
  }

  updateOptions(options: Partial<SessionOptions>) {
    this.options = { ...this.options, ...options };
  }

  getOptions(): SessionOptions {
    return { ...this.options };
  }

  getSessionMetadata(): SessionMetadata {
    return {
      clientName: this.options.clientName,
      webhookUrl: this.options.webhookUrl,
      webhookSecret: this.options.webhookSecret,
      webhookEvents: this.options.webhookEvents,
      includeMedia: this.options.includeMedia,
      syncFullHistory: this.options.syncFullHistory,
      autoReply: this.options.autoReply,
    };
  }

  async connect(): Promise<{ qrCode?: string; pairingCode?: string }> {
    if (this.socket) return {};

    const metadata: SessionMetadata = {
      clientName: this.options.clientName,
      webhookUrl: this.options.webhookUrl,
      webhookSecret: this.options.webhookSecret,
      webhookEvents: this.options.webhookEvents,
      includeMedia: this.options.includeMedia,
      syncFullHistory: this.options.syncFullHistory,
    };

    this.authResult = await useAuthState(this.sessionId, metadata);
    const { state, saveCreds } = this.authResult;

    let version: [number, number, number] | undefined;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
      logger.info(
        "[%s] Using WA v%s (isLatest: %s)",
        this.sessionId,
        version.join("."),
        result.isLatest,
      );
    } catch (error) {
      logger.warn(
        "[%s] Failed to fetch WA version, using default: %s",
        this.sessionId,
        errorToString(error),
      );
    }

    // Load store from file
    await this.store.readFromFile();

    try {
      this.socket = makeWASocket({
        version,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        logger: baileysLogger,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        browser: Browsers.windows(this.options.clientName || "Chrome"),
        syncFullHistory: this.options.syncFullHistory ?? false,
        shouldIgnoreJid: (jid: string) => shouldIgnoreJid(jid),
        getMessage: async (key) => {
          if (!key.remoteJid || !key.id) return undefined;
          const msg = this.store.getMessage(key.remoteJid, key.id);
          return msg?.message || undefined;
        },
      });
    } catch (error) {
      logger.error("[%s] Failed to create socket: %s", this.sessionId, errorToString(error));
      this.options.onConnectionClose?.();
      return {};
    }

    this.store.bind(this.socket.ev);
    this.addEventListeners(saveCreds);

    // Handle pairing code
    if (this.options.usePairingCode && this.options.phoneNumber && !state.creds.registered) {
      if (!state.creds.account) {
        // Wait for the first QR to be generated before requesting pairing code
        await new Promise<void>((resolve) => {
          this.socket?.ev.on("connection.update", (update) => {
            if (update.qr) resolve();
          });
        });
        const code = await this.socket.requestPairingCode(this.options.phoneNumber);
        this._pairingCode = code;
        return { pairingCode: code };
      }
    }

    return {};
  }

  private addEventListeners(saveCreds: () => Promise<void>) {
    if (!this.socket) return;

    this.socket.ev.on("creds.update", saveCreds);

    // Connection events
    this.socket.ev.on("connection.update", async (update) => {
      await this.handleConnectionUpdate(update);
    });

    // Message events
    this.socket.ev.on("messages.upsert", async (m) => {
      await this.handleMessagesUpsert(m);
    });

    this.socket.ev.on("messages.update", async (m) => {
      await this.handleMessagesUpdate(m);
    });

    this.socket.ev.on("messages.delete", (m) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "messages.delete", data: m });
    });

    this.socket.ev.on("messages.reaction", (m) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "messages.reaction", data: m });
    });

    this.socket.ev.on("messages.media-update", (m) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "messages.media-update", data: m });
    });

    this.socket.ev.on("message-receipt.update", async (m) => {
      await this.handleMessageReceiptUpdate(m);
    });

    // Chat events
    this.socket.ev.on("chats.upsert", (c) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "chats.upsert", data: c });
    });

    this.socket.ev.on("chats.update", (c) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "chats.update", data: c });
    });

    this.socket.ev.on("chats.delete", (c) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "chats.delete", data: c });
    });

    // Contact events
    this.socket.ev.on("contacts.upsert", (c) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "contacts.upsert", data: c });
    });

    this.socket.ev.on("contacts.update", (c) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "contacts.update", data: c });
    });

    // Group events
    this.socket.ev.on("groups.upsert", (g) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "groups.upsert", data: g });
    });

    this.socket.ev.on("groups.update", (g) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "groups.update", data: g });
    });

    this.socket.ev.on("group-participants.update", (g) => {
      this.sendToWebhook({
        sessionId: this.sessionId,
        event: "group-participants.update",
        data: g,
      });
    });

    // Presence & labels
    // Presence state tracking to filter anomalous "paused" events
    /**
     * Map: chatJid -> userJid -> lastPresenceType
     * Example: presenceState[chatJid][userJid] = "composing" | "recording" | "paused" | ...
     */
    const presenceState = new LRUCache<string, number>({
      max: 1000,
      ttl: 1000 * 60 * 60, // 1 hour TTL
    });

    this.socket.ev.on("presence.update", (p) => {
      // Throttle presence webhook events (often very noisy)
      const now = Date.now();
      const last = presenceState.get(p.id) || 0;
      // Emit if offline -> online, or if it's been more than 5 seconds since last update
      const shouldEmit = p.presences[p.id]?.lastKnownPresence === "available" || now - last > 5000;

      if (shouldEmit) {
        presenceState.set(p.id, now);
        this.sendToWebhook({ sessionId: this.sessionId, event: "presence.update", data: p });
      }
    });

    this.socket.ev.on("call", async (calls) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "call", data: calls });

      if (config.simulation.rejectCalls) {
        for (const call of calls) {
          if (call.status === "offer") {
            try {
              await this.socket?.rejectCall(call.id, call.from);
              logger.info("[%s] Auto-rejected call from %s", this.sessionId, call.from);
            } catch (err) {
              logger.error(
                "[%s] Failed to reject call from %s: %s",
                this.sessionId,
                call.from,
                errorToString(err),
              );
            }
          }
        }
      }
    });

    this.socket.ev.on("labels.edit", (l) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "labels.edit", data: l });
    });

    this.socket.ev.on("labels.association", (l) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "labels.association", data: l });
    });

    // Blocklist
    this.socket.ev.on("blocklist.set", (b) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "blocklist.set", data: b });
    });

    this.socket.ev.on("blocklist.update", (b) => {
      this.sendToWebhook({ sessionId: this.sessionId, event: "blocklist.update", data: b });
    });

    // History sync
    this.socket.ev.on("messaging-history.set", (h) => {
      if (this.options.syncFullHistory) {
        this.sendToWebhook({ sessionId: this.sessionId, event: "messaging-history.set", data: h });
      }
    });
  }

  // ──────────────────────────────────────
  // Event Handlers
  // ──────────────────────────────────────

  private async handleConnectionUpdate(update: Partial<ConnectionState>) {
    const { connection, lastDisconnect, qr } = update;

    if (connection === "open") {
      this._isConnected = true;
      this._qrCode = null;
      this.reconnectCount = 0;
      logger.info("[%s] Connected successfully", this.sessionId);
    }

    if (connection === "close") {
      this._isConnected = false;
      const error = lastDisconnect?.error as Boom;
      const statusCode = error?.output?.statusCode;
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        this.reconnectCount < config.baileys.maxRetries;

      if (shouldReconnect) {
        this.reconnectCount++;
        logger.info(
          "[%s] Reconnecting (attempt %d/%d)...",
          this.sessionId,
          this.reconnectCount,
          config.baileys.maxRetries,
        );
        this.socket = null;
        setTimeout(
          () => {
            this.connect().catch((err) => {
              logger.error("[%s] Reconnection failed: %s", this.sessionId, errorToString(err));
            });
          },
          statusCode === DisconnectReason.restartRequired ? 0 : config.baileys.reconnectInterval,
        );
        return;
      }

      logger.info(
        "[%s] Connection closed permanently (statusCode: %d)",
        this.sessionId,
        statusCode,
      );
      await this.close();
      return;
    }

    if (qr) {
      this._qrCode = await toDataURL(qr);
      this.sendToWebhook({
        sessionId: this.sessionId,
        event: "connection.update",
        data: { ...update, qrDataUrl: this._qrCode },
      });
      return;
    }

    this.sendToWebhook({
      sessionId: this.sessionId,
      event: "connection.update",
      data: update,
    });
  }

  private async handleMessagesUpsert(data: BaileysEventMap["messages.upsert"]) {
    // Auto-read incoming messages if enabled (like WA Web read-receipts toggle)
    const shouldAutoRead = this.options.autoReadMessages ?? config.simulation.autoReadMessages;
    if (shouldAutoRead) {
      const incomingKeys = data.messages
        .filter((m) => !m.key.fromMe && m.key.remoteJid)
        .map((m) => m.key);
      if (incomingKeys.length > 0) {
        try {
          // Humanize: simulate a natural "opened chat" delay before marking read
          // (unless AUTO_READ_DELAY_ENABLED=false → read instantly, legacy).
          const arDelay = config.simulation.autoReadDelayEnabled;
          const arLo = config.simulation.autoReadDelayMinMs;
          const arHi = config.simulation.autoReadDelayMaxMs;
          if (arDelay && arHi > 0 && arHi >= arLo) {
            const waitMs = Math.floor(Math.random() * (arHi - arLo) + arLo);
            logger.debug(
              "[%s] Auto-read delay %dms before marking %d read",
              this.sessionId,
              waitMs,
              incomingKeys.length,
            );
            await delay(waitMs);
          }
          await this.readMessages(incomingKeys);
          logger.debug(
            "[%s] Auto-read %d incoming message(s)",
            this.sessionId,
            incomingKeys.length,
          );
        } catch (err) {
          logger.error("[%s] Auto-read failed: %s", this.sessionId, errorToString(err));
        }
      }
    }

    const payload: WebhookPayload = {
      sessionId: this.sessionId,
      event: "messages.upsert",
      data,
    };

    // Download media if configured
    const includeMedia = this.options.includeMedia ?? config.media.includeBase64;
    if (includeMedia) {
      try {
        const media = await downloadMediaFromMessages(data.messages, { includeBase64: true });
        if (media) {
          payload.extra = { media };
        }
      } catch (error) {
        logger.error("[%s] Media download error: %s", this.sessionId, errorToString(error));
      }
    }

    const webhookResult = await this.sendToWebhook(payload);

    // Auto-reply logic
    await this.handleAutoReply(data, webhookResult === "failed");
  }

  /**
   * Handles auto-reply logic based on session or global configuration.
   */
  private async handleAutoReply(data: BaileysEventMap["messages.upsert"], webhookFailed: boolean) {
    const autoReply = this.options.autoReply ?? config.autoReply;
    if (!autoReply.enabled) return;

    // Only reply to incoming messages from others
    const messages = data.messages.filter(
      (m) => !m.key.fromMe && m.key.remoteJid && !shouldIgnoreJid(m.key.remoteJid),
    );
    if (messages.length === 0) return;

    let shouldReply = false;
    if (autoReply.type === "always") {
      shouldReply = true;
    } else if (autoReply.type === "on_webhook_fail") {
      shouldReply = webhookFailed;
    } else if (autoReply.type === "time_range") {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const { timeStart, timeEnd } = autoReply;

      if (timeStart && timeEnd) {
        if (timeStart <= timeEnd) {
          // Normal range (e.g., 08:00 - 17:00)
          shouldReply = currentTime >= timeStart && currentTime <= timeEnd;
        } else {
          // Overnight range (e.g., 22:00 - 06:00)
          shouldReply = currentTime >= timeStart || currentTime <= timeEnd;
        }
      }
    }

    if (shouldReply) {
      for (const m of messages) {
        try {
          const remoteJid = m.key.remoteJid;
          if (!remoteJid) continue;

          const cooldownKey = `${this.sessionId}:cooldown:${remoteJid}`;
          const burstKey = `${this.sessionId}:burst:${remoteJid}:${m.key.id || "unknown"}`;
          if (autoReplyCooldownCache.has(cooldownKey) || autoReplyBurstCache.has(burstKey)) {
            logger.debug(
              "[%s] Skipping auto-reply to %s due to cooldown/dedupe",
              this.sessionId,
              remoteJid,
            );
            continue;
          }

          autoReplyBurstCache.set(burstKey, true);
          autoReplyCooldownCache.set(cooldownKey, true);

          await this.humanizeReadStep(m);

          logger.info("[%s] Sending auto-reply to %s", this.sessionId, remoteJid);
          await this.sendMessage(remoteJid, { text: autoReply.message }, { quoted: m });
        } catch (err) {
          logger.error("[%s] Failed to send auto-reply: %s", this.sessionId, errorToString(err));
        }
      }
    }
  }

  /**
   * Humanized read-before-reply, for 1-on-1 chats only (not groups).
   * Waits a natural "reading" gap then marks the message as read, so an
   * auto-reply does not fire instantly with no prior read receipt.
   * No-op unless the feature is enabled via config.
   */
  private async humanizeReadStep(m: WAMessage) {
    const remoteJid = m.key.remoteJid;
    if (!remoteJid || remoteJid.endsWith("@g.us")) return;

    const humanize = resolveHumanizeOptions(m);
    if (!humanize) return;

    try {
      const sock = this.safeSocket();
      await humanizeReadBeforeReply(humanize, {
        markRead: () => sock.readMessages([m.key]),
        setPresence: async () => {},
      });
    } catch (err) {
      logger.debug("[%s] Humanize read step skipped: %s", this.sessionId, errorToString(err));
    }
  }

  private async handleMessagesUpdate(data: BaileysEventMap["messages.update"]) {
    const enriched = data.map(({ key, update }) => ({
      key,
      update: {
        ...update,
        status: update.status ? WAMessageStatus[update.status] : undefined,
      },
    }));
    this.sendToWebhook({ sessionId: this.sessionId, event: "messages.update", data: enriched });
  }

  private async handleMessageReceiptUpdate(data: BaileysEventMap["message-receipt.update"]) {
    // Emit to dashboard event bus (for SSE monitor) so frontend can update message status
    eventBus.emit("baileys-event", {
      sessionId: this.sessionId,
      event: "message-receipt.update",
      data,
      timestamp: Date.now(),
    });

    this.sendToWebhook({ sessionId: this.sessionId, event: "message-receipt.update", data });
  }

  // ──────────────────────────────────────
  // Public API Methods
  // ──────────────────────────────────────

  private safeSocket() {
    if (!this.socket) throw new BaileysNotConnectedError();
    return this.socket;
  }

  async sendMessage(
    receiver: string,
    message: AnyMessageContent,
    options?: { quoted?: WAMessage; simulateTyping?: boolean },
  ) {
    const shouldSimulateTyping =
      options?.simulateTyping ?? this.options.simulateTyping ?? config.simulation.typingBeforeSend;
    const hz = config.humanize;

    if (shouldSimulateTyping) {
      try {
        // Humanize: random "thinking" gap before typing starts (only when enabled)
        const thinkMin = hz.thinkMinMs > 0 ? hz.thinkMinMs : 0;
        const thinkMax = hz.thinkMaxMs >= thinkMin ? hz.thinkMaxMs : thinkMin;
        if (thinkMin > 0) {
          const thinkMs = Math.floor(Math.random() * (thinkMax - thinkMin) + thinkMin);
          logger.debug("[%s] Humanize think gap %dms → %s", this.sessionId, thinkMs, receiver);
          await delay(thinkMs);
        }

        // Typing duration: proportional to reply length when enabled, otherwise
        // the legacy fixed random range.
        const msgText =
          typeof (message as { text?: string }).text === "string"
            ? ((message as { text?: string }).text as string)
            : "";
        const msgLen = msgText.length;
        let delayMs: number;
        if (hz.typingProportional && msgLen > 0) {
          const base = 600;
          const typed = (msgLen / 4) * 1000; // ~4 chars/sec human typing
          delayMs = Math.min(
            Math.max(base + typed, 800),
            config.simulation.typingDelayMaxMs || 6000,
          );
        } else {
          delayMs = Math.floor(
            Math.random() *
              (config.simulation.typingDelayMaxMs - config.simulation.typingDelayMinMs) +
              config.simulation.typingDelayMinMs,
          );
        }

        // Humanize presence dedupe: skip re-sending composing/paused to the SAME
        // chat if we toggled recently (avoids rapid bubble flicker).
        // 0 = always send (legacy).
        const dedupeMs = hz.presenceDedupeMs;
        const lastComposing = this.lastComposingAt.get(receiver) || 0;
        const withinDedupe = dedupeMs > 0 && Date.now() - lastComposing < dedupeMs;

        if (!withinDedupe) {
          // Mark as "available" first (like opening WA Web)
          if (config.simulation.autoMarkOnline) {
            await this.sendPresenceUpdate("available", receiver);
          }
          // Subscribe to presence & send "composing" indicator
          await this.safeSocket().presenceSubscribe(receiver);
          await this.sendPresenceUpdate("composing", receiver);

          logger.debug("[%s] Simulating typing for %dms to %s", this.sessionId, delayMs, receiver);
          await delay(delayMs);

          // Clear composing indicator
          await this.sendPresenceUpdate("paused", receiver);
          this.lastComposingAt.set(receiver, Date.now());
        } else {
          // Still wait a plausible typing duration, but no bubble re-toggle.
          logger.debug(
            "[%s] Presence dedupe active — typing %dms without bubble to %s",
            this.sessionId,
            delayMs,
            receiver,
          );
          await delay(delayMs);
        }
      } catch (err) {
        logger.warn(
          "[%s] Typing simulation error (non-fatal): %s",
          this.sessionId,
          errorToString(err),
        );
      }
    }

    // Humanize: global pacing — random min/max gap between ANY outbound actions
    // within a session (across chats) to avoid bursts. 0/0 = off (legacy).
    const paceMin = hz.globalPacingMinMs;
    const paceMax = hz.globalPacingMaxMs;
    if (paceMin > 0 && paceMax >= paceMin) {
      const paceMs = Math.floor(Math.random() * (paceMax - paceMin) + paceMin);
      logger.debug("[%s] Global pacing gap %dms", this.sessionId, paceMs);
      await delay(paceMs);
    }

    return this.safeSocket().sendMessage(receiver, message, { quoted: options?.quoted });
  }

  async sendMessageWithDelay(receiver: string, message: AnyMessageContent, delayMs = 1000) {
    await delay(delayMs);
    return this.safeSocket().sendMessage(receiver, message);
  }

  async sendPresenceUpdate(type: WAPresence, toJid?: string) {
    if (!this.safeSocket().authState.creds.me) return;

    await this.safeSocket().sendPresenceUpdate(type, toJid);

    // Auto-clear online presence
    if (this.clearOnlinePresenceTimeout && ["unavailable", "available"].includes(type)) {
      clearTimeout(this.clearOnlinePresenceTimeout);
      this.clearOnlinePresenceTimeout = null;
    }
    if (type === "available") {
      this.clearOnlinePresenceTimeout = setTimeout(() => {
        this.socket?.sendPresenceUpdate("unavailable", toJid);
      }, 60000);
    }
  }

  async readMessages(keys: proto.IMessageKey[]) {
    return this.safeSocket().readMessages(keys);
  }

  async deleteMessage(jid: string, key: proto.IMessageKey & { id: string }) {
    return this.safeSocket().sendMessage(jid, { delete: key });
  }

  async editMessage(jid: string, key: proto.IMessageKey, messageContent: AnyMessageContent) {
    return this.safeSocket().sendMessage(jid, {
      ...messageContent,
      edit: key,
    } as AnyMessageContent);
  }

  async chatModify(mod: ChatModification, jid: string) {
    return this.safeSocket().chatModify(mod, jid);
  }

  async fetchMessageHistory(
    count: number,
    oldestMsgKey: proto.IMessageKey,
    oldestMsgTimestamp: number,
  ) {
    return this.safeSocket().fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp);
  }

  async sendReceipts(keys: proto.IMessageKey[], type: MessageReceiptType) {
    return this.safeSocket().sendReceipts(keys, type);
  }

  async onWhatsApp(...jids: string[]) {
    return this.safeSocket().onWhatsApp(...jids);
  }

  async isOnWhatsApp(jid: string): Promise<boolean> {
    try {
      const results = await this.safeSocket().onWhatsApp(jid);
      return results?.[0]?.exists ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Batch WhatsApp-registration check (fewer usync queries to WA than 1-by-1).
   * Chunks into safe batches (Baileys caps onWhatsApp per call), and on any
   * error falls back to checking the remaining jids individually so a single
   * failure never aborts a broadcast. Returns a Set of registered jids.
   */
  async checkOnWhatsAppBatch(jids: string[]): Promise<Set<string>> {
    const registered = new Set<string>();
    const CHUNK = 50;
    for (let i = 0; i < jids.length; i += CHUNK) {
      const chunk = jids.slice(i, i + CHUNK);
      try {
        const results = await this.safeSocket().onWhatsApp(...chunk);
        for (const r of results ?? []) {
          if (r?.exists && r.jid) registered.add(r.jid);
        }
      } catch (err) {
        logger.warn(
          "[%s] Batch WA-check failed (%d jids), falling back 1-by-1: %s",
          this.sessionId,
          chunk.length,
          errorToString(err),
        );
        for (const jid of chunk) {
          const ok = await this.isOnWhatsApp(jid);
          if (ok) registered.add(jid);
        }
      }
    }
    return registered;
  }

  async profilePictureUrl(jid: string, type?: "preview" | "image") {
    return this.safeSocket().profilePictureUrl(jid, type);
  }

  async updateProfilePicture(jid: string, image: { url: string } | Buffer) {
    return this.safeSocket().updateProfilePicture(jid, image);
  }

  async updateProfileStatus(status: string) {
    return this.safeSocket().updateProfileStatus(status);
  }

  async updateProfileName(name: string) {
    return this.safeSocket().updateProfileName(name);
  }

  async fetchStatus(jid: string) {
    return this.safeSocket().fetchStatus(jid);
  }

  async updateBlockStatus(jid: string, action: "block" | "unblock") {
    return this.safeSocket().updateBlockStatus(jid, action);
  }

  // Group operations
  async groupCreate(name: string, participants: string[]) {
    return this.safeSocket().groupCreate(name, participants);
  }

  async groupMetadata(jid: string) {
    return this.safeSocket().groupMetadata(jid);
  }

  async groupFetchAllParticipating() {
    return this.safeSocket().groupFetchAllParticipating();
  }

  async groupParticipantsUpdate(jid: string, participants: string[], action: ParticipantAction) {
    return this.safeSocket().groupParticipantsUpdate(jid, participants, action);
  }

  async groupUpdateSubject(jid: string, subject: string) {
    return this.safeSocket().groupUpdateSubject(jid, subject);
  }

  async groupUpdateDescription(jid: string, description?: string) {
    return this.safeSocket().groupUpdateDescription(jid, description);
  }

  async groupSettingUpdate(
    jid: string,
    setting: "announcement" | "not_announcement" | "locked" | "unlocked",
  ) {
    return this.safeSocket().groupSettingUpdate(jid, setting);
  }

  async groupLeave(jid: string) {
    return this.safeSocket().groupLeave(jid);
  }

  async groupInviteCode(jid: string) {
    return this.safeSocket().groupInviteCode(jid);
  }

  async groupRevokeInvite(jid: string) {
    return this.safeSocket().groupRevokeInvite(jid);
  }

  async groupAcceptInvite(code: string) {
    return this.safeSocket().groupAcceptInvite(code);
  }

  // Store access
  getStore(): MemoryStore {
    return this.store;
  }

  // ──────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────

  private async close() {
    if (this.authResult?.clearState) {
      await this.authResult.clearState();
    }
    this.socket = null;
    this._isConnected = false;
    this.reconnectCount = 0;
    if (this.clearOnlinePresenceTimeout) {
      clearTimeout(this.clearOnlinePresenceTimeout);
      this.clearOnlinePresenceTimeout = null;
    }
    await this.store.destroy();
    this.options.onConnectionClose?.();
  }

  async logout() {
    try {
      await this.safeSocket().logout();
    } catch (error) {
      logger.error("[%s] Logout error: %s", this.sessionId, errorToString(error));
    }
    await this.close();
  }

  async destroy() {
    await this.close();
  }

  // ──────────────────────────────────────
  // Webhook
  // ──────────────────────────────────────

  private async sendToWebhook(
    payload: WebhookPayload,
  ): Promise<"success" | "failed" | "skipped" | "disabled"> {
    const webhookUrl = this.options.webhookUrl || config.webhook.url;
    // Fallback order: per-session secret -> AUTH_GLOBAL_TOKEN (if enabled by env toggle).
    const webhookSecret =
      this.options.webhookSecret ||
      (config.webhook.allowGlobalTokenFallback ? config.auth.globalToken : "");
    if (!webhookUrl) {
      return "disabled";
    }

    // SSRF guard (same policy as deliverWebhookOnce): non-http(s) schemes are
    // always rejected; internal/private targets only when WEBHOOK_BLOCK_INTERNAL.
    const targetError = validateWebhookTarget(webhookUrl);
    if (targetError) {
      addWebhookLog({
        sessionId: this.sessionId,
        event: payload.event,
        webhookUrl,
        status: "network-error",
        attempt: 0,
        error: targetError,
      });
      logger.warn("[%s] Webhook blocked: %s", this.sessionId, targetError);
      return "failed";
    }

    // Check allowed events
    const eventName = payload.event.toUpperCase().replace(/[.-]/g, "_");
    if (!config.webhook.allowedEvents.has("ALL") && !config.webhook.allowedEvents.has(eventName)) {
      addWebhookLog({
        sessionId: this.sessionId,
        event: payload.event,
        webhookUrl,
        status: "skipped",
        attempt: 0,
        error: `Event filtered by WEBHOOK_ALLOWED_EVENTS: ${eventName}`,
      });
      return "skipped";
    }

    // Optional session-level filtering configured from dashboard.
    if (Array.isArray(this.options.webhookEvents) && this.options.webhookEvents.length > 0) {
      const allow = this.options.webhookEvents.includes(payload.event);
      if (!allow) {
        addWebhookLog({
          sessionId: this.sessionId,
          event: payload.event,
          webhookUrl,
          status: "skipped",
          attempt: 0,
          error: `Event filtered by session webhook events: ${payload.event}`,
        });
        return "skipped";
      }
    }

    // Emit to dashboard event bus (for SSE monitor)
    eventBus.emit("baileys-event", {
      sessionId: payload.sessionId,
      event: payload.event,
      data: payload.data,
      timestamp: Date.now(),
    });

    if (logger.isLevelEnabled("debug")) {
      const sanitizedPayload = deepSanitizeObject(payload, { omitKeys: [...LOGGER_OMIT_KEYS] });
      logger.debug({ sessionId: this.sessionId, payload: sanitizedPayload }, "Webhook payload");
    }

    // Circuit breaker: skip delivery entirely while the endpoint is cooling
    // down after repeated failures (event is logged; NOT dead-lettered since
    // the failure is not permanent — it will resume once the circuit closes).
    if (!webhookCircuitBreaker.beforeSend(webhookUrl)) {
      addWebhookLog({
        sessionId: this.sessionId,
        event: payload.event,
        webhookUrl,
        status: "skipped",
        attempt: 0,
        error: "Delivery skipped: circuit breaker open for this webhook URL",
      });
      logger.warn(
        "[%s] Webhook circuit open for %s — delivery skipped",
        this.sessionId,
        webhookUrl,
      );
      return "skipped";
    }

    return webhookQueue.add(async () => {
      const { maxRetries, retryInterval, backoffFactor, retryableStatuses, retryHttp429 } =
        config.webhook.retryPolicy;
      const maxAttempts = Math.max(1, maxRetries);
      let attempt = 0;
      let currentDelay = retryInterval;
      let lastFailureReason = "";
      let nonRetryable = false;

      while (attempt < maxAttempts && !nonRetryable) {
        const startedAt = Date.now();
        const currentAttempt = attempt + 1;
        try {
          const rawBody = JSON.stringify(payload);
          const { headers, error: headerError } = buildWebhookHeaders(webhookSecret, rawBody);
          if (headerError) {
            const reason = headerError;
            addWebhookLog({
              sessionId: this.sessionId,
              event: payload.event,
              webhookUrl,
              status: "network-error",
              attempt: currentAttempt,
              latencyMs: Date.now() - startedAt,
              error: reason,
            });
            throw new Error(reason);
          }

          // Compress large payloads (gzip) — signature stays over the plain body.
          const { body, contentEncoding } = maybeGzipBody(rawBody);
          if (contentEncoding) headers["Content-Encoding"] = contentEncoding;

          // Per-receiver-URL throttle (token bucket). Waits for a free slot
          // when the endpoint is being hit too fast; fails open after cap.
          const waitedMs = await webhookRateLimiter.waitForSlot(webhookUrl);
          if (waitedMs > 100) {
            logger.debug(
              "[%s] Webhook rate limiter: waited %dms for slot on %s",
              this.sessionId,
              waitedMs,
              webhookUrl,
            );
          }

          const response = await fetch(webhookUrl, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(30000), // 30s timeout per attempt
          });

          if (response.ok) {
            logger.debug("[%s] Webhook delivered successfully", this.sessionId);
            webhookCircuitBreaker.recordSuccess(webhookUrl);
            addWebhookLog({
              sessionId: this.sessionId,
              event: payload.event,
              webhookUrl,
              status: "success",
              attempt: attempt + 1,
              httpStatus: response.status,
              latencyMs: Date.now() - startedAt,
            });
            return "success";
          }

          lastFailureReason = `HTTP ${response.status}`;

          // Smart retry: 4xx (except 408/425/429) is a client error that will
          // never succeed on retry — report once and give up immediately.
          const retryable = retryableStatuses.has(response.status);
          if (!retryable) {
            nonRetryable = true;
            logger.warn(
              "[%s] Webhook rejected with non-retryable status HTTP %d (no retry)",
              this.sessionId,
              response.status,
            );
          }

          addWebhookLog({
            sessionId: this.sessionId,
            event: payload.event,
            webhookUrl,
            status: "http-error",
            attempt: currentAttempt,
            httpStatus: response.status,
            latencyMs: Date.now() - startedAt,
            error: `HTTP ${response.status}`,
          });

          if (retryable && currentAttempt < maxAttempts) {
            logger.warn(
              "[%s] Webhook failed (HTTP %d), attempt %d/%d",
              this.sessionId,
              response.status,
              currentAttempt,
              maxAttempts,
            );

            // Respect Retry-After when present (429 / 503) instead of the
            // fixed backoff — the server tells us exactly when to retry.
            const retryAfterMs = retryHttp429
              ? parseRetryAfter(response.headers.get("retry-after"))
              : undefined;
            if (retryAfterMs !== undefined) {
              currentDelay = retryAfterMs;
              logger.warn(
                "[%s] Respecting Retry-After %dms before next attempt",
                this.sessionId,
                retryAfterMs,
              );
            } else {
              currentDelay *= backoffFactor;
            }
          }
        } catch (error) {
          const reason = errorToString(error);
          addWebhookLog({
            sessionId: this.sessionId,
            event: payload.event,
            webhookUrl,
            status: "network-error",
            attempt: currentAttempt,
            latencyMs: Date.now() - startedAt,
            error: reason,
          });
          lastFailureReason = reason;
          if (currentAttempt < maxAttempts) {
            logger.warn(
              "[%s] Webhook error: %s, attempt %d/%d",
              this.sessionId,
              reason,
              currentAttempt,
              maxAttempts,
            );
          }
        }

        attempt++;
        if (attempt < maxAttempts && !nonRetryable) {
          const jitter = Math.floor(Math.random() * 1000);
          await asyncSleep(currentDelay + jitter);
        }
      }

      logger.error(
        "[%s] Webhook failed after %d attempt(s) (last error: %s)%s",
        this.sessionId,
        attempt,
        lastFailureReason || "unknown",
        nonRetryable ? " [non-retryable]" : "",
      );

      // Circuit breaker: only genuine receiver failures (retryable 5xx /
      // network errors that exhausted the loop) count toward opening the
      // circuit — NOT 4xx client errors or a healthy 429 rate-limit signal.
      if (!nonRetryable) {
        webhookCircuitBreaker.recordFailure(webhookUrl);
      }

      // Keep permanently-failed deliveries in the dead-letter buffer so they
      // can be replayed once the receiver recovers (instead of silent loss).
      const dlEntry = addToDeadLetter({
        sessionId: this.sessionId,
        event: payload.event,
        webhookUrl,
        webhookSecret,
        payload,
        attempts: attempt,
        lastError: lastFailureReason || "unknown",
      });
      if (dlEntry) {
        logger.warn("[%s] Webhook delivery moved to dead-letter (%s)", this.sessionId, dlEntry.id);
      }
      return "failed";
    });
  }
}

/**
 * One-shot webhook delivery used by dead-letter replay (and reuse in tests).
 * Builds the same auth/signature headers as sendToWebhook, honors the
 * per-URL rate limiter, and performs a single POST. No retries — the caller
 * owns retry/backoff policy.
 */

/**
 * Compress a webhook body with gzip when it exceeds WEBHOOK_GZIP_THRESHOLD.
 * Returns the body to send plus the header set (Content-Encoding + length
 * hints when compressed). Signature is computed over the UNCOMPRESSED JSON,
 * so receivers verify after decompressing.
 */
function maybeGzipBody(rawBody: string): { body: string | ArrayBuffer; contentEncoding?: string } {
  const threshold = config.webhook.gzipThreshold;
  if (threshold > 0 && Buffer.byteLength(rawBody) >= threshold) {
    // Zero-copy: hand fetch the underlying ArrayBuffer, not the Node Buffer
    // wrapper (Bun/undici BodyInit expects ArrayBuffer/Uint8Array<ArrayBuffer>).
    const buf = gzipSync(rawBody);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { body: ab, contentEncoding: "gzip" };
  }
  return { body: rawBody };
}

/**
 * Build the auth + signature headers for a webhook delivery.
 *
 * Header convention (single source of truth): the secret travels in BOTH
 * `x-webhook-secret` (legacy receivers built for this API) and
 * `Authorization: Bearer <secret>` (standard receivers / gateways), so
 * either kind of consumer can authenticate. When signatureMode != "off" the
 * body is additionally signed as `x-webhook-timestamp` +
 * `x-webhook-signature: sha256=<hmac>` over "<timestamp>.<body>" — with the
 * SAME secret, kept deliberately simple (shared-secret HMAC, not a separate
 * signing key; documented in README).
 *
 * Returns { headers, error } — error is set only when signatureMode is
 * "required" but no secret is available. Headers are still returned so the
 * caller can log/diagnose; callers must abort when error is present.
 */
export function buildWebhookHeaders(
  secret: string,
  rawBody: string,
): { headers: Record<string, string>; error?: string } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) {
    headers["x-webhook-secret"] = secret;
    headers.Authorization = `Bearer ${secret}`;
  }
  if (config.webhook.signatureMode !== "off") {
    if (!secret && config.webhook.signatureMode === "required") {
      return { headers, error: "Missing secret for required webhook signature mode" };
    }
    if (secret) {
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
      headers["x-webhook-timestamp"] = timestamp;
      headers["x-webhook-signature"] = `sha256=${signature}`;
    }
  }
  return { headers };
}

export async function deliverWebhookOnce(
  webhookUrl: string,
  payload: unknown,
  secret: string,
  timeoutMs = 30000,
): Promise<{ ok: boolean; status: number; error?: string }> {
  // SSRF guard: validate the target before fetching.
  const invalid = validateWebhookTarget(webhookUrl);
  if (invalid) {
    return { ok: false, status: 0, error: invalid };
  }
  try {
    const rawBody = JSON.stringify(payload);
    const { headers, error: headerError } = buildWebhookHeaders(secret, rawBody);
    if (headerError) {
      return { ok: false, status: 0, error: headerError };
    }

    // Compress large payloads (gzip) — signature stays over the plain body.
    const { body, contentEncoding } = maybeGzipBody(rawBody);
    if (contentEncoding) headers["Content-Encoding"] = contentEncoding;

    // Per-receiver-URL throttle (token bucket). Fails open after the cap.
    await webhookRateLimiter.waitForSlot(webhookUrl);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: errorToString(error) };
  }
}
