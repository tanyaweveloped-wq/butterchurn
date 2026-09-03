// merge-presets.js
//
// Merges every individual preset JSON file in a directory into one bundle
// file, keyed by preset name (matching what getPresetData() in index.html
// expects — the same keys used in preset-playlists.json).
//
// Usage:
//   node merge-presets.js ./presets ./presets-bundle.json
//
// Run this whenever presets/ changes, then re-deploy presets-bundle.json
// alongside it. Bump PRESET_BUNDLE_VERSION in index.html at the same time
// so already-installed clients know to re-download and re-unpack it.

const fs = require('fs');
const path = require('path');

const [, , srcDir, outFile] = process.argv;

if (!srcDir || !outFile) {
  console.error('Usage: node merge-presets.js <presets-dir> <output-file.json>');
  process.exit(1);
}

const bundle = {};
let count = 0;
let skipped = 0;

for (const file of fs.readdirSync(srcDir)) {
  if (!file.toLowerCase().endsWith('.json')) continue;

  // Filenames are literal (spaces, %, #, etc. appear as-is on disk) — the
  // key is just the filename with ".json" stripped, no decoding. This has
  // to match what getPresetData() in index.html expects: it fetches
  // `/presets/${encodeURIComponent(key)}.json`, relying on the static file
  // server decoding the URL path back to these same literal characters.
  const key = file.slice(0, -'.json'.length);
  const fullPath = path.join(srcDir, file);

  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    bundle[key] = JSON.parse(raw);
    count++;
  } catch (err) {
    console.warn(`Skipping "${file}": ${err.message}`);
    skipped++;
  }
}

fs.writeFileSync(outFile, JSON.stringify(bundle));

const sizeMB = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
console.log(`Bundled ${count} preset(s)${skipped ? ` (${skipped} skipped due to errors)` : ''} → ${outFile} (${sizeMB} MB)`);
