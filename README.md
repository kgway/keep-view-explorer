# Keep View Explorer

Browse, filter, and organize notes in a Google Keep-style card view. Narrow results with Boolean tag queries, folders, dates, and full-text search, then move or retag notes in bulk.

![One workflow: 24 notes → project tags → exclude writing → search garden → select the two matches.](docs/media/demo-en.gif?v=initial-hold-3s)

One workflow: 24 notes → project tags → exclude writing → search garden → select the two matches.

- Markdown previews with checklists, images and links.
- Visual tag trees with AND, OR and NOT.
- Folder navigation and bulk tag edits or moves.

### Find the notes for a project

Start with the Markdown notes already in your vault. In the demo, select `#project`, add `NOT #writing`, then search for `garden`. Each condition narrows the same result set: 24 → 5 → 4 → 2 notes. Expand the Projects/Garden folder and select the two matching notes to prepare a bulk action.

### Get started

1. Run **Open Keep View Explorer** from the command palette, or use its ribbon icon.
2. Build a tag tree, choose folders or dates, and add full-text search. Tag filters include nested tags; you can also type an equivalent expression such as `#project AND NOT #writing`.
3. Select the matching notes with Ctrl/Command-click on desktop or a long press on mobile. Use the selection toolbar to edit frontmatter tags or move notes. Inline body tags are preserved.

Your notes remain ordinary Markdown files. English and Japanese interfaces; desktop and mobile layouts. No additional account, advertising or telemetry. See the README for trash behavior, undo limits, local search-cache storage and Markdown external resources.

