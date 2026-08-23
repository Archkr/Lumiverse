# Mount Points

Mount points are fixed anchor locations in Lumiverse's native UI where your extension can inject DOM. Call `ctx.ui.mount({ mountPoint })` — more precisely `ctx.ui.mount(point)` with the point literal — to get a host-managed root `<div>` appended into the anchor:

```ts
const root = ctx.ui.mount('chat_header_right')
root.appendChild(myWidget)
```

Key behaviors:

- **One root per point per extension.** Calling `ctx.ui.mount()` again with the same point returns the same root element. Each root is stamped with `data-spindle-extension-root` and `data-spindle-mount-point`.
- **Automatic attach and re-attach.** The host observes the DOM and appends your root whenever the anchor appears — including after view switches between the landing page and an active chat. When a frontend generation first attaches a root, any stale children are cleared.
- **Automatic teardown.** All roots are destroyed when your extension is disabled, removed, updated, or reloaded.
- **Unknown literals warn in dev.** Points outside the catalog below log a development-mode warning; unknown strings still work (the type is widened), so third-party anchors are possible, but stick to the catalog for anything user-facing.

## Canonical vs legacy naming

The canonical catalog is `HOST_MOUNT_POINTS` in `frontend/src/lib/spindle/mount-points.ts`: exactly **58 literals** in spec order. Five pre-catalog literals are kept as compatibility aliases (`sidebar`, `chat_column_top`, `landing_toolbar`, `landing_main`, `landing_chats`) and still resolve, because the host UI still stamps matching anchors. Prefer the canonical names in new code.

## Canonical catalog

All 58 canonical mount points, grouped by surface:

### Chat chrome (8)

| ID | Anchors to |
|---|---|
| `chat_header_left` | Left slot of the chat header bar |
| `chat_header_center` | Center slot of the chat header bar |
| `chat_header_right` | Right slot of the chat header bar |
| `chat_top_dock` | Dockable strip above the chat column (hosts QuickToolbar-style rails; honors dock requests) |
| `chat_bottom_dock` | Strip below the composer area at the bottom of the chat column |
| `chat_surface_side` | Side panel area flanking the chat surface |
| `chat_sidebar_left` | Left side rail of the chat layout |
| `chat_sidebar_right` | Right side rail of the chat layout |

### Chat stream (3)

| ID | Anchors to |
|---|---|
| `chat_stream_before` | Immediately before the message list |
| `chat_stream_after` | Immediately after the message list |
| `chat_empty_state` | Inside the stream area; only present while the chat has no messages |

### Composer / input bar (6)

| ID | Anchors to |
|---|---|
| `chat_composer_above` | Directly above the composer input |
| `chat_composer_below` | Directly below the composer input |
| `chat_input_tools_left` | Left tools slot inside the input bar |
| `chat_input_tools_right` | Right tools slot inside the input bar |
| `chat_actions` | Action row associated with the composer |
| `chat_toolbar` | Toolbar strip surrounding the composer |

