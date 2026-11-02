import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (dp1..dp9) lead every title so the suite prints them first.
// The data platform stack plug-in of prescan (dbt projects: models, sources, tests and lineage), run on the fictional
// shop project in tests/fixtures/repos/data-platform/ (read as text only - the extractor must never run dbt or a warehouse client).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'repos', 'data-platform');
const LIB = join(ROOT, 'scripts', 'lib', 'prescan');
const MODULE = join(LIB, 'data-platform.mjs');
const { default: plugin, extractDataPlatform, MAX_ITEMS, MAX_NESTED } = await import(pathToFileURL(MODULE).href);

const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });

const fixtureFiles = walk(FIXTURE).sort();
const fixtureRead = (p) => readFileSync(join(FIXTURE, p), 'utf8');
const frag = extractDataPlatform(fixtureFiles, fixtureRead);
const memFrag = (files) => extractDataPlatform(Object.keys(files).sort(), (p) => files[p] ?? null);
const ev = (path, lines) => [{ path, lines }];
const P = 'shop_analytics';
const where = { project: P, scope: '.' };

test('dp1 one model per .sql file under the model paths, with layer, materialization and the file as evidence', () => {
  assert.deepEqual(frag.models, [
    { name: 'customer_summary', ...where, layer: 'marts', materialization: 'table', evidence: ev('models/marts/customer_summary.sql', '1-5') },
    { name: 'orders_enriched', ...where, layer: 'marts', materialization: 'incremental', evidence: ev('models/marts/orders_enriched.sql', '1-7') },
    { name: 'stg_customers', ...where, layer: 'staging', materialization: 'view', evidence: ev('models/staging/stg_customers.sql', '1-4') },
    { name: 'stg_orders', ...where, layer: 'staging', materialization: 'view', evidence: ev('models/staging/stg_orders.sql', '1-5') },
  ]);
});

test('dp2 sources and tests come from the schema files: a source table per item, a test per entry, each with its target and the line it sits on', () => {
  assert.deepEqual(frag.sources, [
    { source: 'shop', name: 'orders', address: 'shop.orders', ...where, evidence: ev('models/staging/_sources.yml', '7-8') },
    { source: 'shop', name: 'customers', address: 'shop.customers', ...where, evidence: ev('models/staging/_sources.yml', '9-13') },
  ]);
  assert.deepEqual(frag.tests, [
    { name: 'unique', target: 'stg_orders', targetKind: 'model', column: 'order_id', ...where, evidence: ev('models/staging/_models.yml', '8') },
    { name: 'not_null', target: 'stg_orders', targetKind: 'model', column: 'order_id', ...where, evidence: ev('models/staging/_models.yml', '9') },
    { name: 'not_null', target: 'shop.customers', targetKind: 'source', column: 'customer_id', ...where, evidence: ev('models/staging/_sources.yml', '13') },
  ]);
});

test('dp3 lineage: an edge from the upstream source or model to the model for every ref() and source() call, evidence at the call line', () => {
  const edge = (from, fromKind, to, via, path, line) => ({ from, fromKind, to, via, ...where, evidence: ev(path, String(line)) });
  assert.deepEqual(frag.lineage, [
    edge('orders_enriched', 'model', 'customer_summary', 'ref', 'models/marts/customer_summary.sql', 4),
    edge('stg_orders', 'model', 'orders_enriched', 'ref', 'models/marts/orders_enriched.sql', 6),
    edge('stg_customers', 'model', 'orders_enriched', 'ref', 'models/marts/orders_enriched.sql', 7),
    edge('shop.customers', 'source', 'stg_customers', 'source', 'models/staging/stg_customers.sql', 4),
    edge('shop.orders', 'source', 'stg_orders', 'source', 'models/staging/stg_orders.sql', 5),
  ]);
  const lineOf = (path, n) => fixtureRead(path).split('\n')[n - 1];
  for (const { evidence: [{ path, lines }], via } of frag.lineage) {
    assert.match(lineOf(path, Number(lines)), new RegExp(`${via}\\(`), `${path}:${lines} holds the ${via}() call`);
  }
});

