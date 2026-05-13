// tests/confluence.test.js

const { detectConfluence } = require('../lib/confluence');

describe('detectConfluence', () => {
  test('detects classic Confluence URL with pageId', () => {
    const result = detectConfluence(
      'https://confluence.walmart.com/pages/viewpage.action?pageId=12345'
    );
    expect(result.isConfluence).toBe(true);
    expect(result.pageId).toBe('12345');
    expect(result.baseUrl).toBe('https://confluence.walmart.com');
  });

  test('detects wiki-style /display/ URL without pageId', () => {
    const result = detectConfluence(
      'https://confluence.walmart.com/display/TEX/Release+Ramp+Overview'
    );
    expect(result.isConfluence).toBe(true);
    expect(result.pageId).toBeNull();
    expect(result.baseUrl).toBe('https://confluence.walmart.com');
  });

  test('detects Confluence Cloud /wiki/ URL', () => {
    const result = detectConfluence(
      'https://mycompany.atlassian.net/wiki/spaces/DEV/pages/123/My+Page'
    );
    expect(result.isConfluence).toBe(true);
    expect(result.pageId).toBeNull();
  });

  test('returns false for non-Confluence URLs', () => {
    const result = detectConfluence('https://github.com/some/repo');
    expect(result.isConfluence).toBe(false);
    expect(result.pageId).toBeNull();
  });

  test('returns false for malformed URLs', () => {
    const result = detectConfluence('not-a-url');
    expect(result.isConfluence).toBe(false);
  });

  test('handles Confluence URL with extra query params', () => {
    const result = detectConfluence(
      'https://confluence.example.com/pages/viewpage.action?pageId=99999&src=sidebar'
    );
    expect(result.isConfluence).toBe(true);
    expect(result.pageId).toBe('99999');
  });
});
