# Host Surfaces & Registration

Beyond `ctx.ui.mount()` for fixed mount points, the frontend context exposes registration APIs that let an extension customize UI the host already renders: decorate repeated DOM, override native React components, contribute settings tabs, and mount first-party host surfaces into extension-owned elements.

All registrations are scoped to your extension installation and torn down automatically when your frontend unloads or reloads. Component-override and settings-tab handles additionally expose an explicit `destroy()`; `ctx.ui.registerDomDecorator()` returns a bare `() => void` cleanup function instead of a handle object.

## DOM decorators

`ctx.ui.registerDomDecorator(options)` attaches content to every element in the host DOM stamped with a matching mount point — including elements inside virtualized lists that are destroyed and recreated as the user scrolls.

| Option | Type | Description |
|---|---|---|
| `mount` | `string` | *required*. Mount literal to attach to (for example `message_footer`, `world_book_entry_row`). |
| `render` | `(root, ctx) => void \| (() => void)` | Called when the decorator root is mounted on an anchor. Return a cleanup function to run on detach. |
| `update` | `(root, ctx) => void` | Called when an existing root should refresh its content. |
| `priority` | `number` | Ordering among decorators on the same anchor. |
| `instanceKey` | `string` | Distinguishes multiple decorator instances on the same mount. |
| `kind` | `'html' \| 'svg' \| 'badge' \| 'button' \| 'context-action'` | Declarative kind when using `html`/`svg` instead of `render`. |
| `html` / `svg` | `string` | Sanitized markup injected instead of a `render` callback. |

The render context provides `{ mount, scope, liveAnchorId, owner, generation, node, root }`.

Because the service tracks anchors by `data-spindle-mount` / `data-spindle-scope` attributes and replays decorators when anchors reappear, decorators survive virtualizer recycling of chat messages and world-book rows without any work on your side:

```ts
const destroy = ctx.ui.registerDomDecorator({
  mount: 'message_footer',
  render(root, { scope }) {
    const badge = document.createElement('span')
    badge.textContent = `scope: ${scope}`
    root.appendChild(badge)
    return () => badge.remove()
  },
})
```

Registering again with the same `mount` + `instanceKey` updates the existing decorator instead of duplicating it.

The published types package also declares a top-level convenience member `ctx.registerDomDecorator({ target, decorate })` on `SpindleFrontendContext`. It is optional; feature-detect it before use:

```ts
if (typeof ctx.registerDomDecorator === 'function') {
  const handle = ctx.registerDomDecorator({
    target: 'world_book_entry_row',
    decorate: (element) => { /* ... */ },
  })
}
```

## Component overrides

`ctx.ui.registerComponentOverride(options)` replaces or wraps a named native shell component.

| Option | Type | Description |
|---|---|---|
| `host` | `string` | *required*. One of `BubbleMessage`, `MinimalMessage`, `MessageEditArea`, `InputArea`, `PortraitPanel`, `QuickToolbar`, `ConnectionsPicker`, `CharacterCard`, `LoomBuilder`, `LandingPageShell`, `CommandPalette`. |
| `mode` | `'wrap' \| 'replace'` | `wrap` receives the original as the `Original` prop; `replace` fully takes over rendering. |
| `component` | `ComponentType` | Your React component. |
| `priority` | `number` | Lower wins. Defaults to `100`. |

Semantics worth knowing:

- One registration per extension generation per host; a second throws `COMPONENT_OVERRIDE_DUPLICATE`.
- Callback props are only forwarded to your component in `wrap` mode (or for `replace` on `MessageEditArea` / `InputArea`, where replacing without forwarding the native callbacks falls back to the native component).
- Overrides render inside an error boundary: if your component crashes, the host falls back to the native component instead of breaking the chat.

```tsx
ctx.ui.registerComponentOverride({
  host: 'BubbleMessage',
  mode: 'wrap',
  component: ({ Original, ...props }) => (
    <div className="my-frame">
      <Original {...props} />
    </div>
  ),
})
```

## Message actions

The published `SpindleFrontendContext` declares an optional top-level member:

```ts
ctx.registerMessageAction({
  id: 'translate',
  label: 'Translate',
  onClick(messageId: string) { /* ... */ },
})
```

It is declared optional in `lumiverse-spindle-types` and must be feature-detected:

