// popup.js
// Popup orchestration: vault picker, subfolder config, asset settings,
// child page discovery, clip queue management, and progress display.

// --- State ---

let vaultDirHandle   = null;   // Active FSA handle (permission confirmed)
let savedVaultHandle = null;   // Persisted FSA handle (may need permission re-grant)
let clipSubfolder    = '';     // e.g. "raw"
let assetSubfolder   = 'assets';
let downloadAssets   = false;
let cancelled          = false;
let discoveryCancelled = false;
let discovering        = false;
let discoveryEpoch     = 0;   // incremented each run; callbacks ignore stale epochs
let clipping           = false;
let pageInfo         = null;   // { url, title, isConfluence, pageId }
let pageQueue        = [];     // [{ url, title, confluencePageId }]
let activeTabId      = null;   // Tab ID of the active tab (for getLiveHtml)

// --- DOM refs ---

const pageTitleEl              = document.getElementById('page-title');
const includeChildrenEl        = document.getElementById('include-children');
const depthRowEl               = document.getElementById('depth-row');
const depthInputEl             = document.getElementById('depth-input');
const childPagesSectionEl      = document.getElementById('child-pages-section');

const selectVaultBtn           = document.getElementById('select-vault-btn');
const vaultPathDisplay         = document.getElementById('vault-path-display');

const selectClipSubfolderBtn   = document.getElementById('select-clip-subfolder-btn');
const clipSubfolderDisplay     = document.getElementById('clip-subfolder-display');
const clipSubfolderPicker      = document.getElementById('clip-subfolder-picker');
const clipSubfolderSelect      = document.getElementById('clip-subfolder-select');
const clipNewFolderInput       = document.getElementById('clip-new-folder-input');
const clipSubfolderConfirm     = document.getElementById('clip-subfolder-confirm');

const downloadAssetsEl         = document.getElementById('download-assets');
const selectAssetSubfolderBtn  = document.getElementById('select-asset-subfolder-btn');
const assetSubfolderDisplay    = document.getElementById('asset-subfolder-display');
const assetSubfolderPicker     = document.getElementById('asset-subfolder-picker');
const assetSubfolderSelect     = document.getElementById('asset-subfolder-select');
const assetNewFolderInput      = document.getElementById('asset-new-folder-input');
const assetSubfolderConfirm    = document.getElementById('asset-subfolder-confirm');

const discoveryProgressRow     = document.getElementById('discovery-progress-row');
const discoveryProgressLabel   = document.getElementById('discovery-progress-label');

const assetProgressRow         = document.getElementById('asset-progress-row');
const assetProgressLabel       = document.getElementById('asset-progress-label');
const assetProgressBar         = document.getElementById('asset-progress-bar');

const clipBtn                  = document.getElementById('clip-btn');
const cancelBtn                = document.getElementById('cancel-btn');
const statusEl                 = document.getElementById('status');
const progressListEl           = document.getElementById('progress-list');

// --- IndexedDB persistence for FSA handles ---

const DB_NAME    = 'batch-clipper';
const STORE_NAME = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess    = (e) => resolve(e.target.result);
    req.onerror      = () => reject(req.error);
  });
}

async function saveHandle(key, handle) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, key);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadHandle(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

// --- chrome.storage.local helpers ---

async function saveSetting(key, value) {
  return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
}

async function loadSetting(key, defaultValue = null) {
  return new Promise((resolve) =>
    chrome.storage.local.get([key], (result) => resolve(result[key] ?? defaultValue))
  );
}

// --- Enumerate subdirectories ---

async function getSubdirectories(dirHandle) {
  // Ensure we have read permission before enumerating
  try {
    let perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') return [];
  } catch { return []; }

  const folders = [];
  try {
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'directory' && !name.startsWith('.')) {
        folders.push(name);
      }
    }
  } catch { /* ignore */ }
  return folders.sort();
}

async function populateSelect(selectEl, folders, currentValue) {
  selectEl.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = folders.length ? '— choose a folder —' : '— no subfolders yet —';
  selectEl.appendChild(placeholder);

  folders.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    selectEl.appendChild(opt);
  });

  if (currentValue) selectEl.value = currentValue;
}

// --- Display helpers ---

