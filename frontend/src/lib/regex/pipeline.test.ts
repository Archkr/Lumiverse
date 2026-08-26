import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { ApplyWorkerJob, ApplyWorkerResponse } from './apply.worker'
import type { RegexWorkerLike } from './worker-client'
import type { RegexScript } from '@/types/regex'

const toastCalls: string[] = []
mock.module('@/lib/toast', () => ({
  toast: {
    warning: (message: string) => toastCalls.push(message),
    success: () => {}, error: () => {}, info: () => {},
  },
}))
mock.module('@/i18n', () => ({
  default: { t: (key: string) => key, language: 'en', on: () => {}, off: () => {} },
  i18n: { t: (key: string) => key, language: 'en', on: () => {}, off: () => {} },
  initI18n: async () => {}, ensureLanguageLoaded: async () => {}, changeUiLanguage: async () => {},
  UI_LANGUAGE_STORAGE_KEY: 'ui-language',
}))
mock.module('@/lib/cssModuleRegistry', () => ({ CSS_MODULE_REGISTRY: [], generateSelector: () => '' }))

const storeState: Record<string, unknown> = {}
const useStoreShim = Object.assign(
  (selector?: (state: typeof storeState) => unknown) => selector ? selector(storeState) : storeState,
  { getState: () => storeState, setState: (patch: Record<string, unknown>) => Object.assign(storeState, patch), subscribe: () => () => {} },
)
mock.module('@/store', () => ({ useStore: useStoreShim }))

const evidenceReports: Array<{ id: string; payload: Record<string, unknown> }> = []
mock.module('@/api/regex', () => ({
  regexApi: {
    reportEvidence: async (id: string, payload: Record<string, unknown>) => {
      evidenceReports.push({ id, payload })
      return {}
    },
    reportPerformance: async () => ({}), get: async () => ({}), update: async () => ({}),
  },
}))

const registryState: { owned: boolean; resolver: Record<string, unknown> | null } = { owned: false, resolver: null }
mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => registryState.owned,
  getDisplayResolverForChat: () => registryState.owned ? registryState.resolver : null,
}))

const { applyDisplayRegexTiered, resetTieredPipelineForTests } = await import('./pipeline')
const {
  getRegexExecTier,
  quarantineRegexScript,
  readRegexScriptEvidence,
  resetRegexEvidenceForTests,
} = await import('./evidence')
const { KILL_MS, resetRegexWorkerForTests, setRegexWorkerDepsForTests } = await import('./worker-client')

class FakeWorker implements RegexWorkerLike {
  terminated = false
  sent: ApplyWorkerJob[] = []
  messageHandler: ((message: ApplyWorkerResponse) => void) | null = null
  errorHandler: ((error: Error) => void) | null = null
  onJob: ((job: ApplyWorkerJob) => void) | null = null
  postMessage(job: ApplyWorkerJob): void { this.sent.push(job); this.onJob?.(job) }
  terminate(): void { this.terminated = true }
  setMessageHandler(handler: (message: ApplyWorkerResponse) => void): void { this.messageHandler = handler }
  setErrorHandler(handler: (error: Error) => void): void { this.errorHandler = handler }
  respond(message: ApplyWorkerResponse): void { this.messageHandler?.(message) }
}

interface ManualTimer { fn: () => void; cancelled: boolean }

