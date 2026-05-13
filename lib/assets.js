// lib/assets.js
// Asset scanning, downloading, and URL rewriting.

/**
 * Scan an HTML string for asset URLs (images, video, audio, embeds, linked files).
 * Returns a deduplicated list of { url, filename } objects.
 * @param {string} html - HTML content to scan
 * @param {string} baseUrl - page URL for resolving relative paths
 * @returns {Array<{url: string, filename: string}>}
 */
function scanAssets(html, baseUrl) {
  // Lazy-load SUPPORTED_EXTENSIONS and decodeFilenameFromUrl at call time
  // so this works both in the browser (globals) and in tests (require).
  const extensions = (typeof SUPPORTED_EXTENSIONS !== 'undefined')
    ? SUPPORTED_EXTENSIONS
    : require('./utils').SUPPORTED_EXTENSIONS;
  const decodeFn = (typeof decodeFilenameFromUrl !== 'undefined')
    ? decodeFilenameFromUrl
    : require('./utils').decodeFilenameFromUrl;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Resolve relative URLs against the page's base
  const resolve = (src) => {
    try { return new URL(src, baseUrl).href; } catch { return null; }
  };

  const seen = new Set();
  const results = [];

  function add(rawUrl) {
    if (!rawUrl || rawUrl.startsWith('data:')) return;
    const url = resolve(rawUrl);
    if (!url || seen.has(url)) return;
    // Only fetch http/https URLs — skip gs://, s3://, ftp://, etc.
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    const filename = decodeFn(url);
    if (!filename) return;
    const ext = filename.split('.').pop().toLowerCase();
    if (!extensions.has(ext)) return;
    seen.add(url);
    // Store both the resolved absolute URL and the original raw src.
    // The markdown converter may output either form, so we need to rewrite both.
    results.push({ url, rawUrl: rawUrl !== url ? rawUrl : null, filename });
  }

  // Images (skip tiny icons)
  for (const el of doc.querySelectorAll('img[src]')) {
    const explicitWidth = parseInt(el.getAttribute('width') || '0', 10);
    if (explicitWidth > 0 && explicitWidth < 50) continue;
    add(el.getAttribute('src'));
  }

  // Video, audio, embeds
  for (const sel of ['video[src]', 'video source[src]', 'audio[src]', 'audio source[src]', 'embed[src]']) {
    for (const el of doc.querySelectorAll(sel)) {
      add(el.getAttribute('src'));
    }
  }

  // Object data
  for (const el of doc.querySelectorAll('object[data]')) {
    add(el.getAttribute('data'));
  }

  // Linked files (PDFs, docs, etc.)
  for (const el of doc.querySelectorAll('a[href]')) {
    add(el.getAttribute('href'));
  }

  return results;
}

/**
 * Extract and decode just the filename from a URL (strips path, query, fragment).
 * Handles percent-encoding, Unicode escape sequences, and query strings.
 * @param {string} url
 * @returns {string|null}
 */
