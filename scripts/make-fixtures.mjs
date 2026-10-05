/**
 * Regenerate the image-pipeline test fixtures with ffmpeg.
 *
 * The fixtures are the *inputs* the pipeline must accept. Assertions about the
 * pipeline's own output are made from the WebP container bytes
 * (`lib/webp.mjs`), so no fixture encodes an expected result that could drift
 * from the code that produces it.
 *
 * Kept on disk rather than generated per run because a confined DSH session
 * denies a child process whose stdio is piped, so the tests cannot invoke ffmpeg
 * themselves to build their own inputs.
 *
 * Usage: node scripts/make-fixtures.mjs [source-image]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const source = process.argv[2] ?? 'D:\\dsh\\figma-import\\assets\\key-visual.jpg';

mkdirSync(fixtures, { recursive: true });

/** Run ffmpeg with inherited stdio, so its failure is visible. */
function ffmpeg(args) {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  } catch (error) {
    console.error(`ffmpeg failed: ffmpeg ${args.join(' ')}`);
    throw error;
  }
}

/** One encoded fixture at a given size, using the given encoder arguments. */
function make(name, width, height, encodeArgs) {
  ffmpeg(['-i', source, '-vf', `scale=${width}:${height}`, ...encodeArgs, join(fixtures, name)]);
  console.log(`wrote ${name} (${width}x${height})`);
}

// The 2K frame the real pipeline downscales from: this is what Ark returns.
make('baseline-2048.jpg', 2048, 2048, ['-q:v', '2']);
// Sources with other chroma layouts and containers, all of which must be accepted.
make('baseline-512.jpg', 512, 512, ['-q:v', '2', '-huffman', 'optimal']);
make('yuv444-256.jpg', 256, 256, ['-pix_fmt', 'yuvj444p', '-q:v', '2']);
make('png-256.png', 256, 256, []);
// A 2:1 source, to prove the output is square regardless of the input aspect.
make('wide-512x256.jpg', 512, 256, ['-q:v', '2']);
// A single-component source.
ffmpeg(['-i', source, '-vf', 'scale=128:128,format=gray', join(fixtures, 'grey-128.jpg')]);
console.log('wrote grey-128.jpg');

// A WebP input, so a WebP supplied as the source is re-encoded rather than rejected.
ffmpeg(['-i', join(fixtures, 'wide-512x256.jpg'), '-frames:v', '1', '-c:v', 'libwebp', '-quality', '90',
  join(fixtures, 'source-wide.webp')]);
console.log('wrote source-wide.webp');

// A known-good 400x400 WebP, used to test the container reader itself.
ffmpeg(['-i', source, '-vf', 'scale=400:400:flags=area', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '90',
  join(fixtures, 'expected-400x400.webp')]);
console.log('wrote expected-400x400.webp');

console.log(`\nfixtures written to ${fixtures}`);