test('dp4 other forms: precedence of config(), schema config and project folders, package refs, multi-line calls, comments, model paths, unresolved names, several projects', () => {
  const m = memFrag({
    'dbt_project.yml':
      'name: acme\nmodel-paths: ["sql", "more_models"]\nmodels:\n  acme:\n    +materialized: ephemeral\n    raw:\n      +materialized: table\n      deep:\n        materialized: incremental\n  other_pkg:\n    +materialized: table\n',
    'sql/raw/a.sql': '{{ config(materialized="view") }}\nselect 1 from {{ ref(\'b\') }}\n',
    'sql/raw/deep/b.sql':
      "select 1\n-- {{ ref('a') }} commented\n/* {{ ref('a') }} */\n{# {{ ref('a') }} #}\nselect * from ref('a')\n",
    'sql/c.sql':
      "select * from {{ ref('acme', 'a') }}\njoin {{ ref(\n  'b',\n  v=2\n) }}\njoin {{ ref('nothing') }}\njoin {{ source('s', 'missing') }}\n",
    'sql/notes.yml': 'version: 2\n',
    'more_models/d.sql': 'select 1\n',
    'more_models/d.yml':
      'models:\n  - name: d\n    config:\n      materialized: table\n    tests:\n      - not_null\n  - name: ghost\n    columns:\n      - name: id\n        tests: [unique]\n',
    'more_models/e.sql': 'select 1\n',
    'other/x.sql': 'select 1\n',
    'models/z.sql': 'select 1\n',
    'docs/schema.yml': 'models:\n  - name: a\n    tests:\n      - unique\n',
    'warehouse/dbt_project.yml': 'name: wh\n',
    'warehouse/models/m.sql': "select * from {{ ref('a') }}\n",
  });
  assert.deepEqual(
    m.models.map((x) => `${x.evidence[0].path} ${x.project}@${x.scope} ${x.name} ${x.layer} ${x.materialization}`),
    [
      'more_models/d.sql acme@. d null table',
      'more_models/e.sql acme@. e null ephemeral',
      'sql/c.sql acme@. c null ephemeral',
      'sql/raw/a.sql acme@. a raw view',
      'sql/raw/deep/b.sql acme@. b raw/deep incremental',
      'warehouse/models/m.sql wh@warehouse m null view',
    ],
  );
  assert.deepEqual(
    m.lineage.map((e) => `${e.evidence[0].path}:${e.evidence[0].lines} ${e.from} -> ${e.to} ${e.via}`),
    ['sql/c.sql:1 a -> c ref', 'sql/c.sql:2 b -> c ref', 'sql/raw/a.sql:2 b -> a ref'],
  );
  assert.deepEqual(m.tests.map((t) => `${t.evidence[0].lines} ${t.name} ${t.target} ${t.column}`), ['6 not_null d null']);
  assert.deepEqual(m.skipped, { references: 3, tests: 1 }, 'ref(nothing), source(s, missing), the other project\'s ref(a); the test on the model no file declares');
  assert.equal(m.scanned, 10, 'two project files, six model files and two schema files; sql outside the model paths is not read');
  assert.deepEqual(memFrag({ 'models/a.sql': 'select 1\n', 'notes.yml': 'models: []\n' }).models, [], 'no dbt_project.yml, no project');
});

