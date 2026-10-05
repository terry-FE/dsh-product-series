/**
 * `generate_product_series` — turn workspace reference artwork plus a prompt
 * into a consistent 400x400 product series.
 *
 * Pipeline: resolve the reference directory → scan it for images → build a
 * per-frame prompt that pins the shared look → call the configured image
 * provider with those references → rescale every frame to exactly 400x400 →
 * save it under the output directory without overwriting an existing series.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { DEFAULT_BASE_URL, DEFAULT_MODEL, generateImages, runPool } from './lib/ark.mjs';
import { DEFAULT_QUALITY, findFfmpeg, ffmpegMissingError, resizeToWebp } from './lib/image-ffmpeg.mjs';
import {
  buildPrompt,
  readReferences,
  resolveOutputDir,
  resolveReferenceDir,
  scanReferenceImages,
  selectReferences,
  slugify,
  writeFrame,
} from './lib/series.mjs';

/** Cordis plugin name; must match the entry id used in the bundle patch. */
export const name = 'product-series';

/**
 * Services this plugin needs before `apply` runs.
 *
 * `credentials` must be declared, not merely read: an undeclared service access
 * throws "cannot get property \"credentials\" without inject" at call time.
 */
export const inject = ['tools', 'credentials'];

/** Every generated frame is exactly this size. */
export const OUTPUT_SIZE = 400;

/** Upper bound on one request, so a mistyped count cannot start a huge run. */
export const MAX_COUNT = 10;

/** Credential references checked in order for the Ark API key. */
const API_KEY_REFS = ['ARK_API_KEY', 'SEEDREAM_API_KEY'];

/** Referenced asset directories that are noise rather than product artwork. */
const DEFAULT_REFERENCE_HINT = 'figma-import and figma-bridge';

/**
 * Resolve the Ark API key through the credential seam.
 *
 * Resolution happens per call rather than at mount so a key configured in
 * Settings after DSH started takes effect on the next generation, and so no
 * secret is ever held in plugin state.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<string | undefined>}
 */
async function resolveApiKey(ctx) {
  for (const ref of API_KEY_REFS) {
    const resolved = await ctx.credentials.resolve(ref);
    const value = resolved?.value?.trim();
    if (value !== undefined && value.length > 0) return value;
    // The process environment is checked too, so a deployment that exports the
    // key without storing it still works.
    const fromEnv = process.env[ref]?.trim();
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  }
  return undefined;
}

/**
 * The directory a relative reference path resolves against: the calling
 * session's working directory, falling back to the host process's.
 *
 * @param {unknown} agent - the calling agent from the tool execution context.
 */
function workingDirectory(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/** A short, model-facing summary of what went wrong for one frame. */
function failureMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 400 ? `${raw.slice(0, 400)}...` : raw;
}

