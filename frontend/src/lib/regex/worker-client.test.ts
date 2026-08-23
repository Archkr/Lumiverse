import { describe, expect, mock, test } from 'bun:test'
import type { ApplyWorkerJob, ApplyWorkerResponse } from './apply.worker'

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false,
  getDisplayResolverForChat: () => undefined,
}))

const { compileRegex } = await import('./compiler')
import { replaceWithinRegexSearchWindow } from './search-window'
import type { RegexWorkerLike } from './worker-client'
import {
  MAX_PENDING_JOBS,
  RegexJobDroppedError,
  RegexWorkerTimeoutError,
  RegexWorkerUnsupportedError,
  resetRegexWorkerForTests,
  runRegexJobInWorker,
  setRegexWorkerCallbacks,
  setRegexWorkerDepsForTests,
} from './worker-client'

class FakeWorker implements RegexWorkerLike {
  terminated = false
  sent: ApplyWorkerJob[] = []
  responded = new Set<number>()
  messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  errorHandler: ((error: Error) => void) | null = null
  onJob: ((job: ApplyWorkerJob) => void) | null = null

  postMessage(message: ApplyWorkerJob): void {
    this.sent.push(message)
    this.onJob?.(message)
  }

  terminate(): void {
    this.terminated = true
  }

  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void {
    this.messageHandler = handler
  }

  setErrorHandler(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  respond(response: ApplyWorkerResponse): void {
    this.messageHandler?.(response)
  }
}

interface ManualTimer {
  fn: () => void
  ms: number
  cancelled: boolean
}

function makeHarness() {
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
      const timer: ManualTimer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    isSupported: () => true,
  })

  function fireTimers(ms: number): void {
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.ms === ms) timer.fn()
    }
  }

  return { spawned, timers, fireTimers }
}

// Sync reference implementation mirroring the worker's per-script unit:
// search-window-bounded replacement + bounded trim loop.
function syncReference(job: Omit<ApplyWorkerJob, 'jobId'>): string {
  const regex = compileRegex(job.pattern, job.flags)
  if (!regex) throw new Error(`invalid pattern`)
  let result = replaceWithinRegexSearchWindow(
    job.body,
    regex,
    job.pattern,
    job.flags,
    job.replaceString ?? '',
    job.replaceString ?? '',
  )
  for (const trim of job.trimStrings ?? []) {
    if (trim === '') continue
    let iterations = 0
    while (result.includes(trim)) {
      result = result.replaceAll(trim, '')
      iterations += 1
      if (iterations >= 32) break
    }
  }
  return result
}

function echoWorker(fake: FakeWorker): void {
  const handle = (job: ApplyWorkerJob) => {
    if (fake.responded.has(job.jobId)) return
    fake.responded.add(job.jobId)
    if (job.op === 'probe') {
      fake.respond({ type: 'result', jobId: job.jobId, op: 'probe', passed: true, elapsedMs: 2 })
      return
    }
    try {
      const result = syncReference(job)
      fake.respond({ type: 'result', jobId: job.jobId, op: 'apply', result, elapsedMs: 3 })
    } catch (error) {
      fake.respond({
        type: 'error',
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: 3,
      })
    }
  }
  // Replay jobs that were posted before the handler was attached.
  for (const job of [...fake.sent]) handle(job)
  fake.onJob = handle
}

