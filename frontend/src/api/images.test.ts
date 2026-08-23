import { afterEach, describe, expect, mock, test } from 'bun:test'

const post = mock((..._args: unknown[]) => Promise.resolve({
  total: 0,
  current: 0,
  generated: 0,
  skipped: 0,
  failed: 0,
}))

mock.module('./client', () => ({
  BASE_URL: '/custom/api',
  del: mock(),
  get: mock(),
  post,
  upload: mock(),
  uploadWithProgress: mock(),
}))

const { imagesApi } = await import('./images')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  post.mockClear()
})

describe('imagesApi thumbnail rebuild', () => {
  test('uses the shared API client for an ordinary rebuild', async () => {
    await imagesApi.rebuildThumbnails()

    expect(post).toHaveBeenCalledWith(
      '/images/rebuild-thumbnails',
      undefined,
      { timeout: 0 },
    )
  })

  test('uses the configured API base for a streaming rebuild', async () => {
    let requestedUrl = ''
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requestedUrl = String(input)
      return new Response(
        'event: done\ndata: {"total":1,"current":1,"generated":1,"skipped":0,"failed":0}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    await expect(imagesApi.rebuildThumbnails({ onProgress: () => {} })).resolves.toMatchObject({
      total: 1,
      generated: 1,
    })
    expect(requestedUrl).toBe('/custom/api/images/rebuild-thumbnails')
  })
})
