# Keep View Explorer development

## Responsibilities

- `main.ts`: Obsidian lifecycle, view state, event handling, rendering and modals.
- `lib/ui.ts`: shared UI primitives. Folder filtering and moving use the same row; folder and tag selection use the same checkbox. Keep these primitives free of vault mutations and view state.
- `lib/ja.json`, `lib/en.json` and `lib/i18n.ts`: editable Japanese/English UI messages and positional substitution, bundled with the plugin. The language selector shows English and Japanese; the initial choice follows Obsidian's public `getLanguage()` API. A manual choice persists until the host language changes, including across reloads. The last observed host language is saved with settings; a registered interval and focus listener check for live changes. Other app languages fall back to English. Message values are plain text, not markup or selectors.
- `lib/path-export.ts`: formats relative paths by default; device paths are added only by explicit modal opt-in.
- `lib/note-operations.ts`: note creation, tag changes/history, file/folder moves and deletion. Receives the Obsidian app explicitly and returns reports; no DOM or selection UI.
- `lib/note-opening.ts`: opens a note with explicit foreground activation, awaits file loading, then reveals that same tab. Shared by card taps and both creation buttons; does not change host preferences.
- `lib/card-search.ts`: literal substring matching over metadata-filtered candidates. Cancels superseded runs and delegates to the shared persistent index. A scan-only fallback supports callers without a storage adapter.
- `lib/search-index.ts`: lazy compressed search storage, exact substring matching, per-note invalidation and bounded bucket retention. Serializes searches across views and reuses the cache in read-only mode for restored queries.
- `lib/search-codec.ts`: versioned payloads using standard asynchronous Compression Streams, optional Unicode character dictionaries and legacy format decoding. No filesystem access or view state.
- `styles.css`: scoped component styles and responsive layout. Checkbox geometry is defined once under `.kv-dropdown-checkbox`, independent of theme checkmark dimensions.

Prefer extending an existing component over introducing another variant. Keep differences in data and callbacks, rather than copied markup or CSS. File operations must preserve folder identity, avoid overwriting unrelated data, and leave failed items available for retry.

## Build and verify

Use `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm lint`, `pnpm test` and `pnpm build`. Sources use TypeScript with strict checking and ES Modules. Shared data types live in `lib/types.ts`; values read from saved settings, frontmatter and search caches are still validated at runtime. Type assertions do not validate external data.

esbuild bundles `main.ts` into `dist/keep-view/main.js`, with only `obsidian` left external. The built CommonJS entry exports the plugin class. Users install the contents of `dist/keep-view`, not the source entry point. Desktop and mobile receive the same self-contained JavaScript file. TypeScript sources and test loaders are excluded from the install folder.

`pnpm exec playwright install chromium` installs the test browser. `pnpm test:ui` runs the browser integration suite. Set `PLAYWRIGHT_MODULE` when Playwright is installed elsewhere and optionally `PLAYWRIGHT_CHANNEL=msedge`. `KEEP_VIEW_LEGACY_CSS` loads the old snippet to check compatibility. Optional `KEEP_VIEW_HOST_CSS` and `KEEP_VIEW_THEME_CSS` load locally supplied app/theme styles; `KEEP_VIEW_PLUGIN_CSS` supports comparison with a previous release. The browser and VM harnesses compile the real source modules for explicit Obsidian mocks; pure modules also run directly in Node.js. Also verify the built entry point loads without local runtime dependencies.

Progress publishes only a settled prefix of the requested sort order. Tree branches wait for a complete top-level folder. Existing card grids append without remounting; obsolete paints must check the run and connected container before touching layouts.

Expanding large result trees defers card grids outside the viewport. Intersection observers enqueue nearby grids, mounting one per task; closing branches disconnects observers and invalidates queued work. Per-folder pagination is unchanged.

View state and cleanup are owned by `mountKeepView`. Any extraction must keep gesture, selection-history and scroll behavior covered by integration tests.

Metadata notifications coalesce and redraw only when the rendered note metadata changes. File-content and settings changes force a refresh. Hidden views defer redraws until visible; focus and visibility changes release stale drag and scroll interaction state.

Search trade-offs and the reproducible synthetic benchmark are documented in [docs/search-design.md](docs/search-design.md).
