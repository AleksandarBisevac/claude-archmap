import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Case ids (s1, s2, ...) lead every title so the suite prints them first.
const load = (name) =>
  JSON.parse(readFileSync(new URL(`../schema/archmap-${name}.schema.json`, import.meta.url), 'utf8'));

const names = ['model', 'issues', 'theme'];
const model = load('model');
const issues = load('issues');
const theme = load('theme');

// The only keywords validate.mjs (P1.2) will interpret.
const KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'required', 'properties',
  'items', 'enum', 'const', 'pattern', 'minItems', 'minLength', 'oneOf',
]);

// Visit every schema object, skipping property-name maps and enum/const/required payloads.
function walk(node, visit, path = '#') {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, visit, `${path}/${i}`));
  if (node === null || typeof node !== 'object') return;
  visit(node, path);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'enum' || k === 'const' || k === 'required') continue;
    if (k === 'properties' || k === '$defs') {
      for (const [name, sub] of Object.entries(v)) walk(sub, visit, `${path}/${k}/${name}`);
    } else walk(v, visit, `${path}/${k}`);
  }
}

// Minimal interpreter of the same subset, to prove the schemas say what we mean.
function check(schema, value, root = schema) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\/\$defs\//, '');
    return check(root.$defs[target], value, root);
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return false;
  if (schema.type) {
    const ok = {
      object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
      array: Array.isArray,
      string: (v) => typeof v === 'string',
      integer: Number.isInteger,
      number: (v) => typeof v === 'number',
      boolean: (v) => typeof v === 'boolean',
    }[schema.type];
    if (!ok(value)) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.items && !value.every((v) => check(schema.items, v, root))) return false;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required ?? []) if (!(r in value)) return false;
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value && !check(sub, value[k], root)) return false;
    }
  }
  if (schema.oneOf && schema.oneOf.filter((s) => check(s, value, root)).length !== 1) return false;
  return true;
}

const ev = [{ path: 'backend/app/main.py', lines: '10-20' }];
const validModel = () => ({
  meta: {
    schemaVersion: '1.0.0', project: 'demo', commit: 'abc1234', generatedAt: '2026-10-28T00:00:00Z',
    repoUrl: 'https://example.invalid/demo', profile: 'balanced', sources: [], coverage: { backend: ['backend/**'] },
  },
  zones: [{ id: 'svc', kind: 'service', label: 'Service' }],
  nodes: [{ id: 'api', zone: 'svc', kind: 'service', title: 'API', paths: ['backend/**'], level: 1, evidence: ev }],
  edges: [{ id: 'e1', from: 'api', to: 'api', type: 'call', desc: 'self', confidence: 'verified', evidence: ev }],
  entities: [{
    id: 'users', store: 'api', name: 'users', kind: 'table',
    fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }],
  }],
  relations: [{
    from: { entity: 'users', field: 'id' }, to: { entity: 'users', field: 'id' },
    cardinality: '1-1', kind: 'fk', provenance: 'inferred',
  }],
  access: [{ node: 'api', entity: 'users', ops: 'CR', evidence: ev }],
  sequences: [{
    id: 'seq1', title: 'Login', summary: 's',
    participants: [{ id: 'a', label: 'A' }],
    steps: [
      { m: ['a', 'a'], k: 'api', t: 'call', d: 'detail', r: ['api'] },
      { frag: 'alt', t: 'ok?' },
      { note: ['a'], t: 'careful', tone: 'warn' },
    ],
  }],
  views: [{ id: 'system', title: 'System' }],
});
const validIssue = () => ({
  id: 'I1', sev: 'high', category: 'security', title: 't', anchor: { node: 'api' },
  summary: 's', impact: 'i', fix: 'f', evidence: ev, source: 'archmap',
});

test('s1 each schema parses, declares draft 2020-12 $schema and an $id', () => {
  for (const [name, s] of [['model', model], ['issues', issues], ['theme', theme]]) {
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema', name);
    assert.equal(typeof s.$id, 'string', name);
    assert.ok(s.$id.length > 0 && s.$id.includes(`archmap-${name}`), `${name} $id names the file`);
  }
  assert.equal(names.length, 3);
});

