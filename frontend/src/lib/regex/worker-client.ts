import type { ApplyWorkerJob, ApplyWorkerResponse } from './apply.worker'

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
  readonly scriptId?: string
  readonly scriptName?: string

  constructor(jobId: number, script?: { scriptId?: string; scriptName?: string }, message?: string) {
    const label = script?.scriptId ?? 'unknown'
    super(message ?? `regex job ${jobId} exceeded ${KILL_MS}ms deadline (script ${label})`)
    this.name = 'RegexWorkerTimeoutError'
    this.jobId = jobId
    this.scriptId = script?.scriptId
    this.scriptName = script?.scriptName
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
    setMessageHandler: (handler) => { messageHandler = handler },
    setErrorHandler: (handler) => { errorHandler = handler },
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
  deps = { ...getDeps(), ...overrides }
}

export function setRegexWorkerCallbacks(next: RegexWorkerCallbacks): void {
  callbacks = next
}

export type RegexJobInput = Omit<ApplyWorkerJob, 'jobId'>
export type RegexJobOutcome = {
  op: 'apply'
  result: string
  elapsedMs: number
  scriptElapsedMs: number[]
}

interface PendingJob {
  job: ApplyWorkerJob
  resolve: (outcome: RegexJobOutcome) => void
  reject: (error: RegexWorkerError) => void
  cancelDeadline: (() => void) | null
  currentScript: { scriptId?: string; scriptName?: string }
}

const queue: PendingJob[] = []
let active: PendingJob | null = null
let activeWorker: RegexWorkerLike | null = null
let nextJobId = 1

export function isSupported(): boolean {
  return getDeps().isSupported()
}

function ensureWorker(): RegexWorkerLike {
  if (activeWorker) return activeWorker
  const worker = getDeps().spawnWorker()
  worker.setMessageHandler((message) => handleWorkerMessage(worker, message))
  worker.setErrorHandler((error) => handleWorkerError(worker, error))
  activeWorker = worker
  return worker
}

function armDeadline(entry: PendingJob): void {
  entry.cancelDeadline?.()
  entry.cancelDeadline = getDeps().scheduleTimer(() => handleDeadlineExpired(entry), KILL_MS)
}

function pumpQueue(): void {
  if (active || queue.length === 0) return
  const entry = queue.shift()!
  let worker: RegexWorkerLike
  try {
    worker = ensureWorker()
  } catch (error) {
    entry.reject(new RegexWorkerCrashedError(
      `regex worker construction failed: ${error instanceof Error ? error.message : String(error)}`,
    ))
    pumpQueue()
    return
  }
  active = entry
  armDeadline(entry)
  try {
    worker.postMessage(entry.job)
  } catch (error) {
    entry.cancelDeadline?.()
    entry.cancelDeadline = null
    active = null
    activeWorker?.terminate()
    activeWorker = null
    entry.reject(new RegexWorkerCrashedError(
      `regex worker postMessage failed: ${error instanceof Error ? error.message : String(error)}`,
    ))
    pumpQueue()
  }
}

function handleWorkerMessage(worker: RegexWorkerLike, message: ApplyWorkerResponse): void {
  if (worker !== activeWorker || !active || active.job.jobId !== message.jobId) return
  if (message.type === 'progress') {
    active.currentScript = {
      ...(message.scriptId ? { scriptId: message.scriptId } : {}),
      ...(message.scriptName ? { scriptName: message.scriptName } : {}),
    }
    armDeadline(active)
    return
  }

  const entry = active
  active = null
  entry.cancelDeadline?.()
  entry.cancelDeadline = null
  if (message.type === 'error') {
    callbacks.onScriptFlagged?.({
      jobId: message.jobId,
      ...entry.currentScript,
      elapsedMs: message.elapsedMs,
    })
    entry.reject(new RegexWorkerError(`regex job ${message.jobId} failed: ${message.error}`))
  } else {
    entry.resolve({
      op: 'apply',
      result: message.result,
      elapsedMs: message.elapsedMs,
      scriptElapsedMs: message.scriptElapsedMs,
    })
  }
  pumpQueue()
}

function handleWorkerError(worker: RegexWorkerLike, error: Error): void {
  if (worker !== activeWorker) return
  worker.terminate()
  activeWorker = null
  const entry = active
  active = null
  if (entry) {
    entry.cancelDeadline?.()
    entry.reject(new RegexWorkerCrashedError(`regex worker crashed: ${error.message}`))
  }
  pumpQueue()
}

function handleDeadlineExpired(entry: PendingJob): void {
  if (active !== entry) return
  activeWorker?.terminate()
  activeWorker = null
  active = null
  entry.cancelDeadline?.()
  entry.cancelDeadline = null
  entry.reject(new RegexWorkerTimeoutError(entry.job.jobId, entry.currentScript))
  pumpQueue()
}

export function runRegexJobInWorker(input: RegexJobInput): Promise<RegexJobOutcome> {
  if (!isSupported()) return Promise.reject(new RegexWorkerUnsupportedError())

  const job: ApplyWorkerJob = { ...input, jobId: nextJobId++ }
  return new Promise<RegexJobOutcome>((resolve, reject) => {
    while ((active ? 1 : 0) + queue.length >= MAX_PENDING_JOBS) {
      const oldest = queue.shift()
      if (!oldest) break
      callbacks.onDropped?.({
        jobId: oldest.job.jobId,
        ...oldest.currentScript,
      })
      oldest.reject(new RegexJobDroppedError(oldest.job.jobId))
    }
    const first = job.scripts[0]
    queue.push({
      job,
      resolve,
      reject,
      cancelDeadline: null,
      currentScript: {
        ...(first?.scriptId ? { scriptId: first.scriptId } : {}),
        ...(first?.scriptName ? { scriptName: first.scriptName } : {}),
      },
    })
    pumpQueue()
  })
}

export function resetRegexWorkerForTests(): void {
  deps = null
  callbacks = {}
  active?.cancelDeadline?.()
  active = null
  queue.length = 0
  activeWorker?.terminate()
  activeWorker = null
  nextJobId = 1
}
