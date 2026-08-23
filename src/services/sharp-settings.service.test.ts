import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  applySharpSettings,
  getSharpSettingsStatus,
  normalizeSharpSettings,
  releaseSharpCacheMemory,
} from "./sharp-settings.service";

afterEach(() => applySharpSettings({}));

describe("Sharp cache pressure handling", () => {
  test("flushes caches and restores the active limits", () => {
    applySharpSettings({
      concurrency: 1,
      cacheMemoryMb: 23,
      cacheFiles: 7,
      cacheItems: 9,
      thumbnailCodec: "webp",
      webpQuality: 80,
      avifQuality: 54,
    });

    releaseSharpCacheMemory();

    expect(getSharpSettingsStatus().effectiveSettings).toMatchObject({
      concurrency: 1,
      cacheMemoryMb: 23,
      cacheFiles: 7,
      cacheItems: 9,
    });
    expect(sharp.cache()).toMatchObject({
      memory: { max: 23 },
      files: { max: 7 },
      items: { max: 9 },
    });
  });

  test("resolves thumbnail codec and per-codec quality defaults", () => {
    expect(getSharpSettingsStatus().effectiveSettings).toMatchObject({
      thumbnailCodec: "webp",
      webpQuality: 80,
      avifQuality: 54,
    });

    applySharpSettings({ thumbnailCodec: "avif", webpQuality: 77, avifQuality: 51 });
    expect(getSharpSettingsStatus().effectiveSettings).toMatchObject({
      thumbnailCodec: "avif",
      webpQuality: 77,
      avifQuality: 51,
    });
  });

  test("rejects unsupported thumbnail codecs and clamps quality values", () => {
    expect(() => normalizeSharpSettings({ thumbnailCodec: "jpeg" })).toThrow(
      "Thumbnail codec must be webp, avif, or null",
    );
    expect(normalizeSharpSettings({ webpQuality: 0, avifQuality: 101 })).toMatchObject({
      webpQuality: 1,
      avifQuality: 100,
    });
  });
});
