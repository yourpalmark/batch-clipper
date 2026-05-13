// lib/utils.js
// Shared utilities adapted from Asset Clipper.

/**
 * File extensions we consider downloadable assets.
 */
const SUPPORTED_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'avif', 'heic',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'csv', 'txt', 'rtf', 'eml',
  // Video
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v',
  // Audio
  'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac',
  // Archives
  'zip', 'tar', 'gz', '7z',
  // Code / scripts
  'py', 'js', 'ts', 'sh', 'r', 'ipynb', 'sql',
]);

/**
 * Sanitise a string for use as a file or folder name.
 * Replaces illegal characters and trims trailing separators.
 */
function sanitiseTitle(title) {
  return title
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.+$/, '')
    .replace(/[-\s]+$/g, '')
    .trim() || 'Untitled';
}

/**
 * Extract a decoded filename from a URL, stripping query strings and fragments.
 * Returns null if the URL has no usable filename or extension.
 */
function decodeFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const encoded = pathname.split('/').pop();
    if (!encoded) return null;
    const decoded = decodeURIComponent(encoded);
    if (!decoded.includes('.')) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * URL-encode a filename for use in markdown links.
 * Fully decodes first (normalizes any existing %XX or + encoding),
 * then re-encodes spaces, parens, and other characters that break markdown parsers.
 */
function encodeFilenameForMarkdown(str) {
  // Fully decode to normalize any mixed/partial encoding
  let decoded = str;
  try { decoded = decodeURIComponent(str.replace(/\+/g, ' ')); } catch { /* keep original */ }
  // Re-encode characters that break markdown link syntax.
  // \s covers regular space, narrow no-break space (U+202F), and other whitespace variants.
  return decoded
    .replace(/[\s]/g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

/**
 * Escape $$ sequences in markdown outside of code blocks/spans.
 * Obsidian treats $$ as LaTeX math delimiters — unmatched $$ in plain text
 * (e.g. passcodes like "B2$$yENq") break page rendering by opening an unclosed math block.
 */
function escapeLatexDelimiters(markdown) {
  const lines = markdown.split('\n');
  let inFence = false;
  return lines.map((line) => {
    // Track fenced code blocks (``` or ~~~)
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // Skip lines that are intentional LaTeX blocks (start with $$)
    if (/^\s*\$\$/.test(line)) return line;
    // Escape $$ in plain text — replace with \$\$
    return line.replace(/\$\$/g, '\\$\\$');
  }).join('\n');
}

if (typeof module !== 'undefined') {
  module.exports = {
    SUPPORTED_EXTENSIONS,
    sanitiseTitle,
    decodeFilenameFromUrl,
    encodeFilenameForMarkdown,
    escapeLatexDelimiters,
  };
}
