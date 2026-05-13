// lib/fs-utils.js
// File System Access API helpers, adapted from Asset Clipper.

/**
 * Navigate into a nested directory path, creating folders as needed.
 * @param {FileSystemDirectoryHandle} root - starting directory handle
 * @param {string[]} pathSegments - folder names to walk/create
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
async function getOrCreateDir(root, pathSegments) {
  let current = root;
  for (const segment of pathSegments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

/**
 * Fetch a URL and write the response body to a file in the given directory.
 * Uses the browser's active session cookies for authenticated downloads.
 * @param {string} url - asset URL to fetch
 * @param {string} filename - destination filename
 * @param {FileSystemDirectoryHandle} dirHandle - target directory
 */
async function fetchAndWrite(url, filename, dirHandle) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const blob = await response.blob();
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Write a string to a file in the given directory.
 * @param {string} content - file content
 * @param {string} filename - destination filename
 * @param {FileSystemDirectoryHandle} dirHandle - target directory
 */
async function writeTextFile(content, filename, dirHandle) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

if (typeof module !== 'undefined') {
  module.exports = { getOrCreateDir, fetchAndWrite, writeTextFile };
}
