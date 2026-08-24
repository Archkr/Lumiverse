/**
 * Illarin linked-instance routes (authenticated; mounted at /api/v1/illarin).
 *
 * The loopback callback never touches this app — the browser hits the
 * backend's temporary listener directly, so unlike the LumiHub flow there is
 * no unauthenticated callback route here. The frontend starts a link,
 * receives the pending link id, and polls /status until the session resolves.
 *
 * Local unlink removes credentials only: until Illarin publishes a remote
 * revocation endpoint, the owner revokes the matching instance (matched by
 * server-issued instance ID and displayed names) in their account settings.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import * as svc from "../services/illarin-instance.service";
import { buildDeclaration } from "../illarin/declaration";
import { LINK_TIMEOUT_MS, runBrowserLink } from "../illarin/link-browser";
import { createDeviceRequest } from "../illarin/api";
import { DeviceLinkSession } from "../illarin/link-device";
import { readBackendVersion } from "../illarin/warmup";
import { handleTerminalUnauthorized } from "../illarin/tokens";
import type { BrowserLinkOutcome } from "../illarin/link-browser";

interface PendingBrowserLink {
  userId: string;
  status: "pending" | "linked" | "failed";
  reason?: string;
  expiresAt: number;
}

// One live linking attempt per user — a new attempt retires the old one so
// abandoned listeners cannot accumulate.
const pendingLinks = new Map<string, PendingBrowserLink>();


interface PendingDeviceLink {
  userId: string;
  baseUrl: string;
  session: DeviceLinkSession;
  instanceName: string;
  applicationName: string;
  declarationJson: string;
  expiresAt: number;
}

// One active device attempt per user, keyed by userId.
const pendingDeviceLinks = new Map<string, PendingDeviceLink>();
function sweepPendingLinks(): void {
  const now = Date.now();
  for (const [id, link] of pendingLinks) {
    if (now > link.expiresAt && link.status === "pending") link.status = "failed";
    if (link.status !== "pending" && now > link.expiresAt + 60_000) pendingLinks.delete(id);
  }
  for (const [userId, device] of pendingDeviceLinks) {
    if (now > device.expiresAt) pendingDeviceLinks.delete(userId);
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = setInterval(() => sweepPendingLinks(), 30_000);

export function stopIllarinSweeps(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function activeLinkFor(userId: string): PendingBrowserLink | undefined {
  for (const link of pendingLinks.values()) {
    if (link.userId === userId) return link;
  }
  return undefined;
}

function openInSystemBrowser(url: string): void {
  try {
    if (process.platform === "darwin") Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    else if (process.platform === "win32") Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
    else Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  } catch (err) {
    console.warn("[Illarin] Could not open system browser:", err instanceof Error ? err.message : err);
  }
}

export const illarinRoutes = new Hono();

/** Start a same-device browser link. */
illarinRoutes.post("/link/browser", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null) as { illarin_url?: unknown; instance_name?: unknown } | null;

  const baseUrl = typeof body?.illarin_url === "string" ? body.illarin_url.trim().replace(/\/+$/, "") : "";
  if (!baseUrl) return c.json({ error: "illarin_url is required" }, 400);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return c.json({ error: "illarin_url is not a valid URL" }, 400);
  }
  if (parsedUrl.protocol !== "https:") {
    return c.json({ error: "illarin_url must use https" }, 400);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return c.json({ error: "illarin_url must not contain credentials, a query, or a fragment" }, 400);
  }
  try {
    await validateHost(parsedUrl.hostname);
  } catch (err) {
    if (err instanceof SSRFError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // Retire any previous attempt for this user before starting another.
  for (const [id, link] of pendingLinks) {
    if (link.userId === userId) pendingLinks.delete(id);
  }

  const instanceName = typeof body?.instance_name === "string" && body.instance_name.trim()
    ? body.instance_name.trim()
    : "My Lumiverse";

  let declaration;
  try {
    declaration = buildDeclaration({
      instanceName,
      applicationVersion: await readBackendVersion(),
      scopes: ["asset:receive"],
    });
  } catch (err) {
    return c.json({ error: err instanceof RangeError ? err.message : "invalid declaration" }, 400);
  }

  const linkId = randomUUID();
  const session: PendingBrowserLink = {
    userId,
    status: "pending",
    expiresAt: Date.now() + LINK_TIMEOUT_MS + 10_000,
  };
  pendingLinks.set(linkId, session);

  void runBrowserLink({
    baseUrl,
    declaration,
    openUrl: openInSystemBrowser,
  })
    .then(async (outcome: BrowserLinkOutcome) => {
      if (outcome.kind === "linked") {
        await svc.saveInstance({
          userId,
          illarinUrl: baseUrl,
          pair: outcome.tokens,
          instanceName,
          applicationName: declaration.applicationName,
          declarationJson: JSON.stringify(declaration),
        });
        session.status = "linked";
      } else {
        session.status = "failed";
        session.reason = outcome.kind === "invalid_callback" ? outcome.reason : outcome.kind;
      }
    })
    .catch((err) => {
      console.warn("[Illarin] Browser link failed:", err instanceof Error ? err.message : err);
      session.status = "failed";
      session.reason = "link_failed";
    });

  return c.json({ link_id: linkId, expires_at: new Date(session.expiresAt).toISOString() });
});

