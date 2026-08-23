import type { ApplyWorkerJob, ApplyWorkerOp, ApplyWorkerResponse } from './apply.worker'

// Re-export the original policy constant now that compiler.ts exports it
// (Task 2 defined a local mirror pending that export).
export { DISPLAY_SLOW_REGEX_WARNING_MS as WARN_MS } from './compiler'

export const KILL_MS_DEFAULT = 250
export const MAX_PENDING_JOBS = 8

function resolveKillMs(): number {
  const raw = import.meta.env.VITE_REGEX_KILL_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : KILL_MS_DEFAULT
}

export const KILL_MS = resolveKillMs()

export interface RegexWorkerLike {
  postMessage(message: ApplyWorkerJob): void
  terminate(): void
  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void
  setErrorHandler(handler: (error: Error) => void): void
}

export interface RegexWorkerDeps {
  now(): number
  spawnWorker(): RegexWorkerLike
  scheduleTimer(fn: () => void, ms: number): () => void
  isSupported(): boolean
}

export interface RegexWorkerCallbacks {
  onScriptFlagged?: (event: { jobId: number; scriptId?: string; scriptName?: string; elapsedMs?: number }) => void
  onDropped?: (event: { jobId: number; scriptId?: string; scriptName?: string }) => void
}

export class RegexWorkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegexWorkerError'
  }
}

export class RegexWorkerTimeoutError extends RegexWorkerError {
  readonly jobId: number
  constructor(jobId: number, message = `regex job ${jobId} exceeded ${KILL_MS}ms deadline`) {
    super(message)
    this.name = 'RegexWorkerTimeoutError'
    this.jobId = jobId
  }
}

export class RegexJobDroppedError extends RegexWorkerError {
  readonly jobId: number
  constructor(jobId: number, message = `regex job ${jobId} dropped (queue overflow)`) {
    super(message)
    this.name = 'RegexJobDroppedError'
    this.jobId = jobId
  }
}

export class RegexWorkerUnsupportedError extends RegexWorkerError {
  constructor(message = 'Worker is not supported in this environment') {
    super(message)
    this.name = 'RegexWorkerUnsupportedError'
  }
}

export class RegexWorkerCrashedError extends RegexWorkerError {
  constructor(message = 'regex worker crashed') {
    super(message)
    this.name = 'RegexWorkerCrashedError'
  }
}

function defaultSpawnWorker(): RegexWorkerLike {
  const worker = new Worker(new URL('./apply.worker.ts', import.meta.url), {
    type: 'module',
    name: 'lumiverse-regex-apply',
  })
  let messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  let errorHandler: ((error: Error) => void) | null = null
  worker.onmessage = (event: MessageEvent<ApplyWorkerResponse>) => messageHandler?.(event.data)
  worker.onerror = (event) => errorHandler?.(new Error(event.message || 'worker error'))
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    setMessageHandler: (handler) => {
      messageHandler = handler
    },
    setErrorHandler: (handler) => {
      errorHandler = handler
    },
  }
}

let deps: RegexWorkerDeps | null = null
let callbacks: RegexWorkerCallbacks = {}

function getDeps(): RegexWorkerDeps {
  if (!deps) {
    deps = {
      now: () => Date.now(),
      spawnWorker: defaultSpawnWorker,
      scheduleTimer: (fn, ms) => {
        const id = window.setTimeout(fn, ms)
        return () => window.clearTimeout(id)
      },
      isSupported: () => typeof Worker !== 'undefined',
    }
  }
  return deps
}

export function setRegexWorkerDepsForTests(overrides: Partial<RegexWorkerDeps>): void {
  const current = getDeps()
  deps = { ...current, ...overrides }
}

export function setRegexWorkerCallbacks(next: RegexWorkerCallbacks): void {
  callbacks = next
}

export function resetRegexWorkerForTests(): void {
  deps = null
  callbacks = {}
  pending.clear()
  if (activeWorker) {
    activeWorker.terminate()
    activeWorker = null
  }
  nextJobId = 1
}

export type RegexJobInput = Omit<ApplyWorkerJob, 'jobId'>

export type RegexJobOutcome =
  | { op: Extract<ApplyWorkerOp, 'apply'>; result: string; elapsedMs: number }
  | { op: Extract<ApplyWorkerOp, 'probe'>; passed: boolean; elapsedMs: number }

