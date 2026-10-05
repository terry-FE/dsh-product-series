/**
 * Domain-logic tests: reference discovery, prompt composition, and output path
 * handling. These run without a DSH host, so a regression here is caught before
 * a provider call is ever paid for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildPrompt,
  detectMediaType,
  IMAGE_EXTENSIONS,
  OUTPUT_EXTENSION,
  readReferences,
  resolveOutputDir,
  resolveReferenceDir,
  scanReferenceImages,
  selectReferences,
  SHOT_VARIATIONS,
  slugify,
  uniquePath,
  writeFrame,
} from '../lib/series.mjs';

const ROOT = join(tmpdir(), 'dsh-product-series-domain');

function freshRoot() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

/* ---------------- media type sniffing ---------------- */

test('detectMediaType reads the real format from magic bytes', () => {
  assert.equal(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(detectMediaType(webp), 'image/webp');
  assert.equal(detectMediaType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(detectMediaType(Buffer.from([0x42, 0x4d, 0, 0])), 'image/bmp');
  assert.equal(detectMediaType(Buffer.from('plain text')), 'application/octet-stream');
});

test('frames are delivered with the WebP extension', () => {
  assert.equal(OUTPUT_EXTENSION, '.webp');
  assert.equal(IMAGE_EXTENSIONS.has(OUTPUT_EXTENSION), true, 'our own output must be recognisable as an image');
});

/* ---------------- reference scanning ---------------- */

test('scanReferenceImages finds nested images, sorted and filtered by extension', async () => {
  const root = freshRoot();
  mkdirSync(join(root, 'figma-import', 'assets'), { recursive: true });
  mkdirSync(join(root, 'figma-bridge', 'out', 'node-5-2', 'assets'), { recursive: true });
  writeFileSync(join(root, 'figma-import', 'assets', 'key-visual.jpg'), 'x');
  writeFileSync(join(root, 'figma-bridge', 'out', 'node-5-2', 'assets', 'variant.PNG'), 'x');
  writeFileSync(join(root, 'figma-import', 'readme.md'), 'not an image');
  writeFileSync(join(root, 'figma-import', 'index.html'), 'not an image');

  const found = await scanReferenceImages(root);
  assert.equal(found.length, 2, `expected 2 images, got ${found.length}: ${found.join(', ')}`);
  assert.deepEqual(found, [...found].sort(), 'results must be sorted for reproducibility');
  assert.ok(found.some((f) => f.endsWith('key-visual.jpg')), 'nested jpg should be found');
  assert.ok(found.some((f) => f.endsWith('variant.PNG')), 'uppercase extension should be found');
});

test('scanReferenceImages skips dependency and build directories', async () => {
  const root = freshRoot();
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'logo.png'), 'x');
  writeFileSync(join(root, 'assets', 'wanted.png'), 'x');

  const found = await scanReferenceImages(root);
  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith('wanted.png'));
});

test('scanReferenceImages returns empty for a directory with no images', async () => {
  const root = freshRoot();
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'a.txt'), 'nothing');
  assert.deepEqual(await scanReferenceImages(root), []);
});

test('scanReferenceImages honours a non-recursive request', async () => {
  const root = freshRoot();
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'top.png'), 'x');
  writeFileSync(join(root, 'nested', 'deep.png'), 'x');
  const found = await scanReferenceImages(root, { recursive: false });
  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith('top.png'));
});

test('scanReferenceImages respects the result limit', async () => {
  const root = freshRoot();
  for (let i = 0; i < 8; i++) writeFileSync(join(root, `img-${i}.png`), 'x');
  const found = await scanReferenceImages(root, { limit: 3 });
  assert.equal(found.length, 3);
});

/* ---------------- reference reading ---------------- */

test('readReferences keeps only real images and reports their media type', async () => {
  const root = freshRoot();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  writeFileSync(join(root, 'a.png'), png);
  writeFileSync(join(root, 'b.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]));
  writeFileSync(join(root, 'c.txt'), 'plain');

  const refs = await readReferences([
    join(root, 'a.png'),
    join(root, 'b.jpg'),
    join(root, 'c.txt'),
  ]);
  assert.equal(refs.length, 2, 'the text file must be dropped');
  assert.equal(refs[0].mediaType, 'image/png');
  assert.equal(refs[1].mediaType, 'image/jpeg');
  assert.equal(refs[0].name, 'a.png');
  assert.ok(refs[0].data.length > 0);
});

test('readReferences drops files over the size cap', async () => {
  const root = freshRoot();
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096)]);
  writeFileSync(join(root, 'big.png'), big);
  const refs = await readReferences([join(root, 'big.png')], { maxBytes: 100 });
  assert.deepEqual(refs, []);
});

