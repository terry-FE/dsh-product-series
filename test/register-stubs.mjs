/**
 * Test-time module resolution for the DSH packages this bundle consumes.
 *
 * `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` are peer dependencies
 * supplied by the host that composes this bundle. They are deliberately not
 * bundled or declared as install-time dependencies, so when the tests run
 * outside a DSH profile there is nothing to resolve them from.
 *
 * Rather than depending on DSH's internal layout, this hook maps those two
 * specifiers to local stubs that expose only what the plugin actually uses.
 * That keeps the test suite self-contained and portable, and it keeps the
 * plugin's host contract explicit: if the plugin ever starts relying on more of
 * those APIs, the stubs stop satisfying it and the tests say so.
 *
 * Use it with:
 *   node --import ./test/register-stubs.mjs test/plugin.test.mjs
 */

import { register } from 'node:module';

register(new URL('./dsh-stubs.mjs', import.meta.url));
