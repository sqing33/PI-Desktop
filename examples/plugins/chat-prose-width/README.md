# Chat Prose Width

A PI-Desktop plugin that adjusts the **display width of message text** inside
the conversation area (the text lines themselves, not the whole conversation
band).

## What it changes

The host renders message text with:

```css
width: min(100%, var(--chat-prose-max-width, 720px));
```

This plugin contributes a runtime theme whose CSS overrides
`--chat-prose-max-width` on `.main-pane`, so the text lines get the width you
choose. When *Expand conversation band to fit* is enabled, it also raises
`--chat-content-max-width` so wider text is actually reachable inside the band.

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `proseWidth` | select | `720` | Max text width: 560 / 720 / 960 / 1200 px |
| `expandBand` | boolean | `true` | Also widen the conversation band to fit the chosen text width |

Change the values on the plugin's settings page; the width applies
immediately.

## Load it

1. Open **Plugins** (Extensions) in PI-Desktop.
2. Open the header overflow menu → **Load development plugin**.
3. Select this directory (`examples/plugins/chat-prose-width`).
4. Review the requested permission (`ui.theme`) and confirm.

The plugin applies its width theme on startup, restores your previous theme
when disabled or uninstalled, and re-applies when you change a setting or
switch light/dark.

## Package it (optional)

From the repository root:

```bash
pnpm pi-plugin check examples/plugins/chat-prose-width
pnpm pi-plugin pack examples/plugins/chat-prose-width
```

The packed `.piplug` lands in
`examples/plugins/chat-prose-width/dist/` and can be installed via
**Install plugin package**.