function makeHarness(options?: { spawnThrows?: boolean }) {
  resetRegexWorkerForTests()
  const spawned: FakeWorker[] = []
  const timers: ManualTimer[] = []
  setRegexWorkerDepsForTests({
    now: () => timers.length,
    spawnWorker: () => {
      if (options?.spawnThrows) throw new Error('worker construction failed')
      const worker = new FakeWorker()
      spawned.push(worker)
      return worker
    },
    scheduleTimer: (fn) => {
      const timer = { fn, cancelled: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    isSupported: () => true,
  })
  const fireLatestTimer = () => {
    const timer = [...timers].reverse().find((entry) => !entry.cancelled)
    timer?.fn()
  }
  return { spawned, timers, fireLatestTimer }
}

function echoWorker(worker: FakeWorker): void {
  const handled = new Set<number>()
  const handle = (job: ApplyWorkerJob) => {
    if (handled.has(job.jobId)) return
    handled.add(job.jobId)
    let result = job.body
    const scriptElapsedMs: number[] = []
    for (let index = 0; index < job.scripts.length; index += 1) {
      const script = job.scripts[index]!
      worker.respond({ type: 'progress', jobId: job.jobId, scriptIndex: index, scriptId: script.scriptId, scriptName: script.scriptName })
      result = result.replace(new RegExp(script.pattern, script.flags), script.replaceString)
      for (const trim of script.trimStrings) result = trim ? result.replaceAll(trim, '') : result
      scriptElapsedMs.push(2)
    }
    worker.respond({ type: 'result', jobId: job.jobId, op: 'apply', result, elapsedMs: scriptElapsedMs.length * 2, scriptElapsedMs })
  }
  for (const job of worker.sent) handle(job)
  worker.onJob = handle
}

function script(id: string, overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id, user_id: 'user', name: id, script_id: id, find_regex: 'x', replace_string: 'y',
    actions: [], flags: 'g', placement: ['ai_output'], scope: 'global', scope_id: null,
    target: ['display'], min_depth: null, max_depth: null, trim_strings: [], run_on_edit: false,
    substitute_macros: 'none', disabled: false, sort_order: 0, description: '', folder: '', metadata: {},
    created_at: 1, updated_at: 1, ...overrides,
  }
}

const context = { isUser: false, depth: 0 }
const resolveRawTemplates = async (templates: Record<string, string>) => templates
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

afterEach(() => {
  resetRegexWorkerForTests()
  resetRegexEvidenceForTests()
  resetTieredPipelineForTests()
  toastCalls.length = 0
  evidenceReports.length = 0
  registryState.owned = false
  registryState.resolver = null
})

describe('isolated regex pipeline', () => {
  test('an edit re-syncs the session overlay from the persisted row instead of dropping quarantine', () => {
    const original = script('edited', { find_regex: 'a+', updated_at: 1 })
    quarantineRegexScript(original)
    expect(evidenceReports).toEqual([{ id: 'edited', payload: { quarantined: true } }])

    // The row the panel refetches after the edit still carries the flag, so the
    // rebuilt overlay entry keeps the script skipped.
    const editedStillQuarantined = {
      ...original,
      find_regex: '(a|aa)+$',
      updated_at: 2,
      metadata: { regex_evidence: { quarantined: true } },
    }
    expect(readRegexScriptEvidence(editedStillQuarantined)).toEqual({ quarantined: true })
    expect(getRegexExecTier(editedStillQuarantined)).toEqual({ tier: 'quarantined', reason: 'quarantined' })

    // A row without the flag (cleared server-side) wins over the stale overlay
    // entry once the definition fingerprint no longer matches.
    const editedAndCleared = { ...original, find_regex: 'b+', updated_at: 3, metadata: {} }
    expect(readRegexScriptEvidence(editedAndCleared)).toEqual({})
    expect(getRegexExecTier(editedAndCleared)).toEqual({
      tier: 'worker',
      reason: 'user-authored regexes require isolated execution',
    })
  })

  test('compatible scripts share one worker body round trip', async () => {
    const { spawned } = makeHarness()
    const promise = applyDisplayRegexTiered('foo boo', [
      script('one', { find_regex: 'foo', replace_string: 'bar' }),
      script('two', { find_regex: 'o+', replace_string: '<$&>' }),
    ], context, resolveRawTemplates)
    await flush()
    echoWorker(spawned[0])
    expect((await promise).result).toBe('bar b<oo>')
    expect(spawned[0].sent).toHaveLength(1)
    expect(spawned[0].sent[0].scripts).toHaveLength(2)
  })

  test('a timed-out script is quarantined and the safe remainder is retried', async () => {
    const { spawned, fireLatestTimer } = makeHarness()
    const slow = script('slow', { find_regex: 'a' })
    const safe = script('safe', { find_regex: 'b', replace_string: 'B' })
    const promise = applyDisplayRegexTiered('ab', [slow, safe], context, resolveRawTemplates)
    await flush()

    const firstWorker = spawned[0]
    const firstJob = firstWorker.sent[0]
    firstWorker.respond({ type: 'progress', jobId: firstJob.jobId, scriptIndex: 0, scriptId: 'slow', scriptName: 'slow' })
    fireLatestTimer()
    await flush()

    expect(firstWorker.terminated).toBe(true)
    expect(spawned).toHaveLength(2)
    echoWorker(spawned[1])
    expect((await promise).result).toBe('aB')
    expect(getRegexExecTier(slow).tier).toBe('quarantined')
    expect(getRegexExecTier(safe).tier).toBe('worker')
    expect(evidenceReports).toContainEqual({ id: 'slow', payload: { quarantined: true } })
  })

  test('failed worker and backend boundaries return raw text without synchronous execution', async () => {
    makeHarness({ spawnThrows: true })
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))
    try {
      const risky = script('risky', { find_regex: '(a|aa)+$' })
      const body = `${'a'.repeat(40)}X`
      const outcome = await applyDisplayRegexTiered(body, [risky], context, resolveRawTemplates)
      expect(outcome).toMatchObject({ result: body, cacheable: false })
      expect(toastCalls).toHaveLength(1)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('quarantined scripts skip without worker construction', async () => {
    const { spawned } = makeHarness()
    const quarantined = script('quarantined')
    quarantineRegexScript(quarantined)
    const result = await applyDisplayRegexTiered('x', [quarantined], context, resolveRawTemplates)
    expect(result.result).toBe('x')
    expect(spawned).toHaveLength(0)
  })

  test('owned chats retain their resolver bypass', async () => {
    const { spawned } = makeHarness()
    registryState.owned = true
    registryState.resolver = { applyScripts: async ({ content }: { content: string }) => ({ content: `owned:${content}`, cacheable: false }) }
    const result = await applyDisplayRegexTiered('x', [script('owned')], { ...context, chatId: 'chat' }, resolveRawTemplates)
    expect(result).toMatchObject({ result: 'owned:x', cacheable: false })
    expect(spawned).toHaveLength(0)
  })
})
