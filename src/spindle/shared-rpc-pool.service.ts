import {
  assertValidSharedRpcEndpoint,
  normalizeOwnedSharedRpcEndpoint,
} from "./shared-rpc";

type SharedRpcRequestHandler = (requesterExtensionId: string) => Promise<unknown>;
type SharedRpcPermissionResolver = (extensionIdentifier: string) => readonly string[];

type SharedRpcEndpointRecord =
  | {
      mode: "sync";
      ownerExtensionId: string;
      endpoint: string;
      value: unknown;
    }
  | {
      mode: "request";
      ownerExtensionId: string;
      endpoint: string;
      handler: SharedRpcRequestHandler;
    };

const sharedRpcEndpoints = new Map<string, SharedRpcEndpointRecord>();
const sharedRpcByOwner = new Map<string, Set<string>>();

function trackOwnerEndpoint(ownerExtensionId: string, endpoint: string): void {
  let endpoints = sharedRpcByOwner.get(ownerExtensionId);
  if (!endpoints) {
    endpoints = new Set<string>();
    sharedRpcByOwner.set(ownerExtensionId, endpoints);
  }
  endpoints.add(endpoint);
}

function normalizeOwnedEndpoint(ownerExtensionId: string, endpoint: string): string {
  return normalizeOwnedSharedRpcEndpoint(ownerExtensionId, endpoint);
}

export function syncSharedRpcEndpoint(
  ownerExtensionId: string,
  endpoint: string,
  value: unknown
): string {
  const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
  sharedRpcEndpoints.set(normalized, {
    mode: "sync",
    ownerExtensionId,
    endpoint: normalized,
    value,
  });
  trackOwnerEndpoint(ownerExtensionId, normalized);
  return normalized;
}

export function registerSharedRpcRequestEndpoint(
  ownerExtensionId: string,
  endpoint: string,
  handler: SharedRpcRequestHandler
): string {
  const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
  sharedRpcEndpoints.set(normalized, {
    mode: "request",
    ownerExtensionId,
    endpoint: normalized,
    handler,
  });
  trackOwnerEndpoint(ownerExtensionId, normalized);
  return normalized;
}

export function unregisterSharedRpcEndpoint(ownerExtensionId: string, endpoint: string): void {
  const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
  const existing = sharedRpcEndpoints.get(normalized);
  if (!existing || existing.ownerExtensionId !== ownerExtensionId) return;

  sharedRpcEndpoints.delete(normalized);

  const owned = sharedRpcByOwner.get(ownerExtensionId);
  if (!owned) return;
  owned.delete(normalized);
  if (owned.size === 0) {
    sharedRpcByOwner.delete(ownerExtensionId);
  }
}

export function unregisterSharedRpcEndpointsByOwner(ownerExtensionId: string): void {
  const owned = sharedRpcByOwner.get(ownerExtensionId);
  if (!owned) return;

  for (const endpoint of owned) {
    sharedRpcEndpoints.delete(endpoint);
  }

  sharedRpcByOwner.delete(ownerExtensionId);
}

export async function readSharedRpcEndpoint(
  endpoint: string,
  requesterExtensionId: string,
  getGrantedPermissions?: SharedRpcPermissionResolver
): Promise<unknown> {
  const normalized = assertValidSharedRpcEndpoint(endpoint);
  const record = sharedRpcEndpoints.get(normalized);

  if (!record) {
    throw new Error(`Shared RPC endpoint "${normalized}" is not registered`);
  }

  if (getGrantedPermissions) {
    assertRequesterInheritsOwnerPermissions(
      normalized,
      requesterExtensionId,
      record.ownerExtensionId,
      getGrantedPermissions,
    );
  }

  if (record.mode === "sync") {
    return record.value;
  }

  return await record.handler(requesterExtensionId);
}

function assertRequesterInheritsOwnerPermissions(
  endpoint: string,
  requesterExtensionId: string,
  ownerExtensionId: string,
  getGrantedPermissions: SharedRpcPermissionResolver
): void {
  const ownerPermissions = new Set(getGrantedPermissions(ownerExtensionId));
  if (ownerPermissions.size === 0) return;

  const requesterPermissions = new Set(getGrantedPermissions(requesterExtensionId));
  const missing = [...ownerPermissions].filter((permission) => !requesterPermissions.has(permission)).sort();
  if (missing.length === 0) return;

  throw new Error(
    `Shared RPC endpoint "${endpoint}" requires requester "${requesterExtensionId}" to inherit owner "${ownerExtensionId}" permissions: ${missing.join(", ")}`
  );
}

export function resetSharedRpcPoolForTests(): void {
  sharedRpcEndpoints.clear();
  sharedRpcByOwner.clear();
}
