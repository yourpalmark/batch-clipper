// tests/utils.test.js

const { sanitiseTitle, decodeFilenameFromUrl, encodeFilenameForMarkdown, SUPPORTED_EXTENSIONS } = require('../lib/utils');

describe('sanitiseTitle', () => {
  test('replaces illegal filename characters with hyphens', () => {
    expect(sanitiseTitle('My Page: A "Test"')).toBe('My Page- A -Test');
  });

  test('trims trailing dots and separators', () => {
    expect(sanitiseTitle('My Page...')).toBe('My Page');
    expect(sanitiseTitle('My Page - ')).toBe('My Page');
  });

  test('returns Untitled for empty string', () => {
    expect(sanitiseTitle('')).toBe('Untitled');
    expect(sanitiseTitle('   ')).toBe('Untitled');
  });

  test('handles normal titles unchanged', () => {
    expect(sanitiseTitle('Release Ramp Overview')).toBe('Release Ramp Overview');
  });
});

describe('decodeFilenameFromUrl', () => {
  test('extracts filename from a simple URL', () => {
    expect(decodeFilenameFromUrl('https://example.com/images/photo.png')).toBe('photo.png');
  });

  test('decodes percent-encoded filenames', () => {
    expect(decodeFilenameFromUrl('https://example.com/my%20file%20(1).pdf')).toBe('my file (1).pdf');
  });

  test('returns null for URLs without a file extension', () => {
    expect(decodeFilenameFromUrl('https://example.com/page')).toBeNull();
  });

  test('returns null for URLs with no path', () => {
    expect(decodeFilenameFromUrl('https://example.com/')).toBeNull();
  });

  test('strips query strings', () => {
    expect(decodeFilenameFromUrl('https://example.com/img.jpg?size=large')).toBe('img.jpg');
  });
});

describe('encodeFilenameForMarkdown', () => {
  test('encodes spaces', () => {
    expect(encodeFilenameForMarkdown('my file.png')).toBe('my%20file.png');
  });

  test('encodes parentheses', () => {
    expect(encodeFilenameForMarkdown('file (1).png')).toBe('file%20%281%29.png');
  });

  test('leaves normal characters alone', () => {
    expect(encodeFilenameForMarkdown('simple.png')).toBe('simple.png');
  });
});

describe('SUPPORTED_EXTENSIONS', () => {
  test('includes common image formats', () => {
    expect(SUPPORTED_EXTENSIONS.has('png')).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has('jpg')).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has('svg')).toBe(true);
  });

  test('includes document formats', () => {
    expect(SUPPORTED_EXTENSIONS.has('pdf')).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has('docx')).toBe(true);
  });

  test('does not include random extensions', () => {
    expect(SUPPORTED_EXTENSIONS.has('exe')).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has('js')).toBe(false);
  });
});
