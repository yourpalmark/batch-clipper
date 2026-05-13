// flatten-shadow-dom.js
// Runs in the MAIN world (declared web_accessible_resources + injected via <script> tag).
// Content scripts cannot read shadowRoot content due to Chrome's isolated world.
// This script stamps each shadow root's innerHTML into a data attribute so defuddle
// can read it from the serialized DOM.
// Mirrors the approach used by Obsidian Web Clipper.
(function () {
  document.querySelectorAll('*').forEach(function (el) {
    if (el.shadowRoot && el.shadowRoot.innerHTML) {
      el.setAttribute('data-defuddle-shadow', el.shadowRoot.innerHTML);
    }
  });
})();
