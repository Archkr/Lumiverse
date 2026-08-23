import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

type FakeApiErrorShape = { status: number; body?: any }

let getImpl: (id: string) => Promise<any> | any
let updateImpl: (id: string, input: any) => Promise<any> | any
const getCalls: string[] = []
const updateCalls: Array<{ id: string; input: any }> = []

mock.module('@/api/regex', () => ({
  regexApi: {
    get: (id: string) => {
      getCalls.push(id)
      return getImpl(id)
    },
    update: (id: string, input: any) => {
      updateCalls.push({ id, input })
      return updateImpl(id, input)
    },
  },
}))

function fakeApiError(status: number, body?: any): FakeApiErrorShape & Error {
  const err: any = new Error(`${status} error`)
  err.status = status
  err.body = body
  return err
}

const { saveRegexPerformance } = await import('./performance')

function scriptFixture(metadata?: Record<string, any>) {
  return {
    id: 'script-1',
    user_id: 'user',
    name: 'Script',
    script_id: 'script_1',
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
    metadata,
    created_at: 0,
    updated_at: 0,
  }
}

afterEach(() => {
  getCalls.length = 0
  updateCalls.length = 0
})

describe('saveRegexPerformance', () => {
  test('merges the analyzer patch into existing metadata and returns true', async () => {
    getImpl = async () => scriptFixture({ analyzer_risk: { risk: 'low' }, author_note: 'keep' })
    updateImpl = async () => {}

    const ok = await saveRegexPerformance('script-1', {
      risk: 'high',
      reasons: ['r1'],
      analyzed_at: 123,
    })

    expect(ok).toBe(true)
    expect(getCalls).toEqual(['script-1'])
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].id).toBe('script-1')
    expect(updateCalls[0].input.metadata.author_note).toBe('keep')
    expect(updateCalls[0].input.metadata.analyzer_risk).toEqual({
      risk: 'high',
      reasons: ['r1'],
      analyzed_at: 123,
    })
  })

  test('swallows extension-owned 403 rejections silently and returns false', async () => {
    getImpl = async () => scriptFixture()
    updateImpl = async () => {
      throw fakeApiError(403, { error: "Regex script is not an unbound script owned by this extension" })
    }

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ok = await saveRegexPerformance('script-1', { risk: 'medium', reasons: [], analyzed_at: 1 })
      expect(ok).toBe(false)
      expect(warnSpy.mock.calls).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('warns on unexpected failures and returns false', async () => {
    getImpl = async () => scriptFixture()
    updateImpl = async () => {
      throw fakeApiError(500, { error: 'boom' })
    }

    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map((arg) => String(arg)).join(' '))
    })
    try {
      const ok = await saveRegexPerformance('script-1', { risk: 'low' })
      expect(ok).toBe(false)
      expect(warns.some((w) => w.includes('[regex] failed to persist analyzer risk metadata'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('handles a failed metadata fetch without throwing', async () => {
    getImpl = async () => {
      throw fakeApiError(404, { error: 'Not found' })
    }
    updateImpl = async () => {}

    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map((arg) => String(arg)).join(' '))
    })
    try {
      const ok = await saveRegexPerformance('missing', { risk: 'low' })
      expect(ok).toBe(false)
      expect(updateCalls).toHaveLength(0)
      expect(warns.length).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