function updateVaultDisplay(handle) {
  if (handle) {
    vaultPathDisplay.textContent = handle.name;
    vaultPathDisplay.classList.remove('not-set');
    vaultPathDisplay.classList.add('is-set');
    selectVaultBtn.textContent = 'Change';
    selectClipSubfolderBtn.disabled = false;
  } else {
    vaultPathDisplay.textContent = 'Not set';
    vaultPathDisplay.classList.remove('is-set');
    vaultPathDisplay.classList.add('not-set');
    selectVaultBtn.textContent = 'Browse…';
    selectClipSubfolderBtn.disabled = true;
  }
}

function updateClipSubfolderDisplay(close = true) {
  if (clipSubfolder) {
    clipSubfolderDisplay.textContent = clipSubfolder;
    clipSubfolderDisplay.classList.remove('not-set');
    clipSubfolderDisplay.classList.add('is-set');
    selectClipSubfolderBtn.textContent = 'Change';
  } else {
    clipSubfolderDisplay.textContent = 'Not set';
    clipSubfolderDisplay.classList.remove('is-set');
    clipSubfolderDisplay.classList.add('not-set');
    selectClipSubfolderBtn.textContent = 'Set…';
  }
  if (close) clipSubfolderPicker.classList.add('hidden');
}

function updateAssetSubfolderDisplay(close = true) {
  if (downloadAssets) {
    assetSubfolderDisplay.textContent = assetSubfolder || 'assets';
    assetSubfolderDisplay.classList.remove('not-set', 'hidden');
    assetSubfolderDisplay.classList.add('is-set');
    selectAssetSubfolderBtn.textContent = 'Change';
    selectAssetSubfolderBtn.classList.remove('hidden');
  } else {
    assetSubfolderDisplay.classList.add('hidden');
    selectAssetSubfolderBtn.classList.add('hidden');
  }
  if (close) assetSubfolderPicker.classList.add('hidden');
}

function updateClipButton() {
  if (clipping) return;
  const hasVault     = !!(vaultDirHandle || savedVaultHandle);
  const hasSubfolder = !!clipSubfolder;
  const count        = pageQueue.length || 1;
  clipBtn.disabled   = !(hasVault && hasSubfolder);
  clipBtn.textContent = `Clip ${count} page${count !== 1 ? 's' : ''}`;
}

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className   = 'status ' + type;
}

// --- Vault selection ---

selectVaultBtn.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    vaultDirHandle   = handle;
    savedVaultHandle = handle;
    await saveHandle('vaultDir', handle);
    updateVaultDisplay(handle);
    // Reset clip subfolder since vault changed
    clipSubfolder = '';
    await saveSetting('clipSubfolder', '');
    updateClipSubfolderDisplay();
    updateClipButton();
    setStatus('Vault set.', 'success');
  } catch (err) {
    if (err.name !== 'AbortError') setStatus('Could not select vault folder.', 'error');
  }
});

// --- Clip subfolder picker ---

selectClipSubfolderBtn.addEventListener('click', async () => {
  const isOpen = !clipSubfolderPicker.classList.contains('hidden');
  if (isOpen) {
    clipSubfolderPicker.classList.add('hidden');
    return;
  }

  const activeHandle = vaultDirHandle || savedVaultHandle;
  if (!activeHandle) {
    setStatus('Please select a vault first.', 'error');
    return;
  }

  clipSubfolderSelect.innerHTML = '<option value="">Loading…</option>';
  clipNewFolderInput.value = '';
  clipSubfolderPicker.classList.remove('hidden');

  const folders = await getSubdirectories(activeHandle);
  if (!vaultDirHandle && folders.length > 0) vaultDirHandle = activeHandle;
  await populateSelect(clipSubfolderSelect, folders, clipSubfolder);
});

// Selecting from dropdown clears the text input
clipSubfolderSelect.addEventListener('change', () => {
  if (clipSubfolderSelect.value) clipNewFolderInput.value = '';
});

// Typing clears the dropdown selection
clipNewFolderInput.addEventListener('input', () => {
  if (clipNewFolderInput.value.trim()) clipSubfolderSelect.value = '';
});

clipSubfolderConfirm.addEventListener('click', async () => {
  const value = clipSubfolderSelect.value || clipNewFolderInput.value.trim();
  if (!value) {
    setStatus('Please choose or name a subfolder.', 'error');
    return;
  }
  clipSubfolder = value;
  await saveSetting('clipSubfolder', clipSubfolder);
  // Reset asset subfolder when clip subfolder changes
  assetSubfolder = 'assets';
  await saveSetting('assetSubfolder', assetSubfolder);
  updateClipSubfolderDisplay(true);
  updateAssetSubfolderDisplay(true);
  updateClipButton();
  setStatus('Clip subfolder set.', 'success');
});

