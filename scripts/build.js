// scripts/build.js
// Bundle defuddle/full for use in the Chrome extension popup context.
// Outputs defuddle.bundle.js which exposes Defuddle and createMarkdownContent
// as globals on `globalThis`.

const esbuild = require('esbuild');
const path = require('path');

const entryContent = `
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';

globalThis.Defuddle = Defuddle;
globalThis.createMarkdownContent = createMarkdownContent;
`;

const entryPath = path.join(__dirname, '..', '_defuddle-entry.js');
require('fs').writeFileSync(entryPath, entryContent);

esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'iife',
  outfile: path.join(__dirname, '..', 'defuddle.bundle.js'),
  platform: 'browser',
  target: 'chrome120',
  minify: false,
}).then(() => {
  // Clean up temp entry file
  require('fs').unlinkSync(entryPath);
  console.log('Built defuddle.bundle.js');
}).catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
