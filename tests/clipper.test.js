// tests/clipper.test.js

const { preprocessHtml } = require('../lib/clipper');

describe('preprocessHtml', () => {
  test('unwraps Confluence inline comment markers, preserving text', () => {
    const doc = new DOMParser().parseFromString(
      '<p>Before <span class="inline-comment-marker" data-ref="abc">commented text</span> after.</p>',
      'text/html'
    );

    preprocessHtml(doc);

    const p = doc.querySelector('p');
    expect(p.textContent).toBe('Before commented text after.');
    expect(doc.querySelector('.inline-comment-marker')).toBeNull();
  });

  test('unwraps data-inline-comment attributes', () => {
    const doc = new DOMParser().parseFromString(
      '<p>Start <span data-inline-comment="123">marked</span> end.</p>',
      'text/html'
    );

    preprocessHtml(doc);

    expect(doc.querySelector('[data-inline-comment]')).toBeNull();
    expect(doc.querySelector('p').textContent).toBe('Start marked end.');
  });

  test('handles nested elements inside comment markers', () => {
    const doc = new DOMParser().parseFromString(
      '<p><span class="inline-comment-marker"><strong>bold commented</strong> text</span></p>',
      'text/html'
    );

    preprocessHtml(doc);

    expect(doc.querySelector('.inline-comment-marker')).toBeNull();
    expect(doc.querySelector('strong')).not.toBeNull();
    expect(doc.querySelector('strong').textContent).toBe('bold commented');
  });

  test('handles multiple comment markers in one document', () => {
    const doc = new DOMParser().parseFromString(
      '<p><span class="inline-comment-marker">first</span> and <span class="inline-comment-marker">second</span></p>',
      'text/html'
    );

    preprocessHtml(doc);

    expect(doc.querySelectorAll('.inline-comment-marker')).toHaveLength(0);
    expect(doc.querySelector('p').textContent).toBe('first and second');
  });

  test('does nothing when no comment markers exist', () => {
    const doc = new DOMParser().parseFromString(
      '<p>Normal <strong>content</strong> here.</p>',
      'text/html'
    );

    preprocessHtml(doc);

    expect(doc.querySelector('p').textContent).toBe('Normal content here.');
  });

  test('handles comment-containing class names', () => {
    const doc = new DOMParser().parseFromString(
      '<p><span data-ref="x" class="some-other-comment-marker">text</span></p>',
      'text/html'
    );

    preprocessHtml(doc);

    // The selector span[data-ref][class*="comment"] should match
    expect(doc.querySelector('[data-ref]')).toBeNull();
    expect(doc.querySelector('p').textContent).toBe('text');
  });
});
