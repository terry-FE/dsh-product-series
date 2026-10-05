/**
 * Test double for `@deepseek-ai/dsh-tools`.
 *
 * The real package is a host-supplied peer dependency, so it is absent when the
 * tests run outside a DSH profile. `test/register-stubs.mjs` maps the specifier
 * to this module.
 *
 * `defineTool` here validates the declared schemas the way the real registry
 * does, then returns the definition unchanged. The validation is not decorative:
 * the real registry compiles value schemas during `defineTool` and rejects
 * authoring mistakes, and an earlier permissive stub accepted a root-level
 * `required` array that then failed at boot in a real DSH process
 * ("schema.required is not supported by the value schema DSL"). Reproducing that
 * rule is what keeps the mistake inside `npm test`.
 */

/** Keys the value-schema DSL accepts on one node. */
const SUPPORTED_KEYS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'description',
  'enum',
  'const',
  'oneOf',
  'additionalProperties',
  'optional',
  'default',
]);

/**
 * Validate one schema node.
 * @param {unknown} node - candidate node.
 * @param {string} path - dotted path for the error message.
 */
function assertNode(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new Error(`unsupported JSON schema at ${path}: unknown key ${JSON.stringify(key)}`);
    }
  }
  // The DSL marks a required property with `required: true` on the property
  // itself. An ARRAY at any level is what the real compiler rejects.
  if (Array.isArray(node.required)) {
    throw new Error(
      `unsupported JSON schema at ${path}: schema.required is not supported by the value schema DSL `
      + '(mark each property with required: true instead)',
    );
  }
  if (node.properties !== undefined) {
    if (node.type !== 'object') {
      throw new Error(`unsupported JSON schema at ${path}: properties requires type object`);
    }
    for (const [name, child] of Object.entries(node.properties)) assertNode(child, `${path}.${name}`);
  }
  if (node.items !== undefined) assertNode(node.items, `${path}[]`);
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((child, index) => assertNode(child, `${path}.oneOf[${index}]`));
  }
}

/**
 * Validate a parameter map.
 *
 * `parameters` is a map of PARAMETER NAME to that parameter's spec, so its
 * top-level keys are names and must not be checked as schema keywords.
 */
function assertParameters(parameters, path) {
  if (parameters === null || typeof parameters !== 'object') {
    throw new Error(`${path} must be an object`);
  }
  for (const [name, spec] of Object.entries(parameters)) assertNode(spec, `${path}.${name}`);
}

/** Stand-in for the registry's tool authoring entry point. */
export function defineTool(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new Error('defineTool requires a definition object');
  }
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new Error('defineTool requires a tool name');
  }
  if (typeof definition.description !== 'string' || definition.description.length === 0) {
    throw new Error(`defineTool requires a tool description for ${definition.name}`);
  }
  if (typeof definition.execute !== 'function') {
    throw new Error(`defineTool requires an execute function for ${definition.name}`);
  }
  assertParameters(definition.parameters, `${definition.name}.parameters`);
  if (definition.output === undefined || typeof definition.output !== 'object') {
    throw new Error(`defineTool requires a canonical output declaration for ${definition.name}`);
  }
  assertNode(definition.output.schema, `${definition.name}.output.schema`);
  if (typeof definition.output.render !== 'function') {
    throw new Error(`defineTool requires output.render for ${definition.name}`);
  }
  return definition;
}
