# Batch Clipper

A Chrome extension that clips web pages — and entire page trees — to durable Markdown files in your Obsidian vault, with authenticated asset downloading built in.

> Think of it as Obsidian Web Clipper with batch support and local asset saving — no extra plugins or manual steps required.

---

## What it does

- **Clips any web page** to Markdown using [defuddle](https://github.com/kepano/defuddle) — the same content extraction engine as Obsidian Web Clipper
- **Batch-clips Confluence page trees** — discovers and clips an entire hierarchy in one click
- **Downloads assets** using your active browser session — works on authenticated pages (Confluence, intranets, corporate wikis)
- **Rewrites asset URLs** in Markdown to local Obsidian wikilinks — no broken images or missing attachments
- **Writes directly to your vault** via the File System Access API — no downloads folder, no manual moving
- **Opens the last clipped note** in Obsidian automatically when done

---

## Compared to Obsidian Web Clipper

| Feature | Obsidian Web Clipper | Batch Clipper |
|---|---|---|
| Clip current page | ✅ | ✅ |
| Matching frontmatter format | ✅ | ✅ |
| Custom templates | ✅ | — |
| Text selection clipping | ✅ | — |
| Batch clip (Confluence trees) | — | ✅ |
| Download assets locally | — | ✅ |
| Rewrite URLs to local wikilinks | — | ✅ |
| Works behind authentication | — | ✅ |
| Write directly to vault folder | — | ✅ |

---

## Installation

Batch Clipper is not yet published to the Chrome Web Store. To install it manually:

```bash
git clone https://github.com/yourpalmark/batch-clipper
cd batch-clipper
npm install
npm run build
```

Then load it as an unpacked extension:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `batch-clipper` folder

---

## Quick start

1. Navigate to any web page (or a Confluence parent page)
2. Click the Batch Clipper icon in your toolbar
3. Click **Browse…** and select your Obsidian vault root
4. Click **Set…** to choose a subfolder inside the vault for clipped notes (e.g. `Clippings`)
5. *(Optional)* Check **Download assets** and set an assets subfolder (e.g. `assets`)
6. *(Confluence only)* Check **Include child pages** and set a depth limit
7. Click **Clip**

---

## Output

Files are written directly into your vault:

```
vault/
└── Clippings/
    ├── Page Title.md
    ├── Child Page.md
    └── assets/
        ├── Page Title/
        │   ├── diagram.png
        │   └── report.xlsx
        └── Child Page/
            └── screenshot.png
```

Asset links in the Markdown use Obsidian wikilink syntax and resolve correctly inside your vault:

```markdown
![[assets/Page Title/diagram.png]]
![[assets/Page Title/report.xlsx]]
```

---

## Frontmatter

Generated frontmatter matches Obsidian Web Clipper's default template format, so clipped notes look and behave the same:

```yaml
---
title: "Page Title"
source: "https://example.com/page"
author: "Author Name"
published: "2025-01-15"
created: 2025-05-13T12:00:00Z
description: "Page description"
tags:
  - clippings
---
```

---

## Supported asset types

| Category | Extensions |
|---|---|
| Images | `png` `jpg` `jpeg` `gif` `webp` `svg` `ico` `bmp` `tiff` `avif` `heic` |
| Documents | `pdf` `doc` `docx` `xls` `xlsx` `ppt` `pptx` `odt` `ods` `odp` `csv` `txt` `rtf` `eml` |
| Video | `mp4` `webm` `mov` `avi` `mkv` `m4v` |
| Audio | `mp3` `wav` `ogg` `m4a` `flac` `aac` |
| Archives | `zip` `tar` `gz` `7z` |
| Code | `py` `js` `ts` `sh` `r` `ipynb` `sql` |

Only assets in the **main content area** are downloaded — icons, navigation images, and decorative elements are excluded. Small images (explicit width below 50 px) are skipped as likely UI chrome.

---

## Confluence support

Batch Clipper has deep Confluence integration:

- **Auto-detection** — recognises Confluence pages from DOM markers and URL patterns (classic, wiki-style `/display/`, and Confluence Cloud)
- **Child page discovery** — fetches the full page tree via the Confluence REST API with live progress feedback
- **Depth control** — clip just immediate children, N levels deep, or the entire tree
- **Attachment downloading** — downloads page attachments (spreadsheets, PDFs, scripts) using your active session and rewrites links to local wikilinks
- **Inline comment preservation** — unwraps Confluence inline comment markers before extraction so commented text is never silently dropped

---

## Development

```bash
npm install      # install dependencies
npm run build    # bundle defuddle (required before loading unpacked)
npm test         # run unit tests
```

To regenerate icons:

```bash
node generate_icons.js
```

### Project structure

```
batch-clipper/
├── manifest.json          # Manifest V3
├── background.js          # Service worker: routes obsidian:// protocol opens
├── content.js             # Injected: detects page type, extracts page info
├── popup.html/css/js      # UI: vault picker, subfolder config, progress, cancel
├── lib/
│   ├── clipper.js         # Core pipeline: fetch → preprocess → defuddle → markdown → assets
│   ├── assets.js          # Asset scanning, downloading, URL rewriting
│   ├── confluence.js      # Child page discovery via REST API
│   ├── frontmatter.js     # YAML frontmatter generation
│   ├── fs-utils.js        # File System Access API helpers
│   └── utils.js           # Shared utilities (sanitise, decode, encode)
├── scripts/
│   └── build.js           # Bundles defuddle for the extension
└── tests/                 # Jest unit tests for all lib modules
```

### Run tests

```bash
npm test
# or in watch mode during development:
npm run test:watch
```

---

## Third-party libraries

- [defuddle](https://github.com/kepano/defuddle) for content extraction and Markdown conversion

---

## License

MIT