describe('regex worker client', () => {
  test('deadline fires: terminate, respawn, reject timed-out job, next job succeeds', async () => {
    const { spawned, fireTimers } = makeHarness()
    try {
      const first = runRegexJobInWorker({ op: 'apply', body: 'aaa', pattern: 'a', flags: 'g' })
      expect(spawned.length).toBe(1)

      fireTimers(250)
      const firstOutcome = await first.then(
        () => 'resolved',
        (err) => err,
      )
      expect(firstOutcome).toBeInstanceOf(RegexWorkerTimeoutError)
      expect(spawned[0].terminated).toBe(true)
      expect(spawned.length).toBe(2)

      echoWorker(spawned[1])
      const second = await runRegexJobInWorker({
        op: 'apply',
        body: 'hello world hello',
        pattern: 'hello',
        flags: 'g',
        replaceString: 'hi',
      })
      expect(second).toEqual({ op: 'apply', result: 'hi world hi', elapsedMs: 3 })
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('success result parity vs sync reference implementation', async () => {
    const { spawned } = makeHarness()
    try {
      let fake: FakeWorker | null = null
      const cases: Array<Omit<ApplyWorkerJob, 'jobId'>> = [
        { op: 'apply', body: 'foo boo oo', pattern: 'o+', flags: 'g', replaceString: '<$&>' },
        { op: 'apply', body: 'bbcc', pattern: 'zzz', flags: 'g', replaceString: '', trimStrings: ['bc'] },
        { op: 'apply', body: 'aXbXc', pattern: 'X', flags: 'g', replaceString: '', trimStrings: ['X', ''] },
        { op: 'apply', body: 'tail keep end', pattern: 'keep', flags: '', replaceString: 'KEEP tail' },
        {
          op: 'apply',
          body: 'name: alice other: bob',
          pattern: 'name: (?<who>\\w+)',
          flags: 'g',
          replaceString: '[$<who>]',
        },
      ]

      for (const jobInput of cases) {
        const outcomePromise = runRegexJobInWorker(jobInput)
        if (!fake) {
          fake = spawned[0]
          echoWorker(fake)
        }
        const outcome = await outcomePromise
        expect(outcome.op).toBe('apply')
        if (outcome.op !== 'apply') continue
        expect(outcome.result).toBe(syncReference(jobInput))
      }
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('bounded trim rejoin case reaches empty string like the main-thread loop', async () => {
    const { spawned } = makeHarness()
    try {
      const outcomePromise = runRegexJobInWorker({
        op: 'apply',
        body: 'bbcc',
        pattern: 'zzz',
        flags: 'g',
        replaceString: '',
        trimStrings: ['bc'],
      })
      echoWorker(spawned[0])
      const outcome = await outcomePromise
      expect(outcome.op === 'apply' && outcome.result).toBe('')
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('overflow drops OLDEST pending, newest always runs, trailing flush succeeds', async () => {
    const { spawned } = makeHarness()
    try {
      const droppedEvents: Array<{ jobId: number }> = []
      setRegexWorkerCallbacks({
        onDropped: (event) => droppedEvents.push({ jobId: event.jobId }),
      })

      const promises: Array<Promise<unknown>> = []
      for (let i = 0; i < MAX_PENDING_JOBS; i += 1) {
        promises.push(runRegexJobInWorker({ op: 'apply', body: String(i), pattern: String(i), flags: 'g' }))
      }
      expect(droppedEvents.length).toBe(0)

      // Newest job must be accepted even at capacity; the OLDEST is dropped.
      const newestPromise = runRegexJobInWorker({
        op: 'apply',
        body: 'newest-body',
        pattern: 'newest',
        flags: 'g',
        replaceString: 'NEWEST',
      })
      expect(droppedEvents.length).toBe(1)
      await expect(promises[0]).rejects.toBeInstanceOf(RegexJobDroppedError)

      const fake = spawned[0]
      echoWorker(fake)
      const newest = await newestPromise
      expect(newest.op === 'apply' && newest.result).toBe('NEWEST-body')

      // Trailing flush: after the drop, subsequent submissions succeed.
      const flushed = await runRegexJobInWorker({ op: 'apply', body: 'zz', pattern: 'z', flags: 'g', replaceString: '' })
      expect(flushed.op === 'apply' && flushed.result).toBe('')

      const survivors = await Promise.allSettled(promises.slice(1))
      expect(survivors.every((entry) => entry.status === 'fulfilled')).toBe(true)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('unsupported environment rejects without spawning a worker', async () => {
    makeHarness()
    try {
      setRegexWorkerDepsForTests({ isSupported: () => false })
      await expect(
        runRegexJobInWorker({ op: 'apply', body: 'a', pattern: 'a', flags: 'g' }),
      ).rejects.toBeInstanceOf(RegexWorkerUnsupportedError)
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('out-of-order completion: stale/late messages never clobber settled jobs', async () => {
    const { spawned } = makeHarness()
    try {
      const older = runRegexJobInWorker({ op: 'apply', body: 'old', pattern: 'old', flags: 'g', replaceString: 'OLD' })
      const newer = runRegexJobInWorker({ op: 'apply', body: 'new', pattern: 'new', flags: 'g', replaceString: 'NEW' })

      const fake = spawned[0]
      const olderJob = fake.sent[0]
      const newerJob = fake.sent[1]

      // Newer completes first.
      fake.respond({ type: 'result', jobId: newerJob.jobId, op: 'apply', result: 'NEW', elapsedMs: 1 })
      expect(await newer).toEqual({ op: 'apply', result: 'NEW', elapsedMs: 1 })

      // Older resolves late — settles its own caller only.
      fake.respond({ type: 'result', jobId: olderJob.jobId, op: 'apply', result: 'OLD', elapsedMs: 9 })
      expect(await older).toEqual({ op: 'apply', result: 'OLD', elapsedMs: 9 })

      // Stale duplicate for an already-settled jobId must be ignored entirely.
      fake.respond({ type: 'result', jobId: olderJob.jobId, op: 'apply', result: 'STALE', elapsedMs: 99 })
      expect(await older).toEqual({ op: 'apply', result: 'OLD', elapsedMs: 9 })

      // Unknown jobId is ignored without throwing.
      fake.respond({ type: 'result', jobId: 424242, op: 'apply', result: 'ghost', elapsedMs: 0 })
    } finally {
      resetRegexWorkerForTests()
    }
  })

  test('probe op returns passed flag and elapsed ms', async () => {
    const { spawned } = makeHarness()
    try {
      const passedPromise = runRegexJobInWorker({ op: 'probe', body: 'catastrophic'.repeat(50), pattern: 'cat', flags: 'g' })
      const fake = spawned[0]
      echoWorker(fake)
      const passed = await passedPromise
      expect(passed).toEqual({ op: 'probe', passed: true, elapsedMs: 2 })

      fake.onJob = (job) => {
        fake.respond({ type: 'error', jobId: job.jobId, error: 'boom', elapsedMs: 5 })
      }
      await expect(
        runRegexJobInWorker({ op: 'probe', body: 'x', pattern: '(' , flags: '' }),
      ).rejects.toThrow('boom')
    } finally {
      resetRegexWorkerForTests()
    }
  })
})