test('scanReferenceImages skips the plugin\'s own output folder', async () => {
  // Otherwise a second run feeds the first run's frames back in as references.
  const root = freshRoot();
  mkdirSync(join(root, 'product-series'), { recursive: true });
  mkdirSync(join(root, 'figma-import', 'assets'), { recursive: true });
  writeFileSync(join(root, 'product-series', 'previous-frame-01.png'), 'x');
  writeFileSync(join(root, 'figma-import', 'assets', 'key-visual.png'), 'x');

  const found = await scanReferenceImages(root);
  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith('key-visual.png'));
});

test('scanReferenceImages skips screenshot-like filenames', async () => {
  const root = freshRoot();
  writeFileSync(join(root, 'zoom.png'), 'x');
  writeFileSync(join(root, 'thumb-1.png'), 'x');
  writeFileSync(join(root, 'real-product.jpg'), 'x');
  const found = await scanReferenceImages(root);
  assert.equal(found.length, 1);
  assert.ok(found[0].endsWith('real-product.jpg'));
});

/* ---------------- reference ranking ---------------- */

test('selectReferences puts Figma artwork ahead of other images', () => {
  const paths = [
    'D:\\ws\\screenshots\\a.png',
    'D:\\ws\\product-series\\old-frame.png',
    'D:\\ws\\figma-import\\assets\\key-visual.jpg',
    'D:\\ws\\figma-bridge\\out\\node-5-2\\assets\\variant.png',
  ];
  const chosen = selectReferences(paths, 2);
  assert.equal(chosen.length, 2);
  assert.ok(chosen[0].includes('figma-import'), `expected figma artwork first, got ${chosen[0]}`);
  assert.ok(chosen[1].includes('figma-bridge'), `expected figma bridge second, got ${chosen[1]}`);
});

test('selectReferences keeps fallbacks instead of discarding them', () => {
  const paths = ['D:\\ws\\a.png', 'D:\\ws\\b.png'];
  assert.deepEqual(selectReferences(paths, 5), paths);
  assert.deepEqual(selectReferences(paths, 1), ['D:\\ws\\a.png']);
});

test('selectReferences is deterministic for equal candidates', () => {
  const paths = ['D:\\ws\\z.png', 'D:\\ws\\a.png'];
  assert.deepEqual(selectReferences(paths, 2), selectReferences(paths, 2));
});

/* ---------------- prompt composition ---------------- */

