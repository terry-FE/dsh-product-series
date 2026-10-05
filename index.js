/**
 * Bundle entry point referenced by `dsh.bundle.patch` in package.json and by the
 * `name:` field of this bundle's cordis patch entry.
 *
 * A thin re-export keeps the loader's resolution simple — it loads this file,
 * which is exactly the module named in the patch — while the implementation
 * lives in `plugin.mjs`.
 */

export { apply, inject, name } from './plugin.mjs';
