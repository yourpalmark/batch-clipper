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
 * Fetch all descendant pages of a Confluence page using CQL search.
 * Uses a single paginated query (ancestor=<pageId>) instead of recursive
 * child-by-child API calls — far fewer requests, avoids 429 rate limits.
 * @param {string} baseUrl - Confluence origin
 * @param {string} pageId - root page ID
 * @param {number} maxDepth - max ancestor depth relative to root (Infinity for all)
 * @param {number} _unused - kept for API compatibility
 * @param {() => boolean} isCancelled
 * @param {(count: number) => void} [onProgress]
 * @returns {Promise<Array<{id, title, url, parentId, depth}>>}
 */
async function fetchChildPages(baseUrl, pageId, maxDepth, _unused = 0, isCancelled = () => false, onProgress = null) {
  const results = [];
  const limit = 200;
  let start = 0;
  let total = null;

  while (!isCancelled()) {
    const cql = encodeURIComponent(`ancestor="${pageId}" AND type=page`);
    const url = `${baseUrl}/rest/api/content/search?cql=${cql}&start=${start}&limit=${limit}&expand=ancestors`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) {
      console.warn(`[BatchClipper] CQL search HTTP ${resp.status}`);
      break;
    }

    const data = await resp.json();
    if (!data.results || data.results.length === 0) break;
    if (total === null) total = data.totalSize || data.results.length;

    for (const page of data.results) {
      if (isCancelled()) break;

      // Compute depth relative to root using ancestors list
      const ancestors = page.ancestors || [];
      const rootIndex = ancestors.findIndex(a => a.id === pageId);
      const depth = rootIndex === -1 ? 0 : ancestors.length - rootIndex - 1;

      if (depth >= maxDepth) continue;

      // parentId = last ancestor before this page (the immediate parent)
      const parentId = ancestors.length > 0 ? ancestors[ancestors.length - 1].id : pageId;

      results.push({
        id: page.id,
        title: page.title,
        url: `${baseUrl}/pages/viewpage.action?pageId=${page.id}`,
        parentId,
        depth,
      });
      if (onProgress) onProgress(results.length);
    }

    if (data.results.length < limit) break;
    start += limit;
  }

  // Sort into depth-first order matching the original page tree structure
  // Build a map and sort by parentId chain
  const byId = new Map(results.map(r => [r.id, r]));
  const childrenOf = new Map();
  for (const r of results) {
    if (!childrenOf.has(r.parentId)) childrenOf.set(r.parentId, []);
    childrenOf.get(r.parentId).push(r);
  }
  const sorted = [];
  function walk(pid) {
    for (const child of (childrenOf.get(pid) || [])) {
      sorted.push(child);
      walk(child.id);
    }
  }
  walk(pageId);

  // Fall back to original order if tree walk missed anything
  if (sorted.length < results.length) return results;
  return sorted;
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
