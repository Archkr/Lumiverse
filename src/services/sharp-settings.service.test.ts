import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  applySharpSettings,
  getSharpSettingsStatus,
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
    });

    releaseSharpCacheMemory();

    expect(getSharpSettingsStatus().effectiveSettings).toEqual({
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
});
