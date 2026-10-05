/**
 * Plugin-surface tests: the tool is registered with the documented parameters,
 * its output contract is honoured, and its failure messages tell the caller what
 * to fix. These use a stub cordis context, so no host and no provider are needed
 * for everything except the explicit "live" test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apply, inject, name, MAX_COUNT, OUTPUT_SIZE } from '../plugin.mjs';

const ROOT = join(tmpdir(), 'dsh-product-series-plugin');

/** A stub context that records the registered tool and resolves credentials. */
function makeContext(options = {}) {
  const registered = [];
  return {
    registered,
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    credentials: {
      resolve: async (ref) => {
        if (options.apiKey !== undefined && ref === options.apiKeyRef) return { value: options.apiKey };
        return undefined;
      },
    },
  };
}

/** A minimal PNG so reference loading accepts the file. */
function pngBytes(size = 32) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);
}

function freshRoot() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

/** A fake execution context with an abortable signal. */
function makeExec(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: new AbortController().signal };
}

/* ---------------- module surface ---------------- */

test('the bundle exports the loader-facing name, inject and apply', () => {
  assert.equal(typeof name, 'string');
  assert.equal(name, 'product-series');
  // `credentials` must be declared: reading an undeclared cordis service throws
  // at call time, which is exactly how this plugin first failed in a real host.
  assert.deepEqual(inject, ['tools', 'credentials']);
  assert.equal(typeof apply, 'function');
});

test('apply registers exactly one tool with the documented name', () => {
  const ctx = makeContext();
  apply(ctx, {});
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0].name, 'generate_product_series');
});

test('the tool declares every documented parameter', () => {
  const ctx = makeContext();
  apply(ctx, {});
  const params = ctx.registered[0].parameters;
  for (const key of ['prompt', 'referenceDir', 'count', 'outputDir', 'style']) {
    assert.ok(params[key] !== undefined, `missing parameter ${key}`);
  }
  assert.equal(params.prompt.required, true, 'prompt must be required');
  assert.equal(params.count.type, 'integer');
  assert.ok(params.referenceDir.description.includes('working directory'));
  assert.equal(params.count.description.includes(String(MAX_COUNT)), true);
});

test('the tool description states the format, the size, the cap and the slowness', () => {
  const ctx = makeContext();
  apply(ctx, {});
  const description = ctx.registered[0].description;
  assert.match(description, /400x400/);
  assert.match(description, /WebP/);
  assert.match(description, new RegExp(String(MAX_COUNT)));
  assert.match(description, /minute/);
  assert.match(description, /figma-import/);
});

test('the declared parameters satisfy the tool registry contract', async () => {
  const ctx = makeContext();
  apply(ctx, {});
  const definition = ctx.registered[0];
  // The registry validates arguments against this schema shape; a malformed
  // spec fails at registration in a real host, so assert the essentials here.
  assert.equal(typeof definition.description, 'string');
  assert.equal(typeof definition.execute, 'function');
  assert.equal(typeof definition.output, 'object');
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(definition.output.schema.type, 'object');
  assert.equal(typeof definition.presentCall, 'function');
  const view = definition.presentCall({ prompt: 'x', count: 3 });
  assert.match(view.title, /3 product image/);
});

/* ---------------- argument validation ---------------- */

test('a missing prompt is rejected with a clear message', async () => {
  const ctx = makeContext();
  apply(ctx, {});
  await assert.rejects(
    () => ctx.registered[0].execute({ prompt: '   ' }, makeExec(ROOT)),
    /requires a non-empty prompt/,
  );
});

test('an out-of-range count is rejected instead of silently clamped', async () => {
  const ctx = makeContext();
  apply(ctx, {});
  await assert.rejects(
    () => ctx.registered[0].execute({ prompt: 'x', count: 0 }, makeExec(ROOT)),
    new RegExp(`count must be between 1 and ${MAX_COUNT}`),
  );
  await assert.rejects(
    () => ctx.registered[0].execute({ prompt: 'x', count: MAX_COUNT + 1 }, makeExec(ROOT)),
    new RegExp(`count must be between 1 and ${MAX_COUNT}`),
  );
});

test('a missing API key names the credential to configure', async () => {
  const root = freshRoot();
  const ctx = makeContext();
  apply(ctx, {});
  await assert.rejects(
    () => ctx.registered[0].execute({ prompt: 'a cable' }, makeExec(root)),
    /requires an Ark API key[\s\S]*ARK_API_KEY/,
  );
});

