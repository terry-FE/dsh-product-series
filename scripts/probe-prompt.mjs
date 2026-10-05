/**
 * Prompt probe: does an explicit "isolate one product" instruction actually
 * change the result? Writes one frame per variant for visual comparison.
 *
 * Usage: node scripts/probe-prompt.mjs
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { generateImages } from '../lib/ark.mjs';
import { resizeToWebp } from '../lib/image-ffmpeg.mjs';
import { buildPrompt, scanReferenceImages, readReferences } from '../lib/series.mjs';

const workspace = process.cwd();
const outDir = join(workspace, '_probe-output');
mkdirSync(outDir, { recursive: true });

function apiKeyFromCredentials() {
  const path = join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml');
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  const refs = /^refs:\s*\r?\n([\s\S]*)$/m.exec(text)?.[1] ?? '';
  return /^\s+ARK_API_KEY:\s*(.+?)\s*$/m.exec(refs)?.[1].trim().replace(/^['"]|['"]$/g, '');
}

const apiKey = process.env.ARK_API_KEY ?? apiKeyFromCredentials();

// Attach the Figma artwork, exactly as the plugin does at run time. Defaults to
// the parent workspace so the real `figma-import` / `figma-bridge` export is in
// scope; pass a directory as argv[2] to point somewhere else.
const referenceRoot = process.argv[2] ?? join(workspace, '..');
const refs = await readReferences(await scanReferenceImages(referenceRoot), { maxBytes: 12 * 1024 * 1024 });
console.log('reference root:', referenceRoot);
console.log('references:', refs.map((r) => r.name).join(', ') || '(none)');

const subject = 'a matte dark grey braided USB-C charging cable, coiled';

const variants = {
  // The wording the plugin shipped before the isolation clause was added.
  'a-without-isolation': [
    `Product photograph: ${subject}.`,
    'The attached reference image shows the product family; match its look exactly and do not redesign it.',
    'Keep the entire series visually consistent: the same seamless studio backdrop and colour, the same soft diffused lighting direction.',
    'Square 1:1 composition with the product centred and not cropped.',
    'Photorealistic commercial product photography, no text, no logos, no watermark, no collage.',
  ].join(' '),
  // What buildPrompt now produces.
  'b-buildPrompt': buildPrompt({ prompt: subject, index: 0, count: 1, referenceCount: refs.length }),
};

for (const [label, prompt] of Object.entries(variants)) {
  const started = Date.now();
  const images = await generateImages({
    apiKey,
    prompt,
    references: refs.slice(0, 4).map((r) => ({ data: r.data, mediaType: r.mediaType })),
    size: '2K',
    outputFormat: 'png',
    watermark: false,
  });
  const scaled = resizeToWebp({ data: images[0].data, width: 400, height: 400 });
  const path = join(outDir, `${label}.webp`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, scaled.data);
  console.log(`${label}: ${path} in ${Math.round((Date.now() - started) / 1000)}s`);
}