test('s2 model schema requires the design section 5 top-level and meta keys', () => {
  assert.equal(model.type, 'object');
  for (const k of ['meta', 'zones', 'nodes', 'edges']) assert.ok(model.required.includes(k), k);
  for (const k of ['meta', 'zones', 'nodes', 'edges', 'entities', 'relations', 'access', 'sequences', 'views']) {
    assert.ok(model.properties[k], `properties.${k}`);
  }
  const meta = model.properties.meta;
  for (const k of ['schemaVersion', 'project', 'commit', 'generatedAt', 'profile', 'sources', 'coverage']) {
    assert.ok(meta.required.includes(k), `meta.required ${k}`);
  }
  for (const k of ['repoUrl', ...meta.required]) assert.ok(meta.properties[k], `meta.properties.${k}`);
});

test('s3 model enums match design section 5', () => {
  const d = model.$defs;
  assert.deepEqual(d.zone.properties.kind.enum,
    ['browser', 'edge', 'service', 'data', 'external', 'platform', 'delivery']);
  assert.deepEqual(d.edge.properties.type.enum,
    ['api', 'static', 'auth', 'pull', 'sql', 'cache', 'persist', 'call', 'link', 'deploy', 'event', 'queue']);
  assert.deepEqual(d.edge.properties.confidence.enum, ['verified', 'inferred', 'external']);
  assert.deepEqual(d.edge.properties.foundBy.enum, ['static', 'llm', 'introspection']);
  assert.ok(!d.edge.required.includes('foundBy'), 'foundBy is optional');
  assert.deepEqual(d.entity.properties.kind.enum, ['table', 'view', 'collection', 'dataset']);
  assert.deepEqual(d.field.properties.provenance.enum, ['declared', 'observed', 'inferred']);
  assert.deepEqual(d.relation.properties.cardinality.enum, ['1-1', '1-n', 'n-m']);
  assert.deepEqual(d.relation.properties.kind.enum, ['fk', 'join', 'name-convention']);
  assert.deepEqual(d.relation.properties.provenance.enum, ['declared', 'observed', 'inferred']);
  assert.deepEqual(model.properties.meta.properties.profile.enum, ['max', 'balanced', 'economy']);
  assert.deepEqual(d.node.properties.level.enum, [1, 2, 3]);
});