/**
 * Register the tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const baseURL = typeof config.baseURL === 'string' && config.baseURL.trim().length > 0
    ? config.baseURL.trim()
    : DEFAULT_BASE_URL;
  const model = typeof config.model === 'string' && config.model.trim().length > 0
    ? config.model.trim()
    : DEFAULT_MODEL;
  const size = typeof config.size === 'string' && config.size.trim().length > 0 ? config.size.trim() : '2K';
  const watermark = config.watermark === true;
  const concurrency = Number.isInteger(config.concurrency) && config.concurrency > 0 ? config.concurrency : 2;
  const requestTimeoutMs = Number.isInteger(config.requestTimeoutMs) && config.requestTimeoutMs > 0
    ? config.requestTimeoutMs
    : undefined;
  const maxReferences = Number.isInteger(config.maxReferences) && config.maxReferences > 0
    ? config.maxReferences
    : 4;
  const defaultOutputFolder = typeof config.outputFolder === 'string' && config.outputFolder.trim().length > 0
    ? config.outputFolder.trim()
    : 'product-series';
  const webpQuality = Number.isInteger(config.webpQuality) && config.webpQuality >= 0 && config.webpQuality <= 100
    ? config.webpQuality
    : DEFAULT_QUALITY;
  // Resolved once at mount: missing ffmpeg is a deployment problem worth
  // reporting before a caller spends two minutes generating a frame.
  const ffmpeg = findFfmpeg(typeof config.ffmpegPath === 'string' ? config.ffmpegPath : undefined);

  ctx.tools.register(defineTool({
    name: 'generate_product_series',
    description:
      'Generate a consistent series of 400x400 product images from reference artwork in the workspace. '
      + `Scans referenceDir (default: the session working directory, which already contains the Figma export under ${DEFAULT_REFERENCE_HINT}) `
      + 'and passes those images to the configured image provider as references, so every frame shares one look. '
      + 'Counts are capped at '
      + `${MAX_COUNT}. Frames are written as WebP at exactly 400x400 and existing files are never overwritten; `
      + 'generation of each frame is slow (typically one to two minutes), so keep count small unless the user asked for more.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What the product series shows, e.g. "the matte dark grey USB-C charging cable from the reference".',
      },
      referenceDir: {
        type: 'string',
        description:
          'Directory holding the Figma reference artwork. Relative paths resolve against the session working directory. Defaults to the working directory, searched recursively.',
      },
      count: {
        type: 'integer',
        description: `How many frames to generate, 1-${MAX_COUNT}. Defaults to 1.`,
      },
      outputDir: {
        type: 'string',
        description:
          `Where to write the frames. Relative paths resolve against the session working directory. Defaults to ${defaultOutputFolder}/ in the working directory.`,
      },
      style: {
        type: 'string',
        description: 'Extra style direction applied to every frame, e.g. "warm amber accent lighting".',
      },
    },
    output: {
      // The value-schema DSL marks required fields with `required: true` on the
      // property itself; a root-level `required` array is rejected by the
      // registry's schema compiler ("schema.required is not supported").
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requested: { type: 'integer', required: true },
          generated: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          outputDir: { type: 'string', required: true },
          referenceDir: { type: 'string', required: true },
          referenceCount: { type: 'integer', required: true },
          model: { type: 'string', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
          failures: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                frame: { type: 'integer', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `Generated ${value.generated} of ${value.requested} frame(s) at ${OUTPUT_SIZE}x${OUTPUT_SIZE} `
          + `in ${value.outputDir} (references: ${value.referenceCount} from ${value.referenceDir}).`,
          ...value.images.map((image, index) => `${index + 1}. ${image.path}`),
        ];
        if (value.failures.length > 0) {
          lines.push('Failures:');
          for (const failure of value.failures) lines.push(`- frame ${failure.frame}: ${failure.reason}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
      presentationMeta: (_args, value) => value,
    },
    execute: async (args, exec) => {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (prompt.length === 0) throw new Error('generate_product_series requires a non-empty prompt');

      // Checked before any provider call: discovering a missing ffmpeg after a
      // two-minute generation would waste the call and the caller's time.
      if (ffmpeg === undefined) throw ffmpegMissingError();

      const requested = Number.isInteger(args.count) ? args.count : 1;
      if (requested < 1 || requested > MAX_COUNT) {
        throw new Error(`count must be between 1 and ${MAX_COUNT}, got ${requested}`);
      }

      const cwd = workingDirectory(exec.agent);
      const referenceDir = resolveReferenceDir(args.referenceDir, cwd);
      const outputDir = resolveOutputDir(args.outputDir, cwd, defaultOutputFolder);

      const apiKey = await resolveApiKey(ctx);
      if (apiKey === undefined) {
        throw new Error(
          `generate_product_series requires an Ark API key; configure ${API_KEY_REFS[0]} `
          + 'in Settings > Plugins > Image generation, or set it in the environment.',
        );
      }

      // Reference discovery: a missing directory is reported as itself rather
      // than surfacing as a confusing "no reference images" error.
      let referenceFiles;
      try {
        referenceFiles = await scanReferenceImages(referenceDir, { limit: maxReferences * 8 });
      } catch (error) {
        throw new Error(`cannot read referenceDir ${referenceDir}: ${failureMessage(error)}`);
      }
      // Rank before reading, so a workspace full of screenshots and earlier
      // output still attaches the actual Figma artwork.
      const references = await readReferences(selectReferences(referenceFiles, maxReferences), {
        maxBytes: 12 * 1024 * 1024,
      });

      const usedReferences = references;
      const style = typeof args.style === 'string' ? args.style : undefined;
      const slug = slugify(prompt);
      const tasks = Array.from({ length: requested }, (_, index) => async () => {
        const framePrompt = buildPrompt({
          prompt,
          index,
          count: requested,
          style,
          referenceCount: usedReferences.length,
        });
        const generated = await generateImages({
          apiKey,
          baseURL,
          model,
          prompt: framePrompt,
          references: usedReferences.map((reference) => ({
            data: reference.data,
            mediaType: reference.mediaType,
          })),
          size,
          outputFormat: 'png',
          watermark,
          ...(requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs }),
          signal: exec.signal,
        });
        // Rescale to the exact deliverable size before touching the output
        // directory, so a conversion failure cannot leave a wrong-sized frame
        // behind under the final name.
        const scaled = resizeToWebp({
          data: generated[0].data,
          width: OUTPUT_SIZE,
          height: OUTPUT_SIZE,
          ffmpeg,
          quality: webpQuality,
        });
        const path = await writeFrame({
          dir: outputDir,
          stem: `${slug}-${String(index + 1).padStart(2, '0')}`,
          data: scaled.data,
        });
        return {
          path,
          width: scaled.width,
          height: scaled.height,
          bytes: scaled.data.length,
        };
      });

      const results = await runPool(tasks, {
        concurrency,
        // One retry absorbs a transient rate limit without doubling the wait of
        // a real failure.
        retries: 1,
      });

      const images = [];
      const failures = [];
      results.forEach((result, index) => {
        if (result.ok) images.push(result.value);
        else failures.push({ frame: index + 1, reason: failureMessage(result.error) });
      });

      if (images.length === 0) {
        throw new Error(`every frame failed; first error: ${failures[0]?.reason ?? 'unknown'}`);
      }

      return {
        requested,
        generated: images.length,
        failed: failures.length,
        outputDir,
        referenceDir,
        referenceCount: usedReferences.length,
        model,
        images,
        failures,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Generate ${args.count ?? 1} product image(s) at ${OUTPUT_SIZE}x${OUTPUT_SIZE}`,
      kind: 'other',
      rawInput: args,
    }),
  }));
}
