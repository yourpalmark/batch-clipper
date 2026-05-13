// tests/assets.test.js

const { scanAssets, buildRewriteMap, rewriteMarkdownUrls } = require('../lib/assets');

describe('scanAssets', () => {
  test('finds images in HTML', () => {
    const html = '<div><img src="https://example.com/photo.png"><p>Text</p></div>';
    const assets = scanAssets(html, 'https://example.com/page');
    expect(assets).toHaveLength(1);
    expect(assets[0].url).toBe('https://example.com/photo.png');
    expect(assets[0].filename).toBe('photo.png');
  });

  test('resolves relative URLs against base', () => {
    const html = '<img src="/images/diagram.svg">';
    const assets = scanAssets(html, 'https://example.com/docs/page');
    expect(assets).toHaveLength(1);
    expect(assets[0].url).toBe('https://example.com/images/diagram.svg');
  });

  test('skips small images (likely icons)', () => {
    const html = '<img src="https://example.com/icon.png" width="16">';
    const assets = scanAssets(html, 'https://example.com');
    expect(assets).toHaveLength(0);
  });

  test('skips data URIs', () => {
    const html = '<img src="data:image/png;base64,abc123">';
    const assets = scanAssets(html, 'https://example.com');
    expect(assets).toHaveLength(0);
  });

  test('deduplicates identical URLs', () => {
    const html = '<img src="https://example.com/a.png"><img src="https://example.com/a.png">';
    const assets = scanAssets(html, 'https://example.com');
    expect(assets).toHaveLength(1);
  });

  test('finds linked documents', () => {
    const html = '<a href="https://example.com/report.pdf">Download</a>';
    const assets = scanAssets(html, 'https://example.com');
    expect(assets).toHaveLength(1);
    expect(assets[0].filename).toBe('report.pdf');
  });

  test('skips non-asset links', () => {
    const html = '<a href="https://example.com/other-page">Link</a>';
    const assets = scanAssets(html, 'https://example.com');
    expect(assets).toHaveLength(0);
  });

  test('finds video and audio sources', () => {
    const html = `
      <video src="https://example.com/vid.mp4"></video>
      <audio><source src="https://example.com/song.mp3"></audio>
    `;
    const assets = scanAssets(html, 'https://example.com');
    expect(assets).toHaveLength(2);
  });
});

describe('buildRewriteMap', () => {
  test('maps remote URLs to local relative paths', () => {
    const assets = [
      { url: 'https://example.com/photo.png', filename: 'photo.png' },
      { url: 'https://example.com/diagram.svg', filename: 'diagram.svg' },
    ];
    const map = buildRewriteMap(assets, 'My Page', 'assets');

    expect(map.get('https://example.com/photo.png')).toBe('assets/My%20Page/photo.png');
    expect(map.get('https://example.com/diagram.svg')).toBe('assets/My%20Page/diagram.svg');
  });
});

describe('rewriteMarkdownUrls', () => {
  test('replaces remote URLs with local paths in image syntax', () => {
    const md = '![diagram](https://example.com/diagram.png)';
    const map = new Map([['https://example.com/diagram.png', 'assets/Page/diagram.png']]);
    expect(rewriteMarkdownUrls(md, map)).toBe('![diagram](assets/Page/diagram.png)');
  });

  test('replaces URLs in link syntax', () => {
    const md = '[download](https://example.com/report.pdf)';
    const map = new Map([['https://example.com/report.pdf', 'assets/Page/report.pdf']]);
    expect(rewriteMarkdownUrls(md, map)).toBe('[download](assets/Page/report.pdf)');
  });

  test('replaces multiple occurrences of the same URL', () => {
    const md = '![a](https://example.com/img.png) and ![b](https://example.com/img.png)';
    const map = new Map([['https://example.com/img.png', 'assets/P/img.png']]);
    expect(rewriteMarkdownUrls(md, map)).toBe('![a](assets/P/img.png) and ![b](assets/P/img.png)');
  });

  test('leaves markdown unchanged when no URLs match', () => {
    const md = '![alt](https://other.com/img.png)';
    const map = new Map([['https://example.com/img.png', 'assets/P/img.png']]);
    expect(rewriteMarkdownUrls(md, map)).toBe(md);
  });
});
