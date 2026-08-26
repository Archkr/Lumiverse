import { describe, expect, mock, test } from 'bun:test'
import type { ApplyWorkerJob, ApplyWorkerResponse, ApplyWorkerScript } from './apply.worker'

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false,
  getDisplayResolverForChat: () => undefined,
}))
mock.module('@/i18n', () => ({ default: { t: (key: string) => key } }))
mock.module('@/store', () => ({ useStore: { getState: () => ({}) } }))
mock.module('@/lib/cssModuleRegistry', () => ({ CSS_MODULE_REGISTRY: [], generateSelector: () => '' }))

import type { RegexWorkerLike } from './worker-client'
const { compileRegex } = await import('./compile-regex')
const { replaceWithinRegexSearchWindow } = await import('./search-window')
const {
  MAX_PENDING_JOBS,
  RegexJobDroppedError,
  RegexWorkerTimeoutError,
  RegexWorkerUnsupportedError,
  resetRegexWorkerForTests,
  runRegexJobInWorker,
  setRegexWorkerCallbacks,
  setRegexWorkerDepsForTests,
} = await import('./worker-client')

class FakeWorker implements RegexWorkerLike {
  terminated = false
  sent: ApplyWorkerJob[] = []
  messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  errorHandler: ((error: Error) => void) | null = null
  onJob: ((job: ApplyWorkerJob) => void) | null = null

  postMessage(message: ApplyWorkerJob): void {
    this.sent.push(message)
    this.onJob?.(message)
  }

  terminate(): void { this.terminated = true }
  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void { this.messageHandler = handler }
  setErrorHandler(handler: (error: Error) => void): void { this.errorHandler = handler }
  respond(response: ApplyWorkerResponse): void { this.messageHandler?.(response) }
}

interface ManualTimer {
  fn: () => void
  cancelled: boolean
  ms: number
}

function makeHarness() {
  resetRegexWorkerForTests()
  const spawned: FakeWorker[] = []
  const timers: ManualTimer[] = []
  setRegexWorkerDepsForTests({
    now: () => timers.length,
    spawnWorker: () => {
      const worker = new FakeWorker()
      spawned.push(worker)
      return worker
    },
    scheduleTimer: (fn, ms) => {
      const timer = { fn, cancelled: false, ms }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    isSupported: () => true,
    isPageVisible: () => true,
    schedulerLagMs: () => 0,
  })
  const fireTimer = (index: number) => {
    const timer = timers[index]
    if (timer && !timer.cancelled) {
      timer.cancelled = true
      timer.fn()
    }
  }
  return { spawned, timers, fireTimer }
}

function applyScript(body: string, script: ApplyWorkerScript): string {
  const regex = compileRegex(script.pattern, script.flags)
  if (!regex) throw new Error('invalid pattern')
  let result = replaceWithinRegexSearchWindow(
    body,
    regex,
    script.pattern,
    script.flags,
    script.replaceString,
    script.replaceString,
  )
  for (const trim of script.trimStrings) {
    if (trim === '') continue
    let iterations = 0
    while (result.includes(trim)) {
      result = result.replaceAll(trim, '')
      if (++iterations >= 32) break
    }
  }
  return result
}

function echoWorker(fake: FakeWorker): void {
  const handled = new Set<number>()
  const handle = (job: ApplyWorkerJob) => {
    if (handled.has(job.jobId)) return
    handled.add(job.jobId)
    try {
      let result = job.body
      const scriptElapsedMs: number[] = []
      job.scripts.forEach((script, scriptIndex) => {
        fake.respond({ type: 'progress', jobId: job.jobId, scriptIndex, scriptId: script.scriptId, scriptName: script.scriptName })
        result = applyScript(result, script)
        scriptElapsedMs.push(3)
        fake.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex, result, elapsedMs: 3 })
      })
      fake.respond({ type: 'result', jobId: job.jobId, op: 'apply', result, elapsedMs: scriptElapsedMs.length * 3, scriptElapsedMs })
    } catch (error) {
      fake.respond({
        type: 'error',
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: 3,
      })
    }
  }
  for (const job of fake.sent) handle(job)
  fake.onJob = handle
}

function workerScript(pattern: string, replaceString = '', id = pattern): ApplyWorkerScript {
  return { pattern, flags: 'g', replaceString, trimStrings: [], scriptId: id, scriptName: id }
}