/** Connection status plus the state of any in-progress linking attempt. */
illarinRoutes.get("/status", async (c) => {
  const userId = c.get("userId");
  const instance = await svc.getIllarinInstance(userId);

  const active = activeLinkFor(userId);
  return c.json({
    linked: instance !== null,
    illarin_url: instance?.illarinUrl,
    instance_name: instance?.instanceName,
    instance_id: instance?.instanceId,
    scopes: instance?.scopes ?? [],
    linked_at: instance?.linkedAt,
    last_refresh_at: instance?.lastRefreshAt,
    declaration_version: typeof instance?.lastDeclaration?.applicationVersion === "string"
      ? instance.lastDeclaration.applicationVersion
      : null,
    pending_link: active
      ? { status: active.status, reason: active.reason ?? null }
      : null,
  });
});

/** Unlink locally; the owner revokes remotely via Illarin account settings. */
illarinRoutes.post("/unlink", async (c) => {
  const userId = c.get("userId");
  for (const [id, link] of pendingLinks) {
    if (link.userId === userId) pendingLinks.delete(id);
  }
  await handleTerminalUnauthorized(userId, "unlinked");
  return c.json({
    success: true,
    hint: "Also revoke this instance in your Illarin account settings to remove it there.",
  });
});


/** Start the headless device fallback: manual code entry, no prefilled URL. */
illarinRoutes.post("/link/device", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null) as { illarin_url?: unknown; instance_name?: unknown } | null;

  const baseUrl = typeof body?.illarin_url === "string" ? body.illarin_url.trim().replace(/\/+$/, "") : "";
  if (!baseUrl) return c.json({ error: "illarin_url is required" }, 400);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return c.json({ error: "illarin_url is not a valid URL" }, 400);
  }
  if (parsedUrl.protocol !== "https:") {
    return c.json({ error: "illarin_url must use https" }, 400);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return c.json({ error: "illarin_url must not contain credentials, a query, or a fragment" }, 400);
  }
  try {
    await validateHost(parsedUrl.hostname);
  } catch (err) {
    if (err instanceof SSRFError) return c.json({ error: err.message }, 400);
    throw err;
  }

  pendingDeviceLinks.delete(userId);

  const instanceName = typeof body?.instance_name === "string" && body.instance_name.trim()
    ? body.instance_name.trim()
    : "My Lumiverse";

  let declaration;
  try {
    declaration = buildDeclaration({
      instanceName,
      applicationVersion: await readBackendVersion(),
      scopes: ["asset:receive"],
    });
  } catch (err) {
    return c.json({ error: err instanceof RangeError ? err.message : "invalid declaration" }, 400);
  }

  let request;
  try {
    request = await createDeviceRequest(baseUrl, declaration);
  } catch (err) {
    console.warn("[Illarin] Device request failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Failed to start device linking" }, 502);
  }

  const declarationJson = JSON.stringify(declaration);
  const session = new DeviceLinkSession(request, baseUrl, {
    onLinked: async (tokens) => {
      await svc.saveInstance({
        userId,
        illarinUrl: baseUrl,
        pair: tokens,
        instanceName,
        applicationName: declaration.applicationName,
        declarationJson,
      });
    },
  });
  const expiresAt = Date.parse(request.expiresAt);
  pendingDeviceLinks.set(userId, {
    userId,
    baseUrl,
    session,
    instanceName,
    applicationName: declaration.applicationName,
    declarationJson,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000,
  });

  // The private deviceCode stays server-side by design.
  return c.json({
    user_code: request.userCode,
    verification_url: request.verificationUrl,
    expires_at: request.expiresAt,
  });
});

/** Drive one poll-if-due step of the user's active device attempt. */
illarinRoutes.get("/link/device/status", async (c) => {
  const userId = c.get("userId");
  const pending = pendingDeviceLinks.get(userId);
  if (!pending) return c.json({ status: "none" });

  const result = await pending.session.pollIfDue();
  if (result.status !== "pending") {
    pendingDeviceLinks.delete(userId);
  }
  if (result.status === "pending") {
    return c.json({ status: "pending", retry_in_ms: result.retryInMs });
  }
  if (result.status === "linked") {
    return c.json({ status: "linked", instance_id: result.tokens.instance.id });
  }
  return c.json({ status: result.status });
});