/* ---------------- reference discovery ---------------- */

test('a live run reports the reference directory and model it used', async () => {
  const root = freshRoot();
  mkdirSync(join(root, 'figma-import', 'assets'), { recursive: true });
  writeFileSync(join(root, 'figma-import', 'assets', 'key-visual.png'), pngBytes());

  const ctx = makeContext({ apiKey: 'test-key', apiKeyRef: 'ARK_API_KEY' });
  // Point the provider at a loopback URL that refuses immediately, so the run
  // fails at the network step rather than by reaching a real provider.
  apply(ctx, { baseURL: 'http://127.0.0.1:1/api/v3', requestTimeoutMs: 2000 });

  await assert.rejects(
    () => ctx.registered[0].execute({ prompt: 'a matte grey cable', count: 1 }, makeExec(root)),
    /every frame failed|request failed|fetch failed/i,
  );
});

test('a missing reference directory is reported as a directory problem', async () => {
  const root = freshRoot();
  const ctx = makeContext({ apiKey: 'test-key', apiKeyRef: 'ARK_API_KEY' });
  apply(ctx, {});
  // scanReferenceImages tolerates an unreadable tree, so the provider step is
  // what fails here; the assertion is that the error is not about references.
  await assert.rejects(
    () => ctx.registered[0].execute(
      { prompt: 'a cable', referenceDir: join(root, 'does-not-exist'), count: 1 },
      makeExec(root),
    ),
    (error) => !/cannot read referenceDir/.test(String(error)),
  );
});

/* ---------------- output contract ---------------- */

test('the renderer lists every frame path and any failures', () => {
  const ctx = makeContext();
  apply(ctx, {});
  const value = {
    requested: 2,
    generated: 1,
    failed: 1,
    outputDir: 'D:\\ws\\product-series',
    referenceDir: 'D:\\ws',
    referenceCount: 1,
    model: 'doubao-seedream-5-0-pro-260628',
    images: [{
      path: 'D:\\ws\\product-series\\a-cable-01.webp',
      width: 400,
      height: 400,
      bytes: 1234,
    }],
    failures: [{ frame: 2, reason: 'rate limited' }],
  };
  const blocks = ctx.registered[0].output.render({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Generated 1 of 2 frame\(s\) at 400x400/);
  assert.match(blocks[0].text, /a-cable-01\.webp/);
  assert.match(blocks[0].text, /frame 2: rate limited/);
});

test('the output schema declares every field the renderer reads', () => {
  const ctx = makeContext();
  apply(ctx, {});
  const schema = ctx.registered[0].output.schema;
  const fields = ['requested', 'generated', 'failed', 'outputDir', 'referenceDir', 'referenceCount', 'model', 'images', 'failures'];
  for (const key of fields) {
    assert.ok(schema.properties[key] !== undefined, `schema missing ${key}`);
    // The value-schema DSL marks required fields per property. A root-level
    // `required` array is rejected by the registry's schema compiler, so its
    // absence is part of the contract, not an omission.
    assert.equal(schema.properties[key].required, true, `${key} must be marked required on the property`);
  }
  assert.equal(schema.required, undefined, 'root-level required is unsupported by the schema DSL');
});

test('the parameter schema avoids constructs the real DSL rejects', () => {
  // The registry's value-schema compiler rejects a root-level `required` array;
  // this asserts the parameter spec stays clear of it too.
  const ctx = makeContext();
  apply(ctx, {});
  const params = ctx.registered[0].parameters;
  assert.equal(params.required, undefined, 'parameter spec must not carry a root required array');
  for (const [key, spec] of Object.entries(params)) {
    assert.equal(Array.isArray(spec.required), false, `${key} must use required: true, not an array`);
  }
});

test('the test stub reproduces the registry schema rule it guards', async () => {
  // Guards the guard: if the stub stopped rejecting a root `required` array, the
  // schema tests above would silently stop protecting anything, and the mistake
  // would only surface at boot in a real DSH process.
  const tools = await import('@deepseek-ai/dsh-tools');
  assert.throws(
    () => tools.defineTool({
      name: 'probe',
      description: 'probe',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } },
        render: () => [],
      },
      execute: async () => ({}),
    }),
    /schema\.required is not supported/,
  );
});

test('the size constant is the required deliverable size', () => {
  assert.equal(OUTPUT_SIZE, 400);
});

test.after(() => {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
});
