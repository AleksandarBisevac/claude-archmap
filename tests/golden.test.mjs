import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (g1, g2, ...) lead every title so the suite prints them first.
// The golden fixture is a hand-written model of a fictional app (Northwind Freight): the ground truth the renderer is compared against.
const { validate } = await import('../scripts/validate.mjs');

const GOLDEN = fileURLToPath(new URL('./fixtures/golden/', import.meta.url));
const DENYLIST = fileURLToPath(new URL('../.private/anonymise-denylist.txt', import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(GOLDEN, name), 'utf8'));
const model = readJson('architecture.model.json');
const issues = readJson('issues.json');

test('g1 the golden model and its issues validate with validate.mjs (evidence not checked: no repo)', () => {
  const alone = validate(model);
  assert.deepEqual(alone.findings, [], 'model alone has findings');
  const both = validate(model, { issues });
  assert.deepEqual(both.findings, [], 'model + issues have findings');
  assert.equal(both.ok, true);
  assert.equal(both.evidence, 'skipped');
});

test('g2 the model has at least 3 sequences, and entities with observed fields', () => {
  assert.ok(model.sequences.length >= 3, `only ${model.sequences.length} sequences`);
  const observed = model.entities.filter((e) => e.fields.some((f) => f.provenance === 'observed'));
  assert.ok(observed.length >= 1, 'no entity carries an observed field');
});

test('g3 every node and every edge carries at least one {path, lines} evidence', () => {
  for (const kind of ['nodes', 'edges']) {
    for (const x of model[kind]) {
      assert.ok(Array.isArray(x.evidence) && x.evidence.length >= 1, `${kind} ${x.id} has no evidence`);
      for (const e of x.evidence) {
        assert.equal(typeof e.path, 'string', `${kind} ${x.id} evidence path`);
        assert.match(e.lines, /^[0-9]+(-[0-9]+)?$/, `${kind} ${x.id} evidence lines`);
      }
    }
  }
});

test('g4 the fixture is rich: every zone kind, C4 levels 1-3, async edges, CRUD rows, inferred name-convention relations, full step grammar', () => {
  const zoneKinds = new Set(model.zones.map((z) => z.kind));
  for (const k of ['browser', 'edge', 'service', 'data', 'external', 'platform', 'delivery']) {
    assert.ok(zoneKinds.has(k), `no zone of kind ${k}`);
  }
  const levels = new Set(model.nodes.map((n) => n.level));
  for (const l of [1, 2, 3]) assert.ok(levels.has(l), `no node at level ${l}`);
  for (const t of ['event', 'queue']) {
    assert.ok(model.edges.some((e) => e.async === true && e.type === t), `no async ${t} edge`);
  }
  assert.ok(model.access.length >= 1, 'no CRUD access rows');
  assert.ok(
    model.relations.some((r) => r.kind === 'name-convention' && r.provenance === 'inferred'),
    'no inferred name-convention relation',
  );
  assert.equal(model.sequences.length, 7);
  const steps = model.sequences.flatMap((s) => s.steps);
  assert.ok(steps.some((s) => Array.isArray(s.m)), 'no message step');
  assert.ok(steps.some((s) => typeof s.frag === 'string'), 'no fragment step');
  assert.ok(steps.some((s) => Array.isArray(s.note)), 'no note step');
});

test('g5 the issues file holds 6-8 synthetic issues, one per category, anchored to fixture ids', () => {
  const list = issues.issues;
  assert.ok(list.length >= 6 && list.length <= 8, `${list.length} issues`);
  const cats = list.map((i) => i.category);
  assert.equal(new Set(cats).size, cats.length, 'two issues share a category');
  for (const c of ['security', 'data', 'reliability', 'performance', 'design', 'docs']) {
    assert.ok(cats.includes(c), `no ${c} issue`);
  }
  // validate() (g1) proves every anchor resolves; here, that more than one anchor kind is exercised.
  const anchorKinds = new Set(list.map((i) => Object.keys(i.anchor)[0]));
  assert.ok(anchorKinds.size >= 3, `anchor kinds: ${[...anchorKinds]}`);
});

test('g6 meta is fictional: example.invalid repo URL and a fixed fake commit', () => {
  assert.equal(model.meta.repoUrl, 'https://example.invalid/northwind-freight');
  assert.match(model.meta.commit, /^[0-9a-f]{40}$/);
  assert.equal(model.meta.project, 'Northwind Freight');
});

test('g8 the golden model passed through merge.mjs as the previous model still validates, keeps its elements and renders', async () => {
  const { merge } = await import('../scripts/merge.mjs');
  const { layoutModel } = await import('../scripts/layout.mjs');
  const { renderHtml, checkInputs } = await import('../scripts/render.mjs');
  // merge writes canonical JSON (sorted keys, elements in id order), so compare element sets in canonical form
  const canon = (x) => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v));
  const set = (arr) => (arr ?? []).map(canon).sort();
  const r = merge({ fragments: [], previous: model, areas: [], meta: {} });
  assert.deepEqual(validate(r.model).findings, []);
  for (const key of ['nodes', 'edges', 'entities', 'access', 'sequences', 'views', 'zones']) {
    assert.deepEqual(set(r.model[key]), set(model[key]), `${key} unchanged by the merge`);
  }
  const zoneIds = r.model.zones.map((z) => z.id);
  assert.equal(new Set(zoneIds).size, zoneIds.length, 'no duplicate zones');
  const rels = set(r.model.relations);
  for (const rel of set(model.relations)) assert.ok(rels.includes(rel), `authored relation kept: ${rel}`);
  const layout = await layoutModel(r.model);
  assert.deepEqual(checkInputs({ model: r.model, layout }), []);
  const html = renderHtml({ model: r.model, layout });
  for (const n of model.nodes) assert.ok(html.includes(n.id), `${n.id} rendered`);
  // and twice through the merge is byte-identical
  assert.equal(JSON.stringify(merge({ fragments: [], previous: r.model, areas: [], meta: {} }).model), JSON.stringify(r.model));
});

test('g7 no fixture file contains any term from the private denylist (case-insensitive)', (t) => {
  if (!existsSync(DENYLIST)) {
    t.skip('denylist .private/anonymise-denylist.txt is absent (as in CI); denylist not checked here');
    return;
  }
  const terms = readFileSync(DENYLIST, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
  assert.ok(terms.length > 0, 'denylist has no terms');
  const files = readdirSync(GOLDEN).filter((f) => !f.startsWith('.'));
  assert.ok(files.length >= 2, 'no fixture files found');
  const hits = [];
  for (const f of files) {
    const text = readFileSync(join(GOLDEN, f), 'utf8').toLowerCase();
    terms.forEach((term, i) => {
      if (text.includes(term)) hits.push(`${f}: denylist line-term #${i + 1}`);
    });
  }
  // Hits name the term by its index only, so a failure never prints a denied term into CI logs.
  assert.deepEqual(hits, []);
});
