/** Install one Illarin delivery through Lumiverse's existing import paths. */

import { strFromU8, unzipSync } from "fflate";
import { fetchDeliveryArtifact } from "./api";
import type { IllarinDelivery } from "./types";
import {
  installCharacter,
  installPreset,
  installTheme,
  installWorldbook,
} from "../lumihub/installer";
import * as packsSvc from "../services/packs.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_THEME_BYTES = 200 * 1024 * 1024;
const MAX_THEME_ENTRIES = 500;
const MAX_THEME_EXPANDED_BYTES = 250 * 1024 * 1024;

function exportUrl(delivery: IllarinDelivery): string {
  const artifact = delivery.artifacts.find((item) => item.kind === "export");
  if (!artifact) throw new Error(`Illarin delivery ${delivery.id} has no export artifact`);
  return artifact.url;
}

async function fetchJsonArtifact(delivery: IllarinDelivery): Promise<Record<string, any>> {
  const response = await fetchDeliveryArtifact(exportUrl(delivery), { maxBytes: MAX_JSON_BYTES });
  const value = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Illarin delivery ${delivery.id} is not a JSON object`);
  }
  return value as Record<string, any>;
}

function safeArchivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return Boolean(normalized)
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && /^[A-Za-z0-9._/-]+$/.test(normalized);
}

async function decodeThemeArtifact(delivery: IllarinDelivery): Promise<Record<string, any>> {
  const response = await fetchDeliveryArtifact(exportUrl(delivery), { maxBytes: MAX_THEME_BYTES });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  let entryCount = 0;
  let declaredExpandedBytes = 0;
  try {
    entries = unzipSync(bytes, {
      // Check the central-directory sizes before fflate allocates expanded
      // buffers. Illarin assets are creator-controlled, so the compressed
      // download limit alone is not enough to rule out a zip bomb.
      filter: (entry) => {
        entryCount++;
        declaredExpandedBytes += entry.originalSize;
        if (entryCount > MAX_THEME_ENTRIES) throw new Error("too many entries");
        if (declaredExpandedBytes > MAX_THEME_EXPANDED_BYTES) throw new Error("expanded size is too large");
        if (!safeArchivePath(entry.name)) throw new Error("unsafe archive path");
        return true;
      },
    });
  } catch {
    throw new Error(`Illarin theme delivery ${delivery.id} is not a valid archive`);
  }
  const names = Object.keys(entries);
  if (names.length > MAX_THEME_ENTRIES || !entries["theme.json"]) {
    throw new Error(`Illarin theme delivery ${delivery.id} has an invalid archive layout`);
  }
  let expanded = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (!safeArchivePath(name)) throw new Error(`Illarin theme delivery ${delivery.id} has an unsafe path`);
    expanded += data.byteLength;
    if (expanded > MAX_THEME_EXPANDED_BYTES) {
      throw new Error(`Illarin theme delivery ${delivery.id} expands beyond the safe limit`);
    }
  }
  const manifest = JSON.parse(strFromU8(entries["theme.json"])) as Record<string, any>;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Illarin theme delivery ${delivery.id} has an invalid manifest`);
  }
  const descriptors = Array.isArray(manifest.assets) ? manifest.assets : [];
  manifest.assets = descriptors.map((raw: any) => {
    if (!raw || typeof raw !== "object" || typeof raw.archivePath !== "string" || !safeArchivePath(raw.archivePath)) {
      throw new Error(`Illarin theme delivery ${delivery.id} has an invalid asset descriptor`);
    }
    const data = entries[raw.archivePath];
    if (!data) throw new Error(`Illarin theme delivery ${delivery.id} is missing ${raw.archivePath}`);
    return {
      slug: typeof raw.slug === "string" && raw.slug ? raw.slug : raw.archivePath,
      originalFilename: typeof raw.originalFilename === "string" ? raw.originalFilename : raw.archivePath.split("/").pop(),
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "application/octet-stream",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
      dataBase64: Buffer.from(data).toString("base64"),
    };
  });
  return manifest;
}

function requireSuccess(result: { success: boolean; error?: string }, delivery: IllarinDelivery): void {
  if (!result.success) throw new Error(result.error || `Illarin ${delivery.kind} installation failed`);
}

export async function installIllarinDelivery(userId: string, delivery: IllarinDelivery): Promise<void> {
  switch (delivery.kind) {
    case "character": {
      const result = await installCharacter(delivery.id, userId, {
        source: "illarin",
        characterId: delivery.assetId,
        characterName: delivery.name,
        importUrl: exportUrl(delivery),
        importEmbeddedWorldbook: true,
        galleryImageUrls: delivery.artifacts.filter((item) => item.kind === "picture").map((item) => item.url),
      });
      requireSuccess(result, delivery);
      return;
    }
    case "lorebook": {
      const data = await fetchJsonArtifact(delivery);
      const result = await installWorldbook(delivery.id, userId, {
        source: "illarin",
        worldbookId: delivery.assetId,
        worldbookName: delivery.name,
        worldbookData: data as any,
      });
      requireSuccess(result, delivery);
      return;
    }
    case "preset": {
      const preset = await fetchJsonArtifact(delivery);
      const result = await installPreset(delivery.id, userId, {
        source: "illarin",
        presetId: delivery.assetId,
        presetName: delivery.name,
        presetVersion: typeof preset.presetVersion === "string" ? preset.presetVersion : null,
        presetData: { preset },
      });
      requireSuccess(result, delivery);
      return;
    }
    case "theme": {
      const themeData = await decodeThemeArtifact(delivery);
      const result = await installTheme(delivery.id, userId, {
        source: "illarin",
        themeId: delivery.assetId,
        themeName: delivery.name,
        themeData,
      });
      requireSuccess(result, delivery);
      return;
    }
    case "pack": {
      const pack = packsSvc.importPack(userId, await fetchJsonArtifact(delivery) as any);
      eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
        characterId: pack.id,
        characterName: pack.name,
        source: "illarin",
        type: "pack",
      }, userId);
      return;
    }
    default:
      throw new Error(`Illarin delivery kind "${delivery.kind}" is not supported`);
  }
}
