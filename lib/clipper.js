// lib/clipper.js
// Core clipping pipeline: fetch -> preprocess -> extract -> markdown -> assets -> write.
//
// For the active tab, the popup passes liveHtml from the content script — this is the
// already-rendered DOM with JS-rendered content (draw.io, Gliffy, etc.) already present.
// For child pages (batch), we fetch the rendered HTML directly using credentials.
// REST API is used only for child page discovery and resolving page IDs.

/**
 * Pre-process HTML to fix known content-stripping issues before extraction.
 * - Unwraps Confluence inline comment markers (preserves the commented text)
 * - Strips placeholder icon images from Confluence view-file-macro wrappers
 * - Rescues images inside heading elements (defuddle strips h1 with contents)
 * - Replaces draw.io macro scripts with <img> pointing to the attachment PNG
 * @param {Document} doc - parsed DOM document to mutate in-place
 * @param {string} [baseOrigin] - origin for resolving relative draw.io PNG URLs (e.g. "https://confluence.example.com")
 */
function preprocessHtml(doc, baseOrigin = '') {
  // Confluence inline comment markers — the wrapper gets stripped by defuddle,
  // taking the text content with it. Unwrap: keep children, remove the span.
  const commentSelectors = [
    '.inline-comment-marker',
    '[data-inline-comment]',
    'ac\\:inline-comment-marker',
    'span[data-ref][class*="comment"]',
  ];

  for (const selector of commentSelectors) {
    try {
      for (const el of doc.querySelectorAll(selector)) {
        el.replaceWith(...el.childNodes);
      }
    } catch {
      // querySelectorAll may throw on invalid selectors in some browsers
    }
  }

  // Confluence image wrappers: <span class="confluence-embedded-file-wrapper">
  // Also strip CDN placeholder icons (/s/ paths) that are decorative, not content.
  try {
    for (const wrapper of doc.querySelectorAll('.confluence-embedded-file-wrapper')) {
      const img = wrapper.querySelector('img');
      if (img) {
        const src = img.getAttribute('src') || '';
        if (src.startsWith('/s/') || src.includes('/download/resources/')) {
          wrapper.remove();
        } else {
          wrapper.replaceWith(img);
        }
      } else {
        wrapper.remove();
      }
    }
  } catch { /* ignore */ }

  // Confluence section headings: images embedded inside <h1>/<h2>/etc. get dropped
  // when defuddle's standardizeHeadings transforms/removes heading elements.
  // Rescue: move any images inside headings to just after the heading element.
  try {
    for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const imgs = heading.querySelectorAll('img');
      if (!imgs.length) continue;
      for (const img of imgs) {
        if (heading.parentNode) {
          heading.parentNode.insertBefore(img, heading.nextSibling);
        }
      }
    }
  } catch { /* ignore */ }

  // draw.io macros: in batch mode (server-fetched HTML), the draw.io JS has not run
  // so there is no rendered SVG — only the macro container with its <script>.
  // Extract the imageUrl from the script (same logic as content.js) and insert an <img>.
  // For liveHtml (active tab), content.js already replaced SVGs before serializing,
  // so this pass is a no-op (no unprocessed macro scripts remain).
  try {
    for (const macro of doc.querySelectorAll('[data-macro-name="drawio"], [data-macro-name="drawio-sketch"]')) {
      const scriptEl = macro.querySelector('script');
      if (!scriptEl) continue;
      const text = scriptEl.textContent || '';

      // Extract PNG attachment URL
      const imgMatch = text.match(/imageUrl\s*=\s*''\s*\+\s*'([^']+)'\s*\+\s*'([^']*)'/);
      if (!imgMatch) continue;
      const pngUrl = baseOrigin + imgMatch[1] + imgMatch[2];

      // Find or create the container — in batch HTML there's no rendered SVG yet
      const containerIdMatch = text.match(/getElementById\(['"]([^'"]+)['"]\)/);
      const container = containerIdMatch && doc.getElementById(containerIdMatch[1]);
      const svg = container && container.querySelector('svg');

      const img = doc.createElement('img');
      img.src = pngUrl;
      img.alt = imgMatch[1].split('/').pop().replace('.png', '');
      img.style.maxWidth = '100%';

      if (svg) {
        svg.replaceWith(img);
      } else if (container) {
        container.appendChild(img);
      } else {
        // No container found — insert after the macro div
        macro.parentNode && macro.parentNode.insertBefore(img, macro.nextSibling);
      }
    }
  } catch { /* ignore */ }

}

