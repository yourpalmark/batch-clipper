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
    const metaPageId = document.querySelector('meta[name="ajs-page-id"]');
    if (metaPageId) {
      info.pageId = metaPageId.getAttribute('content');
    } else {
      // Fallback: try URL parameter
      try {
        const params = new URL(document.URL).searchParams;
        info.pageId = params.get('pageId');
      } catch {
        // ignore
      }
    }
  }

  sendResponse(info);
});
