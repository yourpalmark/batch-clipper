// lib/clipper.js
// Core clipping pipeline: fetch -> preprocess -> extract -> markdown -> assets -> write.
// Works with both Confluence pages (via REST API) and generic web pages (via defuddle).

/**
 * Pre-process HTML to fix known content-stripping issues before extraction.
 * - Unwraps Confluence inline comment markers (preserves the commented text)
 * - Unwraps other annotation wrappers that hide content from extractors
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
}

/**
 * Clip a single page: fetch, extract content, convert to markdown, download assets.
 *
 * @param {object} params
 * @param {string} params.url - page URL
 * @param {string} [params.confluencePageId] - if known, skips defuddle and uses Confluence REST API
 * @param {string} [params.confluenceBaseUrl] - Confluence origin
 * @param {FileSystemDirectoryHandle} params.clipDir - directory for .md files
 * @param {FileSystemDirectoryHandle} params.assetDir - directory for assets
 * @param {() => boolean} params.isCancelled - cancellation check
 * @returns {Promise<{title: string, filename: string, assetCount: number, error: string|null}>}
 */
async function clipPage({
  url,
  confluencePageId,
  confluenceBaseUrl,
  clipDir,
  assetDir,
  isCancelled,
}) {
  try {
    if (isCancelled()) return { title: '', filename: '', assetCount: 0, error: 'cancelled' };

    let title, contentHtml, pageUrl;

    if (confluencePageId && confluenceBaseUrl) {
      // --- Confluence path: REST API for clean content ---
      const page = await fetchConfluencePageBody(confluenceBaseUrl, confluencePageId);
      if (!page) throw new Error(`Could not fetch Confluence page ${confluencePageId}`);
      title = page.title;
      contentHtml = page.bodyHtml;
      pageUrl = page.url;
    } else {
      // --- Generic path: fetch HTML + defuddle extraction ---
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
      const html = await resp.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      // Fix inline comment markers before defuddle strips them
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

    // --- Scan for assets in the content HTML ---
    const assets = scanAssets(contentHtml, pageUrl);

    // --- Convert HTML to markdown ---
    const createMarkdownContent = globalThis.createMarkdownContent;
    let markdown = createMarkdownContent(contentHtml, pageUrl);

    // --- Build asset rewrite map and rewrite URLs in markdown ---
    const rewriteMap = buildRewriteMap(assets, safeTitle, 'assets');
    markdown = rewriteMarkdownUrls(markdown, rewriteMap);

    // --- Generate frontmatter ---
    const frontmatter = generateFrontmatter({ title, url: pageUrl });

    // --- Assemble final file content ---
    const fileContent = frontmatter + '\n' + markdown;
    const filename = safeTitle + '.md';

    // --- Write the markdown file ---
    await writeTextFile(fileContent, filename, clipDir);

    // --- Download assets ---
    let assetCount = 0;
    if (assets.length > 0) {
      let assetSubDir;
      try {
        assetSubDir = await getOrCreateDir(assetDir, [safeTitle]);
      } catch {
        // If subfolder creation fails, write assets to the root asset dir
        assetSubDir = assetDir;
      }

      for (const asset of assets) {
        if (isCancelled()) break;
        try {
          await fetchAndWrite(asset.url, asset.filename, assetSubDir);
          assetCount++;
        } catch (err) {
          console.warn(`Batch Clipper: failed to download asset ${asset.url}`, err);
        }
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
