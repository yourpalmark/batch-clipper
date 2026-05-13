// popup.js
// Popup orchestration: scans the active tab, discovers child pages,
// manages the clip queue, handles cancellation, and shows progress.

// --- State ---

let clipDirHandle = null;
let assetDirHandle = null;
let savedClipHandle = null;
let savedAssetHandle = null;
let cancelled = false;
let clipping = false;
let pageInfo = null;        // { url, title, isConfluence, pageId }
let pageQueue = [];         // [{ url, title, confluencePageId }]

// --- DOM refs ---

const pageTitleEl = document.getElementById('page-title');
const includeChildrenEl = document.getElementById('include-children');
const depthRowEl = document.getElementById('depth-row');
const depthSelectEl = document.getElementById('depth-select');
const childPagesSectionEl = document.getElementById('child-pages-section');
const clipPathDisplay = document.getElementById('clip-path-display');
const assetPathDisplay = document.getElementById('asset-path-display');
const selectClipBtn = document.getElementById('select-clip-btn');
const selectAssetBtn = document.getElementById('select-asset-btn');
const clipBtn = document.getElementById('clip-btn');
const cancelBtn = document.getElementById('cancel-btn');
const statusEl = document.getElementById('status');
const progressListEl = document.getElementById('progress-list');

// --- IndexedDB persistence (same pattern as Asset Clipper) ---

const DB_NAME = 'batch-clipper';
const STORE_NAME = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(key, handle) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// --- Folder display ---

function updateFolderDisplay(displayEl, btnEl, handle) {
  if (handle) {
    displayEl.textContent = handle.name;
    displayEl.classList.remove('not-set');
    displayEl.classList.add('is-set');
    btnEl.textContent = 'Change';
  } else {
    displayEl.classList.remove('is-set');
    displayEl.classList.add('not-set');
    btnEl.textContent = 'Browse…';
  }
}

function updateClipButton() {
  if (clipping) return;
  const hasClipDir = !!(clipDirHandle || savedClipHandle);
  const count = pageQueue.length || 1;
  clipBtn.disabled = !hasClipDir;
  clipBtn.textContent = `Clip ${count} page${count !== 1 ? 's' : ''}`;
}

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

// --- Folder selection ---

selectClipBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    clipDirHandle = handle;
    savedClipHandle = handle;
    await saveHandle('clipDir', handle);
    updateFolderDisplay(clipPathDisplay, selectClipBtn, handle);
    // Default asset dir to <clipDir>/assets if not explicitly set
    if (!assetDirHandle && !savedAssetHandle) {
      assetPathDisplay.textContent = `${handle.name}/assets/`;
      assetPathDisplay.classList.remove('not-set');
      assetPathDisplay.classList.add('is-set');
    }
    updateClipButton();
  } catch (err) {
    if (err.name !== 'AbortError') setStatus('Could not select folder.', 'error');
  }
});

selectAssetBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    assetDirHandle = handle;
    savedAssetHandle = handle;
    await saveHandle('assetDir', handle);
    updateFolderDisplay(assetPathDisplay, selectAssetBtn, handle);
  } catch (err) {
    if (err.name !== 'AbortError') setStatus('Could not select folder.', 'error');
  }
});

// --- Child pages toggle ---

includeChildrenEl.addEventListener('change', async () => {
  const checked = includeChildrenEl.checked;
  depthRowEl.classList.toggle('hidden', !checked);

  if (checked && pageInfo?.isConfluence && pageInfo?.pageId) {
    await discoverChildPages();
  } else {
    pageQueue = [];
    updateClipButton();
  }
});

depthSelectEl.addEventListener('change', async () => {
  if (includeChildrenEl.checked && pageInfo?.isConfluence && pageInfo?.pageId) {
    await discoverChildPages();
  }
});

async function discoverChildPages() {
  setStatus('Discovering child pages…', 'loading');
  clipBtn.disabled = true;
  clipBtn.textContent = 'Discovering…';

  const depthVal = depthSelectEl.value;
  const maxDepth = depthVal === '0' ? Infinity : parseInt(depthVal, 10);
  const baseUrl = new URL(pageInfo.url).origin;

  try {
    const children = await fetchChildPages(baseUrl, pageInfo.pageId, maxDepth, 0, () => false);

    // Build queue: current page first, then children
    pageQueue = [
      { url: pageInfo.url, title: pageInfo.title, confluencePageId: pageInfo.pageId },
      ...children.map(c => ({ url: c.url, title: c.title, confluencePageId: c.id })),
    ];

    setStatus(`Found ${children.length} child page${children.length !== 1 ? 's' : ''}.`);
    updateClipButton();
  } catch (err) {
    setStatus(`Failed to discover child pages: ${err.message}`, 'error');
    pageQueue = [];
    updateClipButton();
  }
}

// --- Main clip action ---

