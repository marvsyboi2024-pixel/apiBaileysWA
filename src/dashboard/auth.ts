/**
 * Dashboard Auth — file-based user management with hashed passwords and JWT sessions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, Hono, type Next } from "hono";
import { sign, verify } from "hono/jwt";
import config from "@/config";
import logger from "@/lib/logger";
import { hashPassword, verifyPassword } from "@/lib/runtime";
import { authRateLimit } from "@/middleware/rateLimit";

const DATA_DIR = join(process.cwd(), "data");
const USERS_FILE = join(DATA_DIR, "dashboard-users.json");

/** Response used when the dashboard JWT secret is not configured in production. */
function jwtMisconfiguredResponse(c: Context) {
  return c.json(
    {
      success: false,
      message:
        "Dashboard auth is disabled: DASHBOARD_JWT_SECRET is not set to a secure value. Set it in production to enable the dashboard.",
    },
    503,
  );
}

interface DashboardUser {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "manager" | "assistant";
  status?: "active" | "pending";
  assignedSessions?: string[];
  createdAt: string;
}

function getPasswordMinLength(): number {
  return config.dashboard.passwordMinLength;
}

function getUserStatus(user: DashboardUser): "active" | "pending" {
  return user.status || "active";
}

function normalizeAssignedSessions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .filter((entry, index, array) => array.indexOf(entry) === index);
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadUsers(): DashboardUser[] {
  ensureDataDir();
  if (!existsSync(USERS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(USERS_FILE, "utf-8")) as Array<Record<string, unknown>>;
    return raw.map((u) => ({
      id: String(u.id || ""),
      username: String(u.username || ""),
      passwordHash: String(u.passwordHash || ""),
      role: u.role === "admin" ? "admin" : u.role === "manager" ? "manager" : "assistant",
      status: u.status === "pending" ? "pending" : "active",
      assignedSessions: normalizeAssignedSessions(u.assignedSessions),
      createdAt: String(u.createdAt || new Date().toISOString()),
    }));
  } catch {
    return [];
  }
}

