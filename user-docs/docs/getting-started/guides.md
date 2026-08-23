---
title: Built-in Guides
---

# Built-in Guides

Lumiverse ships with a library of built-in guides — short manuals for every panel and feature, readable without leaving the app. The pages you're reading right now are the same guides, served straight from your Lumiverse install.

---

## Opening Guides

There are several ways to open a guide:

- **Landing page** — Click the **Guides** button (book icon) in the landing page header to open the full **Guides browser**.
- **Drawer tabs** — Tabs that have a guide show a help button (**Open guide**) in the panel header, right next to the tab title.
- **Editors** — The Loom Builder and the character editor expose the same **Open guide** button when an extension tab provides one.

Guides open in a modal reader over the current view, so you can follow along while you work.

---

## The Guides Browser

The landing-page Guides browser covers every guide in the library:

| Control | What It Does |
|---------|--------------|
| **Search box** | Type to filter all guides by title or path. Results are ranked by relevance and capped at 20 hits. |
| **Clear button** | Appears while searching — click it to reset the search. |
| **Back arrow** | Walks back through the guides you've opened in this session. |

Links inside a guide open the linked page in the same viewer, so you can hop between related topics; the back arrow retraces your steps. Links to sections within the current guide scroll directly to that heading.

---

## Guide Formatting

Guides are written in Markdown with two extra constructs you'll see rendered in the viewer:

### Admonitions

Blocks that start with `!!!` and a type render as highlighted callouts:

```text
!!! tip "Start with display target"
    If you're not sure about a regex, use the display target first.
```

The first line is the type plus an optional quoted title; the body is indented four spaces below it.

### Content Tabs

Consecutive lines of the form `=== "Label"` split the following indented content into switchable tabs:

```text
=== "Compact"
    300 px collapsed height

=== "Comfortable"
    500 px collapsed height
```

---

## Extension Guides

[Spindle extensions](../extensions/index.md) can contribute their own guides. When an extension registers a drawer tab with a guide attached, its **Open guide** button renders that extension's Markdown through the same viewer — admonitions, tabs, and all.

---

!!! tip "Same content, two homes"
    The in-app viewer and this documentation site serve the same guide sources. If something looks out of date in-app after an update, check the corresponding page here.
