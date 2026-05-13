// content.js
// Injected into the active tab. Detects the current page type and extracts
// basic info for the popup (title, URL, whether it's Confluence, page ID).

/**
 * Flatten shadow DOM content into data attributes so defuddle can read it.
 * Content scripts live in an isolated world and cannot read shadowRoot directly —
 * we inject a main-world script that stamps shadow innerHTML into data-defuddle-shadow.
 * Only injects if shadow roots are actually present (cheap check first).
 * Uses a timeout so a slow injection never blocks clipping.
 * Mirrors Obsidian Web Clipper's approach.
 * @returns {Promise<void>}
 */
function flattenShadowDom() {
  let found = false;
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].shadowRoot) { found = true; break; }
  }
  if (!found) return Promise.resolve();

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('flatten-shadow-dom.js');
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); resolve(); };
    (document.head || document.documentElement).appendChild(script);
  });
}

/**
 * Resolve all relative URLs in the document to absolute before serializing.
 * When the popup re-parses outerHTML, there's no baseURI context — relative URLs
 * would silently break. Mirrors how Obsidian Web Clipper prepares HTML for export.
 */
function resolveRelativeUrls() {
  document.querySelectorAll('[src], [href], [srcset]').forEach((el) => {
    ['src', 'href'].forEach((attr) => {
      const val = el.getAttribute(attr);
      if (!val || val.startsWith('http') || val.startsWith('data:') ||
          val.startsWith('#') || val.startsWith('//')) return;
      try {
        el.setAttribute(attr, new URL(val, document.baseURI).href);
      } catch { /* ignore malformed URLs */ }
    });
    const srcset = el.getAttribute('srcset');
    if (srcset) {
      const resolved = srcset.split(',').map((part) => {
        const [url, size] = part.trim().split(/\s+/);
        try {
          return new URL(url, document.baseURI).href + (size ? ' ' + size : '');
        } catch { return part; }
      }).join(', ');
      el.setAttribute('srcset', resolved);
    }
  });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // Return the live rendered HTML of the current tab — captures JS-rendered content
  // (draw.io, Gliffy, shadow DOM components, etc.) that a fetch() from the popup can never see.
  if (request.action === 'getLiveHtml') {
    const flattenTimeout = new Promise((resolve) => setTimeout(resolve, 3000));
    Promise.race([flattenShadowDom(), flattenTimeout]).then(() => {
      resolveRelativeUrls();
      sendResponse({ html: document.documentElement.outerHTML, url: document.URL });
    });
    return true; // keep message channel open for async response
  }

  if (request.action !== 'getPageInfo') return;

  const info = {
    url: document.URL,
    title: document.title,
    isConfluence: false,
    pageId: null,
  };

  // Detect Confluence — check for common Confluence DOM markers
  const confluenceMarkers = [
    '#com-atlassian-confluence',
    '#main-content',
    'meta[name="confluence-request-time"]',
    'meta[name="ajs-page-id"]',
  ];

  for (const selector of confluenceMarkers) {
    if (document.querySelector(selector)) {
      info.isConfluence = true;
      break;
    }
  }

  // Extract page ID from meta tag (most reliable) or URL
  if (info.isConfluence) {
    // 1. Standard Confluence meta tag
    const metaPageId = document.querySelector('meta[name="ajs-page-id"]');
    if (metaPageId) {
      info.pageId = metaPageId.getAttribute('content');
    }

    // 2. Newer Confluence / Confluence Cloud data attributes
    if (!info.pageId) {
      const dataEl = document.querySelector('[data-page-id]');
      if (dataEl) info.pageId = dataEl.getAttribute('data-page-id');
    }

    // 3. URL ?pageId= param
    if (!info.pageId) {
      try {
        const params = new URL(document.URL).searchParams;
        info.pageId = params.get('pageId') || null;
      } catch { /* ignore */ }
    }

    // 4. Canonical link href (sometimes contains ?pageId=)
    if (!info.pageId) {
      try {
        const canonical = document.querySelector('link[rel="canonical"]');
        if (canonical) {
          const params = new URL(canonical.href).searchParams;
          info.pageId = params.get('pageId') || null;
        }
      } catch { /* ignore */ }
    }

    // 5. Extract from page body — Confluence often embeds it as data-entity-id
    if (!info.pageId) {
      const entityEl = document.querySelector('[data-entity-id]');
      if (entityEl) info.pageId = entityEl.getAttribute('data-entity-id');
    }
  }

  sendResponse(info);
});
