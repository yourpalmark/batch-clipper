# Batch Clipper

Chrome extension for batch-clipping web pages to markdown with authenticated asset downloading.

Replaces **Obsidian Web Clipper + Asset Clipper + Asset Swapper** in one tool.

## What it does

1. **Clips any web page** to markdown using [defuddle](https://github.com/nicholasgasior/defuddle) — the same content extraction engine as Obsidian Web Clipper.
2. **Downloads all assets** (images, PDFs, videos) using your browser session cookies — works on authenticated pages (Confluence, intranets, etc.).
3. **Rewrites URLs** in the markdown to point to local files — no broken images.
4. **Confluence support** — auto-detects Confluence pages and discovers child pages for batch clipping.
5. **Fixes inline comment stripping** — pre-processes Confluence HTML so text wrapped in inline comment markers isn't silently dropped during extraction.

## Quick start

```bash
npm install
npm run build
```

Then load the `batch-clipper/` folder as an unpacked Chrome extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

## Usage

1. Navigate to any web page (or a Confluence parent page)
2. Click the Batch Clipper extension icon
3. Select a destination folder (markdown files go here)
4. Optionally check **Include child pages** (Confluence only) and pick a depth
5. Click **Clip**

Output structure:
```
your-folder/
├── Page Title.md
├── Child Page.md
└── assets/
    ├── Page Title/
    │   ├── diagram.png
    │   └── photo.jpg
    └── Child Page/
        └── screenshot.png
```

## Frontmatter

Generated frontmatter matches Obsidian Web Clipper's default template:

```yaml
---
title: "Page Title"
source: "https://example.com/page"
author: "Author Name"
published: "2025-01-15"
created: 2025-05-13T12:00:00Z
description: "Page description"
tags: clippings
---
```

## Architecture

```
batch-clipper/
├── manifest.json          # Manifest V3
├── content.js             # Injected: detects page type, extracts info
├── popup.html/css/js      # UI: folder picker, depth, progress, cancel
├── lib/
│   ├── clipper.js         # Core pipeline: fetch → preprocess → defuddle → markdown → assets
│   ├── assets.js          # Asset scanning, downloading, URL rewriting
│   ├── confluence.js      # Child page discovery via REST API
│   ├── frontmatter.js     # YAML frontmatter generation
│   ├── fs-utils.js        # File System Access API helpers
│   └── utils.js           # Shared utilities (sanitise, decode, encode)
├── scripts/
│   └── build.js           # Bundles defuddle for the extension
├── tests/                 # Jest tests for all lib modules
└── defuddle.bundle.js     # Built artifact (not committed)
```

## Testing

```bash
npx jest
```

## How the inline comment fix works

Confluence wraps inline-commented text in `<span class="inline-comment-marker">`. Content extractors like defuddle strip these as annotation cruft — taking the text content with them. Batch Clipper pre-processes the HTML before extraction, unwrapping the marker spans while preserving their text content.

## License

MIT
