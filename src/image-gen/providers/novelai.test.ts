import { afterEach, describe, expect, test } from "bun:test";
import { NovelAIImageProvider } from "./novelai";

describe("NovelAIImageProvider", () => {
  const provider = new NovelAIImageProvider();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("lists the V5 Full and Curated models", async () => {
    const models = await provider.listModels("", "");

    expect(models.slice(0, 2)).toEqual([
      { id: "nai-diffusion-5-full", label: "NAI Diffusion V5 (Full)" },
      { id: "nai-diffusion-5-curated", label: "NAI Diffusion V5 (Curated)" },
    ]);
  });

  test("validates persistent tokens without making a generation request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ accountCreatedAt: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(provider.validateKey("pst-test-token", "https://image.novelai.net")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://image.novelai.net/user/information");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer pst-test-token");
  });
});
