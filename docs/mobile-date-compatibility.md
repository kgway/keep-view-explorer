# Android date fields

On affected Android setups, a native calendar icon is visible in Obsidian date inputs. Obsidian positions that icon at the leading edge, but its normal leading-padding rule excludes Android and iOS. Our browser tests reproduce the resulting overlap in both note properties and plugin date inputs. The exact Obsidian or WebView update that first exposed the issue has not been established.

The issue was reported with Obsidian 1.14.4 and Android WebView 154, including a new vault with restricted mode and no theme or snippets. The report also covers datetime properties. See the [Obsidian bug report](https://forum.obsidian.md/t/calendar-icon-overlaps-date-property/119421).

Keep View Explorer includes a scoped fix in its own editable Android date-range inputs. The native icon participates in normal layout, with an eight-pixel gap by default, matching the standard spacing between a property icon and its name. The gap follows Obsidian's `--size-4-2` variable when a theme changes it. The native date picker, date filtering and input widths remain unchanged. The plugin does not style note properties globally.

## Optional native-field workaround

To fix overlapping date and datetime icons in note properties, older Keep View versions and other editable native inputs while waiting for a host fix:

The separately maintained [Android date fix](https://github.com/kgway/obsidian-android-date-fix) repository provides the optional `android-date-fix.css` snippet and its own installation instructions and MIT license. It is independent of this plugin's development and releases. If replacing the earlier `android-date-properties.css`, disable the old copy before enabling the new file.

The snippet covers editable Android HTML `date` and `datetime-local` inputs throughout Obsidian. It does not cover arbitrary custom calendar widgets, plain text dates, disabled or read-only controls. iOS and desktop are unaffected. It does not read or modify notes, property values, cache data or settings.

The plugin and standalone snippet both put the icon in normal layout rather than reserving a fixed icon slot. Applying both does not double the gap. If the host hides the icon with `display: none`, there is no leftover reserved icon space. Browser tests check corrected host padding, right-aligned icons, normal-flow icons and hidden icons. This covers those changes without requiring automatic detection of a host fix; it cannot guarantee compatibility with arbitrary future native-control changes.

Obsidian documents snippet installation in its [CSS snippets guide](https://help.obsidian.md/snippets). The plugin fix is always included in the plugin stylesheet and requires no separate snippet.
