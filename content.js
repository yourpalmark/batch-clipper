// content.js
// Injected into the active tab. Detects the current page type and extracts
// basic info for the popup (title, URL, whether it's Confluence, page ID).

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
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
