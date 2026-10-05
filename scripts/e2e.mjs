/**
 * End-to-end check against the real provider.
 *
 * Drives the registered tool exactly as an agent call would, using the Figma
 * assets in this workspace as references, then verifies the written files really
 * are 400x400 WebP. This is the only test that spends provider credits, so it
 * is a script rather than part of the default suite.
 *
 * Usage:
 *   node --import ./test/register-stubs.mjs scripts/e2e.mjs [count] [prompt]
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { apply } from '../plugin.mjs';
import { isWebp, readWebpSize } from '../lib/webp.mjs';

const count = Number(process.argv[2] ?? 2);
const prompt = process.argv[3] ?? 'the matte dark grey USB-C charging accessories from the reference series';
const workspace = process.cwd();
const outputDir = join(workspace, '_e2e-output');

if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });

/** Read the Ark key the same way the plugin's credential seam would. */
function apiKeyFromCredentials() {
  const path = join(process.env.USERPROFILE ?? '', '.dsh', '.credentials.yaml');
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  const refs = /^refs:\s*\r?\n([\s\S]*)$/m.exec(text)?.[1] ?? '';
  const match = /^\s+ARK_API_KEY:\s*(.+?)\s*$/m.exec(refs);
  return match?.[1].trim().replace(/^['"]|['"]$/g, '');
}

const apiKey = process.env.ARK_API_KEY ?? apiKeyFromCredentials();
if (apiKey === undefined || apiKey.length === 0) {
  console.error('no ARK_API_KEY found in the environment or ~/.dsh/.credentials.yaml');
  process.exit(1);
}

let definition;
const ctx = {
  tools: { register: (d) => { definition = d; return () => {}; } },
  credentials: { resolve: async (ref) => (ref === 'ARK_API_KEY' ? { value: apiKey } : undefined) },
};
apply(ctx, { outputFolder: '_e2e-output', maxReferences: 4, concurrency: 2 });
if (definition === undefined) {
  console.error('plugin did not register a tool');
  process.exit(1);
}

const exec = { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal };

console.log(`generating ${count} frame(s) at 400x400 into ${outputDir}`);
console.log(`references: scanning ${workspace}`);
const started = Date.now();

let result;
try {
  result = await definition.execute({ prompt, count, outputDir: '_e2e-output' }, exec);
} catch (error) {
  console.error('generation failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`\nfinished in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`requested=${result.requested} generated=${result.generated} failed=${result.failed}`);
console.log(`referenceDir=${result.referenceDir} referenceCount=${result.referenceCount} model=${result.model}`);

let failures = 0;
for (const [index, image] of result.images.entries()) {
  const bytes = readFileSync(image.path);
  const size = isWebp(bytes) ? readWebpSize(bytes) : { width: 0, height: 0, format: 'not-webp' };
  const ok = image.width === 400
    && image.height === 400
    && size.format === 'webp'
    && size.width === 400
    && size.height === 400
    && bytes.length === image.bytes;
  if (!ok) failures++;
  console.log(
    `${ok ? 'OK  ' : 'BAD '} frame ${index + 1}: ${image.path} `
    + `${size.width}x${size.height} ${size.format} ${bytes.length} bytes`,
  );
}
for (const failure of result.failures) console.log(`FAIL frame ${failure.frame}: ${failure.reason}`);

// Also render exactly what the model would read.
console.log('\n--- model-facing content ---');
for (const block of definition.output.render({}, result)) console.log(block.text);

process.exit(failures === 0 && result.generated === count ? 0 : 1);