test('dp5 every item carries {path, lines} evidence inside the file, output sorted and deterministic', () => {
  for (const kind of ['lineage', 'models', 'sources', 'tests']) {
    assert.ok(frag[kind].length > 0, `${kind} found something in the fixture`);
    for (const item of frag[kind]) {
      assert.ok(Array.isArray(item.evidence) && item.evidence.length >= 1, `${kind} item has evidence`);
      for (const { path, lines } of item.evidence) {
        assert.match(lines, /^[0-9]+(-[0-9]+)?$/);
        assert.ok(fixtureFiles.includes(path), `evidence path ${path} is a fixture file`);
        const [a, b = a] = lines.split('-').map(Number);
        const total = fixtureRead(path).split('\n').length;
        assert.ok(a >= 1 && a <= b && b <= total, `${path}:${lines} is inside the file`);
      }
    }
    const keys = frag[kind].map((i) => [i.evidence[0].path, Number(i.evidence[0].lines.split('-')[0])]);
    const sorted = keys.slice().sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    assert.deepEqual(keys, sorted, `${kind} is ordered by path then line`);
  }
  assert.deepEqual(Object.keys(frag), ['lineage', 'models', 'scanned', 'skipped', 'sources', 'tests', 'truncated']);
  assert.equal(frag.scanned, 7, 'the project file, four models and two schema files were read');
  assert.deepEqual(frag.skipped, { references: 0, tests: 0 });
  assert.deepEqual(frag.truncated, { lineage: 0, models: 0, sources: 0, tests: 0 });
  const again = extractDataPlatform(fixtureFiles.slice().reverse(), fixtureRead);
  assert.equal(JSON.stringify(again), JSON.stringify(frag), 'input order does not change the output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(frag)), 'no timestamps');
});

test('dp6 caps: items past MAX_ITEMS per kind are counted in truncated; evidence lines past MAX_NESTED are dropped', () => {
  const files = { 'dbt_project.yml': 'name: big\n' };
  for (let i = 0; i < MAX_ITEMS + 2; i++) files[`models/m${String(i).padStart(6, '0')}.sql`] = 'select 1\n';
  const r = memFrag(files);
  assert.equal(r.models.length, MAX_ITEMS);
  assert.equal(r.truncated.models, 2);
  assert.equal(r.models[0].evidence[0].path, 'models/m000000.sql', 'the first rows in sort order are the ones kept');

  let body = '';
  for (let i = 0; i < MAX_NESTED + 5; i++) body += `select * from {{ ref('up') }}\n`;
  const n = memFrag({ 'dbt_project.yml': 'name: big\n', 'models/up.sql': 'select 1\n', 'models/down.sql': body });
  assert.equal(n.lineage.length, 1);
  assert.equal(n.lineage[0].evidence.length, MAX_NESTED);
  assert.ok(JSON.stringify(frag).length < 200 * 1024, 'fragment stays small');
});

test('dp7 names and values the model has no use for stay out: no description, profile, column or argument text reaches the fragment', () => {
  const text = JSON.stringify(frag);
  for (const value of ['placeholder_profile', 'Operational tables', 'One row per order', 'ordered_at', '1.0.0']) {
    assert.ok(!text.includes(value), `${value} is a value, not a name`);
  }
  for (const item of frag.models) assert.deepEqual(Object.keys(item), ['name', 'project', 'scope', 'layer', 'materialization', 'evidence']);
  for (const item of frag.sources) assert.deepEqual(Object.keys(item), ['source', 'name', 'address', 'project', 'scope', 'evidence']);
  for (const item of frag.tests) assert.deepEqual(Object.keys(item), ['name', 'target', 'targetKind', 'column', 'project', 'scope', 'evidence']);
  for (const item of frag.lineage) assert.deepEqual(Object.keys(item), ['from', 'fromKind', 'to', 'via', 'project', 'scope', 'evidence']);
});

test('dp8 the plug-in detects dbt_project.yml by name only, and names the stack data-platform', () => {
  assert.equal(plugin.id, 'data-platform');
  const det = (...files) => plugin.detect({ files });
  assert.equal(det('dbt_project.yml'), true);
  assert.equal(det('analytics/dbt_project.yml', 'analytics/models/a.sql'), true);
  assert.equal(det('app/main.py', 'models/a.sql', 'schema.yml', 'dbt_project.yaml', 'my_dbt_project.yml', 'dbt_project.yml.bak'), false);
  assert.equal(det(), false);
  assert.equal(typeof plugin.extract, 'function');
});

test('dp9 nothing is executed or imported from the scanned repo; the plug-in runs inside prescan and behind the stacks/ re-export', async () => {
  const src = readFileSync(MODULE, 'utf8');
  assert.ok(!/child_process|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|node:vm|node:worker_threads/.test(src), 'data-platform.mjs has no way to run code');

  const shim = join(LIB, 'stacks', 'data-platform.mjs');
  assert.equal(readFileSync(shim, 'utf8').trim(), "export { default } from '../data-platform.mjs';");
  const viaShim = await import(pathToFileURL(shim).href);
  assert.equal(viaShim.default, plugin, 'the re-export is the same object');

  const dir = mkdtempSync(join(tmpdir(), 'archmap-dbtfix-'));
  try {
    for (const f of fixtureFiles) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), fixtureRead(f));
    }
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
    const { prescan } = await import(pathToFileURL(join(ROOT, 'scripts', 'prescan.mjs')).href);
    const out = await prescan(dir, { extractors: [plugin] });
    assert.ok(out.stacks.includes('data-platform'));
    assert.equal(JSON.stringify(out.extracts['data-platform']), JSON.stringify(frag));
    const real = await prescan(dir);
    assert.equal(JSON.stringify(real.extracts['data-platform']), JSON.stringify(frag), 'the default loader finds the plug-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
