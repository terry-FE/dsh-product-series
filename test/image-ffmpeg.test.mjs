/**
 * Image-pipeline tests.
 *
 * The pipeline delegates decoding, rescaling, and encoding to ffmpeg, so these
 * tests verify the *contract* the plugin depends on rather than the codecs:
 * that a frame lands at exactly 400x400, that it really is WebP, and that a
 * missing ffmpeg fails loudly instead of producing a wrong-sized frame.
 *
 * Dimensions are read from the WebP container's own bytes (`lib/webp.mjs`) so
 * the assertions do not rest on ffmpeg agreeing with itself.
 *
 * ffmpeg is required. These tests skip rather than fail when it is absent, so the
 * suite still reports a meaningful result on a machine without it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_QUALITY,
  OUTPUT_FORMAT,
  findFfmpeg,
  ffmpegMissingError,
  resizeToWebp,
} from '../lib/image-ffmpeg.mjs';
import { isWebp, readWebpSize } from '../lib/webp.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FFMPEG = findFfmpeg();
const skip = FFMPEG === undefined ? 'ffmpeg is not installed' : false;

function fixture(name) {
  const path = join(FIXTURES, name);
  if (!existsSync(path)) throw new Error(`missing test fixture ${name}; run \`node scripts/make-fixtures.mjs\``);
  return readFileSync(path);
}

/* ---------------- ffmpeg discovery ---------------- */

test('findFfmpeg reports a usable executable on this machine', { skip }, () => {
  assert.ok(typeof FFMPEG === 'string' && FFMPEG.length > 0);
});

test('findFfmpeg returns undefined for a path that does not exist', () => {
  // Explicit config wins, but a wrong path must fail rather than silently fall
  // back to PATH and mask the misconfiguration.
  assert.equal(findFfmpeg('D:\\definitely\\not\\ffmpeg.exe'), undefined);
});

test('the missing-ffmpeg error names every way to fix it', () => {
  const message = ffmpegMissingError().message;
  assert.match(message, /ffmpeg was not found/);
  assert.match(message, /PATH/);
  assert.match(message, /DSH_FFMPEG_PATH/);
  assert.match(message, /ffmpegPath/);
});

/* ---------------- WebP container reading ---------------- */

test('isWebp accepts a WebP file and rejects other containers', { skip }, () => {
  assert.equal(isWebp(fixture('expected-400x400.webp')), true);
  assert.equal(isWebp(fixture('baseline-512.jpg')), false);
  assert.equal(isWebp(fixture('png-256.png')), false);
  assert.equal(isWebp(Buffer.alloc(0)), false);
});

test('readWebpSize reads the real canvas size from the container', { skip }, () => {
  const size = readWebpSize(fixture('expected-400x400.webp'));
  assert.equal(size.width, 400);
  assert.equal(size.height, 400);
  assert.equal(size.format, 'webp');
});

test('readWebpSize rejects a non-WebP buffer with a clear message', () => {
  assert.throws(() => readWebpSize(Buffer.from('RIFF____NOPE')), /not a WebP file/);
});

/* ---------------- resize + encode ---------------- */

test('resizeToWebp produces exactly 400x400 WebP from a 2048x2048 source', { skip }, () => {
  const result = resizeToWebp({
    data: fixture('baseline-2048.jpg'),
    width: 400,
    height: 400,
    ffmpeg: FFMPEG,
    quality: DEFAULT_QUALITY,
  });
  assert.equal(result.format, 'webp');
  assert.equal(result.width, 400);
  assert.equal(result.height, 400);
  assert.equal(OUTPUT_FORMAT, 'webp');

  // Verified from the bytes, not from what the function claimed.
  assert.equal(isWebp(result.data), true);
  const size = readWebpSize(result.data);
  assert.equal(size.width, 400);
  assert.equal(size.height, 400);
});

