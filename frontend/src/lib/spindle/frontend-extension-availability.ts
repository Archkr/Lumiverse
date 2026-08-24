interface FrontendExtensionAvailability {
  identifier?: unknown
  enabled?: unknown
  has_frontend?: unknown
}

/** True only while the named extension frontend is installed and available to mount. */
export function hasEnabledFrontendExtension(
  extensions: readonly FrontendExtensionAvailability[] | null | undefined,
  identifier: string,
): boolean {
  return Boolean(extensions?.some((extension) => (
    extension.identifier === identifier
    && extension.enabled === true
    && extension.has_frontend === true
  )))
}
