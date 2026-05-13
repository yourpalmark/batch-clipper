// Generates icons/icon16.png, icon48.png, icon128.png from an SVG string.
// Run with: node generate_icons.js

const sharp = require('sharp');
const path = require('path');

// Material "download" icon path, viewBox 0 -960 960 960.
// Embedded in a 960x960 canvas via translate(0,960).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="120 120 720 720">
  <g transform="translate(0,960)" fill="#00b4c8">
    <path d="M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200Z
             M240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120
             q0 33-23.5 56.5T720-160H240Z"/>
  </g>
</svg>`;

const buf = Buffer.from(svg);

async function generate() {
  for (const size of [16, 48, 128]) {
    const out = path.join('icons', `icon${size}.png`);
    await sharp(buf).resize(size, size).png().toFile(out);
    console.log(`Created ${out}`);
  }
}

generate().catch((err) => { console.error(err); process.exit(1); });
