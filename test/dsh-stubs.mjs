/**
 * Module-resolution hook backing `register-stubs.mjs`.
 *
 * Maps the host-provided DSH packages to local stub modules. Those packages are
 * peer dependencies supplied by the host that composes this bundle, so they are
 * deliberately neither bundled nor declared as install-time dependencies — which
 * means there is nothing to resolve them from outside a DSH profile.
 *
 * `test/stub-dsh-tools.mjs` mirrors the registry's tool-authoring validation, so
 * a schema mistake fails here rather than at boot in a real DSH process.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

const STUBS = new Map([
  ['@deepseek-ai/dsh-tools', new URL('./stub-dsh-tools.mjs', import.meta.url)],
  ['@deepseek-ai/cordis', new URL('./stub-cordis.mjs', import.meta.url)],
]);

export async function resolve(specifier, context, nextResolve) {
  const target = STUBS.get(specifier);
  if (target !== undefined) {
    // Resolve to the real stub file on disk and let the default loader read it.
    return { url: pathToFileURL(fileURLToPath(target)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
