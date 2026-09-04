# API Baileys WA Socket

**WhatsApp REST API** powered by [Baileys WA Sockets](https://github.com/WhiskeySockets/Baileys). Built with **Hono + TypeScript** and features **Dual-Runtime Support** (runs natively on **Bun** or **Node.js**). Includes a built-in Visual Dashboard for easy management, keep clean simple and avoid heavy over-engineering.

> [!NOTE]
> This project is not meant to be a full-fledged WhatsApp server. It is a wrapper around the Baileys library, providing an HTTP interface for easier integration with other applications, don't use it for spamming or any activities that's prohibited by **WhatsApp META**.
>
> **Disclaimer:** This project is 100% AI-assisted and intended for educational purposes only. It will be maintained as a side project in spare time only, with no guarantees of ongoing support, updates, or production readiness.
>
> Thus, we do not store WhatsApp messages or any other data (aside from credentials for auto-reconnecting).

---

## ✨ Features

| Feature                     | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| **Dual Runtime Support**    | Run on ultra-fast Bun or standard Node.js (cPanel/VPS compatible) |
| **Visual Dashboard**        | Built-in UI to manage sessions, webhooks, and send messages       |
| **Dashboard RBAC**          | Role-based access (`admin`, `manager`, `assistant`) + approvals   |
| **Session Assignment ACL**  | Optional per-user assigned sessions (dashboard scope only)        |
| **Multi-Session**           | Manage multiple WhatsApp accounts simultaneously                  |
| **QR Code & Pairing Code**  | Connect via QR scan or 8-digit pairing code                       |
| **Complete Chat API**       | Send text, media, forward, delete, read messages                  |
| **Broadcast Queue**         | Bulk message sending with anti-spam delays                        |
| **Group & Profile**         | Full management (create, participants, status, picture)           |
| **Media Handling**          | Download, process, retrieve, and auto-cleanup old media           |
| **Webhook System**          | Retries, exponential backoff, and signature modes                 |
| **Dual Auth State**         | Save session data to Files (dev) or Redis (production)            |
| **API Authentication**      | Bearer token or Redis-stored API keys with roles                  |
| **Hardened Dashboard Auth** | JWT auth, stream token for SSE, password policy, approval flow    |
| **Swagger/OpenAPI**         | Built-in interactive API documentation at `/docs`                 |
| **Docker Support**          | Ready-to-use Dockerfiles for both Bun and Node.js                 |

---

## 🚀 Quick Start

### 1. Prerequisite (Choose One Runtime)

- **Bun**: Ultra-fast, ideal for VPS or Home Servers (Recommended).
- **Node.js**: Standard, portable, ideal for cPanel VPS or traditional Node.js hosting.
- **Docker**: Containerized deployment. Ensure you have Docker Compose installed.

### 2. Local Setup (Bun OR Node.js)

```bash
# Clone the repository
git clone <repository-url>
cd baileys-wa-api

# Configure Environment
cp .env.example .env
# Edit .env and configure DASHBOARD_JWT_SECRET
```

#### Running with Bun (Fastest)

```bash
bun install

# Development (Auto-reload)
bun run dev

# Production Build
bun run start
```

#### Running with Node.js (Highest Compatibility)

```bash
npm install

# Development (via tsx watch)
npm run dev:node

# Production Build
npm run start:node
```

The API will start at `http://localhost:3000`. Access the following default routes:

- 🖥️ **Dashboard**: `http://localhost:3000/dashboard/`
- 📖 **Swagger Docs**: `http://localhost:3000/docs`
- 💚 **Health Check**: `http://localhost:3000/status`

---

## 🐳 Docker Deployment

The project provides configurations for both runtimes. Redis is highly recommended and included in the `docker-compose` setups.

#### Option A: Docker with Bun (Default & Recommended)

```bash
docker compose up -d
docker compose logs -f api
```

#### Option B: Docker with Node.js

If you prefer forcing the native Node.js container:

```bash
docker compose -f docker-compose.node.yml up -d
docker compose -f docker-compose.node.yml logs -f api
```

To stop containers: `docker compose down`

---

## 🖥️ Visual Dashboard

The API includes an intuitive, modular web dashboard to manage everything visually without touching the CLI.

### Dashboard Configuration (`.env`)

```env
DASHBOARD_ENABLED=true
DASHBOARD_REGISTRATION_ENABLED=false
DASHBOARD_REGISTRATION_REQUIRE_APPROVAL=true
DASHBOARD_JWT_SECRET=super-secret-key-change-me
DASHBOARD_PASSWORD_MIN_LENGTH=6
```

### Initial Setup

1. Open `http://localhost:3000/dashboard/` in your browser.
2. If `data/dashboard-users.json` is empty, you will be prompted to create the very first **Admin Account**.
3. Create your account with a secure password (hashed via `bcryptjs`).
4. Once created, recommended to set `DASHBOARD_REGISTRATION_ENABLED=false` in `.env` to prevent public sign-ups.

### Role & Access Model

- `admin`: full dashboard access (users/approval/roles, session lifecycle, webhooks, all messaging).
- `manager`: operational access for chats/outbound/groups, without admin-level account controls.
- `assistant`: reply-focused dashboard role (no proactive outbound), for safer delegated handling.
- Optional `assignedSessions`: per-user session scoping in dashboard APIs/UI only.

### Registration & Approval Behavior

- `DASHBOARD_REGISTRATION_ENABLED=false`: registration form is disabled for additional users.
- `DASHBOARD_REGISTRATION_REQUIRE_APPROVAL=true`: newly registered users remain pending until approved by admin.
- The first bootstrap admin (when user file is empty) is created immediately.

### Features

- **Sessions**: Add WhatsApp accounts (QR/Pairing Code), Delete accounts safely (auto-cleans media/logs).
- **Messaging**: Test sending texts, images, and bulk broadcasts interactively.
- **Webhooks**: Configure webhook URLs and event subscriptions per-session.
- **Events**: Real-time SSE (Server-Sent Events) live log for WhatsApp events.

---

## 🔐 API Authentication

The raw REST API `/chats`, `/groups`, etc., supports two authentication methods:

### 1. Simple Token (Dev / Single-User)

Set `AUTH_GLOBAL_TOKEN` in `.env`:

```env
AUTH_GLOBAL_TOKEN=your-secret-token-here
```

Supported headers for simple token mode:

- `Authorization: Bearer <token>`
- `x-api-key: <token>`
- `x-access-token: <token>`
- `token: <token>`

Use in requests:

```bash
curl -H "Authorization: Bearer your-secret-token-here" http://localhost:3000/sessions
```

### 2. Redis API Keys (Production / Multi-User)

Requires `REDIS_ENABLED=true`. Manage keys using the CLI:

```bash
# Bun Runtime
bun run manage-api-keys create user

# Node.js Runtime
npm run manage-api-keys:node create admin
```

Use header: `x-api-key: <your-api-key>`

```bash
# Create user API key
bun run manage-api-keys create user

# Create admin API key
bun run manage-api-keys create admin

# List all keys
bun run manage-api-keys list

# Delete a key
bun run manage-api-keys delete <api-key>
```

Use in requests:

```bash
curl -H "x-api-key: <your-api-key>" http://localhost:3000/sessions
```

> **Note**: In `development` mode (`NODE_ENV=development`), API authentication is skipped entirely.

### Dashboard Authentication (UI)

- Dashboard endpoints (`/dashboard/api/*`) use JWT-based auth.
- SSE/Event stream endpoints use short-lived stream-scoped tokens.
- Stream token endpoint: `GET /dashboard/api/auth/stream-token`

---

## 📱 API Usage Examples

### Create Session (Pairing Code)

```bash
POST /sessions/my-session
Content-Type: application/json

{
  "usePairingCode": true,
  "phoneNumber": "+6281234567890",
  "webhookUrl": "http://your-server.com/webhook"
}
```

### Send an Image

```bash
POST /chats/my-session/send
Content-Type: application/json

{
  "receiver": "6281234567890",
  "message": {
    "image": { "url": "https://example.com/image.jpg" },
    "caption": "Check this out!"
  }
}
```

### Send Bulk Messages (Anti-Spam)

```bash
POST /chats/my-session/send-bulk
Content-Type: application/json

{
  "messages": [
    { "receiver": "6281234567890", "message": { "text": "Hello #1" } },
    { "receiver": "6281234567891", "message": { "text": "Hello #2" } }
  ]
}
```

Response:

```json
{
 "success": true,
 "message": "Broadcast job created",
 "data": { "jobId": "bc_1709271000_abc123", "total": 3, "status": "pending" }
}
```

Track progress:

```bash
GET /chats/my-session/broadcast/bc_1709271000_abc123
```

### Create a Group

```bash
POST /groups/my-session/create
Content-Type: application/json

{
  "groupName": "API Test Group",
  "participants": ["6281234567890", "6281234567891"]
}
```

### Webhook Events

Set `WEBHOOK_URL` in `.env` or per-session. Events are sent as POST:

```json
{
  "sessionId": "my-session",
  "event": "messages.upsert",
  "data": { "messages": [...], "type": "notify" }
}
```

When signature mode is enabled, webhook requests can include:

- `x-webhook-timestamp`
- `x-webhook-signature: sha256=<hmac>`

Controlled by:

- `WEBHOOK_SIGNATURE_MODE=off|optional|required`
- `WEBHOOK_ALLOW_GLOBAL_TOKEN_FALLBACK=true|false`

Fallback order for webhook auth/signing secret:

1. Per-session webhook secret
2. `AUTH_GLOBAL_TOKEN` (only when fallback is enabled)

Available events:

- `connection.update` — Connection state changes (QR, open, close)
- `messages.upsert` — New messages received
- `messages.update` — Message status updates (sent, delivered, read)
- `messages.delete` — Messages deleted
- `messages.reaction` — Reactions added/removed
- `chats.upsert`, `chats.update`, `chats.delete`
- `contacts.upsert`, `contacts.update`
- `groups.upsert`, `groups.update`
- `group-participants.update`
- `presence.update`
- `blocklist.set`, `blocklist.update`

---

## 📂 Project Structure

```
baileys-wa-api/
├── data/                           # Dashboard users and internal dashboard data (JSON)
├── media/                          # Downloaded media files
├── sessions/                       # Auth/session state per WhatsApp session
├── scripts/
│   └── manage-api-keys.ts          # API key management CLI
├── src/
│   ├── index.ts                    # Runtime entry point (Bun/Node)
│   ├── app.ts                      # Hono app bootstrap + routes + docs
│   ├── config.ts                   # Centralized environment config
│   ├── baileys/
│   │   ├── connection.ts           # BaileysConnection class
│   │   ├── connectionManager.ts    # Multi-session manager
│   │   ├── types.ts                # Type definitions
│   │   ├── authState/
│   │   │   ├── index.ts            # Auth state factory
│   │   │   ├── file.ts             # File-based auth
│   │   │   └── redis.ts            # Redis-based auth
│   │   ├── store/
│   │   │   └── memoryStore.ts      # In-memory message store
│   │   └── helpers/
│   │       ├── downloadMedia.ts    # Media download utilities
│   │       └── shouldIgnoreJid.ts  # JID filtering
│   ├── dashboard/
│   │   ├── api.ts                  # Dashboard backend APIs (stats/events/webhooks)
│   │   ├── auth.ts                 # Dashboard auth + users/roles/approval
│   │   ├── eventBus.ts             # In-process event bus for SSE
│   │   └── loader.ts               # Dashboard route/static loader
│   ├── dashboard-ui/
│   │   ├── index.html              # Dashboard SPA shell
│   │   ├── css/
│   │   │   └── styles.css
│   │   └── js/
│   │       ├── api.js
│   │       ├── app.js
│   │       ├── auth.js
│   │       ├── theme.js
│   │       ├── components/
│   │       │   ├── modal.js
│   │       │   └── toast.js
│   │       └── pages/              # overview/sessions/chatrooms/groups/webhooks/events/settings
│   ├── lib/
│   │   ├── logger.ts               # Pino logger
│   │   ├── redis.ts                # Redis client helpers
│   │   ├── response.ts             # API response helpers
│   │   └── runtime.ts              # Bun/Node runtime abstraction
│   ├── middleware/
│   │   ├── auth.ts                 # API authentication
│   │   ├── rateLimit.ts            # API rate limiting
│   │   └── sessionValidator.ts     # Session existence check
│   ├── routes/
│   │   ├── session.ts              # Session CRUD
│   │   ├── chat.ts                 # Chat operations
│   │   ├── group.ts                # Group management
│   │   ├── profile.ts              # Profile management
│   │   ├── media.ts                # Media handling
│   │   ├── story.ts                # Story broadcasting
│   │   └── status.ts               # Server health
│   ├── schemas/
│   │   ├── chat.ts                 # Chat schemas
│   │   ├── group.ts                # Group schemas
│   │   └── session.ts              # Session schemas
│   ├── services/
│   │   ├── broadcastQueue.ts       # Broadcast queue with delays
│   │   └── mediaCleanup.ts         # Media file cleanup
│   │   └── webhookLog.ts           # Webhook delivery log storage
│   └── utils/
│       ├── asyncSleep.ts           # Async sleep utilities
│       ├── phone.ts                # Phone/JID formatting
│       └── validation.ts           # Validation utilities
├── .env.example
├── biome.jsonc
├── docker-compose.yml
├── docker-compose.node.yml
├── Dockerfile
├── Dockerfile.node
├── package.json
├── tsconfig.json
└── README.md
```

---

## ⚙️ Configuration Reference (`.env`)

| Variable                                  | Default                          | Description                                                              |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`                                | `development`                    | Environment (`development` / `production`)                               |
| `HOST`                                    | `0.0.0.0`                        | Server host                                                              |
| `PORT`                                    | `3000`                           | Server port                                                              |
| `LOG_LEVEL`                               | `info`                           | Log level (`debug`, `info`, `warn`, `error`)                             |
| `AUTH_GLOBAL_TOKEN`                       | —                                | Simple auth token                                                        |
| `REDIS_ENABLED`                           | `false`                          | Enable Redis integration                                                 |
| `REDIS_URL`                               | `redis://localhost:6379`         | Redis connection URL                                                     |
| `REDIS_PASSWORD`                          | —                                | Redis password                                                           |
| `BAILEYS_LOG_LEVEL`                       | `warn`                           | Baileys internal log level                                               |
| `MAX_RETRIES`                             | `5`                              | Max reconnection attempts                                                |
| `RECONNECT_INTERVAL`                      | `5000`                           | Reconnection delay (ms)                                                  |
| `MAX_SESSIONS`                            | `50`                             | Maximum concurrent WhatsApp sessions                                     |
| `WEBHOOK_URL`                             | —                                | Default webhook URL                                                      |
| `WEBHOOK_CONCURRENCY`                     | `20`                             | Max concurrent outbound webhook requests globally                        |
| `WEBHOOK_SIGNATURE_MODE`                  | `off`                            | Webhook signature mode (`off`, `optional`, `required`)                   |
| `WEBHOOK_ALLOW_GLOBAL_TOKEN_FALLBACK`     | `true`                           | Allow fallback to `AUTH_GLOBAL_TOKEN` for webhook secret/signature       |
| `WEBHOOK_ALLOWED_EVENTS`                  | `ALL`                            | Comma-separated event filter                                             |
| `WEBHOOK_RETRY_MAX`                       | `3`                              | Webhook delivery retry count                                             |
| `WEBHOOK_RETRY_INTERVAL`                  | `5000`                           | Initial webhook retry delay (ms)                                         |
| `WEBHOOK_BACKOFF_FACTOR`                  | `3`                              | Exponential backoff multiplier                                           |
| `BROADCAST_MIN_DELAY_MS`                  | `1500`                           | Min delay between bulk messages                                          |
| `BROADCAST_MAX_DELAY_MS`                  | `3000`                           | Max delay between bulk messages                                          |
| `BROADCAST_BATCH_SIZE`                    | `10`                             | Messages per batch before pause                                          |
| `BROADCAST_BATCH_PAUSE_MS`                | `5000`                           | Pause between batches                                                    |
| `BROADCAST_TYPING_SIMULATION`             | `false`                          | Show a per-recipient "composing…" bubble during broadcasts (default: false — safer/less bot-like; adds typing delay per recipient) |
| `BROADCAST_DELAY_DISTRIBUTION`            | `uniform`                        | Delay pattern between messages: `uniform` (random min–max, legacy) or `human` (short gaps + occasional longer pauses) |
| `BROADCAST_BATCH_CHECK_WA`                | `false`                          | Check recipient WA-registration in batches (fewer usync queries) instead of 1-by-1 |
| `BROADCAST_CHECK_WA_BATCH_SIZE`           | `50`                             | Batch size when `BROADCAST_BATCH_CHECK_WA=true`                          |
| `MEDIA_INCLUDE_BASE64`                    | `false`                          | Include media in webhooks                                                |
| `MEDIA_CLEANUP_ENABLED`                   | `true`                           | Auto-delete old media files                                              |
| `MEDIA_CLEANUP_INTERVAL_MS`               | `3600000`                        | Media cleanup interval (ms)                                              |
| `MEDIA_MAX_AGE_HOURS`                     | `24`                             | Max age of media files                                                   |
| `CORS_ORIGIN`                             | `*`                              | CORS allowed origins                                                     |
| `DASHBOARD_ENABLED`                       | `true`                           | Enable internal UI dashboard                                             |
| `DASHBOARD_REGISTRATION_ENABLED`          | `false`                          | Allow account creation                                                   |
| `DASHBOARD_REGISTRATION_REQUIRE_APPROVAL` | `true`                           | Require admin approval before new user can login                         |
| `DASHBOARD_PASSWORD_MIN_LENGTH`           | `6`                              | Minimum password length for dashboard users                              |
| `DASHBOARD_JWT_SECRET`                    | `change-this-to-a-random-secret` | JWT secret for dashboard auth                                            |
| `SIMULATE_TYPING_BEFORE_SEND`             | `true`                           | Auto-send "composing" presence before each message (default: true)       |
| `SIMULATE_TYPING_DELAY_MIN_MS`            | `1500`                           | Typing delay range in ms (random between min-max)                        |
| `SIMULATE_TYPING_DELAY_MAX_MS`            | `3000`                           | Typing delay range in ms (random between min-max)                        |
| `AUTO_READ_MESSAGES`                      | `false`                          | **⚠ RISK**: auto-mark incoming as read. Instant 0ms reads on 100% of chats is a bot signature & may trigger bans. Leave `false` unless required; if enabled also set `AUTO_READ_DELAY_ENABLED=true` for a natural delay |
| `AUTO_READ_DELAY_ENABLED`                 | `true`                           | Wait a natural "opened chat" delay before marking read (only when `AUTO_READ_MESSAGES=true`); `false` = read instantly (legacy) |
| `AUTO_READ_DELAY_MIN_MS`                  | `1500`                           | Min random "opened chat" delay before read receipt (ms)                 |
| `AUTO_READ_DELAY_MAX_MS`                  | `4000`                           | Max random "opened chat" delay before read receipt (ms)                 |
| `AUTO_MARK_ONLINE`                        | `true`                           | Auto-set presence to "available" when sending messages (default: true)   |
| `REJECT_CALLS`                            | `false`                          | Auto-reject incoming calls across all sessions                           |
| `HUMANIZE_READ_BEFORE_REPLY`              | `false`                          | Before auto-replying to a 1-on-1 chat, wait a natural "reading" gap then mark as read (bot-like instant replies without prior read = risky) |
| `HUMANIZE_READ_DELAY_MIN_MS`              | `800`                            | Min random "reading" gap before the read receipt (ms)                   |
| `HUMANIZE_READ_DELAY_MAX_MS`              | `2500`                           | Max random "reading" gap before the read receipt (ms)                   |
| `HUMANIZE_THINK_MIN_MS`                   | `800`                            | Min random "thinking" gap before typing starts (ms)                     |
| `HUMANIZE_THINK_MAX_MS`                   | `2000`                           | Max random "thinking" gap before typing starts (ms)                     |
| `HUMANIZE_TYPING_PROPORTIONAL`            | `false`                          | When `true`, typing ("composing") duration scales with reply length instead of a fixed random range. Default `false` = legacy fixed random typing delay (controlled by `SIMULATE_TYPING_DELAY_*`) |
| `HUMANIZE_PRESENCE_DEDUPE_MS`             | `0`                              | Min gap between repeated composing/paused to the same chat (ms); `0` = always send (legacy) |
| `HUMANIZE_GLOBAL_PACING_MIN_MS`           | `0`                              | Min random gap between ANY outbound actions within a session (ms); `0` = off (legacy) |
| `HUMANIZE_GLOBAL_PACING_MAX_MS`           | `0`                              | Max random gap between ANY outbound actions within a session (ms); `0` = off (legacy) |

---

## 🧪 Useful Scripts

Use these commands for validation and maintenance:

```bash
# Type-check only
npm run build-check

# Lint with error-level gate
npm run lint

# Full lint diagnostics
npm run lint:all

# Auto-format/fix source files
npm run format
```

API key helper:

```bash
# Bun runtime
bun run manage-api-keys create admin

# Node runtime
npm run manage-api-keys:node create admin
```

---

## 📝 License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

This project is licensed under the [MIT License](LICENSE) - see the [LICENSE](LICENSE) file for details.