/**
 * Clip a single page: fetch, extract content, convert to markdown, optionally download assets.
 *
 * Directory layout (Option B vault integration):
 *   <vaultDir>/<clipSubfolder>/<Title>.md
 *   <vaultDir>/<clipSubfolder>/<assetSubfolder>/<Title>/<image.png>   (when downloadAssets=true)
 *
 * Asset references in markdown are relative: `<assetSubfolder>/<Title>/<image.png>`
 * so they resolve correctly from any Obsidian vault that has the clip subfolder open.
 *
 * @param {object} params
 * @param {string} params.url - page URL
 * @param {string} [params.liveHtml] - pre-fetched live HTML from the active tab's content script
 *   (captures JS-rendered content like draw.io). If provided, skips the fetch step.
 * @param {string} [params.confluencePageId] - if known, used to build the canonical viewpage URL
 * @param {string} [params.confluenceBaseUrl] - Confluence origin
 * @param {FileSystemDirectoryHandle} params.vaultDir - vault root directory handle
 * @param {string} params.clipSubfolder - subfolder name inside vault for .md files (e.g. "raw")
 * @param {boolean} [params.downloadAssets=false] - whether to download page assets
 * @param {string} [params.assetSubfolder="assets"] - subfolder name inside clipSubfolder for assets
 * @param {() => boolean} params.isCancelled - cancellation check
 * @param {(done: number, total: number) => void} [params.onAssetProgress] - asset download progress callback
 * @returns {Promise<{title: string, filename: string, assetCount: number, error: string|null}>}
 */