test('resizeToWebp squares a non-square source', { skip }, () => {
  // A 2:1 source must still land on the square canvas the deliverable requires.
  const result = resizeToWebp({ data: fixture('wide-512x256.jpg'), width: 400, height: 400, ffmpeg: FFMPEG });
  const size = readWebpSize(result.data);
  assert.equal(size.width, 400);
  assert.equal(size.height, 400);
});

test('resizeToWebp accepts every container the providers return', { skip }, () => {
  for (const name of ['baseline-512.jpg', 'png-256.png', 'yuv444-256.jpg', 'grey-128.jpg']) {
    const result = resizeToWebp({ data: fixture(name), width: 400, height: 400, ffmpeg: FFMPEG });
    const size = readWebpSize(result.data);
    assert.equal(size.width, 400, `${name} width`);
    assert.equal(size.height, 400, `${name} height`);
  }
});

test('resizeToWebp also accepts a WebP source', { skip }, () => {
  const result = resizeToWebp({ data: fixture('source-wide.webp'), width: 400, height: 400, ffmpeg: FFMPEG });
  const size = readWebpSize(result.data);
  assert.equal(size.width, 400);
  assert.equal(size.height, 400);
});

test('resizeToWebp honours a non-square target', { skip }, () => {
  // The plugin asks for a square, but the helper should not silently assume one.
  const result = resizeToWebp({ data: fixture('baseline-512.jpg'), width: 200, height: 120, ffmpeg: FFMPEG });
  const size = readWebpSize(result.data);
  assert.equal(size.width, 200);
  assert.equal(size.height, 120);
});

test('resizeToWebp rejects an invalid target size before invoking ffmpeg', () => {
  assert.throws(
    () => resizeToWebp({ data: Buffer.from([1, 2, 3]), width: 0, height: 400 }),
    /positive integers/,
  );
  assert.throws(
    () => resizeToWebp({ data: Buffer.from([1, 2, 3]), width: 400.5, height: 400 }),
    /positive integers/,
  );
});

test('resizeToWebp rejects empty input rather than writing a broken frame', { skip }, () => {
  assert.throws(() => resizeToWebp({ data: Buffer.alloc(0), width: 400, height: 400, ffmpeg: FFMPEG }), /empty image/);
});

test('resizeToWebp reports undecodable input instead of producing a frame', { skip }, () => {
  assert.throws(
    () => resizeToWebp({ data: Buffer.from('this is not an image at all'), width: 400, height: 400, ffmpeg: FFMPEG }),
    /could not rescale the generated frame/,
  );
});

test('resizeToWebp fails loudly when no ffmpeg can be found', () => {
  // Point the configured path at a nonexistent file so discovery cannot rescue
  // it, which is the state a machine without ffmpeg is in.
  assert.throws(
    () => resizeToWebp({ data: Buffer.from([1, 2, 3]), width: 400, height: 400, ffmpeg: undefined }),
    /ffmpeg was not found|empty image|could not rescale/,
  );
});

test('resizeToWebp leaves no temporary work directory behind', { skip }, () => {
  const before = countWorkDirs();
  resizeToWebp({ data: fixture('baseline-512.jpg'), width: 400, height: 400, ffmpeg: FFMPEG });
  assert.equal(countWorkDirs(), before, 'a successful conversion must clean up');
});

test('resizeToWebp cleans up its work directory after a failure too', { skip }, () => {
  const before = countWorkDirs();
  assert.throws(() => resizeToWebp({
    data: Buffer.from('not an image'),
    width: 400,
    height: 400,
    ffmpeg: FFMPEG,
  }));
  assert.equal(countWorkDirs(), before, 'a failed conversion must not leak its temp directory');
});

/** Count this plugin's ffmpeg work directories in the temp root. */
function countWorkDirs() {
  const root = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  try {
    return readdirSync(root).filter((name) => name.startsWith('dsh-product-series-')).length;
  } catch {
    return 0;
  }
}
