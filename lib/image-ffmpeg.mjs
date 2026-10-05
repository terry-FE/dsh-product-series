/**
 * Image processing through ffmpeg.
 *
 * Every generated frame must land at exactly 400x400 WebP, and image providers
 * only return their own tiers (Ark Seedream answers 2K/2048x2048), so each frame
 * is decoded, rescaled, and encoded. That work is delegated to ffmpeg rather
 * than reimplemented here: the codecs are already installed, tested, and known
 * correct, and a hand-written codec is a liability nobody asked for.
 *
 * ffmpeg is invoked file-to-file with inherited/ignored stdio. That is a
 * deliberate constraint, not a stylistic choice: DSH's sandbox denies a child
 * process whose stdio is piped, so `spawn` with the default `'pipe'` fails with
 * `EPERM` before ffmpeg ever runs. Writing the frame to a temporary path and
 * reading the result back avoids pipes entirely.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The output container every frame is delivered in. */
export const OUTPUT_FORMAT = 'webp';

/** Default libwebp quality (0-100). */
export const DEFAULT_QUALITY = 90;

/** Bound on one ffmpeg invocation. */
const FFMPEG_TIMEOUT_MS = 120_000;

/**
 * Locate the ffmpeg executable.
 *
 * Resolution order: an explicit path, then `DSH_FFMPEG_PATH`, then `ffmpeg` on
 * PATH. The explicit path is last-resort config for a host where the binary is
 * installed but not on PATH.
 *
 * @param {string} [explicit] - configured path.
 * @returns {string | undefined} the executable to invoke, or undefined when none is usable.
 */
export function findFfmpeg(explicit) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const candidate = explicit.trim();
    return existsSync(candidate) ? candidate : undefined;
  }
  const fromEnv = process.env.DSH_FFMPEG_PATH?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv;
  // Probing once is cheap and keeps the failure message precise.
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 15_000 });
  return probe.error === undefined && probe.status === 0 ? 'ffmpeg' : undefined;
}

/** The error to raise when ffmpeg is missing, naming how to fix it. */
export function ffmpegMissingError() {
  return new Error(
    'ffmpeg was not found, and this plugin needs it to rescale frames to 400x400 WebP. '
    + 'Install ffmpeg and put it on PATH, set DSH_FFMPEG_PATH, or set the plugin\'s '
    + '`ffmpegPath` config to the executable.',
  );
}

/**
 * Run ffmpeg over `args`, inheriting no pipes.
 *
 * @param {string} ffmpeg - executable to invoke.
 * @param {string[]} args - arguments (without the leading executable).
 * @returns {{ok: boolean, reason?: string}} whether it succeeded.
 */
function runFfmpeg(ffmpeg, args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'ignore',
    timeout: FFMPEG_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    return { ok: false, reason: `could not run ffmpeg: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `ffmpeg exited with status ${result.status}` };
  }
  return { ok: true };
}

/**
 * Rescale an image to an exact size and encode it as WebP.
 *
 * The input may be any container ffmpeg can decode (the providers this plugin
 * talks to return PNG or JPEG), so the caller does not need to know what the
 * model produced.
 *
 * @param {object} input
 * @param {Buffer} input.data - encoded source image bytes.
 * @param {number} input.width - exact output width.
 * @param {number} input.height - exact output height.
 * @param {string} [input.ffmpeg] - ffmpeg executable; defaults to discovery.
 * @param {number} [input.quality] - libwebp quality 0-100.
 * @returns {{data: Buffer, width: number, height: number, format: 'webp'}}
 */
export function resizeToWebp(input) {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new Error(`target size must be positive integers, got ${input.width}x${input.height}`);
  }
  const ffmpeg = input.ffmpeg ?? findFfmpeg();
  if (ffmpeg === undefined) throw ffmpegMissingError();
  if (input.data.length === 0) throw new Error('cannot rescale an empty image');

  const quality = Math.min(100, Math.max(0, input.quality ?? DEFAULT_QUALITY));
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-product-series-'));
  // The source extension does not matter to ffmpeg (it sniffs content), but
  // giving a neutral one avoids a misleading name in any error it prints.
  const sourcePath = join(workDir, 'source.img');
  const targetPath = join(workDir, 'frame.webp');

  try {
    writeFileSync(sourcePath, input.data);
    const attempt = runFfmpeg(ffmpeg, [
      '-i', sourcePath,
      // One frame only: a single-image input must never become an animated WebP.
      '-frames:v', '1',
      // Area averaging is the right filter for a large downscale and, unlike
      // `bicubic`, it is a fixed algorithm rather than a tunable one.
      '-vf', `scale=${input.width}:${input.height}:flags=area`,
      '-c:v', 'libwebp',
      '-quality', String(quality),
      targetPath,
    ]);
    if (!attempt.ok) {
      throw new Error(`could not rescale the generated frame: ${attempt.reason}`);
    }
    if (!existsSync(targetPath) || statSync(targetPath).size === 0) {
      throw new Error('ffmpeg produced no output frame');
    }
    const data = readFileSync(targetPath);
    return { data, width: input.width, height: input.height, format: OUTPUT_FORMAT };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Probe an image's dimensions and container with ffmpeg.
 *
 * Used by the tests and by diagnostics, never on the generation path.
 *
 * @param {Buffer} data - encoded image bytes.
 * @param {string} [ffmpeg] - ffmpeg executable.
 * @returns {{width: number, height: number, format: string}} probed facts.
 */
export function probeImage(data, ffmpeg) {
  const executable = ffmpeg ?? findFfmpeg();
  if (executable === undefined) throw ffmpegMissingError();
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-product-series-probe-'));
  const sourcePath = join(workDir, 'source.img');
  try {
    writeFileSync(sourcePath, data);
    // With no output file ffmpeg prints stream information and exits non-zero,
    // so the info is captured from a decode to a null sink instead.
    const probe = spawnSync(executable, [
      '-hide_banner',
      '-i', sourcePath,
      '-frames:v', '1',
      '-f', 'null',
      '-',
    ], { encoding: 'utf8', timeout: FFMPEG_TIMEOUT_MS, windowsHide: true });
    const text = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
    const match = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d+)x(\d+)/.exec(text);
    if (match === null) throw new Error(`could not probe the image: ${text.trim().slice(0, 200)}`);
    return { format: match[1], width: Number(match[2]), height: Number(match[3]) };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