test('s4 model $defs hold the shared shapes and every local $ref resolves', () => {
  for (const k of ['evidence', 'zone', 'node', 'edge', 'entity', 'field', 'relation', 'access', 'sequence', 'view']) {
    assert.ok(model.$defs[k], `$defs.${k}`);
  }
  for (const [name, s] of [['model', model], ['issues', issues], ['theme', theme]]) {
    walk(s, (n, path) => {
      if (n.$ref === undefined) return;
      assert.match(n.$ref, /^#\/\$defs\/[A-Za-z0-9_-]+$/, `${name} ${path} is a local $defs ref`);
      assert.ok(s.$defs?.[n.$ref.split('/').pop()], `${name} ${path} resolves`);
    });
  }
});

test('s5 evidence is required with minItems 1 on nodes and edges, lines is N or N-M', () => {
  const d = model.$defs;
  for (const k of ['node', 'edge']) {
    assert.ok(d[k].required.includes('evidence'), `${k} requires evidence`);
    assert.equal(d[k].properties.evidence.minItems, 1, `${k} evidence minItems`);
  }
  assert.deepEqual([...d.evidence.required].sort(), ['lines', 'path']);
  const lines = d.evidence.properties.lines;
  for (const ok of ['7', '10-20']) assert.ok(check(lines, ok), ok);
  for (const bad of ['', 'a', '10-', '-5', '1-2-3', '1,2']) assert.ok(!check(lines, bad), bad);
});

test('s6 no schema closes objects and all use only the agreed keyword subset', () => {
  for (const [name, s] of [['model', model], ['issues', issues], ['theme', theme]]) {
    walk(s, (n, path) => {
      const isNameMap = /\/(properties|\$defs)$/.test(path);
      if (isNameMap) return;
      assert.ok(!('additionalProperties' in n), `${name} ${path} must not set additionalProperties`);
      for (const k of Object.keys(n)) assert.ok(KEYWORDS.has(k), `${name} ${path} uses unsupported keyword ${k}`);
    });
  }
});

test('s7 access ops must be a non-empty subset of CRUD', () => {
  const ops = model.$defs.access.properties.ops;
  for (const ok of ['C', 'R', 'CRUD', 'CR', 'RU', 'D']) assert.ok(check(ops, ok), ok);
  for (const bad of ['', 'X', 'CX', 'CC', 'crud', 'CRUDD']) assert.ok(!check(ops, bad), bad);
  assert.ok(model.$defs.access.required.includes('ops'));
});

test('s8 sequence steps accept exactly the three grammar shapes', () => {
  const step = model.$defs.sequence.properties.steps.items;
  const msg = { m: ['a', 'b'], k: 'api', t: 'x', d: 'y', r: ['n1'] };
  assert.ok(check(step, msg, model));
  assert.ok(check(step, { ...msg, ret: 'ok', i: 'I1' }, model));
  for (const f of ['alt', 'else', 'opt', 'loop', 'end']) assert.ok(check(step, { frag: f, t: 'x' }, model), f);
  assert.ok(check(step, { note: ['a'], t: 'x', tone: 'warn' }, model));
  assert.ok(!check(step, { frag: 'maybe', t: 'x' }, model), 'unknown frag');
  assert.ok(!check(step, { t: 'orphan' }, model), 'no shape');
  assert.ok(!check(step, { m: ['a', 'b'], k: 'api', t: 'x' }, model), 'message missing d and r');
});

test('s9 a minimal valid model passes and a node or edge without evidence fails', () => {
  assert.ok(check(model, validModel()));
  const noNodeEv = validModel();
  delete noNodeEv.nodes[0].evidence;
  assert.ok(!check(model, noNodeEv), 'node without evidence');
  const emptyEdgeEv = validModel();
  emptyEdgeEv.edges[0].evidence = [];
  assert.ok(!check(model, emptyEdgeEv), 'edge with empty evidence');
  const badType = validModel();
  badType.edges[0].type = 'telepathy';
  assert.ok(!check(model, badType), 'edge type outside the enum');
  const extra = validModel();
  extra.nodes[0].futureKey = { anything: true };
  extra.extraTop = 1;
  assert.ok(check(model, extra), 'unknown keys are tolerated');
});

test('s10 issues schema matches design section 5 and D4', () => {
  const issue = issues.$defs.issue;
  for (const k of ['id', 'sev', 'category', 'title', 'anchor', 'summary', 'impact', 'fix', 'evidence', 'source']) {
    assert.ok(issue.required.includes(k), `required ${k}`);
  }
  assert.ok(!issue.required.includes('detail'), 'detail is optional');
  assert.ok(issue.properties.detail && issue.properties.track);
  assert.deepEqual(issue.properties.sev.enum, ['high', 'med', 'low']);
  assert.deepEqual(issue.properties.category.enum,
    ['security', 'data', 'reliability', 'performance', 'design', 'docs']);
  assert.deepEqual(issue.properties.source.enum, ['archmap', 'audit']);
  assert.ok(issues.required.includes('issues'));
  assert.ok(check(issues, { issues: [validIssue()] }));
  assert.ok(check(issues, { issues: [] }));
  const noEv = validIssue();
  noEv.evidence = [];
  assert.ok(!check(issues, { issues: [noEv] }), 'issue evidence minItems 1');
});

test('s11 an issue anchors to exactly one of node, edge, entity or step', () => {
  const at = (anchor) => check(issues, { issues: [{ ...validIssue(), anchor }] });
  for (const k of ['node', 'edge', 'entity', 'step']) assert.ok(at({ [k]: 'x' }), k);
  assert.ok(!at({}), 'none');
  assert.ok(!at({ node: 'a', edge: 'b' }), 'two');
  assert.ok(!at({ node: 'a', step: 's:1', entity: 'e' }), 'three');
  const bad = { ...validIssue(), sev: 'critical' };
  assert.ok(!check(issues, { issues: [bad] }), 'sev outside enum');
});

test('s12 theme schema themes fonts, chrome and accent only', () => {
  assert.deepEqual(Object.keys(theme.properties).filter((k) => k !== '$schema').sort(), ['accent', 'chrome', 'fonts']);
  for (const banned of ['zone', 'relation', 'severity', 'sev', 'edge']) {
    assert.ok(!Object.keys(theme.properties).some((k) => k.toLowerCase().includes(banned)), banned);
  }
  assert.ok(check(theme, {}), 'every key optional');
  assert.ok(check(theme, {
    fonts: { sans: 'Inter, sans-serif', mono: 'Menlo, monospace' },
    chrome: { bg: '#ffffff', text: '#111111' },
    accent: '#3366cc',
  }));
  assert.ok(!check(theme, { accent: 'blue' }), 'accent must be a hex colour');
  assert.ok(!check(theme, { fonts: 'Inter' }), 'fonts must be an object');
});
