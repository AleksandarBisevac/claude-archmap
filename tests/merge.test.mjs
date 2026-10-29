import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (m1, m2, ...) lead every title so the suite prints them first.
const CLI = fileURLToPath(new URL('../scripts/merge.mjs', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/merge/', import.meta.url));
const { merge } = await import('../scripts/merge.mjs');
const { validate } = await import('../scripts/validate.mjs');

const clone = (x) => JSON.parse(JSON.stringify(x));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const loadDir = (dir) =>
  readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(join(dir, f)));
const META = { project: 'shop', commit: 'abc123', profile: 'balanced', generatedAt: '2026-01-01T00:00:00Z' };
const tmp = () => mkdtempSync(join(tmpdir(), 'archmap-merge-'));
const ids = (arr) => arr.map((x) => x.id);
const ev = (path, lines = '1-2') => [{ path, lines }];
const node = (id, extra = {}) => ({
  id, zone: 'svc-zone', kind: 'service', title: id, paths: ['x/**'], level: 2, evidence: ev(`x/${id}.js`), ...extra,
});
const frag = (area, extra = {}) => ({
  area, nodes: [], edges: [], entities: [], access: [], coverage: [`${area}/**`], skipped: { count: 0, reasons: [] }, ...extra,
});
const cli = (args, opts = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });

const buildFrags = () => loadDir(join(FIX, 'build'));
const built = () => merge({ fragments: buildFrags(), synth: readJson(join(FIX, 'synth.json')), meta: META });

test('m1 fragments merge into a model that validate() accepts, with meta filled and identical nodes deduped', () => {
  const { model, conflicts } = merge({ fragments: buildFrags(), meta: META });
  const v = validate(model);
  assert.deepEqual(v.findings, []);
  assert.equal(v.ok, true);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(ids(model.nodes), ['shared-lib', 'store', 'svc', 'ui']); // sorted, shared-lib once
  assert.deepEqual(ids(model.edges), ['svc-reads-store', 'ui-calls-api']);
  assert.deepEqual(ids(model.entities), ['orders', 'users']);
  assert.equal(model.access.length, 1);
  assert.equal(model.meta.project, 'shop');
  assert.equal(model.meta.commit, 'abc123');
  assert.equal(model.meta.profile, 'balanced');
  assert.equal(model.meta.generatedAt, '2026-01-01T00:00:00Z');
  assert.equal(typeof model.meta.schemaVersion, 'string');
  assert.deepEqual(model.meta.coverage, {
    api: ['api/**'], introspection: ['db/**'], web: ['web/**', 'lib/**'],
  });
  const web = model.meta.sources.find((s) => s.area === 'web');
  assert.deepEqual(web.skipped, { count: 1, reasons: ['generated client'] });
  const intro = model.meta.sources.filter((s) => s.area === 'introspection');
  assert.ok(intro.some((s) => s.tool === 'sqlite3'), 'fragment-declared sources are kept');
  assert.ok(intro.some((s) => s.skipped && s.skipped.count === 2), 'skipped tally recorded');
  // every referenced zone exists
  assert.deepEqual(ids(model.zones), ['api', 'browser', 'data']);
});

test('m1b generatedAt is not invented: absent when not given', () => {
  const { model } = merge({ fragments: buildFrags(), meta: { project: 'shop', commit: 'abc123' } });
  assert.equal('generatedAt' in model.meta, false);
  assert.equal(validate(model).ok, false);
});

test('m2 colliding ids are renamed deterministically and every reference is rewritten', () => {
  const a = frag('alpha', {
    nodes: [node('core', { zone: 'z' }), node('other', { zone: 'z' })],
    edges: [{ id: 'e1', from: 'core', to: 'other', type: 'call', desc: 'a', evidence: ev('x/a.js'), confidence: 'verified' }],
  });
  const b = frag('beta', {
    nodes: [node('core', { zone: 'z', title: 'Different core' }), node('store', { zone: 'z', kind: 'store' })],
    edges: [{ id: 'e1', from: 'core', to: 'store', type: 'sql', desc: 'b', evidence: ev('x/b.js'), confidence: 'verified' }],
    entities: [{
      id: 'items', store: 'store', name: 'items', kind: 'table',
      fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }],
    }],
    access: [{ node: 'core', entity: 'items', ops: 'RU', evidence: ev('x/b.js') }],
  });
  const r1 = merge({ fragments: [a, b], meta: META });
  const r2 = merge({ fragments: [b, a], meta: META }); // order of input does not matter
  assert.deepEqual(r1.model, r2.model);
  const { model, renames } = r1;
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.equal(model.nodes.length, 4);
  const renamedNode = model.nodes.find((n) => n.title === 'Different core');
  assert.notEqual(renamedNode.id, 'core');
  assert.ok(model.nodes.some((n) => n.id === 'core' && n.title === 'core'), 'first fragment (by area) keeps the id');
  const betaEdge = model.edges.find((e) => e.desc === 'b');
  assert.notEqual(betaEdge.id, 'e1');
  assert.equal(betaEdge.from, renamedNode.id, 'edge.from rewritten');
  assert.equal(betaEdge.to, 'store');
  assert.equal(model.edges.find((e) => e.desc === 'a').from, 'core', 'other fragment untouched');
  assert.equal(model.access[0].node, renamedNode.id, 'access.node rewritten');
  assert.ok(renames.length >= 2 && renames.some((x) => x.from === 'core' && x.to === renamedNode.id));
});

