# Changelog

## 1.44.5 — restore saved search results

- Automatically reapply saved full-text queries when their view becomes visible, preserving metadata filters.
- Restore results without opening or updating persistent search storage; only explicit searches update it.
- Keep the current query visible after deleting or disabling the search cache.
- Defer restored full-text searches while views are hidden or detached.
- Update a development URI parser patch and move artifact uploads to the Node.js 24 action.

## 1.44.4 — cache type-check compatibility

- Validate stored path arrays with an explicit type predicate instead of an unnecessary assertion under newer TypeScript versions.
- Retain the same runtime JavaScript and stylesheet as 1.44.3.

## 1.44.3 — native date layout

- Keep the Android calendar indicator in normal layout, without a reserved slot when the host hides it.
- Retain the standard icon-to-text gap with or without a separately enabled snippet.
- Move the optional general-purpose Android snippet to its own repository and release cycle.

## 1.44.2 — consistent Android date spacing

- Match the native date icon gap to the standard property-label spacing, including larger text.
- Extend the optional snippet to editable Android native date and datetime fields, including older plugin versions.
- Use explicit icon geometry and replacement padding so applying both fixes does not stack their spacing.

## 1.44.1 — Android date fields

- Reserve leading space for the native calendar icon in Android date-range inputs.
- Add a separately enabled CSS snippet for the corresponding Obsidian note-property date and datetime issue.
- Check native date text and calendar-icon geometry across input values, locales and viewport widths.

## 1.44.0 — device-local search cache

- Store compressed search bodies in a dedicated IndexedDB database for each device and vault, outside normal vault-folder sync.
- Update persisted cache only on explicit search submission, pruning deleted and renamed paths across all cached buckets.
- Delete saved cache when persistence is turned off, and retain direct note scanning when storage is unavailable.
- Remove recognized legacy cache files on explicit search or cache deletion, without reading or replacing note files.
- Bound compressed cache payloads and commit bucket content and path metadata atomically.

## 1.43.11 — mobile toolbar compatibility

- Use the grid gap shorthand for narrow-screen toolbar groups while preserving their spacing.

## 1.43.10 — review fixes

- Replace unnecessary type assertions with typed DOM queries and enable their lint checks.
- Handle asynchronous preview failures and release reserved scroll space when a pending preview fails.
- Replace mobile `display: contents` with nested grids while preserving control positions and view dimensions.
- Refresh settings through the supported declarative API on newer Obsidian versions, retaining the legacy renderer for older versions.

## 1.43.9 — TypeScript source

- Move the plugin source to TypeScript with strict type checking and shared data types.
- Update the build, tests and source export while retaining the JavaScript install file, plugin ID and saved settings.
- Guard unavailable browser selections and optional popup callbacks.
- Align the manifest introduction with the community listing.

## 1.43.8 — creation date ranges

- Include notes with missing or invalid creation properties in date ranges using file creation time, matching the sorting behavior.

## 1.43.7 — date sorting defaults

- Start new views with the newest modified notes; retain saved sorting choices.
- Use file creation time for missing or invalid creation properties and sort these notes together with other notes.
- Update the introduction to describe the Google Keep-style card view, Boolean tag queries, filters and bulk actions.

## 1.43.6 — restore the full view area

- Override default ItemView padding within Keep View so the toolbar and cards retain their available space.
- Cover the host view structure and stylesheet reload order in layout regression checks.

## 1.43.5 — source and style cleanup

- Use ES Module imports in the source while retaining a self-contained CommonJS install file.
- Give tag-tree drag targets an explicit return type.
- Replace stylesheet `!important` declarations with scoped selectors and use equivalent grid gap declarations.
- Reuse a detached canvas for preview label measurements through Obsidian's DOM helper.

## 1.43.4 — creation date guidance

- Explain missing or invalid creation dates in a dialog once per app session, with a preview-first shortcut for notes whose filenames contain supported timestamps.
- Remember Don't show again and skip the guidance checks while disabled. The Creation date guidance setting restores it.
- Preserve the existing date sorting, filtering and import rules; guidance does not modify notes.

## 1.43.3 — initial card display

- Resume card rendering when a newly opened view is attached to the workspace. Cards appear without changing the sort order, including in folder-tree mode and when opening a hidden tab.

## 1.43.2 — validation and review improvements

- Validate saved settings and search-cache entries before use, and check API and data types during development.
- Make plugin settings searchable on Obsidian 1.13 and later, with the existing settings screen available on older versions.
- Replace broad hover selectors with scoped event handling and reduce CSS overrides while preserving desktop and mobile layouts.
- Add a manually started GitHub Actions build with provenance attestations for the three release assets.

## 1.43.1 — foreground note opening and display name

- Open tapped cards and newly created notes in the foreground, including when the host prefers background tabs. Await file opening, then reveal the same tab using public Obsidian APIs.
- Change the display name to Keep View Explorer; keep the plugin ID, settings and installation folder as `keep-view`.


## 1.43.0 — initial feature set

- Browse Markdown notes as cards or in a folder tree.
- Filter by tag expressions, folders, dates and literal full-text search.
- Create, select, move, trash and edit frontmatter tags in bulk.
- Export search-result paths and import creation timestamps from filenames.
- Support English and Japanese, with desktop and mobile layouts.

Earlier versions were local development builds.