> For *buttons* in the input bar, prefer [`ctx.ui.registerInputBarAction()`](ui-placement.md#input-bar-actions), which handles ordering and caps for you.

### Message-level (8)

These anchors are stamped **per rendered message** and carry a `data-spindle-scope` like `message:{id}:bubble:footer` (bubble theme) or `message:{id}:minimal:footer` (minimal theme). They exist on both the bubble and minimal message themes unless noted. Because messages are virtualized (destroyed and recreated on scroll), use [`ctx.ui.registerDomDecorator()`](host-surfaces.md#dom-decorators) rather than `ctx.ui.mount()` for these — decorators replay automatically onto recycled anchors.

| ID | Anchors to |
|---|---|
| `message_header` | Header strip of each message bubble/minimal row |
| `message_body_before` | Above the message body content |
| `message_body_after` | Below the message body content |
| `message_footer` | Footer of each message |
| `message_actions` | Hover/action cluster on each message bubble |
| `message_edit_actions` | Action row of the inline message-edit area |
| `message_context_menu` | Per-message context menu entries |
| `message_swipe_indicators` | Swipe gesture indicator layer on bubble and minimal messages |

### Landing page (5)

Only present on the landing/home page (no active chat open).

| ID | Anchors to |
|---|---|
| `landing_header` | Page header |
| `landing_hero` | Hero section |
| `landing_characters` | Character panel/card library region |
| `landing_recent_chats` | Recent chats panel region |
| `landing_footer` | Page footer |

### Sidebar & drawer (5)

| ID | Anchors to |
|---|---|
| `sidebar_top` | Top of the drawer's navigation sidebar rail |
| `sidebar_bottom` | Bottom of the drawer's navigation sidebar rail |
| `drawer_tab` | Content wrapper of each drawer tab (stamped per tab) |
| `drawer_header_actions` | Actions area of the drawer header |
| `drawer_footer` | Drawer footer |

To *add* a whole new drawer tab, use [`ctx.ui.registerDrawerTab()`](ui-placement.md#drawer-tabs) instead.

### Editors (14)

| ID | Anchors to |
|---|---|
| `character_editor_tab` | Tab strip of the character editor |
| `character_browser_card_actions` | Action area of each character card in the browser grid |
| `preset_editor_tab` | Tab strip of the Loom preset editor |
| `preset_editor_toolbar` | Toolbar of the Loom preset editor |
| `persona_editor_tab` | Tab strip of the persona editor |
| `world_book_entry_table` | World-book entry table container |
| `world_book_entry_row` | Each world-book entry table row (scoped per entry; rows may be recycled — prefer a [DOM decorator](host-surfaces.md#dom-decorators)) |
| `world_book_entry_editor` | Body of the shared world-book entry editor |
| `world_book_entry_toolbar` | Toolbar of the world-book entry editor |
| `lorebook_workspace` | Full-page lorebook editor workspace |
| `lorebook_half_workspace` | Half-screen lorebook workspace docked beside the chat |
| `loom_builder_toolbar` | Toolbar of the Loom block builder |
| `loom_builder_inspector` | Inspector pane of the Loom block builder |
| `regex_entry_row` | Each row of the regex scripts panel |

### Settings (4)

| ID | Anchors to |
|---|---|
| `settings_tab` | Content host for registered settings tabs (populated via [`ctx.ui.registerSettingsTab()`](host-surfaces.md#settings-tabs)) |
| `settings_section` | Individual settings sections/cards (stamped on several native sections, including productivity cards) |
| `settings_card_actions` | Header action slot of productivity settings cards |
| `settings_extensions` | Extensions area within the settings modal |

### Overlays & misc (5)

| ID | Anchors to |
|---|---|
| `modal_header_actions` | Header actions slot of the shared modal shell (scoped per modal) |
| `modal_footer_actions` | Footer actions slot of the shared modal shell |
| `command_palette_actions` | Actions area of the command palette overlay |
| `manage_chats_actions` | Bulk-action area of the Manage Chats modal (scoped per character) |
| `prompt_variables_toolbar` | Toolbar of the prompt variables modal |

## Legacy alias mapping

| Legacy alias | Status |
|---|---|
| `sidebar` | Still resolves — the drawer sidebar rail is stamped with this literal |
| `chat_column_top` | Still resolves — top of the chat column, above the header slots |
| `landing_toolbar` | Still resolves — landing page toolbar/tab strip |
| `landing_main` | Still resolves — landing page main content region |
| `landing_chats` | Still resolves — landing page recent-chats panel |

Legacy names do **not** count toward the 58 canonical points and may be retired eventually; migrate to the canonical equivalents (`sidebar_top`/`sidebar_bottom`, `chat_top_dock`, and the `landing_*` canonical points).

## Caps and limits

Mount points themselves have **no per-extension cap**: `ctx.ui.mount()` hands you one root per point, and every point in the catalog above is available to every extension without a permission gate. The only guardrails are:

- Unknown mount literals produce a development-only console warning.
- Structured placement APIs (`registerDrawerTab`, `requestDockPanel`, `createFloatWidget`, `mountApp`, `registerInputBarAction`, modals, editor tabs) enforce their own per-extension and global capacity limits and permission requirements — see [Capacity Limits](ui-placement.md#capacity-limits).

## See also

- [UI Placement](ui-placement.md) — structured placement APIs (drawer tabs, float widgets, dock panels, modals, input-bar actions) with caps and permissions
- [Host Surfaces](host-surfaces.md) — DOM decorators (virtualization-safe repeated anchors), component overrides, settings tabs, and host-surface registration
