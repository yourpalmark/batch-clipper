// background.js
// Service worker for Batch Clipper.
// Handles privileged operations that require extension context (e.g. tab navigation).

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'openObsidian') {
    const url = request.url;
    if (!url) { sendResponse({ ok: false }); return; }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.id) {
        // tabs.update navigates the active tab to the obsidian:// URI through
        // the extension's trusted context — no Chrome protocol-handler dialog.
        chrome.tabs.update(tab.id, { url }, () => {
          sendResponse({ ok: true });
        });
      } else {
        sendResponse({ ok: false });
      }
    });

    return true; // keep message channel open for async sendResponse
  }
});