// --- Asset subfolder picker ---

downloadAssetsEl.addEventListener('change', async () => {
  downloadAssets = downloadAssetsEl.checked;
  await saveSetting('downloadAssets', downloadAssets);
  updateAssetSubfolderDisplay(true);
  updateClipButton();
});

selectAssetSubfolderBtn.addEventListener('click', async () => {
  const isOpen = !assetSubfolderPicker.classList.contains('hidden');
  if (isOpen) {
    assetSubfolderPicker.classList.add('hidden');
    return;
  }

  if (!clipSubfolder) {
    setStatus('Please set a clip subfolder first.', 'error');
    return;
  }

  const activeHandle = vaultDirHandle || savedVaultHandle;
  if (!activeHandle) {
    setStatus('Please select a vault first.', 'error');
    return;
  }

  assetSubfolderSelect.innerHTML = '<option value="">Loading…</option>';
  assetNewFolderInput.value = '';
  assetSubfolderPicker.classList.remove('hidden');

  // List subdirs inside the clip subfolder
  let clipDirHandle;
  try {
    clipDirHandle = await activeHandle.getDirectoryHandle(clipSubfolder, { create: false });
  } catch {
    clipDirHandle = null;
  }

  const folders = clipDirHandle ? await getSubdirectories(clipDirHandle) : [];
  await populateSelect(assetSubfolderSelect, folders, assetSubfolder);
});

// Selecting from dropdown clears the text input
assetSubfolderSelect.addEventListener('change', () => {
  if (assetSubfolderSelect.value) assetNewFolderInput.value = '';
});

// Typing clears the dropdown selection
assetNewFolderInput.addEventListener('input', () => {
  if (assetNewFolderInput.value.trim()) assetSubfolderSelect.value = '';
});

assetSubfolderConfirm.addEventListener('click', async () => {
  const value = assetSubfolderSelect.value || assetNewFolderInput.value.trim();
  if (!value) {
    setStatus('Please choose or name an asset subfolder.', 'error');
    return;
  }
  assetSubfolder = value;
  await saveSetting('assetSubfolder', assetSubfolder);
  updateAssetSubfolderDisplay(true);
  setStatus('Asset subfolder set.', 'success');
});

// --- Child pages toggle ---

includeChildrenEl.addEventListener('change', async () => {
  const checked = includeChildrenEl.checked;
  depthRowEl.classList.toggle('hidden', !checked);

  if (!checked) {
    // Cancel any in-progress discovery
    if (discovering) discoveryCancelled = true;
    pageQueue = [];
    discoveryProgressRow.classList.add('hidden');
    setStatus('');
    updateClipButton();
    return;
  }

  if (pageInfo?.isConfluence && pageInfo?.pageId) {
    await discoverChildPages();
  }
});

depthInputEl.addEventListener('change', async () => {
  const raw = depthInputEl.value.trim();
  if (raw !== '' && (isNaN(raw) || parseInt(raw, 10) < 1)) {
    depthInputEl.value = '1';
  } else if (raw !== '') {
    depthInputEl.value = String(parseInt(raw, 10));
  }
  if (includeChildrenEl.checked && pageInfo?.isConfluence && pageInfo?.pageId) {
    await discoverChildPages();
  }
});

async function discoverChildPages() {
  // Cancel any in-flight run and claim a new epoch
  discoveryCancelled = true;
  const myEpoch = ++discoveryEpoch;

  // Give the event loop a tick so in-flight callbacks see the cancellation
  await new Promise(r => setTimeout(r, 0));

  // Another call may have started after us — bail out if we're stale
  if (myEpoch !== discoveryEpoch) return;

  discoveryCancelled  = false;
  discovering         = true;

  setStatus('Discovering child pages…', 'loading');
  clipBtn.disabled    = true;
  clipBtn.textContent = 'Discovering…';

  // Show indeterminate discovery bar, reset count
  discoveryProgressLabel.textContent = '0 found';
  discoveryProgressRow.classList.remove('hidden');

  const depthVal = depthInputEl.value.trim();
  const maxDepth = depthVal === '' ? Infinity : Math.max(1, parseInt(depthVal, 10));
  const baseUrl  = new URL(pageInfo.url).origin;

  try {
    const children = await fetchChildPages(
      baseUrl, pageInfo.pageId, maxDepth, 0, () => discoveryCancelled || myEpoch !== discoveryEpoch,
      (count) => {
        // Ignore callbacks from a superseded run
        if (myEpoch !== discoveryEpoch) return;
        discoveryProgressLabel.textContent = `${count} found`;
      }
    );

    if (myEpoch !== discoveryEpoch || discoveryCancelled) {
      discovering = false;
      return;
    }

    discovering = false;
    discoveryProgressRow.classList.add('hidden');

    pageQueue = [
      { url: pageInfo.url, title: pageInfo.title, confluencePageId: pageInfo.pageId, depth: -1, parentId: null },
      ...children.map(c => ({ url: c.url, title: c.title, confluencePageId: c.id, depth: c.depth, parentId: c.parentId })),
    ];

    setStatus(`Found ${children.length} child page${children.length !== 1 ? 's' : ''}.`);
    updateClipButton();
  } catch (err) {
    if (myEpoch !== discoveryEpoch || discoveryCancelled) {
      discovering = false;
      return;
    }
    discovering = false;
    discoveryProgressRow.classList.add('hidden');
    setStatus(`Failed to discover child pages: ${err.message}`, 'error');
    pageQueue = [];
    updateClipButton();
  }
}

