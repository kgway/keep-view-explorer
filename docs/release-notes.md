# Keep View Explorer

## Changes in 1.44.3

- Prevent native calendar icons from overlapping text in Android date-range inputs, without requiring a separate CSS snippet.
- Keep the icon in normal layout with the standard gap, including when an optional snippet is enabled. A host-hidden icon leaves no reserved icon slot.
- Maintain the optional general-purpose [Android date fix](https://github.com/kgway/obsidian-android-date-fix) separately from the plugin.

- Keep the optional search cache in device- and vault-specific IndexedDB, outside normal vault-folder sync.
- Update saved cache only when Search is submitted; note edits, filter changes and sorting do not write it.
- Remove cached text for deleted or renamed paths on the next explicit search, including paths outside the current filters.
- Turning persistence off also deletes saved cache. Manual deletion leaves notes and settings intact and waits for the next explicit search to rebuild.
- Search notes directly when storage is unavailable, without writing fallback cache files into the vault. Cached note text remains compressed and unencrypted.
- Discard recognized old `search-cache-v1` files on explicit cached search or cache deletion.

## Changes in 1.43.11

- Replace the narrow-screen toolbar's `column-gap` declaration with the equivalent grid `gap` shorthand to resolve the remaining CSS compatibility warning.

## Changes in 1.43.10

- Resolve type-assertion and Promise-handling review warnings.
- Preserve the mobile toolbar layout using nested grids instead of `display: contents`.
- Handle failed asynchronous previews without leaving reserved scroll space behind.
- Use the supported settings refresh API on newer Obsidian versions while retaining support for older versions.

## Recent changes

- Start new views with the newest modified notes while preserving saved choices.
- Use file creation time for missing or invalid creation dates, both when sorting together with other notes and when filtering by date range.
- Use standard ES Module imports in the source, while keeping the installed plugin as one CommonJS file.
- Clarify the type of tag-tree drag targets.
- Remove stylesheet `!important` overrides and simplify grid gap declarations while preserving the layout.
- Reuse the canvas used to measure preview labels.
- Preserve the full view area by overriding default ItemView padding with a selector scoped to Keep View.

Browse, filter, and organize notes in a Google Keep-style card view. Narrow results with Boolean tag queries, folders, dates, and full-text search, then move or retag notes in bulk.

- English and Japanese interface.
- Desktop and mobile layouts.
- Relative paths by default when exporting results.
- Optional compressed local search cache.
- Creation timestamp import for Markdown notes migrated from Google Keep.

Requires Obsidian 1.8.7 or later. Install from the [community directory](https://community.obsidian.md/plugins/keep-view).

For manual installation, copy the attached `main.js`, `manifest.json` and `styles.css` into the vault's plugin folder for `keep-view`, then enable it in Obsidian. The repository README contains usage and data-handling details.
