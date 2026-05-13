// tests/frontmatter.test.js

const { generateFrontmatter, escapeYaml } = require('../lib/frontmatter');

describe('escapeYaml', () => {
  test('escapes double quotes', () => {
    expect(escapeYaml('Say "hello"')).toBe('Say \\"hello\\"');
  });

  test('escapes backslashes', () => {
    expect(escapeYaml('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  test('passes through clean strings', () => {
    expect(escapeYaml('simple title')).toBe('simple title');
  });
});

describe('generateFrontmatter', () => {
  test('generates default frontmatter with all fields', () => {
    const result = generateFrontmatter({
      title: 'My Page',
      url: 'https://example.com/page',
      author: 'John Doe',
      published: '2025-01-15',
      description: 'A test page',
      created: '2025-05-13T12:00:00Z',
    });

    expect(result).toContain('---');
    expect(result).toContain('title: "My Page"');
    expect(result).toContain('source: "https://example.com/page"');
    expect(result).toContain('author: "John Doe"');
    expect(result).toContain('published: "2025-01-15"');
    expect(result).toContain('created: 2025-05-13T12:00:00Z');
    expect(result).toContain('description: "A test page"');
    expect(result).toContain('tags: clippings');
  });

  test('handles missing optional fields', () => {
    const result = generateFrontmatter({
      title: 'Minimal',
      url: 'https://example.com',
    });

    expect(result).toContain('title: "Minimal"');
    expect(result).toContain('source: "https://example.com"');
    expect(result).toContain('author:');
    expect(result).toContain('published:');
    expect(result).toContain('tags: clippings');
    // Empty author/published should be bare keys (no quotes)
    expect(result).not.toContain('author: ""');
  });

  test('escapes special characters in title', () => {
    const result = generateFrontmatter({
      title: 'Page "with" quotes',
      url: 'https://example.com',
    });

    expect(result).toContain('title: "Page \\"with\\" quotes"');
  });

  test('auto-generates created timestamp when not provided', () => {
    const result = generateFrontmatter({
      title: 'Test',
      url: 'https://example.com',
    });

    // Should have a created field with an ISO-ish timestamp
    expect(result).toMatch(/created: \d{4}-\d{2}-\d{2}T/);
  });
});
