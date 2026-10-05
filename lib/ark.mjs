/**
 * Volcengine Ark (Seedream) image generation with reference images.
 *
 * Kept free of any cordis dependency so it can be unit-tested directly: the
 * caller resolves the API key and passes it in.
 *
 * The request shape mirrors what the Ark `images/generations` endpoint accepts
 * for image-to-image work:
 *   { model, prompt, image: [dataURL...], size, output_format, watermark, response_format }
 * Reference images travel as `data:` URLs, which is why the model needs no
 * separately hosted asset and why a Figma export can be used as-is.
 */

/** Ark's own default endpoint. */
export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

/**
 * The Seedream model this plugin defaults to.
 *
 * Not every model name in Ark's catalogue is activated for every account;
 * calling an inactive one answers `ModelNotOpen`/`InvalidEndpointOrModel`, and
 * `listModels` below reports what is actually usable.
 */
export const DEFAULT_MODEL = 'doubao-seedream-5-0-pro-260628';

/** Output sizes Ark accepts for Seedream 5.x. */
export const SIZE_TIERS = ['2K', '3K', '4K'];

/** Default request timeout: 2K frames routinely take ~2 minutes. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * One generated image.
 * @typedef {{
 *   data: Buffer,
 *   mediaType: string,
 *   requestId?: string,
 * }} GeneratedImage
 */

/** Turn a failure body into a short, single-line reason. */
function summarize(text, limit = 400) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

/**
 * Encode bytes as a data URL Ark can read from a JSON body.
 * @param {Buffer} data - raw image bytes.
 * @param {string} mediaType - e.g. `image/jpeg`.
 */
export function toDataUrl(data, mediaType) {
  return `data:${mediaType};base64,${data.toString('base64')}`;
}

/**
 * Turn an `images/generations` response into image bytes.
 *
 * Ark answers with `data[].b64_json` when `response_format` is `b64_json`, but a
 * URL is still possible, so both are handled.
 *
 * @param {unknown} payload - parsed JSON body.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - forwarded to a URL download.
 * @returns {Promise<GeneratedImage[]>}
 */
export async function extractImages(payload, options = {}) {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('image generation returned a non-object payload');
  }
  const record = /** @type {Record<string, unknown>} */ (payload);
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.images)
      ? record.images
      : [];
  const out = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = /** @type {Record<string, unknown>} */ (entry);
    const mediaType = typeof item.mime_type === 'string' ? item.mime_type : 'image/png';
    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      out.push({ data: Buffer.from(item.b64_json, 'base64'), mediaType });
      continue;
    }
    if (typeof item.url === 'string' && item.url.length > 0) {
      const response = await fetch(item.url, { signal: options.signal });
      if (!response.ok) {
        throw new Error(`downloading the generated image failed (${response.status})`);
      }
      out.push({
        data: Buffer.from(await response.arrayBuffer()),
        mediaType: response.headers.get('content-type') ?? mediaType,
      });
    }
  }
  if (out.length === 0) {
    throw new Error(`image generation returned no image: ${summarize(JSON.stringify(payload))}`);
  }
  return out;
}

/**
 * Ask Ark to generate (or edit with `references`) one image.
 *
 * @param {object} input
 * @param {string} input.apiKey - Ark API key.
 * @param {string} input.prompt - the full prompt.
 * @param {Array<{data: Buffer, mediaType: string}>} [input.references] - reference images.
 * @param {string} [input.baseURL] - Ark base URL.
 * @param {string} [input.model] - model name.
 * @param {string} [input.size] - size tier or exact `WxH`.
 * @param {'png'|'jpeg'} [input.outputFormat]
 * @param {boolean} [input.watermark]
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<GeneratedImage[]>}
 */
export async function generateImages(input) {
  const baseURL = input.baseURL?.trim() || DEFAULT_BASE_URL;
  const model = input.model?.trim() || DEFAULT_MODEL;
  const references = input.references ?? [];

  const endpoint = new URL('images/generations', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString();
  const body = {
    model,
    prompt: input.prompt,
    response_format: 'b64_json',
    ...(input.size === undefined ? {} : { size: input.size }),
    ...(input.outputFormat === undefined ? {} : { output_format: input.outputFormat }),
    ...(input.watermark === undefined ? {} : { watermark: input.watermark }),
    // Reference images are what make the output a consistent product series
    // rather than an unrelated picture.
    ...(references.length === 0
      ? {}
      : { image: references.map((reference) => toDataUrl(reference.data, reference.mediaType)) }),
  };

  // A provider call needs both the caller's cancellation and its own bound: the
  // bound protects against a connection that stalls without ever erroring.
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('timed out')), timeoutMs);
  const signals = [timeoutController.signal];
  if (input.signal !== undefined) signals.push(input.signal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (input.signal?.aborted) throw new Error('image generation was cancelled');
    if (timeoutController.signal.aborted) {
      throw new Error(`image generation timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`image generation request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    // The key itself must never reach a log or a model-facing error.
    throw new Error(`image generation failed (${response.status}): ${summarize(text)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`image generation returned invalid JSON: ${summarize(text)}`);
  }
  return extractImages(payload, { signal });
}

/**
 * Whether a failure is worth retrying: transport hiccups, rate limits, and
 * provider-side 5xx are transient; a 4xx other than 429 is a request problem
 * that a retry cannot fix.
 */
export function isRetryable(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = /failed \((\d{3})\)/.exec(message);
  if (status !== null) {
    const code = Number(status[1]);
    return code === 429 || code >= 500;
  }
  return /timed out|request failed|fetch failed|socket|ECONNRESET|ETIMEDOUT/i.test(message);
}

/**
 * Run `task` with bounded concurrency and retries.
 *
 * Generation is a pure fan-out — each call is independent — so a small amount of
 * overlap cuts the wall-clock time for a series substantially, while the cap
 * keeps a provider's per-account concurrency limit in view.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {number} [options.retries] - additional attempts after the first.
 * @param {(error: unknown, attempt: number, index: number) => void} [options.onRetry]
 * @returns {Promise<Array<{ok: true, value: T} | {ok: false, error: unknown}>>}
 */
export async function runPool(tasks, options = {}) {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, tasks.length || 1));
  const retries = options.retries ?? 0;
  const results = new Array(tasks.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      let attempt = 0;
      for (;;) {
        try {
          results[index] = { ok: true, value: await tasks[index]() };
          break;
        } catch (error) {
          if (attempt >= retries || !isRetryable(error)) {
            results[index] = { ok: false, error };
            break;
          }
          attempt++;
          options.onRetry?.(error, attempt, index);
          // Exponential backoff: rate limits need real breathing room.
          await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** (attempt - 1)));
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/**
 * List the models the account can see, for diagnosing a `ModelNotOpen` or
 * `InvalidEndpointOrModel` failure.
 *
 * @param {object} input
 * @param {string} input.apiKey
 * @param {string} [input.baseURL]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<Array<{id: string, status?: string, domain?: string}>>}
 */
export async function listModels(input) {
  const baseURL = input.baseURL?.trim() || DEFAULT_BASE_URL;
  const endpoint = new URL('models', baseURL.endsWith('/') ? baseURL : `${baseURL}/`).toString();
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${input.apiKey}` },
    signal: input.signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`listing models failed (${response.status}): ${summarize(text)}`);
  const payload = JSON.parse(text);
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return list.map((entry) => ({
    id: String(entry?.id ?? ''),
    status: typeof entry?.status === 'string' ? entry.status : undefined,
    domain: typeof entry?.domain === 'string' ? entry.domain : undefined,
  }));
}