test('m2b entity id collisions rewrite access.entity, fk targets and relations', () => {
  const ent = (id, extra = {}) => ({
    id, store: 'db', name: id, kind: 'table',
    fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }], ...extra,
  });
  const a = frag('alpha', { nodes: [node('db', { zone: 'z', kind: 'store' })], entities: [ent('users')] });
  const b = frag('beta', {
    nodes: [node('app', { zone: 'z' })],
    entities: [
      ent('users', { name: 'accounts' }),
      ent('orders', { fields: [
        { name: 'id', type: 'int', pk: true, provenance: 'declared' },
        { name: 'u', type: 'int', provenance: 'declared', fk: { entity: 'users', field: 'id' } },
      ] }),
    ],
    relations: [{ from: { entity: 'orders', field: 'u' }, to: { entity: 'users', field: 'id' }, cardinality: '1-n', kind: 'fk', provenance: 'declared' }],
    access: [{ node: 'app', entity: 'users', ops: 'R' }],
  });
  b.nodes.push(node('db', { zone: 'z', kind: 'store', title: 'other db' }));
  const { model } = merge({ fragments: [a, b], meta: META });
  const accounts = model.entities.find((e) => e.name === 'accounts');
  assert.notEqual(accounts.id, 'users');
  assert.equal(model.access[0].entity, accounts.id);
  const orders = model.entities.find((e) => e.id === 'orders');
  assert.equal(orders.fields[1].fk.entity, accounts.id);
  assert.equal(model.relations[0].to.entity, accounts.id);
  assert.equal(accounts.store === 'db', false, 'store rewritten to the renamed node');
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
});

test('m3 update mode replaces only the affected area and keeps other elements and ids', () => {
  const first = built().model;
  const updated = merge({
    fragments: loadDir(join(FIX, 'update', 'frags')), previous: first, areas: ['api'],
    meta: { commit: 'def456', generatedAt: '2026-02-02T00:00:00Z' },
  });
  const { model } = updated;
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  // untouched areas: byte-identical elements
  for (const id of ['ui', 'store', 'shared-lib']) {
    assert.deepEqual(model.nodes.find((n) => n.id === id), first.nodes.find((n) => n.id === id));
  }
  assert.deepEqual(model.entities, first.entities);
  assert.deepEqual(model.edges.find((e) => e.id === 'ui-calls-api'), first.edges.find((e) => e.id === 'ui-calls-api'));
  // affected area replaced, id stable
  assert.equal(model.nodes.find((n) => n.id === 'svc').title, 'Orders service v2');
  assert.ok(model.nodes.some((n) => n.id === 'worker'));
  assert.ok(model.edges.some((e) => e.id === 'worker-reads-store'));
  assert.equal(model.edges.some((e) => e.id === 'svc-reads-store'), false, 'stale edge of the affected area is gone');
  assert.deepEqual(model.access.map((a) => `${a.node}>${a.entity}`), ['worker>orders']);
  // meta
  assert.equal(model.meta.commit, 'def456');
  assert.equal(model.meta.generatedAt, '2026-02-02T00:00:00Z');
  assert.equal(model.meta.project, 'shop');
  assert.deepEqual(model.meta.coverage.web, first.meta.coverage.web);
  assert.deepEqual(model.meta.coverage.api, ['api/**', 'api/worker.py']);
  assert.equal(model.meta.sources.filter((s) => s.area === 'api').length, 1, 'no duplicate source rows');
  assert.ok(model.meta.sources.some((s) => s.area === 'web'));
  // sequences / views from the previous synth run survive
  assert.deepEqual(model.zones, first.zones);
});

test('m3b fragments of unaffected areas are ignored in update mode', () => {
  const first = built().model;
  const noise = frag('web', { nodes: [node('intruder', { zone: 'browser', evidence: ev('web/x.js') })] });
  const { model } = merge({
    fragments: [...loadDir(join(FIX, 'update', 'frags')), noise], previous: first, areas: ['api'], meta: {},
  });
  assert.equal(model.nodes.some((n) => n.id === 'intruder'), false);
});

