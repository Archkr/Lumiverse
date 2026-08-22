import { clearCapabilityCache } from "../image-gen/comfyui-discovery";
import { clearOpenRouterMetadataCache } from "../llm/providers/openrouter";
import { clearStmtCache } from "./pagination";
import { clearAllDatabankCache } from "./databank/retrieval-cache.service";
import { resetDisplayRegexCache } from "./display-regex.service";
import { embeddingCache } from "./embedding-cache";
import { clearCortexResultCaches } from "./memory-cortex";
import { clearVectorWorldInfoCache } from "./prompt-assembly.service";
import { releaseTokenizerMemory } from "./tokenizer.service";

export type MemoryPressureLevel = "warning" | "critical";

const releasers: ReadonlyArray<readonly [string, () => void]> = [
  ["tokenizers", releaseTokenizerMemory],
  ["embeddings", () => embeddingCache.clearMemory()],
  ["memory cortex", clearCortexResultCaches],
  ["vector world info", clearVectorWorldInfoCache],
  ["display regex", resetDisplayRegexCache],
  ["databank retrieval", clearAllDatabankCache],
  ["ComfyUI capabilities", clearCapabilityCache],
  ["OpenRouter metadata", clearOpenRouterMetadataCache],
  ["prepared statements", clearStmtCache],
];

let installed = false;

/** Release only derived, reconstructable state; active work is left untouched. */
export function releaseMemoryPressureCaches(): string[] {
  const failures: string[] = [];
  for (const [name, release] of releasers) {
    try {
      release();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function handleMemoryPressure(level: MemoryPressureLevel): void {
  const failures = releaseMemoryPressureCaches();
  if (failures.length === 0) {
    console.warn(`[runtime] ${level} memory pressure: released reconstructable caches`);
  } else {
    console.warn(
      `[runtime] ${level} memory pressure: cache release completed with errors: ${failures.join("; ")}`,
    );
  }
}

export function installMemoryPressureHandler(): void {
  if (installed) return;
  installed = true;
  process.on("memoryPressure", handleMemoryPressure);
}
