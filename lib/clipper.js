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

  // Strip TOC macros that are embedded inside heading elements.
  // Turndown converts the whole <h1> content including TOC list items as heading text.
  try {
    for (const el of doc.querySelectorAll('h1 .toc-macro, h2 .toc-macro, h1 [data-macro-name="toc"], h2 [data-macro-name="toc"]')) {
      el.remove();
    }
  } catch { /* ignore */ }

  // Confluence user profile links (/display/~username) — these become broken wikilinks
  // in Obsidian (clicking creates a new empty file). Strip the link, keep the display text.
  try {
    for (const a of doc.querySelectorAll('a[href*="/display/~"]')) {
      a.replaceWith(...a.childNodes);
    }
  } catch { /* ignore */ }

  // Strip data: URI images — these are always inline UI icons (comment buttons, spinners,
  // decorative SVGs), never real content. Real images use http/https URLs.
  try {
    for (const img of doc.querySelectorAll('img[src^="data:"]')) {
      img.remove();
    }
  } catch { /* ignore */ }

  // Confluence image wrappers: <span class="confluence-embedded-file-wrapper">
  // defuddle's span:has(img) transform can lose images inside these spans.
  // For image wrappers: unwrap to expose the bare <img> (or remove CDN icon placeholders).
  // For file attachment wrappers (contain <a> links, not <img>): unwrap to preserve the link.
  try {
    for (const wrapper of doc.querySelectorAll('.confluence-embedded-file-wrapper')) {
      // First, strip any CDN placeholder icons (decorative, not content)
      for (const img of wrapper.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        if (src.startsWith('/s/') || src.includes('/download/resources/')) {
          img.remove();
        }
      }
      // Now check what's left
      const remainingImg = wrapper.querySelector('img');
      if (remainingImg) {
        // Content image — unwrap to bare img so defuddle's span:has(img) transform doesn't lose it
        wrapper.replaceWith(remainingImg);
      } else {
        // File attachment link or other content — unwrap: preserve all children
        wrapper.replaceWith(...wrapper.childNodes);
      }
    }
  } catch { /* ignore */ }

  // Confluence section headings: images embedded inside <h1>/<h2>/etc. get dropped
  // when defuddle's standardizeHeadings transforms/removes heading elements.
  // Two cases:
  // 1. Image-only heading (no text): move img out, then remove the empty heading.
  //    Confluence generates anchor <h2> nodes whose only content is an image —
  //    they would otherwise produce a blank "## " line in the output.
  // 2. Text + image heading: move img out to after the heading, keep the heading.
  try {
    for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const imgs = heading.querySelectorAll('img');
      if (!imgs.length) continue;
      if (!heading.parentNode) continue;
      const clone = heading.cloneNode(true);
      for (const img of clone.querySelectorAll('img')) img.remove();
      // Strip UI chrome elements (icon spans, copy-link anchors, scripts) before checking for text
      for (const el of clone.querySelectorAll('script, style, .handy-header, .aui-icon, [title="Copy link"], a[href^="#"]')) {
        try { el.remove(); } catch { /* ignore */ }
      }
      const hasText = clone.textContent.trim().length > 0;
      for (const img of Array.from(imgs)) {
        heading.parentNode.insertBefore(img, heading.nextSibling);
      }
      if (!hasText) heading.remove();
    }
  } catch (e) { console.error('[DEBUG preprocess] ERROR:', e); }

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
      // Extract PNG URL — two strategies:
      // 1. imageUrl has the attachment path (live DOM renders full paths)
      // 2. imageUrl has empty paths (server-fetched HTML, Velocity vars not filled) —
      //    fall back to loadUrl which has the diagram CRUD path with name and contentId
      let pngUrl = null;
      let diagramAlt = '';

      const imgMatch = text.match(/imageUrl\s*=\s*''\s*\+\s*'(\/download\/attachments\/[^']+)'\s*\+\s*'([^']*)'/);
      if (imgMatch) {
        pngUrl = baseOrigin + imgMatch[1] + imgMatch[2];
        diagramAlt = imgMatch[1].split('/').pop().replace('.png', '');
      } else {
        // Fallback: parse loadUrl CRUD path for contentId and diagramName
        const loadMatch = text.match(/loadUrl\s*=\s*[^']*'[^']*\/diagram\/crud\/([^/]+)\/(\d+)/);
        if (loadMatch) {
          const diagramName = decodeURIComponent(loadMatch[1]);
          const contentId = loadMatch[2];
          pngUrl = `${baseOrigin}/rest/drawio/1.0/diagram/png?contentId=${contentId}&diagramName=${encodeURIComponent(diagramName)}`;
          diagramAlt = diagramName;
        }
      }
      if (!pngUrl) continue;

      // Find the diagram container
      const containerIdMatch = text.match(/getElementById\(['"]([^'"]+)['"]\)/);
      const container = containerIdMatch && doc.getElementById(containerIdMatch[1]);

      // Find the diagram container and check what content.js left behind
      const svg = container && container.querySelector('svg');
      const existingImg = container && container.querySelector('img');

      // If content.js already replaced the SVG with an img, it's inside the macro div —
      // which uiSelectors will remove. Move the img out to after the macro so it survives.
      if (existingImg && !svg) {
        macro.parentNode && macro.parentNode.insertBefore(existingImg, macro.nextSibling);
        continue;
      }

      const img = doc.createElement('img');
      img.src = pngUrl;
      img.alt = diagramAlt;
      img.style.maxWidth = '100%';

      if (svg) {
        // SVG present — replace it; img is now inside the container inside the macro.
        // Then move it out so it survives macro removal by uiSelectors.
        svg.replaceWith(img);
        macro.parentNode && macro.parentNode.insertBefore(img, macro.nextSibling);
      } else {
        // No SVG, no existing img (batch mode) — insert after macro
        macro.parentNode && macro.parentNode.insertBefore(img, macro.nextSibling);
      }
    }
  } catch { /* ignore */ }

  // Confluence code macro: replaces the entire macro container with a clean <pre><code> block.
  // The macro renders as <div data-macro-name="code"> containing syntaxhighlighter markup
  // with toolbar links, gutter spans, and per-line <span> wrappers that confuse Turndown.
  // We extract just the text content and language, then replace the whole structure.
  try {
    for (const macro of doc.querySelectorAll('[data-macro-name="code"], [data-macro-name="code-block"]')) {
      // Extract language from the syntaxhighlighter class: "sh-confluence nogutter java"
      // or from data-macro-parameters="language=java|..."
      let lang = '';
      const macroParams = macro.getAttribute('data-macro-parameters') || '';
      const langMatch = macroParams.match(/(?:^|[|])language=([^|]+)/i);
      if (langMatch) {
        lang = langMatch[1].trim().toLowerCase();
        if (lang === 'none' || lang === 'plain' || lang === 'text') lang = '';
      }

      // Do NOT fall back to the syntaxhighlighter div class — Confluence defaults to "java"
      // even when no language is specified, so the class is unreliable as a language signal.

      // Extract code text: each <div class="line ..."> is one line.
      // textContent of each line div concatenates all the token <code> spans correctly.
      // &nbsp; on blank lines becomes \u00A0 — normalize to empty string.
      const lineEls = macro.querySelectorAll('.line');
      let codeText = '';
      if (lineEls.length > 0) {
        codeText = Array.from(lineEls)
          .map(el => (el.textContent || '').replace(/^\u00A0+$/, ''))
          .join('\n');
      } else {
        // Fallback: <pre> with text nodes
        const pre = macro.querySelector('pre');
        codeText = pre ? pre.textContent || '' : macro.textContent || '';
      }

      // Build clean replacement: <pre><code data-lang="...">text</code></pre>
      const newPre = doc.createElement('pre');
      const newCode = doc.createElement('code');
      if (lang) newCode.setAttribute('data-lang', lang);
      newCode.textContent = codeText;
      newPre.appendChild(newCode);

      macro.replaceWith(newPre);
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
 * @param {string[]} [params.clipSubfolderSegments] - if provided, overrides clipSubfolder with a
 *   multi-level path (e.g. ["raw", "Parent", "Child"]) for hierarchical clipping
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
  clipSubfolderSegments,
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

    // Extract Confluence page author before uiSelectors strips .page-metadata.
    // Try multiple selectors in priority order.
    let confluenceAuthor = null;
    if (confluenceBaseUrl) {
      try {
        // 1. .page-metadata author link (most reliable in Confluence Server/DC)
        const authorEl = doc.querySelector('.page-metadata .author a, .page-metadata a[data-username], #page-metadata-banner .author a');
        if (authorEl) confluenceAuthor = authorEl.textContent.trim() || null;

        // 2. ajs-creator-name meta tag
        if (!confluenceAuthor) {
          const metaCreator = doc.querySelector('meta[name="ajs-creator-name"]');
          if (metaCreator) confluenceAuthor = metaCreator.getAttribute('content')?.trim() || null;
        }

        // 3. og:author or author meta
        if (!confluenceAuthor) {
          const metaAuthor = doc.querySelector('meta[name="author"], meta[property="article:author"]');
          if (metaAuthor) confluenceAuthor = metaAuthor.getAttribute('content')?.trim() || null;
        }
      } catch { /* ignore */ }
    }

    // defuddle is used for title extraction only on Confluence pages.
    // Its content selection/refinement logic narrows to a subtree and drops table-heavy
    // sections even with all removal passes disabled. Since we have a precise content
    // selector for Confluence, extract directly and strip UI chrome ourselves.
    // For generic pages, use defuddle fully for content extraction.
    const Defuddle = globalThis.Defuddle;
    const defuddleOptions = { url: fetchUrl };
    const defuddled = new Defuddle(doc, defuddleOptions).parse();
    title = defuddled.title || doc.title || 'Untitled';
    pageUrl = fetchUrl;

    if (confluenceBaseUrl) {
      const mainEl = doc.querySelector('#main-content, .wiki-content, #content');
      if (mainEl) {
        // Strip Confluence UI chrome that would otherwise appear in the markdown
        const uiSelectors = [
          // Toolbars and action buttons
          '.aui-toolbar', '.aui-toolbar2', '.action-bar', '.page-header',
          // Navigation and metadata
          '.page-metadata', '.page-hierarchy', '#breadcrumb-section', '#title-heading',
          '.page-children-button', '.plugin_pagetree',
          // Table of contents macro
          '.toc-macro', '.toc', '#toc', '.conf-macro[data-macro-name="toc"]',
          '.conf-macro[data-macro-name="children"]',
          // Footer / page-info panel
          '#page-info', '.page-info', '#footer', '.footer',
          '.page-section-header', '#likes-and-labels-container',
          '#comments-section', '#page-comments',
          // Confluence warning/info macros that are UI chrome (not content)
          // Note: keep content macros like expand, note, warning that have real content
          // draw.io macro container — preprocessHtml already inserted the img before the macro
          '[data-macro-name="drawio"]', '[data-macro-name="drawio-sketch"]',
          // Inline comment UI icons (data: SVG images used as comment toggle buttons)
          'a[data-inline-comment-marker]', '.inline-comment-marker-link',
          // Scripts and styles
          'script', 'style',
        ];
        for (const sel of uiSelectors) {
          try { for (const el of mainEl.querySelectorAll(sel)) el.remove(); } catch { /* ignore */ }
        }

        contentHtml = mainEl.innerHTML;
      } else {
        contentHtml = defuddled.content || '';
      }
    } else {
      contentHtml = defuddled.content || '';
    }

    if (isCancelled()) return { title, filename: '', assetCount: 0, error: 'cancelled' };

    const safeTitle = sanitiseTitle(title);

    // --- Resolve clip directory inside vault ---
    // clipSubfolderSegments overrides clipSubfolder for hierarchical placement
    const clipDir = await getOrCreateDir(vaultDir, clipSubfolderSegments || [clipSubfolder]);

    // --- Scan for assets ---
    const assets = scanAssets(contentHtml, pageUrl);

    // --- Convert HTML to markdown ---
    // createMarkdownContent strips the first # heading assuming it's the page title.
    // For Confluence pages we already stripped #title-heading via uiSelectors, so the
    // first h1 in contentHtml is a real content section heading — capture it so we
    // can restore it if createMarkdownContent removes it.
    const createMarkdownContent = globalThis.createMarkdownContent;
    let firstH1Text = null;
    if (confluenceBaseUrl) {
      const tmpParser = new DOMParser();
      const tmpDoc = tmpParser.parseFromString(contentHtml, 'text/html');
      const firstH1 = tmpDoc.querySelector('h1');
      if (firstH1) firstH1Text = firstH1.textContent?.trim() || null;
    }
    let markdown = createMarkdownContent(contentHtml, pageUrl);
    // createMarkdownContent strips the first # heading assuming it's the page title.
    // For Confluence we already removed #title-heading, so the first h1 is a real
    // content section heading. Detect if it was stripped by checking whether the
    // markdown starts with a # line whose text matches the first h1.
    if (firstH1Text) {
      const firstLine = markdown.trimStart().match(/^#[^\n]*/)?.[0] || '';
      // Strip markdown formatting from first line to compare with plain text
      const firstLinePlain = firstLine.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
      if (firstLinePlain !== firstH1Text) {
        // The first h1 was stripped — restore it
        markdown = `# ${firstH1Text}\n\n` + markdown.trimStart();
      }
    }

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
    const pageAuthor = confluenceAuthor || defuddled.author || undefined;
    const frontmatter = generateFrontmatter({ title, url: pageUrl, author: pageAuthor });

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