```ts
if (typeof ctx.registerMessageAction === 'function') {
  ctx.registerMessageAction({ id: 'translate', label: 'Translate', onClick(id) { /* ... */ } })
}
```

When unavailable, per-message buttons can still be placed through the free `message_actions` and `message_context_menu` mount points with `ctx.ui.mount()`.

## Settings tabs

`ctx.ui.registerSettingsTab(options)` contributes a tab in the Settings screen. Up to 4 tabs per extension, 32 globally. A shared tab `id` may belong to core or another extension — your registration joins it with its own body order.

| Option | Type | Description |
|---|---|---|
| `id` | `string` | *required*. Tab id (max 100 chars); may be shared with core/other extensions. |
| `title` / `shortName` | `string` | Display metadata (ignored when a core tab owns the id). |
| `iconSvg` | `string` | Inline SVG icon. |
| `description` / `keywords` | `string` / `string[]` | Search metadata. |
| `sections` | `{ key, titleKey, titleFallback, keywords }[]` | Declared sections for search indexing. |
| `position` | `string` | `'top'`, `'bottom'`, `'after-display'`, `'before-chat'`, or `'after-<tabId>'` / `'before-<tabId>'`. |
| `order` | `number` | Body order among registrants sharing a tab. Defaults to `100`. |

The returned handle exposes `root` (render your UI here), `setTitle`, `activate`, `destroy`, and `onActivate`:

```ts
const tab = ctx.ui.registerSettingsTab({
  id: 'my-extension',
  title: 'My Extension',
  sections: [{ key: 'general', titleKey: '', titleFallback: 'General', keywords: [] }],
})

tab.root.appendChild(buildMyPanel())
```

## Host surfaces

`ctx.components.mountHostSurface(target, surfaceId, props?)` mounts a first-party host component into an element you own (`target` may be a host-provided mount root from `ctx.ui.mount()` or one of your own attached elements). Props are JSON values validated against a per-surface schema; functions, symbols, and deep structures are rejected.

Permission checks fail closed: if the surface requires a permission your extension lacks, mounting throws `PERMISSION_DENIED:<permission>`. If no renderer is registered for the id, it throws `HOST_SURFACE_UNAVAILABLE:<surfaceId>`.

The handle supports live updates, events emitted by the surface (`update(props)`, `on(event, handler)`, `destroy()`):

```ts
const root = ctx.ui.mount('chat_top_dock')
const surface = ctx.components.mountHostSurface(root, 'quick_toolbar.workspace', {
  contractVersion: 1,
  ownerToken: 'my_extension',
  generation: 0,
  capabilities: [],
})

const stop = surface.on('command', (payload) => { /* host-routed command */ })
surface.update({ contractVersion: 1, ownerToken: 'my_extension', generation: 1, capabilities: [] })
```

### Surface IDs

