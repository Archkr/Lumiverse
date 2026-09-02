/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { processMarkdownInHtmlIsland } from './htmlIslandMarkdown'

function render(html: string): string {
  return processMarkdownInHtmlIsland(html, {
    renderBlockText: (markdown) => `<block>${markdown.trim()}</block>`,
    renderInlineText: (markdown) => `<inline>${markdown.trim()}</inline>`,
  })
}

describe('processMarkdownInHtmlIsland', () => {
  test('keeps markdown inside span-based code editor rows inline', () => {
    const html = [
      '<div style="background:#1e1e2e;">',
      '  <span style="color:#6c7086;"># flatten nested response</span><br>',
      '</div>',
    ].join('')

    expect(render(html)).toContain('<span style="color:#6c7086;"><inline># flatten nested response</inline></span><br>')
    expect(render(html)).not.toContain('<block># flatten nested response</block>')
  })

  test('still allows block markdown in block containers', () => {
    expect(render('<div># heading</div>')).toBe('<div><block># heading</block></div>')
  })

  test('treats paragraph text as inline markdown to avoid invalid nested blocks', () => {
    expect(render('<p># heading</p>')).toBe('<p><inline># heading</inline></p>')
  })

  test('does not parse text inside pre/code/script blocks', () => {
    expect(render('<pre># heading</pre>')).toBe('<pre># heading</pre>')
    expect(render('<code>**bold**</code>')).toBe('<code>**bold**</code>')
    expect(render('<script># heading</script>')).toBe('<script># heading</script>')
  })

  test('does not parse text inside svg subtrees', () => {
    expect(render('<svg><text>*bold*</text></svg>')).toBe('<svg><text>*bold*</text></svg>')
  })

  test('unknown pseudo-tags do not flip following prose to inline', () => {
    const html = '<div><close>\n\n## NPC\n\n*intro*</div>'
    expect(render(html)).toContain('<block>## NPC\n\n*intro*</block>')
  })

  test('unreplaced card markers with payloads do not become markdown context', () => {
    const html = '<div><Name: evan | Background: heropng>\n\n## HEROES</div>'
    expect(render(html)).toContain('<block>## HEROES</block>')
  })

  test('stray unknown close tags do not pop known containers', () => {
    const html = '<div></wiki># heading</div>'
    expect(render(html)).toBe('<div></wiki><block># heading</block></div>')
  })

  test('form is sanitizer-forbidden and does not become markdown context', () => {
    expect(render('<div><form>## heading</div>')).toContain('<block>## heading</block>')
  })

  const WRAP = '<div data-message-prose class="not-island-prose">'

  test('inline-led paragraph after a block element wraps in <p>', () => {
    const html = `${WRAP}<table><tbody><tr><td>x</td></tr></tbody></table>\n\n<span>"Oho!"</span> she boomed.\n\nNext.</div>`
    const outHtml = render(html)
    expect(outHtml).toContain('<p><span><inline>"Oho!"</inline></span><inline>she boomed.</inline></p>')
    expect(outHtml).toContain('<block>Next.</block>')
  })

  test('text-led paragraph joins its trailing inline tags in one <p>', () => {
    const outHtml = render(`${WRAP}\n\nHe said <span>"hi"</span> and left.\n\n</div>`)
    expect(outHtml).toContain('<p><inline>He said</inline><span><inline>"hi"</inline></span><inline>and left.</inline></p>')
  })

  test('standalone inline-only dialogue line wraps in <p>', () => {
    const outHtml = render(`${WRAP}intro\n\n<span>"Quote"</span>\n\noutro</div>`)
    expect(outHtml).toContain('<p><span><inline>"Quote"</inline></span></p>')
    expect(outHtml).toContain('<block>intro</block>')
    expect(outHtml).toContain('<block>outro</block>')
  })

  test('tag-only groups such as a lone image stay unwrapped', () => {
    const outHtml = render(`${WRAP}a\n\n<img src="x">\n\nb</div>`)
    expect(outHtml).toContain('<img src="x">')
    expect(outHtml).not.toContain('<p><img')
  })

  test('blank line inside trailing text closes the paragraph', () => {
    const outHtml = render(`${WRAP}<span>q</span> tail\n\n# heading</div>`)
    expect(outHtml).toContain('<p><span><inline>q</inline></span><inline>tail</inline></p>')
    expect(outHtml).toContain('<block># heading</block>')
  })

  test('raw HTML runs to the first blank line, CommonMark-style', () => {
    const tight = render(`${WRAP}<div class="row">Name:\n<span>Haru</span></div></div>`)
    expect(tight).not.toContain('<p>')
    expect(tight).toContain('Name:\n<span>Haru</span>')
    const blanked = render(`${WRAP}<div class="row">Name:\n\n<span>Haru</span></div></div>`)
    expect(blanked).toContain('<p><span><inline>Haru</inline></span></p>')
  })

  test('plain islands without the prose root never group', () => {
    const plainIsland = render('<div style="x">label\n\n<span>pill</span></div>')
    expect(plainIsland).not.toContain('<p>')
  })

  test('unbalanced card HTML still yields paragraphs after a blank line', () => {
    const html = `${WRAP}<div class="card"><h1>HP<br /><span>100</span></h15></div>\n\nThe dive begins.\n\n<span>"Ready?"</span> she asked.\n\n</div>`
    const outHtml = render(html)
    expect(outHtml).toContain('<block>The dive begins.</block>')
    expect(outHtml).toContain('<p><span><inline>"Ready?"</inline></span><inline>she asked.</inline></p>')
  })
})
