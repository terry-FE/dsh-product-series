/**
 * Product-series domain logic: finding Figma reference assets, composing the
 * generation prompt, and choosing collision-free output paths.
 *
 * Separate from the plugin entry so every decision here is directly testable
 * without a running DSH host.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

/** Extensions treated as reference artwork. */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/** The extension every delivered frame carries. */
export const OUTPUT_EXTENSION = '.webp';

/** Sniff a reference image's media type from its magic bytes. */
export function detectMediaType(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (data.length >= 3 && data.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

/**
 * Directories whose contents are never source artwork. Deliberately does NOT
 * include a directory named `out`: the Figma bridge this plugin targets exports
 * into exactly `figma-bridge/out/<node>/assets`, so skipping that name would
 * hide the reference images it exists to find.
 *
 * `product-series` is the plugin's own default output folder: without it, a
 * second run would feed the first run's frames back in as references.
 */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'product-series',
  '_e2e-output',
  '_probe-output',
]);

/** Filenames that are never source artwork, even inside a scanned directory. */
const SKIP_FILE_PATTERN = /(^|[-_.])(zoom|thumb|thumbnail|preview|sprite|placeholder)([-_.]|$)/i;

/**
 * Directories most likely to hold the source Figma export.
 *
 * Used only to order candidates, never to exclude any: a workspace that keeps
 * its artwork elsewhere still works, it just loses the tie-break.
 */
const PREFERRED_DIR_PATTERN = /(^|[\\/])(figma-import|figma-bridge|assets?|design|designs|source|exports?)([\\/]|$)/i;

/**
 * Walk `root` for reference images.
 *
 * Recursion is what makes a Figma export usable without the caller knowing its
 * internal layout (`figma-import/assets/...`, `figma-bridge/out/<node>/assets`),
 * and the result is sorted so a run is reproducible.
 *
 * @param {string} root - absolute directory to scan.
 * @param {object} [options]
 * @param {boolean} [options.recursive] - default true.
 * @param {number} [options.limit] - maximum files to return.
 * @returns {Promise<string[]>} absolute file paths, sorted.
 */
export async function scanReferenceImages(root, options = {}) {
  const recursive = options.recursive ?? true;
  const limit = options.limit ?? 32;
  const found = [];

  const walk = async (dir, depth) => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // An unreadable subtree is reported by the caller's own path check; skip it.
      return;
    }
    const dirs = [];
    for (const entry of entries) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < 6 && !SKIP_DIR_NAMES.has(entry.name) && !entry.name.startsWith('.')) {
          dirs.push(full);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (SKIP_FILE_PATTERN.test(entry.name)) continue;
      found.push(full);
    }
    for (const dir of dirs.sort()) await walk(dir, depth + 1);
  };

  await walk(root, 0);
  found.sort();
  return found;
}

/**
 * Order reference candidates so the ones that look like source artwork come
 * first, then cap the list.
 *
 * Ordering is what keeps a run reproducible and on-target: a workspace also
 * contains screenshots, test fixtures and earlier output, and simply taking the
 * first N in path order was observed to attach those instead of the Figma
 * export. Nothing is excluded here — preferred candidates are only moved ahead
 * of the rest, so a workspace that keeps artwork elsewhere still works.
 *
 * @param {string[]} paths - candidates from {@link scanReferenceImages}.
 * @param {number} limit - maximum number to keep.
 * @returns {string[]}
 */
export function selectReferences(paths, limit) {
  const preferred = paths.filter((path) => PREFERRED_DIR_PATTERN.test(path));
  const rest = paths.filter((path) => !PREFERRED_DIR_PATTERN.test(path));
  // Both halves are already sorted by the scanner; concatenating keeps the
  // result deterministic without a second comparison.
  return [...preferred, ...rest].slice(0, limit);
}

/**
 * Read reference files into memory, skipping any that vanished or are not
 * images this plugin can pass to a provider.
 *
 * @param {string[]} paths - absolute file paths.
 * @param {object} [options]
 * @param {number} [options.maxBytes] - per-file cap; Ark rejects huge payloads.
 * @returns {Promise<Array<{path: string, name: string, data: Buffer, mediaType: string}>>}
 */
export async function readReferences(paths, options = {}) {
  const maxBytes = options.maxBytes ?? 12 * 1024 * 1024;
  const out = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) continue;
    const data = await readFile(path);
    const mediaType = detectMediaType(data);
    if (mediaType === 'application/octet-stream') continue;
    out.push({ path, name: basename(path), data, mediaType });
  }
  return out;
}

/**
 * Per-image direction, so a series is recognisably one product family without
 * every frame being the same picture. Cycled when `count` exceeds the list.
 */
