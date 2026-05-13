// lib/clipper.js
// Core clipping pipeline: fetch -> preprocess -> extract -> markdown -> assets -> write.
// Works with both Confluence pages (via REST API) and generic web pages (via defuddle).

/**
 * Pre-process HTML to fix known content-stripping issues before extraction.
 * - Unwraps Confluence inline comment markers (preserves the commented text)
 * - Strips placeholder icon images from Confluence view-file-macro wrappers
 * @param {Document} doc - parsed DOM document to mutate in-place
 */
function preprocessHtml(doc) {
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

  // Confluence view-file-macro: strip the decorative placeholder icon (spreadsheet/pdf/doc thumbnail).
  // These are CDN UI images served from /s/ paths, not actual attachment content.
  // Real attachment images (from /download/attachments/) are preserved.
  try {
    for (const wrapper of doc.querySelectorAll('.confluence-embedded-file-wrapper')) {
      for (const img of wrapper.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        // Only remove CDN placeholder icons — paths starting with /s/ are Confluence static resources
        if (src.startsWith('/s/') || src.includes('/download/resources/')) {
          img.remove();
        }
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
 * @param {string} [params.confluencePageId] - if known, skips defuddle and uses Confluence REST API
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

    if (resolvedPageId && confluenceBaseUrl) {
      // --- Confluence path: REST API for clean content ---
      const page = await fetchConfluencePageBody(confluenceBaseUrl, resolvedPageId);
      if (!page) throw new Error(`Could not fetch Confluence page ${resolvedPageId}`);
      title = page.title;
      // Preprocess the REST HTML (strips view-file-macro icons, inline comment markers, etc.)
      const parser = new DOMParser();
      const confluenceDoc = parser.parseFromString(page.bodyHtml, 'text/html');
      preprocessHtml(confluenceDoc);
      // Resolve relative URLs (images, links) to absolute using the Confluence base URL.
      // createMarkdownContent doesn't resolve URLs itself — without this, image src like
      // /download/attachments/... remain relative and may not scan/rewrite correctly.
      for (const el of confluenceDoc.querySelectorAll('[src]')) {
        const src = el.getAttribute('src');
        if (src && !src.startsWith('http') && !src.startsWith('data:')) {
          try { el.setAttribute('src', new URL(src, confluenceBaseUrl).href); } catch { /* ignore */ }
        }
      }
      for (const el of confluenceDoc.querySelectorAll('[href]')) {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
          try { el.setAttribute('href', new URL(href, confluenceBaseUrl).href); } catch { /* ignore */ }
        }
      }
      contentHtml = confluenceDoc.body.innerHTML;
      pageUrl = page.url;
    } else {
      // --- Generic path: fetch HTML + defuddle extraction ---
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const html = await resp.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Fix inline comment markers and view-file-macro icons before defuddle strips them
      preprocessHtml(doc);

      // defuddle extracts main content (loaded via bundle)
      const Defuddle = globalThis.Defuddle;
      const defuddled = new Defuddle(doc, { url }).parse();
      title = defuddled.title || doc.title || 'Untitled';
      contentHtml = defuddled.content || '';
      pageUrl = url;
    }

    if (isCancelled()) return { title, filename: '', assetCount: 0, error: 'cancelled' };

    const safeTitle = sanitiseTitle(title);

    // --- Resolve clip directory inside vault ---
    const clipDir = await getOrCreateDir(vaultDir, [clipSubfolder]);

    // --- Scan for assets in the content HTML ---
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
