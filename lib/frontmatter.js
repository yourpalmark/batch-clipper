// lib/frontmatter.js
// Generate YAML frontmatter matching Obsidian Web Clipper's default template.

/**
 * Escape double quotes in a YAML value.
 * @param {string} str
 * @returns {string}
 */
function escapeYaml(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Generate YAML frontmatter for a clipped page.
 * Matches Web Clipper's default template output format.
 * @param {object} params
 * @param {string} params.title
 * @param {string} params.url
 * @param {string} [params.author]
 * @param {string} [params.published]
 * @param {string} [params.description]
 * @param {string} [params.created] - date string, defaults to today (YYYY-MM-DD)
 * @returns {string}
 */
function generateFrontmatter({ title, url, author, published, description, created }) {
  const now = new Date();
  const timestamp = created || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const lines = ['---'];
  lines.push(`title: "${escapeYaml(title || '')}"`);
  lines.push(`source: "${escapeYaml(url || '')}"`);

  if (author) {
    lines.push(`author: "${escapeYaml(author)}"`);
  } else {
    lines.push('author:');
  }

  if (published) {
    lines.push(`published: "${escapeYaml(published)}"`);
  } else {
    lines.push('published:');
  }

  lines.push(`created: ${timestamp}`);

  if (description) {
    lines.push(`description: "${escapeYaml(description)}"`);
  } else {
    lines.push('description:');
  }

  lines.push('tags: clippings');
  lines.push('---');

  return lines.join('\n') + '\n';
}

if (typeof module !== 'undefined') {
  module.exports = { generateFrontmatter, escapeYaml };
}
