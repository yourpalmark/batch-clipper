// lib/confluence.js
// Confluence-specific utilities: page detection and child page discovery.

/**
 * Detect whether a URL is a Confluence page and extract its page ID.
 * Handles both classic and new-style Confluence URLs.
 * @param {string} url
 * @returns {{ isConfluence: boolean, baseUrl: string, pageId: string|null }}
 */
function detectConfluence(url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;

    // Classic Confluence: /pages/viewpage.action?pageId=12345
    const pageIdParam = parsed.searchParams.get('pageId');
    if (parsed.pathname.includes('/pages/viewpage.action') && pageIdParam) {
      return { isConfluence: true, baseUrl: origin, pageId: pageIdParam };
    }

    // Wiki-style: /display/SPACE/Page+Title (need to resolve via API)
    if (parsed.pathname.includes('/display/')) {
      return { isConfluence: true, baseUrl: origin, pageId: null };
    }

    // Confluence Cloud or custom paths with /wiki/
    if (parsed.pathname.includes('/wiki/')) {
      return { isConfluence: true, baseUrl: origin, pageId: null };
    }

    return { isConfluence: false, baseUrl: origin, pageId: null };
  } catch {
    return { isConfluence: false, baseUrl: '', pageId: null };
  }
}

/**
 * Resolve a Confluence page URL to its page ID by querying the REST API.
 * Falls back to null if the page can't be found.
 * @param {string} baseUrl - Confluence origin (e.g. https://confluence.walmart.com)
 * @param {string} pageUrl - full page URL
 * @returns {Promise<string|null>}
 */
async function resolvePageId(baseUrl, pageUrl) {
  // Try extracting pageId from the URL first
  const parsed = new URL(pageUrl);
  const pageIdParam = parsed.searchParams.get('pageId');
  if (pageIdParam) return pageIdParam;

  // For /display/SPACE/Title URLs, use search
  const displayMatch = parsed.pathname.match(/\/display\/([^/]+)\/(.+)/);
  if (displayMatch) {
    const spaceKey = displayMatch[1];
    const title = decodeURIComponent(displayMatch[2].replace(/\+/g, ' '));
    const searchUrl = `${baseUrl}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&limit=1`;
    const resp = await fetch(searchUrl, { credentials: 'include' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.results && data.results.length > 0) {
        return data.results[0].id;
      }
    }
  }

  return null;
}

/**
 * Fetch child pages of a Confluence page, recursively up to a given depth.
 * @param {string} baseUrl - Confluence origin
 * @param {string} pageId - parent page ID
 * @param {number} maxDepth - how deep to recurse (Infinity for full tree)
 * @param {number} currentDepth - internal tracker
 * @param {() => boolean} isCancelled - callback to check for cancellation
 * @param {(count: number) => void} [onProgress] - called after each page is discovered with running total
 * @param {{ count: number }} [_counter] - internal shared counter across recursive calls
 * @returns {Promise<Array<{id: string, title: string, url: string}>>}
 */
async function fetchChildPages(baseUrl, pageId, maxDepth, currentDepth = 0, isCancelled = () => false, onProgress = null, _counter = null) {
  if (currentDepth >= maxDepth || isCancelled()) return [];

  // Shared counter object so recursive calls all update the same total
  if (!_counter) _counter = { count: 0 };

  const results = [];
  let start = 0;
  const limit = 100;

  while (!isCancelled()) {
    const url = `${baseUrl}/rest/api/content/${pageId}/child/page?start=${start}&limit=${limit}&expand=metadata.labels`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) break;

    const data = await resp.json();
    if (!data.results || data.results.length === 0) break;

    for (const child of data.results) {
      if (isCancelled()) break;

      const childInfo = {
        id: child.id,
        title: child.title,
        url: `${baseUrl}/pages/viewpage.action?pageId=${child.id}`,
        parentId: pageId,
        depth: currentDepth,
      };
      results.push(childInfo);
      _counter.count++;
      if (onProgress) onProgress(_counter.count);

      // Recurse into this child's children
      const grandchildren = await fetchChildPages(
        baseUrl, child.id, maxDepth, currentDepth + 1, isCancelled, onProgress, _counter
      );
      results.push(...grandchildren);
    }

    // Pagination: if fewer results than limit, we've got them all
    if (data.results.length < limit) break;
    start += limit;
  }

  return results;
}

/**
 * Fetch the body of a Confluence page in storage (HTML) format.
 * @param {string} baseUrl - Confluence origin
 * @param {string} pageId - page ID
 * @returns {Promise<{title: string, bodyHtml: string, url: string}|null>}
 */
async function fetchConfluencePageBody(baseUrl, pageId) {
  const url = `${baseUrl}/rest/api/content/${pageId}?expand=body.view,version`;
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) return null;

  const data = await resp.json();
  return {
    title: data.title,
    bodyHtml: data.body?.view?.value || '',
    url: `${baseUrl}/pages/viewpage.action?pageId=${pageId}`,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    detectConfluence,
    resolvePageId,
    fetchChildPages,
    fetchConfluencePageBody,
  };
}