interface PendingJob {
  job: ApplyWorkerJob
  resolve: (outcome: RegexJobOutcome) => void
  reject: (error: RegexWorkerError) => void
  cancelDeadline: (() => void) | null
}

const pending = new Map<number, PendingJob>()
let activeWorker: RegexWorkerLike | null = null
let nextJobId = 1

export function isSupported(): boolean {
  return getDeps().isSupported()
}

function ensureWorker(): RegexWorkerLike {
  if (activeWorker) return activeWorker
  const worker = getDeps().spawnWorker()
  worker.setMessageHandler(handleWorkerMessage)
  worker.setErrorHandler(handleWorkerError)
  activeWorker = worker
  return worker
}

function settleAll(rejectWithError: (job: PendingJob) => RegexWorkerError): void {
  for (const entry of pending.values()) {
    entry.cancelDeadline?.()
    entry.reject(rejectWithError(entry))
  }
  pending.clear()
}

function handleWorkerMessage(message: ApplyWorkerResponse): void {
  // Out-of-order protection: only the live pending entry for this jobId may
  // settle, and it is removed before settling so late/stale duplicates are
  // guaranteed to be ignored.
  const entry = pending.get(message.jobId)
  if (!entry) return
  pending.delete(message.jobId)
  entry.cancelDeadline?.()
  entry.cancelDeadline = null
  if (message.type === 'error') {
    callbacks.onScriptFlagged?.({
      jobId: message.jobId,
      scriptId: entry.job.scriptId,
      scriptName: entry.job.scriptName,
      elapsedMs: message.elapsedMs,
    })
    entry.reject(new RegexWorkerError(`regex job ${message.jobId} failed: ${message.error}`))
    return
  }
  if (message.op === 'apply') {
    entry.resolve({ op: 'apply', result: message.result, elapsedMs: message.elapsedMs })
  } else {
    entry.resolve({ op: 'probe', passed: message.passed, elapsedMs: message.elapsedMs })
  }
}

function handleWorkerError(error: Error): void {
  activeWorker?.terminate()
  activeWorker = null
  settleAll(() => new RegexWorkerCrashedError(`regex worker crashed: ${error.message}`))
}

function handleDeadlineExpired(entry: PendingJob): void {
  // Kill the whole worker: any in-flight script is suspect once one exceeds
  // the deadline. Respawn immediately so the next job stays warm.
  activeWorker?.terminate()
  activeWorker = null
  ensureWorker()
  settleAll((killed) => new RegexWorkerTimeoutError(
    killed.job.jobId,
    `regex job ${killed.job.jobId} exceeded ${KILL_MS}ms deadline (script ${killed.job.scriptId ?? 'unknown'})`,
  ))
}

function dispatch(entry: PendingJob): void {
  const worker = ensureWorker()
  pending.set(entry.job.jobId, entry)
  worker.postMessage(entry.job)
  entry.cancelDeadline = getDeps().scheduleTimer(() => handleDeadlineExpired(entry), KILL_MS)
}

export function runRegexJobInWorker(input: RegexJobInput): Promise<RegexJobOutcome> {
  if (!isSupported()) {
    return Promise.reject(new RegexWorkerUnsupportedError())
  }
  const job: ApplyWorkerJob = { ...input, jobId: nextJobId }
  nextJobId += 1

  // Bounded queue: overflow drops the OLDEST pending job so the NEWEST always
  // executes. Callers re-arm via coalescing (trailing flush lands in Task 3).
  while (pending.size >= MAX_PENDING_JOBS) {
    const oldestKey = pending.keys().next().value
    if (oldestKey === undefined) break
    const oldest = pending.get(oldestKey)
    if (!oldest) break
    pending.delete(oldestKey)
    oldest.cancelDeadline?.()
    callbacks.onDropped?.({
      jobId: oldest.job.jobId,
      scriptId: oldest.job.scriptId,
      scriptName: oldest.job.scriptName,
    })
    oldest.reject(new RegexJobDroppedError(oldestKey))
  }

  return new Promise<RegexJobOutcome>((resolve, reject) => {
    dispatch({ job, resolve, reject, cancelDeadline: null })
  })
}
