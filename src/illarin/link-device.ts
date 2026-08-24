/**
 * Headless device fallback (protocol v1).
 *
 * Adopts RFC 8628's protections without being an OAuth Device Authorization
 * Grant: no client ID, no grant_type. The verification URL and user code are
 * shown SEPARATELY by design — there is deliberately no complete prefilled
 * verification URL. The private deviceCode never leaves the backend.
 *
 * This class owns the polling state machine from the protocol table. Each
 * `pollIfDue` call is one finite ordinary request; timing decisions are
 * computed from an injectable clock so tests stay deterministic.
 */

import { pollDeviceRequest, type IllarinFetch } from "./api";
import type { DeviceRequestResponse, TokenPair } from "./types";

export type DeviceLinkStatus =
  | { status: "pending"; retryInMs: number }
  | { status: "linked"; tokens: TokenPair }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "unknown_code" };

export interface DeviceLinkDeps {
  /** Injectable transport for tests; production uses safeFetch. */
  fetchImpl?: IllarinFetch;
  /** Called once when the owner approves. Persist credentials here. */
  onLinked: (tokens: TokenPair) => void | Promise<void>;
  now?: () => number;
}

const MAX_BACKOFF_MS = 60_000;

export class DeviceLinkSession {
  /** Persistent polling interval in ms — a `slow_down` raises it for good. */
  private intervalMs: number;
  private nextPollAt: number;
  private failedAttempts = 0;

  constructor(
    readonly request: DeviceRequestResponse,
    private readonly baseUrl: string,
    private readonly deps: DeviceLinkDeps,
  ) {
    this.intervalMs = Math.max(1_000, request.interval * 1000);
    this.nextPollAt = this.now() + this.intervalMs;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private schedule(delayMs: number): void {
    this.nextPollAt = this.now() + delayMs;
  }

  /**
   * Poll at most once per call, and only when the current interval has
   * elapsed. Returns the mapped protocol-table outcome.
   */
  async pollIfDue(): Promise<DeviceLinkStatus> {
    const now = this.now();
    if (now < this.nextPollAt) {
      return { status: "pending", retryInMs: this.nextPollAt - now };
    }

    let result;
    try {
      result = await pollDeviceRequest(this.baseUrl, this.request.deviceCode, {
        fetchImpl: this.deps.fetchImpl,
      });
      this.failedAttempts = 0;
    } catch {
      // Network failure: outcome unknown, but a poll consumes nothing, so
      // backing off and retrying is protocol-conformant here.
      this.failedAttempts++;
      const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(this.failedAttempts, 5));
      this.schedule(backoff);
      return { status: "pending", retryInMs: backoff };
    }

    switch (result.kind) {
      case "pending": {
        this.schedule(this.intervalMs);
        return { status: "pending", retryInMs: this.intervalMs };
      }
      case "slow_down": {
        // The larger interval remains in force from now on.
        const waitMs = Math.max(result.retryAfterSeconds ?? 0, this.request.interval) * 1000;
        this.intervalMs = Math.max(this.intervalMs, waitMs);
        this.schedule(this.intervalMs);
        return { status: "pending", retryInMs: this.intervalMs };
      }
      case "rate_limited": {
        // Source-wide limit: honor Retry-After once without raising the
        // persistent interval, but never poll before the current interval.
        const waitMs = Math.max(
          this.intervalMs,
          (result.retryAfterSeconds ?? this.request.interval) * 1000,
        );
        this.schedule(waitMs);
        return { status: "pending", retryInMs: waitMs };
      }
      case "linked":
        await this.deps.onLinked(result.tokens);
        return { status: "linked", tokens: result.tokens };
      case "denied":
        return { status: "denied" };
      case "expired":
        return { status: "expired" };
      case "unknown_code":
        return { status: "unknown_code" };
    }
  }
}
