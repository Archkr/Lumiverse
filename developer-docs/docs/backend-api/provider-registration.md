# Provider Registration

Extensions can act as providers for embeddings, text-to-speech, speech-to-text, and sidecar workloads. The extension's backend worker registers a broker descriptor with the host; when a Lumiverse feature needs that provider kind, the host dispatches the request to your registered broker URL server-side.

## Permissions

Provider registration is gated by one permission per kind:

| Permission | Registers |
|---|---|
| `providers.embedding.register` | Embedding providers |
| `providers.tts.register` | Text-to-speech providers |
| `providers.stt.register` | Speech-to-text providers |
| `providers.sidecar.register` | Sidecar providers (for example Memory Cortex ingestion) |

These permissions are **PRIVILEGED**: they require explicit operator approval before they are granted, and upgrading does not auto-grant them to previously installed extensions. See [Upgrade Notes](../UPGRADE-NOTES.md). Declare them in `spindle.json`:

```json
{
  "permissions": ["providers.embedding.register"]
}
```

Registering without the grant fails with a `permission_denied` message for the `provider_register` operation.

## Registering a provider

Use the `spindle.providers` API from your backend module:

```ts
spindle.providers.register({
  kind: 'embedding',
  id: 'my-embedder',
  description: { name: 'My Embedder', model: 'embed-v1' },
  broker: {
    url: 'https://broker.example.com:8443/embed',
    method: 'POST',
    secretKey: 'extension:<installationId>:broker-key',
  },
})

// Optional: handle invokes in-worker instead of using a broker URL
const stop = spindle.providers.handle('embedding', 'my-embedder', async (request) => {
  return { embedding: await embed(request.input) }
})

// React to registry changes for this installation
const unwatch = spindle.providers.onChanged((msg) => { /* registered | unregistered | updated */ })

spindle.providers.unregister('embedding', 'my-embedder')
```

Rules enforced by the registry:

- `kind` must be one of `embedding`, `tts`, `stt`, `sidecar`; anything else is denied.
- A duplicate `kind`/`id` pair within the same installation scope throws `provider already registered`.
- Registrations are scoped: each provider key is `(effectiveScope, installationId, kind, id)`. Unloading your installation removes its providers and aborts their pending invocations.
- Descriptors are capped at 64 KiB.

## Broker specification

The `broker` object tells the host where — and how — to dispatch requests:

| Field | Description |
|---|---|
| `url` | *required.* Must be `http:` or `https:`, with no embedded credentials. When an operator has configured approved broker origins, the URL origin must match the allowlist or registration is rejected. |
| `method` | HTTP method. Defaults to `POST`. |
| `headers` | Static headers. Secret-bearing header names are redacted before storage and dispatch. |
| `secretKey` | Secret reference resolved host-side at request time. See [secret scoping](#secret-scoping) below. |

**Destination immutability**: the broker URL is fixed at registration time. Per-invocation `payload.url` overrides are never honored — callers control only method, headers, body, and binary mode. The structural URL checks are re-run on every dispatch so a tampered request cannot bypass what registration would have rejected.

**`allowlistKey`** (dispatch-time option): callers may reference a host-approved broker configuration by key. Unapproved keys are rejected with an authorization error before any network request is made.

All broker egress goes through the host's SSRF-guarded fetch (private-IP and DNS-rebinding protection), with response size caps and timeouts.

## Secret scoping

Broker secrets resolve only inside your own installation namespace:

- `secretKey` must be shaped `extension:<installationId>:<name>`, where `<installationId>` is your installation.
- Global or user-scoped keys (such as a plain `openai_api_key`) are rejected with an authorization error before any network request is made.
- A `secretKey` naming a different installation than your own is also rejected.
- At dispatch time the host resolves the secret and injects it as `Authorization: Bearer <secret>`. The worker-visible view of every broker request is redacted: secrets never reach extension workers through the broker path, and envelopes containing secrets fail closed.

Secret values are provisioned by the operator, not by the extension: the operator REST endpoints under `/api/v1/spindle-secrets` store encrypted values (keyed by `extension:<installationId>:<name>`) for system-scope brokers to resolve host-side. Reference the provisioned key from your broker spec; your worker can set and read the reference but never the resolved value.

## Where providers surface in the product

Registered providers appear in the host UI without any frontend code on your side:

- **Embeddings settings**: embedding providers register as selectable embedding drivers/models.
- **Voice & Speech settings**: `tts` and `stt` registrations join the voice provider lists.
- **Memory Cortex**: `sidecar` registrations join the sidecar connection options.

The frontend projects scoped `provider_changed` WebSocket events (`add`, `change`, `remove`) into these pickers live — no page reload is required after registration or unload. Events are scope-filtered: other users' or denied providers are never projected into your view.

Each entry carries an availability status reported through the registry projection:

- `ok` — healthy
- `unavailable` — the provider is marked unavailable; the picker renders an "unavailable" fallback badge
- `timeout` — the provider timed out; rendered as a timeout badge

Pickers keep working while a provider is degraded: the badges tell the user which entries currently cannot serve requests instead of hiding them. For Memory Cortex sidecars, a timeout state means primary retries, then secondary, then the configured fallback.
