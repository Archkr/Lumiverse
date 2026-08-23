# Chats (Frontend)

The frontend `ctx.chats` namespace gives extensions host-backed access to the user's chat sessions: flat and grouped recent-chat listings with server-side search, sort, and pagination, plus rename and delete mutations.

!!! tip "Frontend vs Backend chats"

    - **`ctx.chats`** (this page) — runs in the browser against the session-authenticated REST API. Recent-chat reads are free; writes require the `chats` permission.
    - **`spindle.chats`** ([Chats (Backend)](../backend-api/chats.md)) — runs in the backend worker under the `chats` permission, with its own `list`, `get`, `getActive`, `update`, and `delete` surface.

## Permission Summary

| Method | Permission | Notes |
|---|---|---|
| `listForCharacter(characterId)` | Free | Session-authenticated REST read |
| `getMessages(chatId, options?)` | Free | Limit is capped by the host |
| `listRecent(options?)` | Free | Session-authenticated read; limit is a resource cap |
| `listRecentGrouped(options?)` | Free | Session-authenticated read; limit is a resource cap |
| `update(chatId, input)` | `chats` | Durable chat write |
| `delete(chatId)` | `chats` | Durable destructive write |

Reads are free because they mirror REST endpoints the user's own session can already call (`GET /api/v1/chats/recent`, `GET /api/v1/chats/recent-grouped`, `GET /api/v1/chats/character-chats/:id`, `GET /api/v1/chats/:id/messages`); the host only caps the requested limits.

## Reading Recent Chats

### `listRecent(options?)`

Returns a flat, one-row-per-chat recent list (`Promise<PaginatedResult<RecentChat>>`) enriched per row so list UIs never need a per-row message fetch.

### `listRecentGrouped(options?)`

Returns one row per solo character / group member set (`Promise<PaginatedResult<GroupedRecentChat>>`), pointing at that lineage's most recent chat. This is the same shape the landing page's recent-chats panel renders — see [Mount Points](mount-points.md#legacy-alias-mapping) for the `landing_chats` anchor.

### Query Options

Both methods accept the same options object:

| Field | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `50` | Maximum rows. Clamped by the host to `[0, 200]`. |
| `offset` | `number` | `0` | Pagination offset. |
| `search` | `string` | — | Server-side substring filter applied before pagination. |
| `sort` | `"name" \| "recent" \| "created"` | — | Sort key: chat name, last-update time, or creation time. |
| `direction` | `"asc" \| "desc"` | — | Sort direction. |

The result is `{ data, total, limit, offset }`, where `total` is the full unpaginated count after filtering.

!!! note "Feature detection"

    In `lumiverse-spindle-types`, `listRecent` and `listRecentGrouped` are optional members of the chats API. If you support hosts older than their introduction, feature-detect before calling:

    ```ts
    if (typeof ctx.chats.listRecent === 'function') {
      const page = await ctx.chats.listRecent({ limit: 20 })
    }
    ```

### Row Schemas

`RecentChat` — a single chat:

```ts
{
  id: string
  character_id: string
  name: string
  created_at: number            // unix epoch seconds
  updated_at: number
  character_name: string
  character_image_id: string | null
  character_avatar_path?: string | null
  message_count: number         // total messages; avoids per-row message fetches
  last_message_preview: string  // first ~280 chars of the newest message
}
```

`GroupedRecentChat` — a character/group lineage:

```ts
{
  character_id: string
  character_name: string
  character_image_id: string | null
  character_avatar_path?: string | null
  latest_chat_id: string
  latest_chat_name: string
  updated_at: number
  chat_count: number            // chats in this lineage
  is_group: boolean
  group_character_ids?: string[] // member character IDs when is_group is true
  group_name?: string
  multiplayer?: boolean
}
```

## Other Reads

| Method | Returns | Description |
|---|---|---|
| `listForCharacter(characterId)` | `Promise<ChatSummary[]>` | All chats for one character, each with `message_count` and a truncated `last_message_preview`. |
| `getMessages(chatId, options?)` | `Promise<PaginatedResult<Message>>` | Messages for a chat. Options: `{ limit?, tail? }`; `limit` is capped at 200 by the host. |

## Mutations

### `update(chatId, input)`

Renames a chat or replaces its metadata. Requires the **`chats`** permission.

```ts
const updated = await ctx.chats.update('chat-id', {
  name: 'Renamed Chat',
  metadata: { custom_field: 'value' },
})
```

| Field | Type | Description |
|---|---|---|
| `name` | `string?` | New chat name |
| `metadata` | `Record<string, unknown>?` | Replacement metadata object |

Only provided fields are updated. Returns the updated chat.

### `delete(chatId)`

Deletes a chat and all of its messages. Requires the **`chats`** permission.

```ts
await ctx.chats.delete('chat-id')
```

Permission checks run before the request is sent and re-verified after any await, so a permission revoked mid-flight cannot be exploited by a stale call.

## Usage

```ts
import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  async function showRecents() {
    const { data, total } = await ctx.chats.listRecent({
      limit: 20,
      search: 'alice',
      sort: 'recent',
      direction: 'desc',
    })

    for (const chat of data) {
      console.log(`${chat.character_name}: ${chat.name} (${chat.message_count} msgs)`)
      console.log(`  ${chat.last_message_preview.slice(0, 60)}`)
    }

    const grouped = await ctx.chats.listRecentGrouped({ limit: 50 })
    for (const row of grouped.data) {
      console.log(row.is_group ? `${row.group_name} (${row.chat_count})` : row.character_name)
    }
  }

  void showRecents()
}
```

## Related

- [Chats (Backend)](../backend-api/chats.md) — the backend-worker `spindle.chats` surface and chat memories
- [Mount Points](mount-points.md) — the `landing_chats` anchor where the native recent-chats panel mounts