function saveUsers(users: DashboardUser[]) {
  ensureDataDir();
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function generateId(): string {
  return `usr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function hasUsers(): boolean {
  return loadUsers().length > 0;
}

export function findDashboardUserById(userId: string): DashboardUser | undefined {
  return loadUsers().find((user) => user.id === userId);
}

type DashboardEnv = {
  Variables: {
    dashboardUser: { sub: string; username: string; role: string; exp: number };
  };
};

type DashboardUserPayload = {
  sub: string;
  username: string;
  role: "admin" | "manager" | "assistant";
  exp: number;
  scope?: "stream";
};

const dashboardAuth = new Hono<DashboardEnv>();

/**
 * POST /dashboard/api/auth/login
 */
dashboardAuth.post("/login", authRateLimit, async (c) => {
  if (config.dashboard.jwtMisconfigured) return jwtMisconfiguredResponse(c);

  const body = await c.req.json();
  const { username, password } = body;

  if (!username || !password) {
    return c.json({ success: false, message: "Username and password required" }, 400);
  }

  const users = loadUsers();
  const normalizedLogin = String(username).toLowerCase().trim();
  const user = users.find((u) => u.username === normalizedLogin);

  if (!user) {
    return c.json({ success: false, message: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json({ success: false, message: "Invalid credentials" }, 401);
  }

  if (getUserStatus(user) !== "active") {
    return c.json({ success: false, message: "Your account is pending admin approval" }, 403);
  }

  const token = await sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + 86400,
    },
    config.dashboard.jwtSecret,
  );

  return c.json({
    success: true,
    data: {
      token,
      user: { id: user.id, username: user.username, role: user.role },
    },
  });
});

/**
 * POST /dashboard/api/auth/register
 */
dashboardAuth.post("/register", authRateLimit, async (c) => {
  if (config.dashboard.jwtMisconfigured) return jwtMisconfiguredResponse(c);

  const users = loadUsers();

  // If users exist and registration is disabled
  if (users.length > 0 && !config.dashboard.registrationEnabled) {
    return c.json({ success: false, message: "Registration is disabled" }, 403);
  }

  const body = await c.req.json();
  const { username, password } = body;

  if (!username || !password) {
    return c.json({ success: false, message: "Username and password required" }, 400);
  }

  // Username standardization: lowercase, alphanumeric + underscores, 3-30 chars
  const normalizedUsername = String(username).toLowerCase().trim();
  if (!/^[a-z][a-z0-9_]{2,29}$/.test(normalizedUsername)) {
    return c.json(
      {
        success: false,
        message:
          "Username must be 3-30 characters, start with a letter, and contain only lowercase letters, numbers, and underscores",
      },
      400,
    );
  }

  const minPasswordLength = getPasswordMinLength();
  if (password.length < minPasswordLength) {
    return c.json(
      { success: false, message: `Password must be at least ${minPasswordLength} characters` },
      400,
    );
  }

  if (users.find((u) => u.username === normalizedUsername)) {
    return c.json({ success: false, message: "Username already exists" }, 409);
  }

  const passwordHash = await hashPassword(password);
  const role: DashboardUser["role"] = users.length === 0 ? "admin" : "assistant";
  const shouldRequireApproval = users.length > 0 && config.dashboard.registrationRequireApproval;
  const status: "active" | "pending" = shouldRequireApproval ? "pending" : "active";

  const newUser: DashboardUser = {
    id: generateId(),
    username: normalizedUsername,
    passwordHash,
    role,
    status,
    assignedSessions: [],
    createdAt: new Date().toISOString(),
  };

  users.push(newUser);
  saveUsers(users);

  logger.info("[Dashboard] New user registered: %s (role: %s)", username, role);

  if (status === "pending") {
    return c.json({
      success: true,
      message: "Registration submitted. Please wait for admin approval.",
      data: {
        requiresApproval: true,
      },
    });
  }

  const token = await sign(
    {
      sub: newUser.id,
      username: newUser.username,
      role: newUser.role,
      exp: Math.floor(Date.now() / 1000) + 86400,
    },
    config.dashboard.jwtSecret,
  );

  return c.json({
    success: true,
    message: users.length === 1 ? "Admin account created" : "Account registered",
    data: {
      token,
      user: { id: newUser.id, username: newUser.username, role: newUser.role },
    },
  });
});

/**
 * GET /dashboard/api/auth/me
 */
dashboardAuth.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return c.json({ success: false, message: "Not authenticated" }, 401);

  try {
    if (config.dashboard.jwtMisconfigured) return jwtMisconfiguredResponse(c);
    const payload = await verify(token, config.dashboard.jwtSecret, "HS256");
    return c.json({
      success: true,
      data: { id: payload.sub, username: payload.username, role: payload.role },
    });
  } catch {
    return c.json({ success: false, message: "Invalid or expired token" }, 401);
  }
});

/**
 * GET /dashboard/api/auth/stream-token
 * Issue short-lived token for SSE/EventSource connections.
 */
dashboardAuth.get("/stream-token", dashboardAuthMiddleware, async (c) => {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  const token = await sign(
    {
      sub: userPayload.sub,
      username: userPayload.username,
      role: userPayload.role,
      scope: "stream",
      exp: Math.floor(Date.now() / 1000) + 120,
    },
    config.dashboard.jwtSecret,
  );

  return c.json({ success: true, data: { token, expiresInSeconds: 120 } });
});

/**
 * GET /dashboard/api/auth/status
 * Public endpoint to check if setup is needed
 */
dashboardAuth.get("/status", (c) => {
  const users = loadUsers();
  return c.json({
    success: true,
    data: {
      hasUsers: users.length > 0,
      registrationEnabled: config.dashboard.registrationEnabled || users.length === 0,
      registrationRequireApproval: config.dashboard.registrationRequireApproval,
      passwordMinLength: getPasswordMinLength(),
    },
  });
});

/**
 * Middleware to verify dashboard JWT token
 */
export async function dashboardAuthMiddleware(c: Context, next: Next) {
  if (config.dashboard.jwtMisconfigured) return jwtMisconfiguredResponse(c);

  const authHeader = c.req.header("Authorization");
  const tokenFromHeader = authHeader?.replace(/^Bearer\s+/i, "").trim();
  const tokenFromQuery =
    c.req.path === "/dashboard/api/events/stream" ? c.req.query("token") : undefined;
  const token = tokenFromHeader || tokenFromQuery;
  if (!token) return c.json({ success: false, message: "Not authenticated" }, 401);

  try {
    const payload = await verify(token, config.dashboard.jwtSecret, "HS256");
    if (tokenFromQuery && payload.scope !== "stream") {
      return c.json({ success: false, message: "Invalid stream token" }, 401);
    }
    c.set("dashboardUser", payload);
    return next();
  } catch {
    return c.json({ success: false, message: "Invalid or expired token" }, 401);
  }
}

/**
 * PUT /dashboard/api/auth/password
 * Change current user password
 */
dashboardAuth.put("/password", dashboardAuthMiddleware, async (c) => {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  const body = await c.req.json().catch(() => ({}));
  const { currentPassword, newPassword } = body;

  if (!currentPassword || !newPassword) {
    return c.json({ success: false, message: "Current and new password required" }, 400);
  }

  const minPasswordLength = getPasswordMinLength();
  if (newPassword.length < minPasswordLength) {
    return c.json(
      { success: false, message: `New password must be at least ${minPasswordLength} characters` },
      400,
    );
  }

  const users = loadUsers();
  const userIndex = users.findIndex((u) => u.id === userPayload.sub);
  if (userIndex === -1) return c.json({ success: false, message: "User not found" }, 404);

  const valid = await verifyPassword(currentPassword, users[userIndex].passwordHash);
  if (!valid) {
    return c.json({ success: false, message: "Incorrect current password" }, 401);
  }

  users[userIndex].passwordHash = await hashPassword(newPassword);
  saveUsers(users);

  return c.json({ success: true, message: "Password updated successfully" });
});

/**
 * GET /dashboard/api/auth/users
 * List all users (Admin only)
 */
dashboardAuth.get("/users", dashboardAuthMiddleware, (c) => {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  if (userPayload.role !== "admin")
    return c.json({ success: false, message: "Forbidden: Admin only" }, 403);

  const users = loadUsers().map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    status: getUserStatus(u),
    assignedSessions: u.assignedSessions || [],
    createdAt: u.createdAt,
  }));
  return c.json({ success: true, data: users });
});

/**
 * PUT /dashboard/api/auth/users/:id/sessions
 * Update lightweight dashboard-only session assignments (Admin only)
 */
dashboardAuth.put("/users/:id/sessions", dashboardAuthMiddleware, async (c) => {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  if (userPayload.role !== "admin")
    return c.json({ success: false, message: "Forbidden: Admin only" }, 403);

  const targetId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const assignedSessions = normalizeAssignedSessions(body.assignedSessions);

  const users = loadUsers();
  const userIndex = users.findIndex((u) => u.id === targetId);
  if (userIndex === -1) return c.json({ success: false, message: "User not found" }, 404);

  users[userIndex].assignedSessions = assignedSessions;
  saveUsers(users);

  return c.json({ success: true, message: "Assigned sessions updated" });
});

/**
 * PUT /dashboard/api/auth/users/:id/approve
 * Approve a pending user (Admin only)
 */
dashboardAuth.put("/users/:id/approve", dashboardAuthMiddleware, (c) => {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  if (userPayload.role !== "admin")
    return c.json({ success: false, message: "Forbidden: Admin only" }, 403);

  const targetId = c.req.param("id");
  const users = loadUsers();
  const userIndex = users.findIndex((u) => u.id === targetId);
  if (userIndex === -1) return c.json({ success: false, message: "User not found" }, 404);

  users[userIndex].status = "active";
  saveUsers(users);
  return c.json({ success: true, message: "User approved" });
});

/**
 * PUT /dashboard/api/auth/users/:id/role
 * Change user role (Admin only)
 */
dashboardAuth.put("/users/:id/role", dashboardAuthMiddleware, async (c) => {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  if (userPayload.role !== "admin")
    return c.json({ success: false, message: "Forbidden: Admin only" }, 403);

  const targetId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  if (body.role !== "admin" && body.role !== "manager" && body.role !== "assistant") {
    return c.json(
      { success: false, message: "Invalid role (must be admin, manager, or assistant)" },
      400,
    );
  }

  const users = loadUsers();

  // Prevent removing the last admin
  if (body.role !== "admin") {
    const adminCount = users.filter((u) => u.role === "admin").length;
    const targetIsAdmin = users.find((u) => u.id === targetId)?.role === "admin";
    if (adminCount <= 1 && targetIsAdmin) {
      return c.json({ success: false, message: "Cannot demote the last admin" }, 400);
    }
  }

  const userIndex = users.findIndex((u) => u.id === targetId);
  if (userIndex === -1) return c.json({ success: false, message: "User not found" }, 404);

  users[userIndex].role = body.role;
  saveUsers(users);

  return c.json({ success: true, message: "Role updated" });
});

/**
 * DELETE /dashboard/api/auth/users/:id
 * Delete a user (Admin only)
 */
dashboardAuth.delete("/users/:id", dashboardAuthMiddleware, (c) => {
  const userPayload = c.get("dashboardUser") as DashboardUserPayload;
  if (userPayload.role !== "admin")
    return c.json({ success: false, message: "Forbidden: Admin only" }, 403);

  const targetId = c.req.param("id");

  // Prevent self-deletion
  if (targetId === userPayload.sub) {
    return c.json({ success: false, message: "Cannot delete your own account" }, 400);
  }

  let users = loadUsers();

  // Prevent deleting the last admin
  const targetIsAdmin = users.find((u) => u.id === targetId)?.role === "admin";
  if (targetIsAdmin) {
    const adminCount = users.filter((u) => u.role === "admin").length;
    if (adminCount <= 1) {
      return c.json({ success: false, message: "Cannot delete the last admin" }, 400);
    }
  }

  const initialCount = users.length;
  users = users.filter((u) => u.id !== targetId);

  if (users.length === initialCount) {
    return c.json({ success: false, message: "User not found" }, 404);
  }

  saveUsers(users);
  return c.json({ success: true, message: "User deleted" });
});

export default dashboardAuth;