| Surface ID | Permission | Renders |
|---|---|---|
| `provider_icon` | Free | Static provider glyph (`{ provider, size? }`). Schema-only row: mounting fails closed with `HOST_SURFACE_UNAVAILABLE` unless the running host registers a renderer for it. |
| `token_count_button` | Free | Token count button for caller-supplied text (`{ text, profileId? }`). Same schema-only caveat as `provider_icon`. |
| `character_card` | Free | Native character card (`{ characterId, batchMode?, isSelected? }`). |
| `character_library_grid` | Free | Native character library grid with scope/filter/sort props. |
| `character_preview_panel` | Free | Native character preview panel (`{ characterId, imageHeight?, pinned? }`). |
| `homepage_character_library` | Free | The host-owned homepage character library grid (no props). |
| `world_book_entry_table` | Free | Native world-book entry table (`{ bookId, selectedEntryId?, density? }`). |
| `world_book_entry_editor` | `world_books` | Native world-book entry editor form bound to the durable entry-write API (`{ bookId, entryId, density?, fillContent? }`). The same editor is also reachable as a decorator anchor stamped at `data-spindle-mount="world_book_entry_editor"` with scope `world-book-entry:<entryId>:editor`. |
| `productivity.settings.workspace` | Free | Productivity preference controls. |
| `quick_toolbar.workspace` | Free | The native QuickToolbar. See [QuickToolbar and the chat top dock](#quicktoolbar-and-the-chat-top-dock). |
| `connections_picker.launcher` | `generation` | Connections-picker launcher action (capability `open`). |
| `connections_picker.panel` | `generation` | The ConnectionsPicker panel, anchored to the `[data-lumiverse-connections-launcher]` element (capability `close`). |
| `activated_lore.indicator` | Free | Activated lore indicator (capability `open`). |
| `activated_lore.panel` | Free | Activated lore panel (capability `close`). |
| `portrait_dock.workspace` | `ui_panels` | A host-managed portrait dock panel. Chat view layout measures the mounted `[data-spindle-host-surface="portrait_dock.workspace"]` element. |
| `lorebook.half.action` / `lorebook.enhanced.action` | Free | Actions that emit a negotiated request to open the lorebook workspace (capability `open`). |
| `lorebook.half.workspace` / `lorebook.enhanced.workspace` | `world_books` | Lorebook workspace variants hosting world-book state and mutations (capability `close`; `state` requires `{ open, bookId?, entryId?, invocationId?, source? }`). |

Productivity surfaces share one props contract:

| Prop | Type | Description |
|---|---|---|
| `contractVersion` | `1` | Protocol version. Must be exactly `1`. |
| `ownerToken` | `string` | Identifier pattern `^[A-Za-z0-9_-]{1,128}$`; used to sign commands emitted back to you. |
| `generation` | `number` | Bump it when re-negotiating; stale-generation commands are ignored. |
| `capabilities` | `string[]` | Negotiated capabilities; must match the surface's allowed set (`open` / `close` above), otherwise props validation fails. |
| `state` | `object` | Optional surface state projection (for example panel open state). |

Commands the surface invokes (such as `open` or `close`) arrive through `handle.on('command', ...)` as `{ command, invocationId, ownerToken, generation }`. Verify `ownerToken` and `generation` belong to you before acting.

## QuickToolbar and the chat top dock

Composer-adjacent placement is reachable through free mount points: `chat_composer_above`, `chat_composer_below`, `chat_input_tools_left`, `chat_input_tools_right`, `chat_toolbar`, `chat_actions`, and `chat_top_dock`.

There are two supported ways to extend the toolbar area:

- **Input bar actions**: `ctx.ui.registerInputBarAction({ id, label, subtitle?, iconSvg?, iconUrl?, enabled })` adds a host-rendered button. An action crosses into the QuickToolbar rail only when its `placement` is **unset** or equals `'input_bar.extras'` (the Extras popover — see [UI Placement > Input Bar Actions](ui-placement.md#input-bar-actions)), or when its contribution ID is one of the host's hardcoded `lumiverse_suite.*` action IDs. There is no `'quick_toolbar'` placement value; passing any other placement keeps the action out of the rail.
- **Full workspace surface**: mount `quick_toolbar.workspace` into a `chat_top_dock` root. The host renders its QuickToolbar inside your root and participates in chat-top-dock negotiation: when the toolbar is docked (or a strip dock host is requested), the host stamps `data-dock-request="strip"` on your extension root so the dock column stays open as a stable host.

Dock behavior attributes to be aware of when styling around the dock:

- `_chatToolbar` keeps `data-dock-request="strip"` while docked (or while "keep chat top dock enabled while floating" is active): it stays open as a stable glass-styled dock host with a minimum height.
- It collapses (`display: contents`) only for floating/unrequested docks not occupied by extensions.
- Full viewport breakout (`data-fill-screen="1"` / `data-fill-top-dock="1"`) is reserved for explicit breakout requests and uses fixed positioning.

Never fight these attributes from extension CSS; the host owns the dock lifecycle, and your surface content simply lives inside the negotiated rail.

## Public SDK boundary

Extension repos that predate the current published types often wrap the host context in a local public SDK module (as Lumiverse's own suite extension does in `shared/public-sdk.ts`):

- Widen mount ids the old union does not name yet (`asMount(id)` cast).
- Declare local stand-in handle types (`SpindleHostSurfaceHandle`, `SpindleSettingsTabHandle`) until the types package exports them.
- Treat every host-provided root as a scoped boundary: validate it with `isScopedHostRoot` / `requireScopedHostRoot` and keep all DOM work inside it.

Follow the same pattern for forward compatibility: feature-detect optional members, never reach outside host-provided roots, and treat anything not exported by `lumiverse-spindle-types` as internal.