test('buildPrompt includes the description, a shot direction and the style clause', () => {
  const prompt = buildPrompt({ prompt: 'a matte grey USB-C cable', index: 0, count: 3, referenceCount: 1 });
  assert.match(prompt, /a matte grey USB-C cable/);
  assert.match(prompt, new RegExp(SHOT_VARIATIONS[0].slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /Keep the entire series visually consistent/);
  assert.match(prompt, /attached reference image is the product family/);
  assert.match(prompt, /frame 1 of 3/);
});

test('buildPrompt demands one isolated product when references are attached', () => {
  // A group-shot reference otherwise gets reproduced wholesale instead of the
  // single product the caller asked for.
  const prompt = buildPrompt({ prompt: 'the grey cable', index: 0, count: 1, referenceCount: 2 });
  assert.match(prompt, /Render ONLY the one product described above, isolated/);
  assert.match(prompt, /Remove every other item shown in the references/);
  assert.match(prompt, /do not reproduce the group/);
  assert.match(prompt, /2 attached reference images are the product family/);
});

test('buildPrompt varies the shot direction across the series', () => {
  const prompts = [0, 1, 2].map((index) => buildPrompt({ prompt: 'a charger', index, count: 3 }));
  assert.equal(new Set(prompts).size, 3, 'each frame needs its own direction');
  assert.match(prompts[0], new RegExp(SHOT_VARIATIONS[0].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompts[1], new RegExp(SHOT_VARIATIONS[1].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('buildPrompt cycles directions when count exceeds the variation list', () => {
  const a = buildPrompt({ prompt: 'x', index: 0, count: 8 });
  const b = buildPrompt({ prompt: 'x', index: SHOT_VARIATIONS.length, count: 8 });
  assert.equal(a.split('This is frame')[0], b.split('This is frame')[0]);
});

test('buildPrompt always demands a square, uncropped, text-free frame', () => {
  const prompt = buildPrompt({ prompt: 'anything', index: 0, count: 1 });
  assert.match(prompt, /Square 1:1/);
  assert.match(prompt, /not cropped/);
  assert.match(prompt, /no text, no logos, no watermark, no collage/);
});

test('buildPrompt mentions the reference count and any extra style guidance', () => {
  const prompt = buildPrompt({ prompt: 'buds', index: 1, count: 2, referenceCount: 3, style: 'warm amber tone' });
  assert.match(prompt, /3 attached reference images/);
  assert.match(prompt, /Additional style direction: warm amber tone/);
});

test('buildPrompt omits the reference sentences when there are no references', () => {
  const prompt = buildPrompt({ prompt: 'buds', index: 0, count: 1, referenceCount: 0 });
  assert.doesNotMatch(prompt, /attached reference/);
  assert.doesNotMatch(prompt, /Render ONLY/);
});

/* ---------------- slugs ---------------- */

test('slugify produces safe, bounded filenames', () => {
  assert.equal(slugify('Matte Grey USB-C Cable'), 'Matte-Grey-USB-C-Cable');
  assert.equal(slugify('  spaces  everywhere  '), 'spaces-everywhere');
  assert.equal(slugify('///'), 'product', 'an unusable prompt still yields a name');
  assert.ok(slugify('x'.repeat(200)).length <= 48);
  assert.doesNotMatch(slugify('a/b\\c:d*e?f"g<h>i|j'), /[/\\:*?"<>|]/);
});

test('slugify keeps non-Latin text rather than emptying the name', () => {
  const slug = slugify('数码配件系列');
  assert.ok(slug.length > 0);
  assert.doesNotMatch(slug, /[/\\:*?"<>|]/);
});

/* ---------------- directory resolution ---------------- */

test('resolveOutputDir prefers an explicit path and defaults under the workspace', () => {
  assert.equal(resolveOutputDir('D:\\out', 'D:\\ws'), 'D:\\out');
  assert.equal(resolveOutputDir('', 'D:\\ws'), 'D:\\ws\\product-series');
  assert.equal(resolveOutputDir(undefined, 'D:\\ws'), 'D:\\ws\\product-series');
  assert.equal(resolveOutputDir('series', 'D:\\ws'), 'D:\\ws\\series');
});

test('resolveReferenceDir defaults to the session working directory', () => {
  assert.equal(resolveReferenceDir(undefined, 'D:\\ws'), 'D:\\ws');
  assert.equal(resolveReferenceDir('', 'D:\\ws'), 'D:\\ws');
  assert.equal(resolveReferenceDir('figma-import', 'D:\\ws'), 'D:\\ws\\figma-import');
  assert.equal(resolveReferenceDir('D:\\assets', 'D:\\ws'), 'D:\\assets');
});

/* ---------------- output naming ---------------- */

test('uniquePath avoids overwriting an existing frame', async () => {
  const root = freshRoot();
  const taken = new Set([join(root, 'shot.png'), join(root, 'shot-2.png')]);
  const path = await uniquePath(root, 'shot', '.png', async (p) => taken.has(p));
  assert.equal(path, join(root, 'shot-3.png'));
});

test('writeFrame creates the directory and writes the bytes', async () => {
  const root = freshRoot();
  const dir = join(root, 'nested', 'series');
  const target = await writeFrame({ dir, stem: 'frame-1', data: Buffer.from('webp-bytes') });
  assert.ok(existsSync(target));
  assert.equal(target, join(dir, 'frame-1.webp'));
});

test('writeFrame never clobbers an existing file on a re-run', async () => {
  const root = freshRoot();
  const dir = join(root, 'series');
  const first = await writeFrame({ dir, stem: 'frame-1', data: Buffer.from('one') });
  const second = await writeFrame({ dir, stem: 'frame-1', data: Buffer.from('two') });
  assert.notEqual(first, second);
  assert.equal(second, join(dir, 'frame-1-2.webp'));
});

test.after(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});