async function clipPage({
  url,
  liveHtml,
  confluencePageId,
  confluenceBaseUrl,
  vaultDir,
  clipSubfolder,
  downloadAssets = false,
  assetSubfolder = 'assets',
  isCancelled,
  onAssetProgress,
}) {
  try {
    if (isCancelled()) return { title: '', filename: '', assetCount: 0, error: 'cancelled' };

    let title, contentHtml, pageUrl;

    // If this is a Confluence URL but we don't have a pageId yet, try to resolve it
    let resolvedPageId = confluencePageId;
    if (!resolvedPageId && confluenceBaseUrl) {
      try { resolvedPageId = await resolvePageId(confluenceBaseUrl, url); } catch { /* ignore */ }
    }

    // Determine the canonical page URL (used for asset resolution and frontmatter).
    // For Confluence /display/ URLs, resolve to the viewpage.action form.
    let fetchUrl = url;
    if (resolvedPageId && confluenceBaseUrl) {
      fetchUrl = `${confluenceBaseUrl}/pages/viewpage.action?pageId=${resolvedPageId}`;
    }

    // --- HTML source ---
    // Priority: liveHtml (from content script, has JS-rendered content like draw.io)
    //           → fetch (authenticated, for child pages and non-active-tab pages)
    let html;
    if (liveHtml) {
      // Use the live rendered DOM passed in from the active tab's content script.
      // This is the same HTML the browser already rendered, so draw.io SVGs etc. are present.
      html = liveHtml;
    } else {
      // Fetch the rendered HTML directly. Credentials are included so authenticated
      // Confluence pages load fully.
      const resp = await fetch(fetchUrl, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${fetchUrl}`);
      html = await resp.text();
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Preprocess before defuddle strips annotation wrappers, macro icons, etc.
    preprocessHtml(doc, confluenceBaseUrl || '');

    // defuddle extracts main content and title for generic pages.
    // For Confluence, we use a precise contentSelector and disable removeLowScoring:
    // defuddle's content scorer penalizes image-heavy/text-light blocks (score formula
    // subtracts points per image relative to word count), stripping real content screenshots.
    // With a known selector we don't need scoring heuristics — just disable that pass.
    const Defuddle = globalThis.Defuddle;
    const defuddleOptions = { url: fetchUrl };
    if (confluenceBaseUrl) {
      defuddleOptions.contentSelector = '#main-content, .wiki-content, #content';
    }
    const defuddled = new Defuddle(doc, defuddleOptions).parse();
    title = defuddled.title || doc.title || 'Untitled';
    contentHtml = defuddled.content || '';
    pageUrl = fetchUrl;

    if (isCancelled()) return { title, filename: '', assetCount: 0, error: 'cancelled' };

    const safeTitle = sanitiseTitle(title);

    // --- Resolve clip directory inside vault ---
    const clipDir = await getOrCreateDir(vaultDir, [clipSubfolder]);

    // --- Scan for assets ---
    const assets = scanAssets(contentHtml, pageUrl);

    // --- Convert HTML to markdown ---
    const createMarkdownContent = globalThis.createMarkdownContent;
    let markdown = createMarkdownContent(contentHtml, pageUrl);

    // --- Fix Obsidian rendering issues ---
    // Escape $$ outside code blocks — Obsidian treats $$ as LaTeX math delimiters,
    // so unmatched $$ in plain text (e.g. passcodes like "B2$$yENq") break page rendering.
    markdown = escapeLatexDelimiters(markdown);

    // --- Rewrite asset URLs to local relative paths (only when downloading) ---
    // Links will be `<assetSubfolder>/<Title>/image.png` — relative from within clipSubfolder.
    if (downloadAssets && assets.length > 0) {
      const rewriteMap = buildRewriteMap(assets, safeTitle, assetSubfolder);
      markdown = rewriteMarkdownUrls(markdown, rewriteMap);
    }

    // --- Generate frontmatter ---
    const frontmatter = generateFrontmatter({ title, url: pageUrl });

    // --- Assemble final file content ---
    const fileContent = frontmatter + '\n' + markdown;
    const filename = safeTitle + '.md';

    // --- Write the markdown file ---
    await writeTextFile(fileContent, filename, clipDir);

    // --- Download assets (optional) ---
    let assetCount = 0;
    if (downloadAssets && assets.length > 0) {
      // Normalize Unicode spaces in the title used as subfolder name so it matches wikilinks.
      const normalTitle = safeTitle.replace(/[\u00A0\u202F\u2009\u2007\u2008\u200A\u205F\u3000]/g, ' ');
      // Assets go inside clip dir: <clipSubfolder>/<assetSubfolder>/<Title>/
      const assetRootDir = await getOrCreateDir(clipDir, [assetSubfolder]);
      let assetSubDir;
      try {
        assetSubDir = await getOrCreateDir(assetRootDir, [normalTitle]);
      } catch {
        assetSubDir = assetRootDir;
      }

      const total = assets.length;
      if (onAssetProgress) onAssetProgress(0, total);

      for (const asset of assets) {
        if (isCancelled()) break;
        try {
          // Normalize Unicode spaces in filename so it matches the wikilink path
          const normalFilename = asset.filename.replace(/[\u00A0\u202F\u2009\u2007\u2008\u200A\u205F\u3000]/g, ' ');
          await fetchAndWrite(asset.url, normalFilename, assetSubDir);
          assetCount++;
        } catch (err) {
          console.warn(`Batch Clipper: failed to download asset ${asset.url}`, err);
        }
        if (onAssetProgress) onAssetProgress(assetCount, total);
      }
    }

    return { title, filename, assetCount, error: null };
  } catch (err) {
    return {
      title: url,
      filename: '',
      assetCount: 0,
      error: err.message || String(err),
    };
  }
}

if (typeof module !== 'undefined') {
  module.exports = { clipPage, preprocessHtml };
}