// --- Live HTML helper ---

/**
 * Request the live rendered HTML from the active tab's content script.
 * Returns { html, url } or null if the content script is unavailable.
 * This captures JS-rendered content (draw.io, Gliffy, etc.) that fetch() misses.
 */
function getLiveHtmlFromTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) { resolve(null); return; }
    chrome.tabs.sendMessage(tabId, { action: 'getLiveHtml' }, (response) => {
      if (chrome.runtime.lastError || !response) { resolve(null); return; }
      resolve(response);
    });
  });
}

// --- Permission helper ---

async function ensurePermission(saved, active) {
  if (active) return active;
  if (!saved) return null;
  try {
    let perm = await saved.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return saved;
    perm = await saved.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') return saved;
  } catch { /* stale handle */ }
  return null;
}

// --- Main clip action ---

clipBtn.addEventListener('click', async () => {
  if (clipping) return;

  const activeVault = await ensurePermission(savedVaultHandle, vaultDirHandle);
  if (!activeVault) {
    setStatus('Please select a Vault folder first.', 'error');
    return;
  }
  vaultDirHandle = activeVault;

  if (!clipSubfolder) {
    setStatus('Please set a clip subfolder first.', 'error');
    return;
  }

  if (pageQueue.length === 0) {
    const entry = { url: pageInfo.url, title: pageInfo.title };
    if (pageInfo.isConfluence && pageInfo.pageId) {
      entry.confluencePageId = pageInfo.pageId;
    }
    pageQueue = [entry];
  }

  clipping    = true;
  cancelled   = false;
  discovering = false;
  clipBtn.classList.add('hidden');
  cancelBtn.classList.remove('hidden');
  progressListEl.innerHTML = '';

  pageQueue.forEach((page, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="page-name" title="${page.title}">${page.title}</span>
      <span class="item-status pending" id="item-${i}">·</span>
    `;
    progressListEl.appendChild(li);
  });

  let successCount     = 0;
  let errorCount       = 0;
  let lastClippedTitle = null;

  const clipLog = []; // { title, url, filename, status, error }

  // Build hierarchy path map: pageId -> subfolder segments for hierarchical clipping.
  // Only used when batch has multiple pages (single-page clips use flat clipSubfolder).
  const pageIdToSegments = new Map();
  if (pageQueue.length > 1) {
    // Map pageId -> sanitised title for ancestor lookup
    const idToTitle = new Map();
    for (const page of pageQueue) {
      if (page.confluencePageId) {
        idToTitle.set(page.confluencePageId, sanitiseTitle(page.title || ''));
      }
    }
    // Root page (index 0, depth -1) goes directly in clipSubfolder
    const rootPage = pageQueue[0];
    if (rootPage.confluencePageId) {
      pageIdToSegments.set(rootPage.confluencePageId, [clipSubfolder]);
    }
    // For each child page, walk ancestor chain to build path segments
    for (const page of pageQueue.slice(1)) {
      if (!page.confluencePageId) continue;
      // Walk up parentId chain to build ancestor title segments
      const segments = [clipSubfolder];
      const chain = [];
      let current = page;
      while (current.parentId) {
        const parentPage = pageQueue.find(p => p.confluencePageId === current.parentId);
        if (!parentPage) break;
        chain.unshift(sanitiseTitle(parentPage.title || ''));
        current = parentPage;
        if (current.depth === -1) break; // reached root
      }
      segments.push(...chain);
      pageIdToSegments.set(page.confluencePageId, segments);
    }
  }

  for (let i = 0; i < pageQueue.length; i++) {
    if (cancelled) break;

    const page   = pageQueue[i];
    const itemEl = document.getElementById(`item-${i}`);
    if (itemEl) { itemEl.textContent = '↓'; itemEl.className = 'item-status downloading'; }

    setStatus(`Clipping ${i + 1} of ${pageQueue.length}…`, 'loading');

    // Set confluenceBaseUrl whenever the page is on a Confluence host, even if we don't
    // have a pageId yet — clipPage will call resolvePageId to look it up via REST API.
    const { isConfluence } = detectConfluence(page.url);
    const confluenceBaseUrl = (page.confluencePageId || isConfluence) ? new URL(page.url).origin : null;

    assetProgressRow.classList.add('hidden');
    assetProgressBar.style.width = '0%';

    // For the first page (the active tab), use live rendered HTML so JS-rendered
    // content (draw.io, Gliffy, etc.) is captured. Child pages fall back to fetch().
    let liveHtml = null;
    if (i === 0 && activeTabId) {
      const live = await getLiveHtmlFromTab(activeTabId);
      if (live && live.html) liveHtml = live.html;
    }

    const clipSubfolderSegments = pageIdToSegments.get(page.confluencePageId) || null;

    const result = await clipPage({
      url:               page.url,
      confluencePageId:  page.confluencePageId || null,
      confluenceBaseUrl,
      liveHtml,
      vaultDir:          vaultDirHandle,
      clipSubfolder,
      clipSubfolderSegments,
      downloadAssets,
      assetSubfolder,
      isCancelled:       () => cancelled,
      onAssetProgress:   downloadAssets ? (done, total) => {
        if (total < 2) return; // not worth showing for 0-1 assets
        assetProgressRow.classList.remove('hidden');
        assetProgressLabel.textContent = `Assets: ${done} / ${total}`;
        assetProgressBar.style.width = `${Math.round((done / total) * 100)}%`;
      } : undefined,
    });

    if (result.error) {
      errorCount++;
      if (itemEl) { itemEl.textContent = '✗'; itemEl.className = 'item-status error'; }
      if (result.error !== 'cancelled') {
        console.error(`Batch Clipper: failed ${page.url} — ${result.error}`);
        if (itemEl) itemEl.title = result.error;
      }
      clipLog.push({ title: page.title || page.url, url: page.url, filename: null, status: 'failed', error: result.error });
    } else {
      successCount++;
      lastClippedTitle = result.title;
      if (itemEl) { itemEl.textContent = '✓'; itemEl.className = 'item-status done'; }
      clipLog.push({ title: result.title || page.title || page.url, url: page.url, filename: result.filename, status: 'ok', error: null });
    }
  }

  // Write clip log (always for batch, top-level in vault)
  let clipLogWritten = false;
  if (clipLog.length > 1 && vaultDirHandle) {
    try {
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      const ok     = clipLog.filter(e => e.status === 'ok');
      const failed = clipLog.filter(e => e.status === 'failed');

      // Build a map from confluencePageId -> log entry for tree rendering
      const idToEntry = new Map();
      for (let i = 0; i < pageQueue.length; i++) {
        const page = pageQueue[i];
        if (page.confluencePageId) idToEntry.set(page.confluencePageId, clipLog[i]);
      }

      // Render tree: root is pageQueue[0] (depth -1), children are depth 0, 1, 2...
      // We render in pageQueue order (which is already depth-first from fetchChildPages).
      // Indent level = depth + 1 (root is depth -1 → indent 0).
      function renderEntry(entry, depth) {
        const indent = '  '.repeat(Math.max(0, depth));
        const icon = entry.status === 'ok' ? '✓' : '✗';
        const link = entry.status === 'ok'
          ? `[[${sanitiseTitle(entry.title)}]]`
          : `[${entry.title}](${entry.url})`;
        const errSuffix = entry.error && entry.error !== 'cancelled' ? ` — \`${entry.error}\`` : '';
        return `${indent}- ${icon} ${link}${errSuffix}`;
      }

      const lines = [
        `# clipper-log`,
        '',
        `${dateStr} ${timeStr} — **${ok.length} clipped** | **${failed.length} failed** | **${clipLog.length} total**`,
        '',
        '## Pages',
        '',
      ];

      for (let i = 0; i < pageQueue.length && i < clipLog.length; i++) {
        const page  = pageQueue[i];
        const entry = clipLog[i];
        const depth = page.depth === -1 ? 0 : (page.depth ?? 0) + 1;
        lines.push(renderEntry(entry, depth));
      }

      if (failed.length) {
        lines.push('', '## Failed', '');
        for (const e of failed) {
          const errSuffix = e.error && e.error !== 'cancelled' ? ` — \`${e.error}\`` : '';
          lines.push(`- [${e.title}](${e.url})${errSuffix}`);
        }
      }

      lines.push('');
      await writeTextFile(lines.join('\n'), 'clipper-log.md', vaultDirHandle);
      clipLogWritten = true;
    } catch (e) {
      console.error('Batch Clipper: failed to write clip log', e);
    }
  }

  clipping = false;
  cancelBtn.classList.add('hidden');
  clipBtn.classList.remove('hidden');
  assetProgressRow.classList.add('hidden');

  if (cancelled) {
    setStatus(`Cancelled. ${successCount} clipped, ${pageQueue.length - successCount - errorCount} skipped.`);
  } else if (errorCount === 0) {
    if (successCount === 1 && lastClippedTitle) {
      const safeTitle = sanitiseTitle(lastClippedTitle);
      setStatus(`Saved to ${clipSubfolder}/${safeTitle}.md`, 'success');
    } else {
      setStatus(`Done! ${successCount} pages clipped.`, 'success');
    }
  } else {
    setStatus(`${successCount} clipped, ${errorCount} failed.`, errorCount === pageQueue.length ? 'error' : '');
  }

  // Open clipper-log in Obsidian after a batch, otherwise open the single clipped file.
  if (successCount > 0 && !cancelled) {
    const vaultName = encodeURIComponent(vaultDirHandle.name);
    let filePath;
    if (clipLogWritten) {
      filePath = encodeURIComponent('clipper-log');
    } else if (lastClippedTitle) {
      filePath = encodeURIComponent(clipSubfolder + '/' + sanitiseTitle(lastClippedTitle));
    }
    if (filePath) {
      const obsidianUrl = `obsidian://open?vault=${vaultName}&file=${filePath}`;
      chrome.runtime.sendMessage({ action: 'openObsidian', url: obsidianUrl });
    }
  }

  clipBtn.textContent = 'Done';
  clipBtn.disabled    = false;
  clipBtn.onclick     = () => window.close();
  pageQueue = [];
});

