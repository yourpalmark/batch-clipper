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
    const filename = decodeFn(url);
    if (!filename) return;
    const ext = filename.split('.').pop().toLowerCase();
    if (!extensions.has(ext)) return;
    seen.add(url);
    results.push({ url, filename });
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
 * Build a map of remote URL -> local relative path for asset URL rewriting.
 * @param {Array<{url: string, filename: string}>} assets
 * @param {string} pageTitle - sanitised page title (used as asset subfolder)
 * @param {string} assetsPrefix - relative path prefix (e.g. 'assets')
 * @returns {Map<string, string>} remote URL -> local relative path
 */
function buildRewriteMap(assets, pageTitle, assetsPrefix) {
  const encodeFn = (typeof encodeFilenameForMarkdown !== 'undefined')
    ? encodeFilenameForMarkdown
    : require('./utils').encodeFilenameForMarkdown;

  const map = new Map();
  for (const asset of assets) {
    const localPath = `${assetsPrefix}/${encodeFn(pageTitle)}/${encodeFn(asset.filename)}`;
    map.set(asset.url, localPath);
  }
  return map;
}

/**
 * Rewrite asset URLs in markdown text using the provided rewrite map.
 * Handles both image syntax ![alt](url) and link syntax [text](url).
 * @param {string} markdown
 * @param {Map<string, string>} rewriteMap - remote URL -> local path
 * @returns {string}
 */
function rewriteMarkdownUrls(markdown, rewriteMap) {
  let result = markdown;
  for (const [remoteUrl, localPath] of rewriteMap) {
    // Escape special regex characters in the URL
    const escaped = remoteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Replace all occurrences in markdown (images + links)
    result = result.replace(new RegExp(escaped, 'g'), localPath);
  }
  return result;
}

if (typeof module !== 'undefined') {
  module.exports = { scanAssets, buildRewriteMap, rewriteMarkdownUrls };
}
