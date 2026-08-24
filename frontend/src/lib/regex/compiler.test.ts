import { describe, expect, mock, test } from 'bun:test'
import type { RegexScript } from '@/types/regex'

mock.module('@/lib/spindle/display-resolver-registry', () => ({
  isDisplayChatOwned: () => false,
  getDisplayResolverForChat: () => undefined,
}))

const { applyDisplayRegex } = await import('./compiler')

function script(overrides: Partial<RegexScript>): RegexScript {
  return {
    id: 'find-only',
    user_id: 'user',
    name: 'Find only',
    script_id: 'find_only',
    find_regex: '{{char}}',
    replace_string: '{{user}}',
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
    substitute_macros: 'find',
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

describe('find-only macro substitution', () => {
  test('resolves Find while leaving Replace unchanged', () => {
    expect(applyDisplayRegex(
      'Alice',
      [script({})],
      {
        isUser: false,
        depth: 0,
        macroCtx: { charName: 'Alice', userName: 'Bob' },
      },
    )).toBe('{{user}}')
  })
})

describe('carry-forward match replacement', () => {
  test('replaces the previous match by default', () => {
    expect(applyDisplayRegex(
      'new',
      [script({
        find_regex: '<status>([^<]+)</status>',
        replace_string: '<strong>$1</strong>',
        metadata: {
          match_actions: ['repeat_back'],
          repeat_position: 'end_nl',
        },
      })],
      {
        isUser: false,
        depth: 0,
        previousContent: 'old <status>ready</status>',
      },
    )).toBe('new\n<strong>ready</strong>')
  })

  test('can carry the original previous match', () => {
    expect(applyDisplayRegex(
      'new',
      [script({
        find_regex: '<status>([^<]+)</status>',
        replace_string: '<strong>$1</strong>',
        metadata: {
          match_actions: ['repeat_back'],
          repeat_position: 'end_nl',
          repeat_raw_match: true,
        },
      })],
      {
        isUser: false,
        depth: 0,
        previousContent: 'old <status>ready</status>',
      },
    )).toBe('new\n<status>ready</status>')
  })
})

describe('associative regex action captures', () => {
  test('empties an optional named capture that did not participate in the match', () => {
    const output = applyDisplayRegex(
      '<choice>North</choice>',
      [script({
        find_regex: '<choice>(?<label>[^<]+)</choice>(?:<req>(?<req>[^<]*)</req>)?',
        replace_string: '<button data-req="$<req>" data-regex-action="choose">$<label><small>$<req></small></button>',
        actions: [{
          id: 'choose',
          type: 'send',
          multi_select: false,
          cost: '1',
          limit: '3',
          title: '$<label>',
          subtitle: '$<req>',
          content: 'Choose $<label>$<req>',
        }],
      })],
      { isUser: false, depth: 0 },
    )

    expect(output).toContain('data-req=""')
    expect(output).not.toContain('$<req>')
    const encoded = output.match(/data-lumiverse-regex-action="([^"]+)"/)?.[1]
    expect(encoded).toBeTruthy()
    expect(JSON.parse(decodeURIComponent(encoded!))).toMatchObject({
      title: 'North',
      subtitle: '',
      content: 'Choose North',
    })
  })
})

describe('display regex performance reporting', () => {
  test('reports recovery for a fast run of a display flagged script', () => {
    const recovered: Array<{ elapsedMs: number }> = []
    applyDisplayRegex(
      'one',
      [script({
        find_regex: 'one',
        replace_string: 'two',
        metadata: {
          regex_performance: {
            slow: true,
            timed_out: false,
            elapsed_ms: 7200,
            threshold_ms: 5000,
            detected_at: 0,
            source: 'display_backend',
            version: 0,
            engine_version: 2,
          },
        },
      })],
      { isUser: false, depth: 0 },
      undefined,
      (report) => recovered.push({ elapsedMs: report.elapsedMs }),
    )

    expect(recovered).toHaveLength(1)
    expect(recovered[0].elapsedMs).toBeLessThan(5000)
  })
})