cancelBtn.addEventListener('click', () => {
  cancelled             = true;
  cancelBtn.disabled    = true;
  cancelBtn.textContent = 'Cancelling…';
  setStatus('Cancelling after current page…', 'loading');
});

// --- Init ---

async function init() {
  try {
    const vault = await loadHandle('vaultDir');
    if (vault) {
      savedVaultHandle = vault;
      const perm = await vault.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') vaultDirHandle = vault;
      updateVaultDisplay(vault);
    }
  } catch { /* ignore */ }

  [clipSubfolder, downloadAssets, assetSubfolder] = await Promise.all([
    loadSetting('clipSubfolder', ''),
    loadSetting('downloadAssets', false),
    loadSetting('assetSubfolder', 'assets'),
  ]);

  downloadAssetsEl.checked = downloadAssets;
  updateClipSubfolderDisplay(true);
  updateAssetSubfolderDisplay(true);

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) {
      pageTitleEl.textContent = 'No active tab';
      return;
    }

    activeTabId = tab.id;

    chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' }, async (response) => {
      if (!chrome.runtime.lastError && response) {
        applyPageInfo(response);
        return;
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
        });
      } catch {
        pageTitleEl.textContent = 'Cannot scan this page';
        setStatus('Cannot scan this page (restricted URL).', 'error');
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'getPageInfo' }, (response2) => {
        if (chrome.runtime.lastError || !response2) {
          pageTitleEl.textContent = tab.title || 'Unknown page';
          pageInfo = { url: tab.url, title: tab.title, isConfluence: false, pageId: null };
          setStatus('Could not scan page. Try reloading the tab.', 'error');
          childPagesSectionEl.classList.add('hidden');
          updateClipButton();
          return;
        }
        applyPageInfo(response2);
      });
    });
  });

  updateClipButton();
}

function applyPageInfo(info) {
  pageInfo = info;
  pageTitleEl.textContent = info.title || 'Untitled';

  if (info.isConfluence) {
    childPagesSectionEl.classList.remove('hidden');
  } else {
    childPagesSectionEl.classList.add('hidden');
  }

  updateClipButton();
}

init();
