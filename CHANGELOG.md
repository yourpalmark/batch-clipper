# Changelog

## [Unreleased]

### Added
- Background service worker (`background.js`) — routes `obsidian://open` via `chrome.tabs.update` (no Chrome protocol-handler dialog)
- Asset download progress bar (teal, shows `Assets: N / total` for 2+ assets)
- `filenameFromUrl` utility for robust filename extraction from any URL encoding

### Changed (breaking)
- Replaced dual folder pickers (clip dir + asset dir) with Obsidian vault integration:
  - Pick vault root once via File System Access API; persisted across sessions
  - Choose clip subfolder from a dropdown (auto-populated from vault dirs) or type a name
  - Asset downloading is now **off by default**; enable via checkbox to download alongside clipped pages
  - Asset subfolder defaults to `assets/` inside the clip subfolder (e.g. `raw/assets/<Title>/`)
  - Markdown asset links are relative so they resolve correctly in Obsidian
  - After clipping, the last clipped file is auto-opened in Obsidian via `obsidian://open`
- `clipPage()` signature changed: `clipDir`/`assetDir` handles replaced by `vaultDir` handle + `clipSubfolder` string + `downloadAssets` boolean + `assetSubfolder` string
- Replaced placeholder icon with proper download arrow icon (purple `#a78bfa`, matching Asset Clipper's original style)
- Added `generate_icons.js` for reproducible icon generation via sharp
- Asset URL rewriting now uses filename-based matching (handles all encoding variants, Confluence tables, narrow no-break spaces)
- `encodeFilenameForMarkdown` fully normalizes mixed/partial URL encoding before re-encoding
- Content script detects Confluence page ID via 5 fallback strategies (meta tag, data attributes, URL params, canonical link, entity ID)
- `clipPage` resolves `/display/` Confluence URLs via REST API before falling back to direct fetch (fixes CORS errors)
- Depth selector replaced with numeric input (any depth, blank = all)
- Clip subfolder and asset subfolder use dropdown + new-name input pickers (consistent with Vault UX)

## [1.0.0] - 2026-05-13

### Added
- Initial release: batch-clip multiple pages to an Obsidian vault
- Core pipeline: fetch → preprocess → defuddle → Markdown → asset download
- Confluence REST API integration for child page discovery
- Inline comment marker fix (unwraps spans before extraction)
- Asset scanning, authenticated downloading, and URL rewriting
- Frontmatter matching Obsidian Web Clipper default template
- File System Access API for writing directly to vault folder
- Popup UI: folder picker, depth control, progress display, cancel
- 47 Jest unit tests across all lib modules
