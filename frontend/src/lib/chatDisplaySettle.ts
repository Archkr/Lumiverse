import { areMessageTagRuntimeInterceptorsReady } from './spindle/message-tag-runtime-readiness'

// Settled-state tracking for the chat reveal.
//
// On chat open, message content goes through asynchronous stages before it
// reaches its final form: Spindle extensions register message-tag
// interceptors (stripping embedded payloads like status JSON), display regex
// scripts resolve their macros and run through the worker/backend pipeline,
// and extension-owned display preprocessors rewrite content. Every stage
// repaints already-mounted rows, so revealing the chat before the pipeline
// settles shows raw tags/JSON that visibly flash away a second or two later.
//
// This module tracks the three signals the reveal gate needs:
//   - runtime tag readiness: backend-declared tag-interceptor extensions must
//     attach their frontend handlers before raw payload-bearing tags can paint.
//   - PENDING first resolves: in-flight first resolutions for the mounted
//     chat must drain before the content on screen can be trusted as final.
//   - PENDING display work: first-wave tag-intercept delivery and the
//     widget DOM inserts those handlers schedule. SimTracker (and similar
//     interceptors) rewrite row height after the registry has gone quiet;
//     revealing before those inserts finish still thrashes the list.
// The reveal itself is deferred by two animation frames, giving React time to
// commit the interceptor-triggered repaint without imposing an arbitrary
// quiet-period delay. The caller bounds its wait with a hard cap so
// pathological cases (a slow backend, an extension stuck mid-load) degrade to
// today's behavior instead of blocking the reveal forever.

export const CHAT_REVEAL_SETTLE_CAP_MS = 5000

export function resetChatDisplaySettleForTests(): void {
  pendingFirstResolves = 0
  pendingDisplayWork = 0
}

let pendingFirstResolves = 0
let pendingDisplayWork = 0

/**
 * Count first-wave intercept delivery / widget-insert work that lands after
 * interceptor registration. Pair with `endChatDisplayWork`.
 */
export function beginChatDisplayWork(): void {
  pendingDisplayWork += 1
}

export function endChatDisplayWork(): void {
  if (pendingDisplayWork > 0) pendingDisplayWork -= 1
}

/**
 * Track a first-pass resolve (one whose cache entry had no value yet). The
 * returned promise is behaviorally identical — same value, same rejection —
 * with a decrement hooked on settlement, so callers should store/await the
 * wrapped promise wherever they would have stored the original.
 */
export function trackInitialDisplayResolve<T>(promise: Promise<T>): Promise<T> {
  pendingFirstResolves += 1
  return promise.finally(() => {
    pendingFirstResolves -= 1
  })
}

/**
 * True when all declared tag interceptors are attached and no first resolves
 * or first-wave display work remain in flight.
 */
export function isChatDisplaySettled(): boolean {
  if (!areMessageTagRuntimeInterceptorsReady()) return false
  if (pendingFirstResolves > 0 || pendingDisplayWork > 0) return false
  return true
}
