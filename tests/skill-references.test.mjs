import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Case ids (r1, r2, ...) lead every title so the suite prints them first.
// The architecture-map skill's model-contract references must stay in step with
// schema/archmap-model.schema.json: every key and enum value the schema defines is named.
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const schema = JSON.parse(read('schema/archmap-model.schema.json'));
const modelSchemaMd = read('skills/architecture-map/references/model-schema.md');
const taxonomyMd = read('skills/architecture-map/references/relation-taxonomy.md');
const sequencesMd = read('skills/architecture-map/references/sequences.md');

// A name counts as documented when it appears as a whole token (not as part of a longer word).
const tokenRe = (name) =>
  new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![A-Za-z0-9_-])`);
const missing = (text, names) => names.filter((n) => !tokenRe(n).test(text));

// Node kinds are an open string in the schema; docs/design.md section 5 lists the recommended ones.
const NODE_KINDS = ['app', 'module', 'route-group', 'service', 'store', 'queue', 'job', 'external'];

test('r1 every top-level and meta property of the schema is named in model-schema.md', () => {
  const top = Object.keys(schema.properties);
  const meta = Object.keys(schema.properties.meta.properties);
  assert.ok(top.length >= 9 && meta.length >= 7, 'schema read sanity');
  assert.deepEqual(missing(modelSchemaMd, top), [], 'top-level keys missing');
  assert.deepEqual(missing(modelSchemaMd, meta), [], 'meta keys missing');
  // User-authored fields and field provenance values are part of the contract.
  assert.deepEqual(missing(modelSchemaMd, ['locked', 'notes', 'pinned', 'declared', 'observed', 'inferred']), []);
});

test('r2 every edge type, zone kind and node kind appears in relation-taxonomy.md', () => {
  const edgeTypes = schema.$defs.edge.properties.type.enum;
  const zoneKinds = schema.$defs.zone.properties.kind.enum;
  const confidence = schema.$defs.edge.properties.confidence.enum;
  assert.equal(edgeTypes.length, 12);
  assert.deepEqual(missing(taxonomyMd, edgeTypes), [], 'edge types missing');
  assert.deepEqual(missing(taxonomyMd, zoneKinds), [], 'zone kinds missing');
  assert.deepEqual(missing(taxonomyMd, confidence), [], 'confidence values missing');
  assert.deepEqual(missing(taxonomyMd, NODE_KINDS), [], 'node kinds missing');
  assert.deepEqual(missing(taxonomyMd, ['async']), []);
});

test('r3 model-schema.md has an explorer fragment-contract section', () => {
  assert.match(modelSchemaMd, /^#{1,3} .*fragment contract/im, 'heading naming the fragment contract');
  const section = modelSchemaMd.split(/^#{1,3} .*fragment contract.*$/im)[1] ?? '';
  assert.deepEqual(missing(section, ['nodes', 'edges', 'entities', 'access', 'evidence', 'coverage', 'skipped']), []);
});

test('r4 sequences.md names every step key and frag value from the schema', () => {
  const d = schema.$defs;
  const keys = new Set([
    ...Object.keys(d.stepMessage.properties),
    ...Object.keys(d.stepFragment.properties),
    ...Object.keys(d.stepNote.properties),
  ]);
  const frags = d.stepFragment.properties.frag.enum;
  assert.deepEqual(missing(sequencesMd, [...keys]), [], 'step keys missing');
  assert.deepEqual(missing(sequencesMd, frags), [], 'frag values missing');
});