export const SHOT_VARIATIONS = [
  'a three-quarter hero angle with the product centred and generous negative space',
  'a straight-on front view, centred and symmetrical, with generous negative space',
  'a slightly elevated angle showing the product from above with room around it',
  'a low side angle emphasising the product silhouette, centred in the frame',
  'a close detail angle highlighting materials and finish, subject fully inside the frame',
  'a gently rotated angle showing a second side of the product, centred in the frame',
];

/**
 * The style contract every frame in a series must share.
 *
 * Stated as an explicit instruction rather than left to the model because
 * "consistent series" is exactly what a per-frame call would otherwise drift on.
 */
export const STYLE_CLAUSE = [
  'Keep the entire series visually consistent:',
  'the same seamless studio backdrop and colour, the same soft diffused lighting direction,',
  'the same camera height and lens character, the same shadow softness,',
  'and the same material and colour grade as the reference images provided.',
  'Square 1:1 composition with the product centred and not cropped.',
  'Photorealistic commercial product photography, no text, no logos, no watermark, no collage.',
].join(' ');

/**
 * Compose the prompt for one frame of the series.
 *
 * The isolation sentence is load-bearing, not decorative: when the reference is
 * a group shot (which is exactly what a Figma series key visual tends to be),
 * the model otherwise reproduces the whole group instead of the single product
 * the caller described. Stating that the references are a style guide only is
 * what turns them into a look reference rather than a composition to copy.
 *
 * @param {object} input
 * @param {string} input.prompt - the user's product description (required).
 * @param {number} input.index - zero-based frame index.
 * @param {number} input.count - total frames in the series.
 * @param {string} [input.style] - extra style guidance from the caller.
 * @param {number} [input.referenceCount] - how many reference images accompany it.
 * @returns {string}
 */
export function buildPrompt(input) {
  const direction = SHOT_VARIATIONS[input.index % SHOT_VARIATIONS.length];
  const parts = [`Product photograph of a single product: ${input.prompt.trim()}.`];
  parts.push(`Show it as ${direction}.`);
  if (input.referenceCount !== undefined && input.referenceCount > 0) {
    parts.push(
      input.referenceCount === 1
        ? 'The attached reference image is the product family: use it only as a guide to materials, colour, proportions and lighting.'
        : `The ${input.referenceCount} attached reference images are the product family: use them only as a guide to materials, colour, proportions and lighting.`,
    );
    parts.push(
      'Render ONLY the one product described above, isolated on a seamless studio backdrop. '
      + 'Remove every other item shown in the references, and do not reproduce the group, lay out multiple products, or make a collage.',
    );
  }
  if (input.style !== undefined && input.style.trim().length > 0) {
    parts.push(`Additional style direction: ${input.style.trim()}.`);
  }
  parts.push(STYLE_CLAUSE);
  if (input.count > 1) {
    // Naming the position helps the model vary the shot rather than repeat it.
    parts.push(`This is frame ${input.index + 1} of ${input.count} in one product series.`);
  }
  return parts.join(' ');
}

/** Turn a prompt into a short, filesystem-safe slug. */
export function slugify(text, limit = 48) {
  const slug = text
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'product';
}

/**
 * Resolve the output directory: absolute paths are used as-is, relative paths
 * are resolved against the session working directory.
 */
export function resolveOutputDir(outputDir, cwd, defaultName = 'product-series') {
  const raw = outputDir?.trim();
  if (raw === undefined || raw.length === 0) return resolve(cwd, defaultName);
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** Resolve the reference directory, defaulting to the session working directory. */
export function resolveReferenceDir(referenceDir, cwd) {
  const raw = referenceDir?.trim();
  if (raw === undefined || raw.length === 0) return resolve(cwd);
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/**
 * Choose a path that does not overwrite an existing file.
 *
 * Generated frames are the plugin's only irreversible output, so a re-run must
 * never clobber a previous series.
 *
 * @param {string} dir - directory to write into.
 * @param {string} stem - filename without extension.
 * @param {string} extension - extension including the dot.
 * @param {(path: string) => Promise<boolean>} exists - existence probe.
 */
export async function uniquePath(dir, stem, extension, exists) {
  let candidate = join(dir, `${stem}${extension}`);
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = join(dir, `${stem}-${suffix}${extension}`);
    suffix++;
    if (suffix > 999) throw new Error(`could not find a free filename for ${stem} in ${dir}`);
  }
  return candidate;
}

/**
 * Write one frame, creating the directory and avoiding every pre-existing name.
 *
 * @param {object} input
 * @param {string} input.dir - output directory.
 * @param {string} input.stem - filename without extension.
 * @param {Buffer} input.data - encoded frame bytes.
 * @returns {Promise<string>} the path actually written.
 */
export async function writeFrame(input) {
  const { access } = await import('node:fs/promises');
  await mkdir(input.dir, { recursive: true });
  const exists = async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
  const path = await uniquePath(input.dir, input.stem, OUTPUT_EXTENSION, exists);
  await writeFile(path, input.data);
  return path;
}