test('m4 locked and notes survive; a disagreeing locked node keeps its content and yields a conflict', () => {
  const first = built().model;
  const prev = clone(first);
  const svc = prev.nodes.find((n) => n.id === 'svc');
  svc.locked = true;
  svc.notes = 'Do not touch: owned by team Orders.';
  svc.title = 'Orders (authored)';
  prev.nodes.find((n) => n.id === 'ui').notes = 'UI is being rewritten.'; // notes on an unlocked node
  const r = merge({
    fragments: loadDir(join(FIX, 'update', 'frags')), previous: prev, areas: ['api', 'web'], meta: {},
  });
  const out = r.model.nodes.find((n) => n.id === 'svc');
  assert.equal(out.title, 'Orders (authored)', 'locked content kept');
  assert.equal(out.locked, true);
  assert.equal(out.notes, 'Do not touch: owned by team Orders.');
  assert.equal(r.conflicts.length >= 1, true);
  const c = r.conflicts.find((x) => x.ids.includes('svc'));
  assert.ok(c, 'conflict names the locked node');
  assert.match(c.reason, /locked/i);
  // unlocked node with notes: the web area was re-run with no web fragment => node vanishes from fragments,
  // but user-authored notes are never dropped
  const ui = r.model.nodes.find((n) => n.id === 'ui');
  assert.ok(ui, 'node carrying notes is kept');
  assert.equal(ui.notes, 'UI is being rewritten.');
  assert.ok(r.conflicts.some((x) => x.ids.includes('ui')), 'its disappearance is reported');
  assert.equal(validate(r.model).ok, true, JSON.stringify(validate(r.model).findings));
});

test('m4b an unlocked node re-emitted by its explorer takes new content but keeps notes', () => {
  const prev = built().model;
  prev.nodes.find((n) => n.id === 'svc').notes = 'Keep this note.';
  const { model, conflicts } = merge({
    fragments: loadDir(join(FIX, 'update', 'frags')), previous: prev, areas: ['api'], meta: {},
  });
  const svc = model.nodes.find((n) => n.id === 'svc');
  assert.equal(svc.title, 'Orders service v2');
  assert.equal(svc.notes, 'Keep this note.');
  assert.deepEqual(conflicts, []);
});

test('m4c a locked node that the new fragment agrees with is kept without a conflict', () => {
  const prev = built().model;
  const same = frag('api', { nodes: [clone(prev.nodes.find((n) => n.id === 'svc'))], coverage: ['api/**'] });
  prev.nodes.find((n) => n.id === 'svc').locked = true;
  const { model, conflicts } = merge({ fragments: [same], previous: prev, areas: ['api'], meta: {} });
  assert.equal(model.nodes.find((n) => n.id === 'svc').locked, true);
  assert.deepEqual(conflicts, []);
});

test('m5 synthesizer edges, sequences, views, access and relations merge by id and notes/conflicts are returned', () => {
  const { model, notes, conflicts } = built();
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  // edge with an existing id replaced in place, new one added
  const e = model.edges.find((x) => x.id === 'ui-calls-api');
  assert.equal(e.desc, 'UI calls the orders API');
  assert.equal(e.confidence, 'verified');
  assert.ok(model.edges.some((x) => x.id === 'svc-persists'));
  assert.equal(model.edges.filter((x) => x.id === 'ui-calls-api').length, 1);
  assert.deepEqual(ids(model.sequences), ['place-order']);
  assert.deepEqual(ids(model.views), ['system']);
  assert.equal(model.relations.length, 1);
  const acc = model.access.filter((a) => a.node === 'svc' && a.entity === 'orders');
  assert.equal(acc.length, 1);
  assert.equal(acc[0].ops, 'CRU');
  assert.deepEqual(notes, ['Only one flow is distinct.']);
  assert.deepEqual(conflicts, []);
});

test('m5b synthesizer conflicts are returned, never resolved; synth cannot overwrite a locked node', () => {
  const prev = built().model;
  prev.nodes.find((n) => n.id === 'svc').locked = true;
  const synth = {
    conflicts: [{ ids: ['svc', 'worker'], reason: 'fragments disagree on ownership' }],
    nodes: [{ ...node('svc', { zone: 'api' }), title: 'Synth rename' }],
  };
  const r = merge({ fragments: [], previous: prev, areas: [], synth, meta: {} });
  assert.equal(r.model.nodes.find((n) => n.id === 'svc').title, 'Orders service');
  assert.ok(r.conflicts.some((c) => c.reason === 'fragments disagree on ownership'));
  assert.ok(r.conflicts.some((c) => c.ids.includes('svc') && /locked/i.test(c.reason)));
});

