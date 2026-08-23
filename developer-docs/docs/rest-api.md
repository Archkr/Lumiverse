# REST API Reference

Lumiverse exposes two useful HTTP surfaces for developers:

- the app's core `/api/v1/settings` endpoints for persisted user preferences
- the `/api/v1/spindle/*` endpoints for managing installed extensions

## Settings API

Use the settings endpoints when you need to inspect or update persisted host preferences.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/settings` | List all settings as `{ key, value, updated_at }[]` |
| `GET` | `/api/v1/settings/:key` | Get a single setting row |
| `PUT` | `/api/v1/settings` | Bulk upsert settings from a flat `{ key: value }` object |
| `PUT` | `/api/v1/settings/:key` | Upsert one setting from `{ value }` |
| `DELETE` | `/api/v1/settings/:key` | Delete a single setting row |

### Landing Page Display Settings

The landing page layout is controlled by persisted display settings:

| Key | Type | Description |
|---|---|---|
| `landingPageLayoutMode` | `'cards' \| 'compact'` | Switches the home screen between the existing card gallery and the compact adaptive recent-chat list. |
| `landingPageChatsDisplayed` | `number` | Controls the recent-chat batch size loaded per request. |

```bash
# Switch the landing page to the compact adaptive list view
curl -X PUT http://localhost:7860/api/v1/settings/landingPageLayoutMode \
  -H 'Content-Type: application/json' \
  -d '{ "value": "compact" }'

# Or update multiple display settings in one request
curl -X PUT http://localhost:7860/api/v1/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "landingPageLayoutMode": "compact",
    "landingPageChatsDisplayed": 24
  }'
```

## Spindle Extension Endpoints

Extensions can also be managed via the HTTP API.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/spindle` | List all installed extensions |
| `POST` | `/api/v1/spindle/install` | Install from `{ github_url }` |
| `POST` | `/api/v1/spindle/:id/update` | Pull latest + rebuild |
| `DELETE` | `/api/v1/spindle/:id` | Remove extension |
| `POST` | `/api/v1/spindle/:id/enable` | Enable + start worker |
| `POST` | `/api/v1/spindle/:id/disable` | Disable + stop worker |
| `GET` | `/api/v1/spindle/:id/permissions` | Get requested and granted permissions |
| `POST` | `/api/v1/spindle/:id/permissions` | Grant/revoke: `{ grant: [...], revoke: [...] }` |
| `GET` | `/api/v1/spindle/:id/manifest` | Get parsed `spindle.json` |
| `GET` | `/api/v1/spindle/tools` | List all registered LLM tools |
| `GET` | `/api/v1/spindle/:id/frontend` | Serve frontend JS bundle |

## Chat Edit-and-Send

Edits a user message and immediately re-sends it for generation in one atomic call.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/chats/:chatId/edit-and-send` | Edit a user message and trigger regeneration |

Request body:

| Field | Type | Description |
|---|---|---|
| `messageId` | `string` | *required.* ID of the user message to edit. Only user messages can be edited. |
| `content` | `string` | *required.* The edited, non-empty message content. |
| `expectedVersion` | `number` | *required.* Positive integer. The message's current revision for optimistic concurrency. |
| `requestId` | `string` | *required.* Client-generated id used for idempotent replay of this request. |

```bash
curl -X POST http://localhost:7860/api/v1/chats/my-chat-id/edit-and-send \
  -H 'Content-Type: application/json' \
  -d '{
    "messageId": "msg-123",
    "content": "Edited prompt text",
    "expectedVersion": 4,
    "requestId": "8f0c1e5a-..."
  }'
```

Behavior:

- **Optimistic concurrency**: when `expectedVersion` does not match the stored message revision the endpoint returns `409 Conflict`. Unknown chat or message returns `404 Not Found`.
- **History branch**: the edit is written on a newly created history branch of the chat rather than mutating the visible timeline. If an assistant reply already follows the edited message, the new generation routes through the swipe generation path (a new swipe slot on the branch's assistant copy); otherwise a normal generation is started.
- **Idempotent replay**: repeating the same `requestId` with an identical payload returns the original response (`replayed: true`) instead of branching again; reusing a `requestId` with a different payload is a `409`.
- **Durable outbox dispatch**: the generation request is tracked in a persistent outbox. If the server crashes after accepting the request, startup recovery inspects orphaned rows — verifying persisted output before completing them, retrying with backoff (up to 8 attempts), and marking exhausted rows terminally failed.

Success response:

```json
{
  "branchChatId": "...",
  "editedMessageId": "...",
  "immediateAssistantId": "...",
  "generationCursor": {
    "generationId": "...",
    "chatId": "...",
    "requestId": "...",
    "mode": "swipe"
  }
}
```

## Install

```bash
curl -X POST http://localhost:7860/api/v1/spindle/install \
  -H 'Content-Type: application/json' \
  -d '{ "github_url": "https://github.com/you/my-extension" }'
```

## Manage Permissions

```bash
# View permissions
curl http://localhost:7860/api/v1/spindle/my_extension/permissions

# Grant permissions
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/permissions \
  -H 'Content-Type: application/json' \
  -d '{ "grant": ["generation", "interceptor"] }'

# Revoke permissions
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/permissions \
  -H 'Content-Type: application/json' \
  -d '{ "revoke": ["cors_proxy"] }'
```

## Enable / Disable

```bash
# Enable
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/enable

# Disable
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/disable
```

## Update

```bash
curl -X POST http://localhost:7860/api/v1/spindle/my_extension/update
```

## Remove

```bash
curl -X DELETE http://localhost:7860/api/v1/spindle/my_extension
```