describe('regex worker client', () => {
  test('dispatch starvation blames no script and preserves queued work', async () => {
    const { spawned, fireTimer } = makeHarness()
    try {
      const first = runRegexJobInWorker({ op: 'apply', body: 'aaa', scripts: [workerScript('a', 'b', 'slow')] })
      const second = runRegexJobInWorker({ op: 'apply', body: 'hello', scripts: [workerScript('hello', 'hi', 'safe')] })
      expect(spawned[0].sent).toHaveLength(1)

      fireTimer(0)
      fireTimer(1)
      const timeout = await first.catch((error) => error)
      expect(timeout).toBeInstanceOf(RegexWorkerTimeoutError)
      expect(timeout.scriptId).toBeUndefined()
      expect(timeout.completedScriptCount).toBe(0)
      expect(timeout.checkpointResult).toBe('aaa')
      expect(spawned[0].terminated).toBe(true)
      expect(spawned).toHaveLength(2)

      echoWorker(spawned[1])
      expect(await second).toMatchObject({ result: 'hi', scriptElapsedMs: [3] })
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('progress re-arms the per-script deadline', async () => {
    const { spawned, timers, fireTimer } = makeHarness()
    try {
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'ab',
        scripts: [workerScript('a', 'A', 'first'), workerScript('b', 'B', 'second')],
      })
      const fake = spawned[0]
      const job = fake.sent[0]
      fake.respond({ type: 'progress', jobId: job.jobId, scriptIndex: 0, scriptId: 'first' })
      expect(timers[0].cancelled).toBe(true)
      fake.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex: 0, result: 'Ab', elapsedMs: 3 })
      fake.respond({ type: 'progress', jobId: job.jobId, scriptIndex: 1, scriptId: 'second' })
      expect(timers[1].cancelled).toBe(true)

      fireTimer(2)
      fireTimer(3)
      const timeout = await promise.catch((error) => error)
      expect(timeout.scriptId).toBe('second')
      expect(timeout.scriptIndex).toBe(1)
      expect(timeout.completedScriptCount).toBe(1)
      expect(timeout.checkpointResult).toBe('Ab')
      expect(timeout.phase).toBe('execution')
      expect(timeout.environmentCongested).toBe(false)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('batches scripts into one body round trip', async () => {
    const { spawned } = makeHarness()
    try {
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'foo boo',
        scripts: [workerScript('foo', 'bar'), workerScript('o+', '<$&>')],
      })
      echoWorker(spawned[0])
      const outcome = await promise
      expect(spawned[0].sent).toHaveLength(1)
      expect(outcome.result).toBe('bar b<oo>')
      expect(outcome.scriptElapsedMs).toEqual([3, 3])
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('the post-deadline grace lets an already-finished innocent regex win the task race', async () => {
    const { spawned, timers, fireTimer } = makeHarness()
    try {
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'a',
        scripts: [workerScript('a', 'A', 'instant')],
      })
      const worker = spawned[0]
      const job = worker.sent[0]
      worker.respond({ type: 'progress', jobId: job.jobId, scriptIndex: 0, scriptId: 'instant' })

      // The primary timer happened to win against the queued worker result.
      fireTimer(1)
      expect(timers[2].ms).toBe(50)
      worker.respond({ type: 'checkpoint', jobId: job.jobId, scriptIndex: 0, result: 'A', elapsedMs: 0 })
      worker.respond({ type: 'result', jobId: job.jobId, op: 'apply', result: 'A', elapsedMs: 0, scriptElapsedMs: [0] })

      expect((await promise).result).toBe('A')
      expect(worker.terminated).toBe(false)
      expect(timers[2].cancelled).toBe(true)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('hidden or globally starved workers receive the extended grace and diagnostic attribution', async () => {
    const { spawned, timers, fireTimer } = makeHarness()
    try {
      setRegexWorkerDepsForTests({
        isPageVisible: () => false,
        schedulerLagMs: () => 900,
      })
      const promise = runRegexJobInWorker({
        op: 'apply',
        body: 'a',
        scripts: [workerScript('a', 'A', 'innocent')],
      })
      const job = spawned[0].sent[0]
      spawned[0].respond({ type: 'progress', jobId: job.jobId, scriptIndex: 0, scriptId: 'innocent' })

      fireTimer(1)
      expect(timers[2].ms).toBe(1_000)
      fireTimer(2)
      const timeout = await promise.catch((error) => error)
      expect(timeout).toBeInstanceOf(RegexWorkerTimeoutError)
      expect(timeout.pageVisible).toBe(false)
      expect(timeout.schedulerLagMs).toBe(900)
      expect(timeout.environmentCongested).toBe(true)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('overflow drops the oldest queued job, never the active job', async () => {
    const { spawned } = makeHarness()
    try {
      const dropped: number[] = []
      setRegexWorkerCallbacks({ onDropped: ({ jobId }) => dropped.push(jobId) })
      const promises = Array.from({ length: MAX_PENDING_JOBS }, (_, index) => runRegexJobInWorker({
        op: 'apply', body: String(index), scripts: [workerScript(String(index))],
      }))
      expect(spawned[0].sent).toHaveLength(1)

      const newest = runRegexJobInWorker({ op: 'apply', body: 'new', scripts: [workerScript('new', 'NEW')] })
      expect(dropped).toEqual([2])
      await expect(promises[1]).rejects.toBeInstanceOf(RegexJobDroppedError)

      echoWorker(spawned[0])
      expect((await promises[0]).result).toBe('')
      expect((await newest).result).toBe('NEW')
      const survivors = await Promise.allSettled(promises.slice(2))
      expect(survivors.every((entry) => entry.status === 'fulfilled')).toBe(true)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('unsupported environments reject without spawning', async () => {
    const { spawned } = makeHarness()
    try {
      setRegexWorkerDepsForTests({ isSupported: () => false })
      await expect(runRegexJobInWorker({ op: 'apply', body: 'a', scripts: [workerScript('a')] }))
        .rejects.toBeInstanceOf(RegexWorkerUnsupportedError)
      expect(spawned).toHaveLength(0)
    } finally {
      resetRegexWorkerForTests()
    }
  })
})