function filenameFromUrl(url) {
  if (!url) return null;
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.replace(/[?#].*$/, '');
  }
  const raw = pathname.split('/').pop();
  if (!raw) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* malformed encoding — use raw */ }
  decoded = decoded.replace(/[?#].*$/, '').trim();
  return decoded || null;
}

/**
 * Build a map of decoded-filename -> local relative path for asset URL rewriting.
 * Keyed on the decoded filename so it matches regardless of how the URL was encoded.
 * @param {Array<{url: string, filename: string}>} assets
 * @param {string} pageTitle - sanitised page title (used as asset subfolder)
 * @param {string} assetsPrefix - relative path prefix (e.g. 'assets')
 * @returns {Map<string, string>} decoded filename -> local relative path
 */
// Normalize Unicode whitespace variants to regular ASCII space for wikilink paths.
// Obsidian resolves wikilinks using the literal filename on disk — narrow no-break space
// (U+202F, common in macOS screenshot names like "11.55.42 AM.png") must match exactly.
// We normalize to regular space both here and when saving the file so they always agree.
function normalizeSpaces(str) {
  return str.replace(/[\u00A0\u202F\u2009\u2007\u2008\u200A\u205F\u3000]/g, ' ');
}

function buildRewriteMap(assets, pageTitle, assetsPrefix) {
  const encodeFn = (typeof encodeFilenameForMarkdown !== 'undefined')
    ? encodeFilenameForMarkdown
    : require('./utils').encodeFilenameForMarkdown;

  const map = new Map();
  for (const asset of assets) {
    // Normalize Unicode spaces in both title and filename for the wikilink path.
    // The asset is saved to disk with the normalized name (see fetchAndWrite in fs-utils).
    const normalTitle = normalizeSpaces(pageTitle);
    const normalFilename = normalizeSpaces(asset.filename);
    const wikilinkPath = `${assetsPrefix}/${normalTitle}/${normalFilename}`;
    const markdownPath = `${assetsPrefix}/${encodeFn(pageTitle)}/${encodeFn(asset.filename)}`;
    const paths = { markdownPath, wikilinkPath };

    // Key on decoded filename (canonical form) — matches regardless of encoding in markdown
    const decoded = filenameFromUrl(asset.url) || asset.filename;
    map.set(decoded, paths);

    // Also key on asset.filename directly in case it differs from URL-decoded form
    if (asset.filename !== decoded) map.set(asset.filename, paths);
  }
  return map;
}

/**
 * Rewrite asset URLs in markdown using a filename-based lookup (asset-swapper approach).
 * Two passes: markdown syntax ![alt](url) / [text](url), then HTML <img src="..."> tags.
 * Extracts and decodes the filename from each URL, looks it up in the rewrite map.
 * @param {string} markdown
 * @param {Map<string, string>} rewriteMap - decoded filename -> local path
 * @returns {string}
 */
// Image extensions for deciding embed vs attachment wikilink syntax
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif', 'heic', 'ico']);

function isImageFilename(filename) {
  if (!filename) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function rewriteMarkdownUrls(markdown, rewriteMap) {
  // Split on fenced code blocks so we never rewrite URLs inside code.
  // Segments alternate: [outside, inside, outside, inside, ...]
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm;
  const segments = [];
  let lastIndex = 0;
  let match;
  while ((match = fenceRe.exec(markdown)) !== null) {
    segments.push({ text: markdown.slice(lastIndex, match.index), isCode: false });
    segments.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }
  segments.push({ text: markdown.slice(lastIndex), isCode: false });

  const rewriteSegment = (text) => {
    // Pass 1: markdown image/link syntax — ![alt](url) and [text](url)
    let result = text.replace(/(!?)\[([^\]]*)\]\(([^)]+)\)/g, (m, bang, alt, url) => {
      const filename = filenameFromUrl(url.trim());
      if (filename && rewriteMap.has(filename)) {
        const { wikilinkPath } = rewriteMap.get(filename);
        return `![[${wikilinkPath}]]`;
      }
      return m;
    });

    // Pass 2: HTML <img src="..."> tags (common in Confluence tables)
    result = result.replace(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*?\/?>/gi, (m, url) => {
      const filename = filenameFromUrl(url.trim());
      if (filename && rewriteMap.has(filename)) {
        const { wikilinkPath } = rewriteMap.get(filename);
        const widthMatch = m.match(/\bwidth=["'](\d+)["']/i);
        return widthMatch ? `![[${wikilinkPath}|${widthMatch[1]}]]` : `![[${wikilinkPath}]]`;
      }
      return m;
    });

    return result;
  };

  return segments.map(seg => seg.isCode ? seg.text : rewriteSegment(seg.text)).join('');
}

if (typeof module !== 'undefined') {
  module.exports = { scanAssets, buildRewriteMap, rewriteMarkdownUrls, filenameFromUrl, isImageFilename };
}