test('m6 two runs are byte-identical, whatever order the fragments arrive in', () => {
  const dir = tmp();
  const out1 = join(dir, 'm1.json');
  const out2 = join(dir, 'm2.json');
  const args = ['--synth', join(FIX, 'synth.json'), '--commit', 'abc123', '--project', 'shop', '--profile', 'balanced',
    '--generated-at', '2026-01-01T00:00:00Z'];
  const r1 = cli([join(FIX, 'build'), '--out', out1, ...args]);
  assert.equal(r1.status, 0, r1.stderr);
  const r2 = cli([join(FIX, 'build'), '--out', out2, ...args]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(out1, 'utf8'), readFileSync(out2, 'utf8'));
  assert.equal(validate(readJson(out1)).ok, true);
  // the library gives the same object for a reversed fragment list
  const fwd = merge({ fragments: buildFrags(), meta: META });
  const rev = merge({ fragments: buildFrags().reverse(), meta: META });
  assert.equal(JSON.stringify(fwd.model), JSON.stringify(rev.model));
  rmSync(dir, { recursive: true, force: true });
});

test('m6b update through the CLI, previous in and the same file out, keeps user fields and is stable', () => {
  const dir = tmp();
  const out = join(dir, 'model.json');
  const base = ['--commit', 'abc123', '--project', 'shop', '--profile', 'balanced', '--generated-at', '2026-01-01T00:00:00Z'];
  assert.equal(cli([join(FIX, 'build'), '--out', out, '--synth', join(FIX, 'synth.json'), ...base]).status, 0);
  const m = readJson(out);
  m.nodes.find((n) => n.id === 'ui').notes = 'hand written';
  writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
  const up = [join(FIX, 'update', 'frags'), '--out', out, '--previous', out, '--areas', 'api', '--commit', 'def456'];
  const r = cli(up);
  assert.equal(r.status, 0, r.stderr);
  const after = readJson(out);
  assert.equal(after.nodes.find((n) => n.id === 'ui').notes, 'hand written');
  assert.equal(after.meta.commit, 'def456');
  assert.equal(after.meta.generatedAt, '2026-01-01T00:00:00Z', 'kept from previous when not given');
  const bytes = readFileSync(out, 'utf8');
  assert.equal(cli(up).status, 0);
  assert.equal(readFileSync(out, 'utf8'), bytes, 'idempotent');
  rmSync(dir, { recursive: true, force: true });
});

test('m7 an invalid result is refused with exit 1 and nothing is written', () => {
  const dir = tmp();
  const fragDir = join(dir, 'frags');
  mkdirSync(fragDir);
  // edge to a node nobody defined => dangling reference
  const bad = frag('only', {
    nodes: [node('a', { zone: 'z' })],
    edges: [{ id: 'e', from: 'a', to: 'ghost', type: 'call', desc: 'x', evidence: ev('x/a.js'), confidence: 'verified' }],
  });
  writeFileSync(join(fragDir, 'only.json'), JSON.stringify(bad));
  const out = join(dir, 'model.json');
  const r = cli([fragDir, '--out', out, '--commit', 'c', '--project', 'p', '--generated-at', '2026-01-01T00:00:00Z']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ghost/);
  assert.equal(existsSync(out), false);
  // an existing out file is left untouched too
  writeFileSync(out, 'KEEP');
  assert.equal(cli([fragDir, '--out', out, '--commit', 'c', '--project', 'p', '--generated-at', 'x']).status, 1);
  assert.equal(readFileSync(out, 'utf8'), 'KEEP');
  rmSync(dir, { recursive: true, force: true });
});

test('m8 usage errors exit 2; --strict turns conflicts into exit 1 and writes nothing', () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli([join(FIX, 'build')]).status, 2, '--out is required');
  assert.equal(cli([join(FIX, 'no-such-dir'), '--out', join(tmp(), 'x.json')]).status, 2);
  assert.equal(cli([join(FIX, 'build'), '--out', join(tmp(), 'x.json'), '--bogus']).status, 2);
  const dir = tmp();
  const prev = built().model;
  prev.nodes.find((n) => n.id === 'svc').locked = true;
  const prevPath = join(dir, 'prev.json');
  writeFileSync(prevPath, JSON.stringify(prev));
  const out = join(dir, 'out.json');
  const args = [join(FIX, 'update', 'frags'), '--out', out, '--previous', prevPath, '--areas', 'api'];
  const loose = cli(args);
  assert.equal(loose.status, 0, loose.stderr);
  assert.match(loose.stderr, /conflict/i);
  rmSync(out);
  const strict = cli([...args, '--strict']);
  assert.equal(strict.status, 1);
  assert.equal(existsSync(out), false);
  rmSync(dir, { recursive: true, force: true });
});
