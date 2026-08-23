import { describe, expect, mock, spyOn, afterEach, test } from 'bun:test'
import type { ApplyWorkerJob, ApplyWorkerResponse } from './apply.worker'
import type { RegexWorkerLike } from './worker-client'
import type { RegexScript } from '@/types/regex'

// Boundary mocks (registered before any import of the pipeline graph).
const toastCalls: Array<{ kind: string; message: string }> = []
mock.module('@/lib/toast', () => ({
  toast: {
    warning: (message: string, opts?: { title?: string }) => {
      toastCalls.push({ kind: 'warning', message: `${opts?.title ?? ''}:${message}` })
    },
    success: () => {},
    error: () => {},
    info: () => {},
  },
}))

const i18nStub = {
  default: { t: (k: string) => k, language: 'en', on: () => {}, off: () => {} },
  i18n: { t: (k: string) => k, language: 'en', on: () => {}, off: () => {} },
  initI18n: async () => i18nStub.default,
  ensureLanguageLoaded: async () => {},
  changeUiLanguage: async () => {},
  UI_LANGUAGE_STORAGE_KEY: 'lumiverse-ui-language',
}
mock.module('@/i18n', () => i18nStub)
mock.module('@/lib/cssModuleRegistry', () => ({
  CSS_MODULE_REGISTRY: [],
  generateSelector: () => '',
}))

const storeState: Record<string, unknown> = {}
const storeListeners = new Set<() => void>()
const useStoreShim = Object.assign(
  (selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
  {
    getState: () => storeState,
    setState: (partial: Record<string, unknown>) => {
      Object.assign(storeState, partial)
      for (const l of storeListeners) l()
    },
    subscribe: (l: () => void) => {
      storeListeners.add(l)
      return () => { storeListeners.delete(l) }
    },
  },
)
mock.module('@/store', () => ({ useStore: useStoreShim }))

const evidenceReports: Array<{ id: string; payload: Record<string, unknown> }> = []
mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: async (id: string, payload: Record<string, unknown>) => {
      evidenceReports.push({ id, payload })
      return {}
    },
    reportPerformance: async () => ({}),
    get: async () => ({}),
    update: async () => ({}),
  },
}))

// Own the registry boundary: neighbor files in the same `bun test` invocation
// register their own stubs process-wide, so this file must not depend on the
// real display-resolver-registry implementation.
const registryState: { owned: boolean; resolver: Record<string, unknown> | null } = { owned: false, resolver: null }
mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => registryState.owned,
  getDisplayResolverForChat: () => (registryState.owned ? registryState.resolver : null),
}))

const { applyDisplayRegex } = await import('./compiler')
const { applyDisplayRegexTiered, resetTieredPipelineForTests } = await import('./pipeline')
const { getRegexExecTier, recordRegexScriptSuccess, quarantineRegexScript, resetRegexEvidenceForTests } = await import('./evidence')
const {
  KILL_MS,
  RegexWorkerTimeoutError,
  resetRegexWorkerForTests,
  setRegexWorkerCallbacks,
  setRegexWorkerDepsForTests,
} = await import('./worker-client')

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