[Detailed usage and data handling](#features)

[Cards with tasks, images and Markdown previews](docs/media/cards-en.png) · [Build tag conditions visually](docs/media/tags-en.png) · [Expand Projects/Garden while keeping the filters](docs/media/tree-en.png) · [Select notes and organize them together](docs/media/selection-en.png) · [Mobile layout](docs/media/mobile-en.png)

[日本語の詳しい説明](docs/README.ja.md)

## Features

- Cards with Markdown or source previews and adjustable density.
- AND, OR and NOT tag expressions, folder filters, untagged notes and date ranges.
- Literal substring search in note names and full Markdown text, including frontmatter. English matching ignores case; Japanese single characters and partial words are supported.
- Creation date, modification date and title sorting.
- Create notes, edit frontmatter tags, move notes or folders, and trash selected notes using Obsidian's configured deletion behavior.
- Export all matching note paths as JSON or text. Relative paths are the default.
- Import creation timestamps from filenames of Markdown notes migrated from Google Keep.
- English and Japanese interfaces, with desktop and mobile layouts.

## Installation

Requires **Obsidian 1.8.7 or later**. Install [Keep View Explorer from the community directory](https://community.obsidian.md/plugins/keep-view), or open **Settings → Community plugins → Browse** and search for **Keep View Explorer**. Enable the plugin after installation. New listings can take up to 24 hours to appear in the app search.

For manual installation, use the built release assets:

1. Download `main.js`, `manifest.json` and `styles.css` from the GitHub release, or build them locally.
2. Place them in the vault's configured plugin directory under `keep-view` (normally `.obsidian/plugins/keep-view/`).
3. Enable community plugins and Keep View Explorer in Obsidian settings.
4. Open Keep View Explorer using its ribbon icon or the **Open Keep View Explorer** command.

When updating manually, disable the plugin, replace these three files, then enable it again. Preserve `data.json`. The repository's source `main.ts` uses TypeScript and local modules; install the release assets or the files in `dist/keep-view/`.

## Usage

Use the toolbar to combine tags, folders, date ranges and full-text search. For example, `#work AND NOT #done AND (#important OR #urgent)` matches work notes that are unfinished and important or urgent. Full-text search starts only when requested; it does not scan the vault at startup.

New views start with modification time, newest first. Saved sorting choices are retained. Creation dates come from a frontmatter property, `created` by default. Missing or invalid creation dates use file creation time and sort together with notes that have a valid property, in the selected direction. Equal times use the path as a tie-breaker. Creation-date ranges use the same file creation time fallback. No property is changed. Modification dates use file modification time. Date ranges use the device timezone.

When creation dates are in use, a dialog explains missing or invalid values once per app session for each date property. It shows the counts and, when a supported timestamp filename is available, offers the import preview. The dialog does not change notes. Check Don't show again and close it to save that choice across reloads and skip the extra guidance checks. Turn Creation date guidance back on in settings to restore it. Ordinary card filtering and manual date import remain available.

Click or tap a card to open its note. Long-press to select it; on desktop, Ctrl/Command-click or Space on a focused card also selects it. The selection toolbar lets you draft tag edits and a destination folder, then apply them. Inline body tags are preserved. Folder selection moves the entire folder, including hidden notes, attachments and empty folders. File collisions receive numbered names; folder collisions and moves into their own descendants are rejected.

Trash asks for confirmation by default. Undo/redo covers filters, selection and tag edits; moving and deleting are outside that history. Test file operations on synthetic notes before using them on important data.

Export includes every matching note, including cards that have not been rendered yet. Absolute device paths are included only when explicitly selected and supported by the device. Exported JSON also includes the vault name and filter conditions; review exports before sharing them.

For migration from Google Keep, first import Markdown notes with Obsidian's [Importer](https://help.obsidian.md/import/google-keep). The optional timestamp tool recognizes date-shaped filenames and previews changes before applying them. It preserves existing properties, note bodies and filenames; Obsidian's YAML writer may reformat frontmatter.

## Data and privacy

On affected Android versions, note-property date icons may overlap the text. The plugin's date-range fields include a scoped fix; an optional property-field workaround is described in [Android date fields](docs/mobile-date-compatibility.md).

Keep View Explorer adds no accounts, advertising or telemetry. It does not send notes or search queries to external services. Note operations use the Obsidian vault API; the optional search cache uses device-local IndexedDB.

Settings and view conditions are saved in the plugin's `data.json`. **Save search cache on this device** is enabled by default. It stores compressed, **unencrypted note text**, vault-relative paths and update metadata in a dedicated, vault-specific IndexedDB database on each device, outside normal vault-folder sync. The database name uses a random identifier stored through Obsidian's vault-local storage API, without the vault name or absolute path. This storage is not an encryption or isolation boundary against other plugins.

Only pressing **Search** (or submitting the search form) updates the persistent cache. Startup, note events, sorting and filter changes do not update it. Only search candidates are indexed; the next explicit search also removes cached text for deleted or renamed paths, including paths outside the current filters. Until then, that old text can remain stored. Cache payload is limited to eight compressed buckets of up to 8 MiB each; path metadata and database overhead are additional. Memory retention is bounded separately.

Turning this setting off deletes saved search-cache data on the device where you perform that action and uses direct note scanning. **Delete search cache** removes stored and retained cache data without changing notes or settings, and leaves rebuilding to the next explicit search. A setting change received through sync does not erase another device's database at startup; clear cache explicitly on each device when needed. If IndexedDB is unavailable or a write fails, searches still return source-note results; no cache files are written into the vault as a fallback. Uninstalling the plugin is not a substitute for clearing its device-local cache first.

Old `search-cache-v1` files are no longer read. Recognized old bucket files are removed at the next explicit cached search, when turning cache storage off, or through **Delete search cache**. Other files are preserved. Each device must handle its local database; old files on synced devices and in backups may remain until those copies are cleaned up.

Markdown previews use Obsidian's renderer. External images or other remote resources referenced by your notes may cause network requests when rendered.

## Development

Use Node.js 24 and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile
pnpm release:prepare
pnpm exec playwright install chromium
pnpm test:ui
```

Build assets are generated in `dist/keep-view/`. The only external runtime module is `obsidian`; source modules are bundled into readable CommonJS JavaScript. Development packages are not shipped.

See [architecture](ARCHITECTURE.md) and [contributing](CONTRIBUTING.md). UI text is editable in [Japanese](lib/ja.json) and [English](lib/en.json); keep keys and numbered placeholders intact, then rebuild.

The interface initially follows Obsidian's language. A manual language choice remains until Obsidian's language changes, including across reloads. Other host languages use English.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md). Keep View Explorer is an independent project and is not affiliated with Google or Obsidian.

The installed JavaScript retains the MIT copyright and permission notice. README and license documents are available in the source repository; installation requires only the three runtime files.
