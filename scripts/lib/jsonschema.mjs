// A tiny JSON Schema interpreter for exactly the keywords archmap's schemas use:
// type, required, properties, items, enum, const, pattern, minItems, minLength, oneOf,
// and local "$ref": "#/$defs/<name>". Annotation keys ($schema, $id, $defs, title,
// description) are ignored. Unknown keys in DATA are always allowed.
// Zero dependencies; Node >= 18.

const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

const escapeToken = (t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1');
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolveRef(ref, root) {
  const m = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (!m || !root.$defs || !(m[1] in root.$defs)) {
    throw new Error(`unsupported or unresolvable $ref: ${ref}`);
  }
  return root.$defs[m[1]];
}

/**
 * Validate `data` against `schema`.
 * @returns {{pointer: string, keyword: string, message: string}[]} empty when valid;
 *   `pointer` is an RFC 6901 JSON pointer into `data` ("" for the root).
 */
export function validateSchema(schema, data, root = schema) {
  const errors = [];
  visit(schema, data, '', root, errors);
  return errors;
}

function visit(schema, data, pointer, root, errors) {
  if (schema.$ref !== undefined) {
    visit(resolveRef(schema.$ref, root), data, pointer, root, errors);
    return;
  }
  const fail = (keyword, message) => errors.push({ pointer, keyword, message });

  if (schema.type !== undefined) {
    const check = TYPES[schema.type];
    if (!check) throw new Error(`unsupported type: ${schema.type}`);
    if (!check(data)) {
      fail('type', `expected ${schema.type}`);
      return; // the remaining keywords would only add noise
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, data)) {
    fail('const', `expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, data))) {
    fail('enum', `expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      fail('minLength', `shorter than ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
      fail('pattern', `does not match ${schema.pattern}`);
    }
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      fail('minItems', `fewer than ${schema.minItems} items`);
    }
    if (schema.items !== undefined) {
      data.forEach((item, i) => visit(schema.items, item, `${pointer}/${i}`, root, errors));
    }
  }
  if (TYPES.object(data)) {
    for (const key of schema.required ?? []) {
      if (!(key in data)) {
        errors.push({ pointer: `${pointer}/${escapeToken(key)}`, keyword: 'required', message: `missing required "${key}"` });
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in data) visit(sub, data[key], `${pointer}/${escapeToken(key)}`, root, errors);
    }
  }
  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter((sub) => {
      const sink = [];
      visit(sub, data, pointer, root, sink);
      return sink.length === 0;
    }).length;
    if (matching !== 1) fail('oneOf', `matches ${matching} of ${schema.oneOf.length} alternatives, expected exactly 1`);
  }
}
