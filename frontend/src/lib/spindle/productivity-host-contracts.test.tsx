import { describe, expect, test } from 'bun:test'

const source = await Bun.file(new URL('./productivity-host-contracts.tsx', import.meta.url)).text()

describe('productivity host connections picker contract', () => {
  test('renders ConnectionsPicker only through connections_picker.panel and launcher contract', () => {
    expect(source).toContain("export const CONNECTIONS_PICKER_CONTRACT_SURFACES = [")
    expect(source).toContain("'connections_picker.launcher'")
    expect(source).toContain("'connections_picker.panel'")
    expect(source).toContain("case 'connections_picker.launcher':")
    expect(source).toContain("case 'connections_picker.panel':")
    expect(source.match(/<ConnectionsPicker[\s>]/g)?.length).toBe(1)
    expect(source).toContain("content = <ConnectionsPicker open={state?.open !== false} onClose={() => emitCommand('close')} anchorElement={connectionsAnchor} />")
    expect(source.indexOf("case 'connections_picker.panel':")).toBeLessThan(source.indexOf('<ConnectionsPicker'))
    expect(source.indexOf("case 'connections_picker.launcher':")).toBeLessThan(source.indexOf("case 'connections_picker.panel':"))
    const cases = [...source.matchAll(/case '([^']+)':\s*([\s\S]*?)(?=\n\s*case |\n\s*default:)/g)]
    expect(cases.filter(([, , body]) => body.includes('<ConnectionsPicker')).map(([, id]) => id)).toEqual([
      'connections_picker.panel',
    ])
  })
})