clipBtn.addEventListener('click', async () => {
  if (clipping) return;

  // Ensure we have a clip directory
  const activeClipHandle = await ensurePermission(savedClipHandle, clipDirHandle, 'clipDir');
  if (!activeClipHandle) {
    setStatus('Please select a Clip folder first.', 'error');
    return;
  }
  clipDirHandle = activeClipHandle;

  // Resolve asset directory: explicit override or default to <clipDir>/assets
  let activeAssetHandle;
  if (savedAssetHandle) {
    activeAssetHandle = await ensurePermission(savedAssetHandle, assetDirHandle, null);
  }
  if (!activeAssetHandle) {
    // Default: create assets/ subfolder inside clip dir
    activeAssetHandle = await clipDirHandle.getDirectoryHandle('assets', { create: true });
  }
  assetDirHandle = activeAssetHandle;

  // Build queue if not already set (single-page clip)
  if (pageQueue.length === 0) {
    const entry = { url: pageInfo.url, title: pageInfo.title };
    if (pageInfo.isConfluence && pageInfo.pageId) {
      entry.confluencePageId = pageInfo.pageId;
    }
    pageQueue = [entry];
  }

  // Start clipping
  clipping = true;
  cancelled = false;
  clipBtn.classList.add('hidden');
  cancelBtn.classList.remove('hidden');
  progressListEl.innerHTML = '';

  // Render initial progress list
  pageQueue.forEach((page, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="page-name" title="${page.title}">${page.title}</span>
      <span class="item-status pending" id="item-${i}">·</span>
    `;
    progressListEl.appendChild(li);
  });

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < pageQueue.length; i++) {
    if (cancelled) break;

    const page = pageQueue[i];
    const statusEl = document.getElementById(`item-${i}`);
    if (statusEl) { statusEl.textContent = '↓'; statusEl.className = 'item-status downloading'; }

    setStatus(`Clipping ${i + 1} of ${pageQueue.length}…`, 'loading');

    const confluenceBaseUrl = page.confluencePageId ? new URL(page.url).origin : null;

    const result = await clipPage({
      url: page.url,
      confluencePageId: page.confluencePageId || null,
      confluenceBaseUrl,
      clipDir: clipDirHandle,
      assetDir: assetDirHandle,
      isCancelled: () => cancelled,
    });

    if (result.error) {
      errorCount++;
      if (statusEl) { statusEl.textContent = '✗'; statusEl.className = 'item-status error'; }
      if (result.error !== 'cancelled') {
        console.error(`Batch Clipper: failed ${page.url}`, result.error);
      }
    } else {
      successCount++;
      if (statusEl) { statusEl.textContent = '✓'; statusEl.className = 'item-status done'; }
    }
  }

  // Done
  clipping = false;
  cancelBtn.classList.add('hidden');
  clipBtn.classList.remove('hidden');

  if (cancelled) {
    setStatus(`Cancelled. ${successCount} clipped, ${pageQueue.length - successCount - errorCount} skipped.`);
  } else if (errorCount === 0) {
    setStatus(`Done! ${successCount} page${successCount !== 1 ? 's' : ''} clipped.`, 'success');
  } else {
    setStatus(`${successCount} clipped, ${errorCount} failed.`, errorCount === pageQueue.length ? 'error' : '');
  }

  clipBtn.textContent = 'Done';
  pageQueue = [];
});

cancelBtn.addEventListener('click', () => {
  cancelled = true;
  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancelling…';
  setStatus('Cancelling after current page…', 'loading');
});

// --- Permission helpers ---

async function ensurePermission(saved, active, saveKey) {
  if (active) return active;
  if (!saved) return null;

  try {
    let perm = await saved.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return saved;
    perm = await saved.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') return saved;
  } catch {
    // permission denied or handle stale
  }
  return null;
}

// --- Init ---

async function init() {
  // Restore saved folder handles
  try {
    const clip = await loadHandle('clipDir');
    if (clip) {
      savedClipHandle = clip;
      const perm = await clip.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') clipDirHandle = clip;
      updateFolderDisplay(clipPathDisplay, selectClipBtn, clip);
      if (!savedAssetHandle) {
        assetPathDisplay.textContent = `${clip.name}/assets/`;
        assetPathDisplay.classList.remove('not-set');
        assetPathDisplay.classList.add('is-set');
      }
    }
  } catch { /* ignore */ }

  try {
    const asset = await loadHandle('assetDir');
    if (asset) {
      savedAssetHandle = asset;
      const perm = await asset.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') assetDirHandle = asset;
      updateFolderDisplay(assetPathDisplay, selectAssetBtn, asset);
    }
  } catch { /* ignore */ }

  // Scan the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) {
      pageTitleEl.textContent = 'No active tab';
      return;
    }

    // Try sending to existing content script
    chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' }, async (response) => {
      if (!chrome.runtime.lastError && response) {
        applyPageInfo(response);
        return;
      }

      // Content script not injected yet — inject and retry
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
      } catch {
        pageTitleEl.textContent = 'Cannot scan this page';
        setStatus('Restricted page (chrome://, extension, etc.)', 'error');
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' }, (response2) => {
        if (chrome.runtime.lastError || !response2) {
          pageTitleEl.textContent = tab.title || 'Unknown page';
          pageInfo = { url: tab.url, title: tab.title, isConfluence: false, pageId: null };
          // Still allow clipping for generic pages
          childPagesSectionEl.classList.add('hidden');
          updateClipButton();
          return;
        }
        applyPageInfo(response2);
      });
    });
  });
}

function applyPageInfo(info) {
  pageInfo = info;
  pageTitleEl.textContent = info.title || 'Untitled';

  // Show child pages option only for Confluence
  if (info.isConfluence) {
    childPagesSectionEl.classList.remove('hidden');
  } else {
    childPagesSectionEl.classList.add('hidden');
  }

  updateClipButton();
}

init();
