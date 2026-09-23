const permissionErrors = new Map<string, "work:receive" | "library:sync">();

export function getPermissionError(userId: string): string | null {
  return permissionErrors.get(userId) ?? null;
}

export function setPermissionError(userId: string, permission: "work:receive" | "library:sync"): void {
  permissionErrors.set(userId, permission);
}

export function clearPermissionError(userId: string): void {
  permissionErrors.delete(userId);
}
