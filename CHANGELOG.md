# Changelog

## [Unreleased]

### Changed
- Replaced placeholder icon with proper download arrow icon (purple `#a78bfa`, matching Asset Clipper's original style)
- Added `generate_icons.js` for reproducible icon generation via sharp

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