function makeHarness(opts?: { spawnThrows?: boolean }) {
  const spawned: FakeWorker[] = []
  const timers: ManualTimer[] = []

  setRegexWorkerDepsForTests({
    now: () => timers.length,
    spawnWorker: () => {
      if (opts?.spawnThrows) throw new Error('worker construction failed')
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

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

function echoWorker(fake: FakeWorker): void {
  const handle = (job: ApplyWorkerJob) => {
    if (fake.responded.has(job.jobId)) return
    fake.responded.add(job.jobId)
    try {
      const regex = new RegExp(job.pattern, job.flags.includes('g') ? job.flags : `${job.flags}g`)
      let result = job.body.replace(regex, job.replaceString ?? '')
      for (const trim of job.trimStrings ?? []) {
        if (trim === '') continue
        let iterations = 0
        while (result.includes(trim)) {
          result = result.replaceAll(trim, '')
          iterations += 1
          if (iterations >= 32) break
        }
      }
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
  for (const job of [...fake.sent]) handle(job)
  fake.onJob = handle
}

function script(id: string, overrides: Partial<RegexScript>): RegexScript {
  return {
    id,
    user_id: 'user',
    name: `Script ${id}`,
    script_id: id,
    find_regex: 'x',
    replace_string: 'y',
    actions: [],
    flags: 'g',
    placement: ['ai_output'],
    scope: 'global',
    scope_id: null,
    target: ['display'],
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: 'none',
    disabled: false,
    sort_order: 0,
    description: '',
    folder: '',
    metadata: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

function lowRisk(scriptDef: RegexScript): RegexScript {
  return { ...scriptDef, metadata: { ...scriptDef.metadata, analyzer_risk: { risk: 'low', reasons: [], analyzed_at: 1 } } }
}

const context = { isUser: false, depth: 0 }
const resolveRawTemplates = async (templates: Record<string, string>) => templates

afterEach(() => {
  resetRegexWorkerForTests()
  resetRegexEvidenceForTests()
  resetTieredPipelineForTests()
  toastCalls.length = 0
  evidenceReports.length = 0
  registryState.owned = false
  registryState.resolver = null
})

describe('three-way golden parity (sync vs worker vs backend)', () => {
  const corpus: Array<{ name: string; body: string; find: string; flags: string; replace: string; trims?: string[] }> = [
    { name: 'lookahead', body: 'foo bar baz foo bar', find: 'foo(?= bar)', flags: 'g', replace: '<$&>' },
    { name: 'backreference', body: '<b>bold</b> and <i>it</i>', find: '<(\\w+)>(.*?)</\\1>', flags: 'g', replace: '[$1]' },
    { name: 'multiline', body: '# Title\n## Section\n## Another', find: '^## (.*)$', flags: 'gm', replace: 'H2: $1' },
    {
      name: 'incident-v2-shape',
      body: '<Status>[DATE:2026-08-23|ok] trailing text',
      find: '<Status>\\[DATE:([^|\\n]*)\\|([^|\\n]*)\\]',
      flags: 'g',
      replace: '[$1|$2]',
    },
    { name: 'trim-rejoin', body: 'seed tail', find: 'seed', flags: 'g', replace: 'bbcc', trims: ['bc'] },
  ]

  function backendReference(content: string, scripts: RegexScript[]): string {
    let result = content
    for (const s of scripts) {
      result = result.replace(new RegExp(s.find_regex, s.flags), s.replace_string)
      for (const trim of s.trim_strings) {
        if (trim === '') continue
        let iterations = 0
        while (result.includes(trim)) {
          result = result.replaceAll(trim, '')
          iterations += 1
          if (iterations >= 32) break
        }
      }
    }
    return result
  }

  test('sync, worker, and backend legs produce identical output across the corpus', async () => {
    let harness = makeHarness()

    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body?: unknown })?.body)) as { content: string; scripts: RegexScript[] }
      return new Response(JSON.stringify({ result: backendReference(body.content, body.scripts), cacheable: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch)

    try {
      for (const entry of corpus) {
        // Sync leg: proven-safe evidence -> sync fast path.
        const syncScript = lowRisk(script(`parity-sync-${entry.name}`, {
          find_regex: entry.find,
          replace_string: entry.replace,
          flags: entry.flags,
          ...(entry.trims ? { trim_strings: entry.trims } : {}),
        }))
        recordRegexScriptSuccess(syncScript, 5)
        expect(getRegexExecTier(syncScript).tier).toBe('sync')
        const syncOut = await applyDisplayRegexTiered(entry.body, [syncScript], context, resolveRawTemplates)

        // Reference leg: plain applyDisplayRegex must agree with the tiered sync path.
        const refOut = applyDisplayRegex(entry.body, [syncScript], context)

        // Worker leg: no evidence -> worker tier, fake worker executes jobs.
        const workerScript = lowRisk(script(`parity-worker-${entry.name}`, {
          find_regex: entry.find,
          replace_string: entry.replace,
          flags: entry.flags,
          ...(entry.trims ? { trim_strings: entry.trims } : {}),
        }))
        expect(getRegexExecTier(workerScript).tier).toBe('worker')
        resetRegexWorkerForTests()
        harness = makeHarness()
        const workerPromise = applyDisplayRegexTiered(entry.body, [workerScript], context, resolveRawTemplates)
        await flushMicrotasks()
        echoWorker(harness.spawned[harness.spawned.length - 1])
        const workerOut = await workerPromise

        // Backend leg: worker construction failure escalates to /apply.
        resetRegexWorkerForTests()
        makeHarness({ spawnThrows: true })
        const backendScript = lowRisk(script(`parity-backend-${entry.name}`, {
          find_regex: entry.find,
          replace_string: entry.replace,
          flags: entry.flags,
          ...(entry.trims ? { trim_strings: entry.trims } : {}),
        }))
        const backendOut = await applyDisplayRegexTiered(entry.body, [backendScript], context, resolveRawTemplates)

        expect(refOut).toBe(syncOut.result)
        expect(workerOut.result).toBe(syncOut.result)
        expect(backendOut.result).toBe(syncOut.result)

        // Re-arm the fake-worker harness for the next corpus entry.
        resetRegexWorkerForTests()
        harness = makeHarness()
      }
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('evidence tier transitions', () => {
  test('unknown -> safe -> quarantined', async () => {
    const { spawned, fireTimers } = makeHarness()
    const s = lowRisk(script('tier-transition', { find_regex: 'a+', replace_string: 'b' }))

    // Unknown: no last_ok evidence.
    expect(getRegexExecTier(s)).toMatchObject({ tier: 'worker' })

    // Safe: a fast successful run earns the sync fast path...
    recordRegexScriptSuccess(s, 5)
    expect(getRegexExecTier(s)).toMatchObject({ tier: 'sync' })
    // ...and the unknown->safe transition was persisted.
    expect(evidenceReports.some((r) => r.id === 'tier-transition' && r.payload.last_ok_ms === 5)).toBe(true)

    // Quarantined: deadline kill flags the script and every pass skips it.
    quarantineRegexScript(s)
    expect(getRegexExecTier(s)).toMatchObject({ tier: 'quarantined' })
    const outcome = await applyDisplayRegexTiered('aaa', [s], context, resolveRawTemplates)
    expect(outcome.result).toBe('aaa')
    fireTimers(KILL_MS)
    expect(spawned.length).toBe(0)
  })

  test('oversized bodies stay on the worker path even with safe evidence', () => {
    const big = lowRisk(script('big-body', { find_regex: 'a'.repeat(9 * 1024), replace_string: 'b' }))
    recordRegexScriptSuccess(big, 1)
    expect(getRegexExecTier(big).tier).toBe('worker')
  })

  test('high analyzer risk stays on the worker path even with safe evidence', () => {
    const risky = script('risky', { find_regex: 'a', replace_string: 'b', metadata: { analyzer_risk: { risk: 'high' } } })
    recordRegexScriptSuccess(risky, 1)
    expect(getRegexExecTier(risky).tier).toBe('worker')
  })
})

describe('quarantine skip + toast idempotency', () => {
  test('deadline timeout quarantines once per session; later passes skip silently', async () => {
    const { spawned, fireTimers } = makeHarness()
    setRegexWorkerCallbacks({})

    const hanging = lowRisk(script('hanging', { find_regex: 'a', replace_string: 'b' }))
    expect(getRegexExecTier(hanging).tier).toBe('worker')

    // First invocation: worker never answers -> deadline fires.
    const firstPromise = applyDisplayRegexTiered('aaa', [hanging], context, resolveRawTemplates)
    await flushMicrotasks()
    expect(spawned.length).toBe(1)
    fireTimers(KILL_MS)
    const first = await firstPromise
    expect(first.result).toBe('aaa') // raw text, script skipped
    expect(spawned[0].terminated).toBe(true)
    expect(getRegexExecTier(hanging).tier).toBe('quarantined')

    const toastsAfterFirst = toastCalls.length
    expect(toastsAfterFirst).toBe(1)
    expect(toastCalls[0].message).toContain('panels:regexPanel.quarantinedDisplay')

    // Second invocation: skipped without another toast or any worker activity.
    const second = await applyDisplayRegexTiered('bbb', [hanging], context, resolveRawTemplates)
    expect(second.result).toBe('bbb')
    expect(toastCalls.length).toBe(toastsAfterFirst)
  })
})

describe('trailing-flush after drop resolves final content', () => {
  test('older in-flight job resolving late never clobbers the newest resolved content', async () => {
    const { spawned } = makeHarness()

    const olderScript = lowRisk(script('flush-older', { find_regex: 'old', replace_string: 'OLD' }))
    const newerScript = lowRisk(script('flush-newer', { find_regex: 'new', replace_string: 'NEW' }))

    // Older invocation posted but left unanswered (warm worker reused).
    const olderPromise = applyDisplayRegexTiered('old-content', [olderScript], context, resolveRawTemplates)
    await flushMicrotasks()
    expect(spawned.length).toBe(1)
    const fake = spawned[0]
    expect(fake.sent.length).toBe(1)
    const olderJobId = fake.sent[0].jobId

    // Newer invocation (fresh streaming chunk) posts its own job.
    const newerPromise = applyDisplayRegexTiered('new-content', [newerScript], context, resolveRawTemplates)
    await flushMicrotasks()
    expect(fake.sent.length).toBe(2)
    const newerJobId = fake.sent[1].jobId

    // The newest job resolves FIRST — final settled content must land.
    fake.respond({ type: 'result', jobId: newerJobId, op: 'apply', result: 'NEW-content', elapsedMs: 1 })
    const newer = await newerPromise
    expect(newer.result).toBe('NEW-content')

    // The stale older job resolves late into its own caller only.
    fake.respond({ type: 'result', jobId: olderJobId, op: 'apply', result: 'OLD-old-content', elapsedMs: 1 })
    const older = await olderPromise
    expect(older.result).toBe('OLD-old-content')
  })
})

describe('owned-chat bypass', () => {
  test('owned chats apply via the Spindle resolver on the main thread only', async () => {
    const harness = makeHarness()
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('backend must not be reached for owned chats')
    }) as unknown as typeof fetch)

    registryState.owned = true
    registryState.resolver = {
      applyScripts: async ({ content }: { content: string }) => ({ content: `RESOLVED(${content})`, touchedVars: ['local:a'], cacheable: false }),
    }

    try {
      const ownedScript = lowRisk(script('owned-bypass', { find_regex: 'x', replace_string: 'y' }))
      // Even a quarantined script list must not matter: owned chats bypass tiers.
      quarantineRegexScript(ownedScript)
      const outcome = await applyDisplayRegexTiered(
        'payload-x',
        [ownedScript],
        { ...context, chatId: 'chat-owned' },
        resolveRawTemplates,
      )
      expect(outcome.result).toBe('RESOLVED(payload-x)')
      expect(outcome.touchedVars?.has('local:a')).toBe(true)
      expect(outcome.cacheable).toBe(false)
      // No worker was ever constructed and no backend call was attempted.
      expect(harness.spawned.length).toBe(0)
      expect(fetchSpy.mock.calls.length).toBe(0)
    } finally {
      registryState.owned = false
      registryState.resolver = null
      fetchSpy.mockRestore()
    }
  })

  test('unowned chats never take the resolver bypass and go through the worker tier', async () => {
    const { spawned } = makeHarness()
    const unowned = lowRisk(script('unowned-path', { find_regex: 'q', replace_string: 'Q' }))
    const promise = applyDisplayRegexTiered('qq', [unowned], { ...context, chatId: 'chat-normal' }, resolveRawTemplates)
    await flushMicrotasks()
    expect(spawned.length).toBe(1)
    echoWorker(spawned[0])
    const outcome = await promise
    expect(outcome.result).toBe('QQ')
  })
})
