import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
    nodes: [node('core', { zone: 'z', title: 'Different core', paths: ['y/**'] }), node('store', { zone: 'z', kind: 'store', paths: ['db/**'] })],
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
    nodes: [node('app', { zone: 'z', paths: ['app/**'] })],
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
  b.nodes.push(node('db', { zone: 'z', kind: 'store', title: 'other db', paths: ['other-db/**'] }));
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

test('m5 synthesizer sequences and views merge by id, notes and conflicts are returned; edges, access and relations stay the script\'s', () => {
  const { model, notes, conflicts } = built();
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  // the explorer's edge is untouched: the synthesizer no longer supplies edges
  const e = model.edges.find((x) => x.id === 'ui-calls-api');
  assert.equal(e.desc, 'UI fetches orders');
  assert.equal(model.edges.filter((x) => x.id === 'ui-calls-api').length, 1);
  assert.deepEqual(ids(model.sequences), ['place-order']);
  assert.deepEqual(ids(model.views), ['system']);
  // the one relation is computed from the declared foreign key orders.user_id -> users.id, with its provenance
  assert.deepEqual(model.relations, [
    { from: { entity: 'orders', field: 'user_id' }, to: { entity: 'users', field: 'id' }, cardinality: '1-n', kind: 'fk', provenance: 'observed' },
  ]);
  const acc = model.access.filter((a) => a.node === 'svc' && a.entity === 'orders');
  assert.deepEqual(acc.map((a) => a.ops), ['R'], 'the explorer row, not a synthesizer one');
  assert.deepEqual(notes, ['Only one flow is distinct.']);
  assert.deepEqual(conflicts, []);
});

test('m5b synthesizer conflicts are returned, never resolved; a synth node, even for a locked node, is refused', () => {
  const prev = built().model;
  prev.nodes.find((n) => n.id === 'svc').locked = true;
  const synth = {
    conflicts: [{ ids: ['svc', 'worker'], reason: 'fragments disagree on ownership' }],
    nodes: [{ ...node('svc', { zone: 'api' }), title: 'Synth rename' }],
  };
  const r = merge({ fragments: [], previous: prev, areas: [], synth, meta: {} });
  assert.equal(r.model.nodes.find((n) => n.id === 'svc').title, 'Orders service');
  assert.ok(r.conflicts.some((c) => c.reason === 'fragments disagree on ownership'));
  assert.ok(r.conflicts.some((c) => c.ids.includes('svc') && /synthesizer may not add nodes/i.test(c.reason)));
});

test('m5c a synth object carrying nodes, edges, entities, access or relations has each refused and reported, the rest merged', () => {
  const synth = {
    nodes: [node('extra', { zone: 'api' })],
    edges: [{ id: 'svc-persists', from: 'svc', to: 'store', type: 'persist', desc: 'x', evidence: ev('api/main.py'), confidence: 'verified' }],
    entities: [{ id: 'ghost', store: 'store', name: 'ghost', kind: 'table', fields: [] }],
    access: [{ node: 'svc', entity: 'orders', ops: 'CRU' }],
    relations: [{ from: { entity: 'orders', field: 'id' }, to: { entity: 'users', field: 'id' }, cardinality: '1-1', kind: 'join', provenance: 'inferred' }],
    views: [{ id: 'system', title: 'System', nodes: ['ui', 'svc'] }],
  };
  const { model, conflicts } = merge({ fragments: buildFrags(), synth, meta: META });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.equal(model.nodes.some((n) => n.id === 'extra'), false);
  assert.equal(model.edges.some((e) => e.id === 'svc-persists'), false);
  assert.equal(model.entities.some((e) => e.id === 'ghost'), false);
  assert.deepEqual(model.access.map((a) => a.ops), ['R']);
  assert.equal(model.relations.some((r) => r.kind === 'join'), false);
  assert.deepEqual(ids(model.views), ['system']);
  for (const key of ['nodes', 'edges', 'entities', 'access', 'relations']) {
    assert.ok(conflicts.some((c) => new RegExp(`synthesizer may not add ${key}`).test(c.reason)), `${key}: ${JSON.stringify(conflicts)}`);
  }
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
  // a node the schema cannot accept (no title): a dangling reference is dropped and noted (m19b), this is not repairable
  const bad = frag('only', { nodes: [node('ghost', { zone: 'z', title: undefined })] });
  writeFileSync(join(fragDir, 'only.json'), JSON.stringify(bad));
  const out = join(dir, 'model.json');
  const r = cli([fragDir, '--out', out, '--commit', 'c', '--project', 'p', '--generated-at', '2026-01-01T00:00:00Z']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /title/);
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

test('m9 update mode reports an --areas entry with no fragment and a fragment whose area is not in --areas', () => {
  const first = built().model;
  const apiFrags = loadDir(join(FIX, 'update', 'frags'));
  const text = (cs) => JSON.stringify(cs);
  // clean: every listed area has a fragment and every fragment is listed
  const clean = merge({ fragments: apiFrags, previous: first, areas: ['api'], meta: {} });
  assert.equal(/\bapi\b/.test(text(clean.conflicts)), false, 'no area conflict when areas and fragments agree');
  // an area named in --areas with no fragment: its elements would vanish silently
  const missing = merge({ fragments: apiFrags, previous: first, areas: ['api', 'ghost'], meta: {} });
  assert.ok(missing.conflicts.some((c) => /ghost/.test(JSON.stringify(c))), text(missing.conflicts));
  // a fragment in the directory whose area is not in --areas: it would be dropped silently
  const noise = frag('web', { nodes: [node('intruder', { zone: 'browser', evidence: ev('web/x.js') })] });
  const extra = merge({ fragments: [...apiFrags, noise], previous: first, areas: ['api'], meta: {} });
  assert.ok(extra.conflicts.some((c) => /web/.test(JSON.stringify(c))), text(extra.conflicts));
  assert.equal(extra.model.nodes.some((n) => n.id === 'intruder'), false, 'still not merged');
});

test('m9b through the CLI an unmatched area is a conflict on stderr; --strict exits 1 and writes nothing', () => {
  const dir = tmp();
  const prevPath = join(dir, 'prev.json');
  writeFileSync(prevPath, JSON.stringify(built().model));
  const out = join(dir, 'out.json');
  const args = [join(FIX, 'update', 'frags'), '--out', out, '--previous', prevPath, '--areas', 'api,ghost'];
  const loose = cli(args);
  assert.equal(loose.status, 0, loose.stderr);
  assert.match(loose.stderr, /ghost/);
  rmSync(out);
  const strict = cli([...args, '--strict']);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /ghost/);
  assert.equal(existsSync(out), false);
  rmSync(dir, { recursive: true, force: true });
});

test('m10 merge shares lib/glob.mjs ownership: a bare directory coverage glob does not own its subtree, as in diffmap', async () => {
  const { matchAny } = await import('../scripts/lib/glob.mjs');
  const prev = built().model;
  const old = node('old-api', { evidence: ev('api/old.js') });
  prev.nodes.push(old);
  prev.meta.coverage.api = ['api'];
  assert.equal(matchAny(['api'], 'api/old.js'), false, 'the shared matcher reads a bare directory literally');
  const fresh = frag('api', { nodes: [clone(prev.nodes.find((n) => n.id === 'svc'))], coverage: ['api'] });
  const r = merge({ fragments: [fresh], previous: prev, areas: ['api'], meta: {} });
  assert.ok(ids(r.model.nodes).includes('old-api'), 'not owned by the area, so not replaced or dropped');
  assert.equal(r.conflicts.some((c) => c.ids?.includes('old-api')), false, JSON.stringify(r.conflicts));
  // the explicit subtree form still owns it
  prev.meta.coverage.api = ['api/**'];
  const owned = merge({ fragments: [fresh], previous: prev, areas: ['api'], meta: {} });
  assert.equal(ids(owned.model.nodes).includes('old-api'), false, 'api/** owns the subtree');
});

test('m10b merge.mjs imports its matcher from lib/glob.mjs and keeps no glob translator of its own', () => {
  const src = readFileSync(CLI, 'utf8');
  assert.match(src, /from '\.\/lib\/glob\.mjs'/);
  assert.doesNotMatch(src, /function globToRegExp/);
});

test('m11 unknown top-level keys and unknown meta keys in --previous are carried through, appended after the known ones in sorted order', () => {
  const prev = built().model;
  prev.zeta = [{ id: 'z1' }];
  prev.alpha = { note: 'from a newer schema' };
  prev.meta.zzMeta = { keep: true };
  prev.meta.aaMeta = 'x';
  const r = merge({ fragments: buildFrags(), previous: prev, areas: ['api'], meta: {} });
  assert.deepEqual(r.model.alpha, { note: 'from a newer schema' });
  assert.deepEqual(r.model.zeta, [{ id: 'z1' }]);
  assert.deepEqual(r.model.meta.zzMeta, { keep: true });
  assert.equal(r.model.meta.aaMeta, 'x');
  const top = Object.keys(r.model);
  assert.deepEqual(top.slice(-2), ['alpha', 'zeta'], `unknown top-level keys last, sorted: ${top}`);
  const meta = Object.keys(r.model.meta);
  assert.deepEqual(meta.slice(-2), ['aaMeta', 'zzMeta'], `unknown meta keys last, sorted: ${meta}`);
  // known keys keep their position ahead of the unknown ones
  assert.ok(top.indexOf('nodes') < top.indexOf('alpha'));
  // a second run over its own output is byte-identical
  const again = merge({ fragments: buildFrags(), previous: r.model, areas: ['api'], meta: {} });
  assert.equal(JSON.stringify(again.model), JSON.stringify(r.model));
  // a fresh build (no previous) has nothing to carry
  assert.equal('alpha' in built().model, false);
});

// ---------------------------------------------------------------------------------------------
// P10.2: fragments are read from <work>/fragments/ and normalised or truncated, never re-asked.

const runDir = (frags, extra = []) => {
  const work = tmp();
  const dir = join(work, 'fragments');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(frags)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(body));
  const out = join(work, 'model.json');
  const r = cli([dir, '--out', out, '--commit', 'c1', '--project', 'p', '--generated-at', '2026-01-01T00:00:00Z', ...extra]);
  return { r, out, model: existsSync(out) ? readJson(out) : null };
};
const pad = (n, w = 2) => String(n).padStart(w, '0');

test('m12 an over-cap fragment is truncated to the caps with a meta.sources note naming the area and the count dropped; exit stays 0', () => {
  const nodes = Array.from({ length: 45 }, (_, i) => node(`n${pad(i)}`, { zone: 'z' }));
  const edge = (id, to) => ({ id, from: 'n00', to, type: 'call', desc: 'd', evidence: ev('x/a.js'), confidence: 'verified' });
  const edges = [...Array.from({ length: 90 }, (_, i) => edge(`e${pad(i)}`, 'n01')), ...['n44', 'n43', 'n42'].map((t, i) => edge(`z${i}`, t))];
  const entities = Array.from({ length: 65 }, (_, i) => ({
    id: `t${pad(i)}`, store: 'n00', name: `t${pad(i)}`, kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }],
  }));
  const access = [
    ...Array.from({ length: 85 }, (_, i) => ({ node: `n${pad(i % 40)}`, entity: `t${pad(Math.floor(i / 40))}`, ops: 'R', evidence: ev('x/a.js') })),
    { node: 'n00', entity: 't64', ops: 'R', evidence: ev('x/a.js') },
    { node: 'n01', entity: 't64', ops: 'R', evidence: ev('x/a.js') },
  ];
  const { r, model } = runDir({ big: frag('big', { nodes, edges, entities, access }) }, ['--strict']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(model.nodes.length, 40, 'nodes cut to 40');
  assert.deepEqual(ids(model.nodes), nodes.slice(0, 40).map((n) => n.id), 'the first nodes in the explorer order are the ones kept');
  assert.equal(model.edges.length, 80);
  assert.equal(model.entities.length, 60);
  assert.equal(model.access.length, 80);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const note = model.meta.sources.find((s) => s.area === 'big' && s.type === 'truncation');
  assert.ok(note, JSON.stringify(model.meta.sources));
  // edges: 3 hang on dropped nodes, then 90 are cut to 80; access: 2 hang on a dropped entity, then 85 cut to 80
  assert.deepEqual(note.dropped, { access: 7, edges: 13, entities: 5, nodes: 5 });
  assert.match(note.note, /big/);
  assert.match(note.note, /5 nodes/);
  assert.match(note.note, /13 edges/);
  assert.equal(model.meta.sources.filter((s) => s.area === 'big' && s.type === 'explorer').length, 1, 'the usual explorer row is still there');
});

test('m12b a fragment missing every optional field (coverage, skipped, edges, entities, access, area, node level and paths) still merges', () => {
  const bare = { id: 'solo', zone: 'z', kind: 'service', title: 'solo', evidence: ev('x/solo.js') };
  const lean = { nodes: [bare] };
  const { r, model } = runDir({ lean });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(ids(model.nodes), ['solo']);
  assert.deepEqual([model.nodes[0].level, model.nodes[0].paths], [2, ['x/solo.js']], 'level and paths get defaults');
  assert.deepEqual(model.meta.coverage, { lean: [] });
  const row = model.meta.sources.find((s) => s.area === 'lean' && s.type === 'explorer');
  assert.deepEqual(row.skipped, { count: 0, reasons: [] });
  assert.ok(!model.meta.sources.some((s) => s.type === 'truncation'), 'nothing was cut, so no truncation note');
  assert.equal(merge({ fragments: [{ area: 'a' }], meta: META }).model.nodes.length, 0, 'an empty fragment is not an error');
});

test('m12c the usual explorer slips (numeric lines, string level, no paths, no confidence, lowercase ops) are normalised and counted', () => {
  const messy = {
    area: 'messy',
    nodes: [{ id: 'a', zone: 'z', kind: 'service', title: 'A', level: '2', evidence: [{ path: 'x/a.js', lines: 7 }] }],
    edges: [{ id: 'e1', from: 'a', to: 'a', type: 'call', desc: 'self', evidence: [{ path: 'x/a.js', lines: 'L3-L5' }] }],
    entities: [{ id: 't', store: 'a', name: 't', kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }] }],
    access: [{ node: 'a', entity: 't', ops: 'ur', evidence: { path: 'x/a.js', lines: '9' } }],
    coverage: ['x/**'],
  };
  const { r, model } = runDir({ messy });
  assert.equal(r.status, 0, r.stderr);
  const n = model.nodes[0];
  assert.deepEqual([n.level, n.paths, n.evidence], [2, ['x/a.js'], [{ path: 'x/a.js', lines: '7' }]]);
  assert.deepEqual([model.edges[0].confidence, model.edges[0].evidence], ['inferred', [{ path: 'x/a.js', lines: '3-5' }]]);
  assert.deepEqual([model.access[0].ops, model.access[0].evidence], ['RU', [{ path: 'x/a.js', lines: '9' }]]);
  const note = model.meta.sources.find((s) => s.area === 'messy' && s.type === 'normalisation');
  assert.ok(note && note.fixed >= 5, JSON.stringify(model.meta.sources));
});

test('m12d a fragment file that is not valid JSON is recorded as a skipped area, not a reason to stop or to ask again', () => {
  const work = tmp();
  const dir = join(work, 'fragments');
  mkdirSync(dir);
  writeFileSync(join(dir, 'good.json'), JSON.stringify(frag('good', { nodes: [node('g', { zone: 'z' })], coverage: ['good/**'] })));
  writeFileSync(join(dir, 'broken.json'), '{"area": "broken", "nodes": [');
  const out = join(work, 'model.json');
  const r = cli([dir, '--out', out, '--commit', 'c1', '--project', 'p', '--generated-at', '2026-01-01T00:00:00Z']);
  assert.equal(r.status, 0, r.stderr);
  const model = readJson(out);
  assert.deepEqual(ids(model.nodes), ['g']);
  const row = model.meta.sources.find((s) => s.area === 'broken');
  assert.equal(row.skipped.count, 1);
  assert.match(row.skipped.reasons[0], /broken\.json unreadable/);
});

// ---------------------------------------------------------------------------------------------
// P10.3: merge computes the cross-area layer the synthesizer used to loop for: edges from the prescan
// links, dedup by path, zones, access rows from SQL evidence, relations from declared foreign keys, and a digest.

const CROSS = join(FIX, 'cross');
const crossFrags = () => loadDir(join(CROSS, 'fragments'));
const crossExtracts = () => loadDir(join(CROSS, 'extracts'));
const crossed = (extra = {}) =>
  merge({ fragments: crossFrags(), extracts: crossExtracts(), repo: join(CROSS, 'repo'), meta: META, ...extra });
const edgeOf = (model, from, to, type) => model.edges.filter((e) => e.from === from && e.to === to && e.type === type);
const crossCli = (out, digest, extra = []) =>
  cli([join(CROSS, 'fragments'), '--out', out, '--extracts', join(CROSS, 'extracts'), '--repo', join(CROSS, 'repo'),
    '--digest', digest, '--commit', 'abc123', '--project', 'shop', '--profile', 'balanced', '--generated-at', '2026-01-01T00:00:00Z', ...extra]);

test('m13 cross-area edges come from the prescan http, queue and import links, each with evidence, with no synth file', () => {
  const { model } = crossed();
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const http = edgeOf(model, 'web-app', 'orders-api', 'api');
  assert.equal(http.length, 1, JSON.stringify(model.edges));
  // the caller's line first, so an update of the caller's area owns (and recomputes) the edge
  assert.deepEqual(http[0].evidence, [{ path: 'web/src/api.ts', lines: '12' }, { path: 'api/main.py', lines: '20' }]);
  assert.match(http[0].desc, /POST \/orders/);
  assert.equal(http[0].confidence, 'verified');
  assert.equal(http[0].foundBy, 'static');
  const queue = edgeOf(model, 'orders-api', 'mailer-worker', 'queue');
  assert.equal(queue.length, 1, JSON.stringify(model.edges));
  assert.equal(queue[0].async, true);
  assert.deepEqual(queue[0].evidence, [{ path: 'api/main.py', lines: '31' }, { path: 'worker/tasks.py', lines: '8' }]);
  assert.match(queue[0].desc, /send_receipt/);
  // an import link carries no line: the merge finds the import statement in the file (read as text, never run)
  const imp = edgeOf(model, 'mailer-worker', 'orders-api', 'call');
  assert.equal(imp.length, 1, JSON.stringify(model.edges));
  assert.deepEqual(imp[0].evidence, [{ path: 'worker/tasks.py', lines: '2' }]);
  // a link whose far end no node owns is not invented: it is counted in a derivation row
  assert.equal(model.edges.some((e) => e.evidence.some((x) => x.path === 'web/src/legacy.ts')), false);
  const row = model.meta.sources.find((s) => s.type === 'derivation');
  assert.ok(row, JSON.stringify(model.meta.sources));
  assert.equal(row.skipped.count >= 1, true);
  assert.ok(row.skipped.reasons.some((r) => /ext\/server\.js/.test(r)), JSON.stringify(row));
  // each computed edge is listed once, though the link appears in the slices of both its areas
  assert.equal(new Set(ids(model.edges)).size, model.edges.length);
});

test('m13b with no repo an import link cannot be cited and is skipped, never given a guessed line; without extracts nothing is derived', () => {
  const { model } = crossed({ repo: undefined });
  assert.equal(edgeOf(model, 'mailer-worker', 'orders-api', 'call').length, 0);
  assert.equal(edgeOf(model, 'web-app', 'orders-api', 'api').length, 1, 'line-carrying links still derive');
  const row = model.meta.sources.find((s) => s.type === 'derivation');
  assert.ok(row.skipped.reasons.some((r) => /worker\/tasks\.py/.test(r)), JSON.stringify(row));
  const bare = merge({ fragments: crossFrags(), meta: META }).model;
  assert.deepEqual(ids(bare.edges), ['mailer-uses-shared'], 'no extracts, no derived edges');
  assert.deepEqual(bare.access ?? [], [], 'no extracts, no derived access rows');
});

test('m13c in update mode a derived edge belongs to its caller area: re-running that area with fresh extracts recomputes it', () => {
  const first = crossed().model;
  const fresh = crossExtracts().map((s) => ({ ...s, links: (s.links ?? []).filter((l) => l.kind !== 'http') }));
  const webFrag = crossFrags().filter((f) => f.area === 'web');
  const { model } = merge({ fragments: webFrag, extracts: fresh, repo: join(CROSS, 'repo'), previous: first, areas: ['web'], meta: {} });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.equal(edgeOf(model, 'web-app', 'orders-api', 'api').length, 0, 'the call is gone, so is its edge');
  assert.equal(edgeOf(model, 'orders-api', 'mailer-worker', 'queue').length, 1, 'edges of other areas are kept, once');
  assert.equal(edgeOf(model, 'mailer-worker', 'orders-api', 'call').length, 1);
  assert.equal(model.meta.sources.filter((s) => s.type === 'derivation').length, 1, 'one derivation row, the fresh one');
});

test('m14 nodes of different areas with the same paths collapse to one, every reference rewritten', () => {
  const { model, renames } = crossed();
  assert.deepEqual(ids(model.nodes), ['mailer-worker', 'orders-api', 'orders-db', 'shared-utils', 'web-app']);
  const e = model.edges.find((x) => x.id === 'mailer-uses-shared');
  assert.equal(e.to, 'shared-utils', 'edge.to rewritten to the kept node');
  assert.ok(renames.some((r) => r.from === 'shared' && r.to === 'shared-utils' && r.area === 'worker'), JSON.stringify(renames));
  // the same node twice inside one area is the explorer's own business and is kept apart
  const one = frag('solo', { nodes: [node('a', { zone: 'z' }), node('b', { zone: 'z' })] });
  assert.equal(merge({ fragments: [one], meta: META }).model.nodes.length, 2);
});

test('m15 zones are derived once each: no duplicate ids, every node zone exists, kinds follow the nodes in them', () => {
  const { model } = crossed();
  const zoneIds = ids(model.zones);
  assert.equal(new Set(zoneIds).size, zoneIds.length, `duplicate zone ids: ${zoneIds}`);
  for (const n of model.nodes) assert.ok(zoneIds.includes(n.zone), `zone ${n.zone} of ${n.id} exists`);
  assert.deepEqual(zoneIds, ['browser', 'data', 'service']);
  assert.deepEqual(model.zones.map((z) => z.kind), ['browser', 'data', 'service']);
  // a zone id spelled the same in two areas and one already in the previous model are still one zone
  const prev = clone(model);
  const again = merge({ fragments: crossFrags(), extracts: crossExtracts(), previous: prev, areas: ['api'], meta: {} }).model;
  assert.deepEqual(ids(again.zones), zoneIds);
  // spellings of one zone across areas ('Service', 'service', 'service ') are one zone; a node with no zone gets one
  // from its kind and its area's stack (a ts-frontend app runs in the browser, a store sits in data)
  const spelled = [
    frag('a1', { nodes: [node('svc-a', { zone: 'Service', paths: ['a1/**'] })], zones: [{ id: 'Service', kind: 'service', label: 'Backend' }] }),
    frag('a2', { nodes: [node('svc-b', { zone: 'service ', paths: ['a2/**'] })] }),
    frag('a3', { nodes: [node('db', { zone: undefined, kind: 'store', paths: ['a3/db/**'] }), node('spa', { zone: undefined, kind: 'app', paths: ['a3/web/**'] })] }),
  ];
  const slices = [{ area: 'a3', stacks: ['ts-frontend'], links: [] }];
  const z = merge({ fragments: spelled, extracts: slices, meta: META }).model;
  assert.equal(validate(z).ok, true, JSON.stringify(validate(z).findings));
  assert.deepEqual(ids(z.zones), ['browser', 'data', 'service']);
  assert.equal(z.zones.find((x) => x.id === 'service').label, 'Backend', 'the declared zone keeps its label');
  assert.deepEqual(z.nodes.map((n) => `${n.id}:${n.zone}`), ['db:data', 'spa:browser', 'svc-a:service', 'svc-b:service']);
});

test('m16 access rows come from the SQL evidence and relations from the declared foreign keys', () => {
  const { model } = crossed();
  const rows = model.access.map((a) => `${a.node} ${a.entity} ${a.ops} ${a.evidence.map((x) => `${x.path}:${x.lines}`).join(',')}`);
  assert.deepEqual(rows, [
    'mailer-worker orders R worker/tasks.py:12',
    'orders-api customers R api/main.py:22',
    'orders-api orders C api/main.py:25',
  ]);
  // a SQL table no entity models is not invented
  assert.equal(model.entities.some((e) => e.id === 'orders_archive'), false);
  // one fk declared on a model field, one declared in the ORM table of the prescan extract
  assert.deepEqual(model.relations, [
    { from: { entity: 'orders', field: 'customer_id' }, to: { entity: 'customers', field: 'id' }, cardinality: '1-n', kind: 'fk', provenance: 'declared' },
    { from: { entity: 'receipts', field: 'order_id' }, to: { entity: 'orders', field: 'id' }, cardinality: '1-n', kind: 'fk', provenance: 'declared' },
  ]);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
});

test('m17 digest.json is written beside the model: ids, kinds, roles, edges, entities and a pre-drafted sequence, under 30 K characters', () => {
  const dir = tmp();
  const out = join(dir, 'model.json');
  const dg = join(dir, 'digest.json');
  const r = crossCli(out, dg);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(dg, 'utf8');
  assert.ok(text.length < 30000, `${text.length} characters`);
  const d = JSON.parse(text);
  const model = readJson(out);
  assert.deepEqual(d.nodes.map((n) => n.id), ids(model.nodes));
  assert.equal(d.nodes.find((n) => n.id === 'orders-api').kind, 'service');
  assert.equal(d.nodes.find((n) => n.id === 'orders-api').role, 'Takes and stores orders.');
  assert.ok(d.edges.some((e) => e.from === 'web-app' && e.to === 'orders-api' && e.type === 'api'), JSON.stringify(d.edges));
  assert.deepEqual(d.entities.map((e) => e.name).sort(), ['customers', 'orders', 'receipts']);
  // the flow from the web entry point: route, handler, access rows and the queue hop, drafted in the step grammar
  assert.ok(Array.isArray(d.drafts) && d.drafts.length >= 1, JSON.stringify(d.drafts));
  const draft = d.drafts.find((s) => /POST \/orders/.test(s.title));
  assert.ok(draft, JSON.stringify(d.drafts));
  const lanes = draft.participants.map((p) => p.node);
  for (const n of ['web-app', 'orders-api', 'orders-db', 'mailer-worker']) assert.ok(lanes.includes(n), `${n} in ${lanes}`);
  const kinds = draft.steps.filter((s) => Array.isArray(s.m)).map((s) => s.k);
  for (const k of ['api', 'sql', 'queue']) assert.ok(kinds.includes(k), `${k} step in ${kinds}`);
  for (const s of draft.steps.filter((x) => Array.isArray(x.m))) assert.ok(s.r.length >= 1, `step ${s.t} cites its lines`);
  // a draft is a valid sequence of this model as it stands
  const withDraft = { ...model, sequences: d.drafts };
  assert.equal(validate(withDraft).ok, true, JSON.stringify(validate(withDraft).findings));
  rmSync(dir, { recursive: true, force: true });
});

test('m17b the digest keeps under its cap on a large model and counts what it left out', async () => {
  const { buildDigest, digestText, DIGEST_CAP } = await import('../scripts/merge.mjs');
  assert.equal(DIGEST_CAP <= 30000, true);
  const long = 'x'.repeat(60);
  const nodes = Array.from({ length: 400 }, (_, i) => node(`node-${pad(i, 3)}`, { zone: 'z', title: `${long} ${i}`, role: `${long} role` }));
  const edges = Array.from({ length: 900 }, (_, i) => ({
    id: `edge-${pad(i, 3)}`, from: nodes[i % 400].id, to: nodes[(i + 1) % 400].id, type: 'call', desc: long, evidence: ev('x/a.js'), confidence: 'verified',
  }));
  const model = { meta: META, zones: [{ id: 'z', kind: 'service', label: 'z' }], nodes, edges, entities: [], access: [] };
  const d = buildDigest(model, { drafts: [] });
  const text = digestText(d);
  assert.ok(text.length <= DIGEST_CAP, `${text.length} > ${DIGEST_CAP}`);
  assert.deepEqual(JSON.parse(text), d, 'the text is the digest');
  assert.ok(d.truncated && (d.truncated.edges > 0 || d.truncated.nodes > 0), JSON.stringify(d.truncated));
});

test('m18 with extracts, repo and digest the merge output and the digest are byte-identical across two runs', () => {
  const dir = tmp();
  const outs = [1, 2].map((i) => [join(dir, `model${i}.json`), join(dir, `digest${i}.json`)]);
  for (const [out, dg] of outs) {
    const r = crossCli(out, dg);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(readFileSync(outs[0][0], 'utf8'), readFileSync(outs[1][0], 'utf8'));
  assert.equal(readFileSync(outs[0][1], 'utf8'), readFileSync(outs[1][1], 'utf8'));
  // and the library result does not depend on the order fragments or extracts arrive in
  const fwd = crossed();
  const rev = merge({ fragments: crossFrags().reverse(), extracts: crossExtracts().reverse(), repo: join(CROSS, 'repo'), meta: META });
  assert.equal(JSON.stringify(fwd.model), JSON.stringify(rev.model));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// P10.6: a reference to something that is not there never costs the build. An area id (or area:<id>) in
// `to` or `from` resolves to that area's level-2 node; what still resolves to nothing is dropped and noted.

const refFrags = () => ({
  web: frag('web', {
    nodes: [node('web-app', { zone: 'z', kind: 'app' }), node('web-db', { zone: 'z', kind: 'store', paths: ['web/db/**'] })],
    edges: [
      { id: 'w-to-api', from: 'web-app', to: 'api', type: 'api', desc: 'by area id', evidence: ev('x/web.js', '3-4'), confidence: 'verified' },
      { id: 'w-to-api2', from: 'web-app', to: 'area:api', type: 'api', desc: 'by area:id', evidence: ev('x/web.js', '5-6'), confidence: 'inferred' },
      { id: 'w-to-data', from: 'web-app', to: 'area:data', type: 'call', desc: 'area with no app or service', evidence: ev('x/web.js', '7-8'), confidence: 'inferred' },
      { id: 'api-to-w', from: 'api', to: 'web-app', type: 'call', desc: 'from side', evidence: ev('x/web.js', '9-10'), confidence: 'inferred' },
      { id: 'w-ghost', from: 'web-app', to: 'area:ghost', type: 'call', desc: 'nothing there', evidence: ev('x/web.js', '11-12'), confidence: 'inferred' },
      { id: 'w-ghost2', from: 'web-app', to: 'no-such-node', type: 'call', desc: 'nothing there', evidence: ev('x/web.js', '13-14'), confidence: 'inferred' },
    ],
    entities: [
      { id: 'e-ok', store: 'web-db', name: 'ok', kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }] },
      { id: 'e-lost', store: 'gone-db', name: 'lost', kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }] },
    ],
    access: [
      { node: 'web-app', entity: 'e-ok', ops: 'R', evidence: ev('x/web.js', '15-16') },
      { node: 'gone-node', entity: 'e-ok', ops: 'R', evidence: ev('x/web.js', '17-18') },
    ],
  }),
  api: frag('api', {
    nodes: [
      node('api-db', { zone: 'z', kind: 'store', paths: ['api/db/**'] }),
      node('api-handler', { zone: 'z', kind: 'service', level: 3, paths: ['api/h/**'] }),
      node('api-svc', { zone: 'z', kind: 'service', paths: ['api/**'] }),
    ],
  }),
  data: frag('data', { nodes: [node('data-first', { zone: 'z', kind: 'store', paths: ['data/a/**'] }), node('data-second', { zone: 'z', kind: 'store', paths: ['data/b/**'] })] }),
});

test('m19 an edge to or from an area id (or area:<id>) lands on that area\'s level-2 app or service node, else its first node, and keeps its evidence', () => {
  const { r, model } = runDir(refFrags(), ['--strict']);
  assert.equal(r.status, 0, r.stderr);
  const e = (id) => model.edges.find((x) => x.id === id);
  assert.equal(e('w-to-api').to, 'api-svc');
  assert.deepEqual(e('w-to-api').evidence, ev('x/web.js', '3-4'), 'the evidence stays');
  assert.equal(e('w-to-api2').to, 'api-svc');
  assert.equal(e('w-to-data').to, 'data-first');
  assert.equal(e('api-to-w').from, 'api-svc');
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
});

test('m19b a reference that resolves to nothing is dropped with one dropped-ref row each, and the merge still exits 0 and writes a valid model', () => {
  const { r, model } = runDir(refFrags());
  assert.equal(r.status, 0, r.stderr);
  assert.ok(model, 'the model was written');
  assert.equal(model.edges.some((x) => x.id === 'w-ghost' || x.id === 'w-ghost2'), false);
  assert.equal(model.entities.some((x) => x.id === 'e-lost'), false, 'an entity whose store is missing is dropped');
  assert.equal(model.access.some((x) => x.node === 'gone-node'), false, 'an access row on a missing node is dropped');
  assert.equal(model.access.length, 1);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const rows = model.meta.sources.filter((s) => s.type === 'dropped-ref');
  const key = (s) => `${s.area}:${s.id}:${s.target}`;
  assert.deepEqual(rows.map(key).sort(), [
    'web:access:gone-node/e-ok:gone-node', 'web:e-lost:gone-db', 'web:w-ghost2:no-such-node', 'web:w-ghost:area:ghost',
  ].sort());
});

// ---------------------------------------------------------------------------------------------
// P10.9: with --repo the merge checks evidence against the repository at meta.commit, the way validate --repo
// does, and normalises what it can instead of handing validate a slip: a range past the end of the file is
// clamped, an entry whose path is not a file is dropped, a node or edge left without evidence goes with its
// references. What it cannot normalise stays a finding, listed, exit 1.

const git = (cwd, ...args) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A throwaway git repo: a 16-line and a 7-line file, a directory, committed once. Returns {dir, sha}. */
function evidenceRepo() {
  const dir = tmp();
  mkdirSync(join(dir, 'infra'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'long.js'), numbered(16));
  writeFileSync(join(dir, 'src', 'short.js'), numbered(7));
  writeFileSync(join(dir, 'infra', 'main.tf'), numbered(3));
  assert.equal(git(dir, 'init', '-q').status, 0);
  assert.equal(git(dir, 'add', '-A').status, 0);
  assert.equal(git(dir, 'commit', '-q', '-m', 'init').status, 0);
  return { dir, sha: git(dir, 'rev-parse', 'HEAD').stdout.trim() };
}

const slipFrags = () => [
  frag('web', {
    nodes: [
      node('ok-node', { evidence: ev('src/long.js', '1-4') }),
      node('past-end', { evidence: ev('src/short.js', '1-8') }),
      node('start-past-end', { evidence: ev('src/short.js', '9-12') }),
      node('dir-node', { evidence: ev('infra', '1-3') }),
      node('half-ghost', { evidence: [{ path: 'src/gone.js', lines: '1-2' }, { path: 'src/long.js', lines: '2-3' }] }),
      node('ghost-node', { evidence: ev('src/nothing.js', '1-2') }),
    ],
    edges: [
      { id: 'e-clamp', from: 'ok-node', to: 'past-end', type: 'call', desc: 'x', evidence: ev('src/long.js', '1-20'), confidence: 'verified' },
      { id: 'e-ghost', from: 'ok-node', to: 'ghost-node', type: 'call', desc: 'to a dropped node', evidence: ev('src/long.js', '5-6'), confidence: 'verified' },
      { id: 'e-nopath', from: 'ok-node', to: 'dir-node', type: 'call', desc: 'x', evidence: ev('src/missing.js', '1'), confidence: 'verified' },
    ],
    entities: [{
      id: 'ent', store: 'ok-node', name: 'ent', kind: 'table',
      fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared', evidence: ev('src/short.js', '7-9') }],
      evidence: [{ path: 'src/long.js', lines: '16' }, { path: 'src/gone.js', lines: '1' }],
    }],
    access: [{ node: 'ok-node', entity: 'ent', ops: 'R', evidence: ev('src/long.js', '17') }],
  }),
];
const slipMeta = (sha) => ({ ...META, commit: sha });
const rowsOf = (model, type) => model.meta.sources.filter((s) => s.type === type);

test('m20 with --repo an evidence range past the end of the file is clamped to its last line and each change is one clamped-evidence row', () => {
  const { dir, sha } = evidenceRepo();
  const { model } = merge({ fragments: slipFrags(), repo: dir, meta: slipMeta(sha) });
  const n = (id) => model.nodes.find((x) => x.id === id);
  assert.deepEqual(n('ok-node').evidence, ev('src/long.js', '1-4'), 'a range inside the file is untouched');
  assert.deepEqual(n('past-end').evidence, ev('src/short.js', '1-7'), 'the end moves to the last line');
  assert.deepEqual(n('start-past-end').evidence, ev('src/short.js', '7'), 'a start past the end becomes the last line too');
  assert.deepEqual(model.edges.find((e) => e.id === 'e-clamp').evidence, ev('src/long.js', '1-16'));
  assert.deepEqual(model.access[0].evidence, ev('src/long.js', '16'), 'a single line past the end');
  const rows = rowsOf(model, 'clamped-evidence');
  const key = (s) => `${s.area}|${s.id}|${s.path}`;
  assert.deepEqual(rows.map(key).sort(), [
    'web|e-clamp|src/long.js', 'web|ent.id|src/short.js', 'web|past-end|src/short.js',
    'web|start-past-end|src/short.js', 'web|access:ok-node/ent|src/long.js',
  ].sort());
  for (const r of rows) assert.deepEqual(Object.keys(r).filter((k) => !['area', 'type', 'id', 'path', 'note'].includes(k)), []);
});

test('m20b an evidence entry whose path is not a file at the commit (missing, or a directory) is dropped; a node or edge left with none is dropped, with a dropped-evidence row and its references', () => {
  const { dir, sha } = evidenceRepo();
  const { model } = merge({ fragments: slipFrags(), repo: dir, meta: slipMeta(sha) });
  const nodeIds = model.nodes.map((x) => x.id);
  assert.equal(nodeIds.includes('ghost-node'), false, 'no evidence left: the node goes');
  assert.equal(nodeIds.includes('dir-node'), false, 'a directory is not a file');
  assert.deepEqual(model.nodes.find((x) => x.id === 'half-ghost').evidence, ev('src/long.js', '2-3'), 'the valid entry stays');
  assert.deepEqual(model.edges.map((e) => e.id), ['e-clamp'], 'e-nopath has no evidence left, e-ghost points at a dropped node');
  assert.deepEqual(model.entities[0].evidence, ev('src/long.js', '16'), 'an entity keeps itself, loses the entry');
  const dropped = rowsOf(model, 'dropped-evidence').map((s) => `${s.area}|${s.id}|${s.path}`).sort();
  assert.deepEqual(dropped, [
    'web|dir-node|infra', 'web|e-nopath|src/missing.js', 'web|ent|src/gone.js', 'web|ghost-node|src/nothing.js', 'web|half-ghost|src/gone.js',
  ].sort());
  assert.ok(rowsOf(model, 'dropped-ref').some((s) => s.id === 'e-ghost'), 'the edge to a dropped node is dropped by the reference pass');
  const v = validate(model, { repo: dir });
  assert.deepEqual(v.findings, []);
});

test('m20c through the CLI the fixture that validate --repo refused now merges with exit 0, and validate --repo accepts what was written', () => {
  const { dir, sha } = evidenceRepo();
  const fr = join(tmp(), 'fragments');
  mkdirSync(fr);
  writeFileSync(join(fr, 'web.json'), JSON.stringify(slipFrags()[0]));
  const out = join(tmp(), 'model.json');
  const args = [fr, '--out', out, '--commit', sha, '--project', 'p', '--profile', 'balanced', '--generated-at', '2026-01-01T00:00:00Z'];
  const before = merge({ fragments: slipFrags(), meta: slipMeta(sha) }); // no --repo: nothing normalised
  const refused = validate(before.model, { repo: dir }).findings.map((f) => f.code);
  assert.ok(refused.includes('evidence-lines-out-of-range') && refused.includes('evidence-path-missing'), refused.join());
  const r = cli([...args, '--repo', dir]);
  assert.equal(r.status, 0, r.stderr);
  const model = readJson(out);
  assert.deepEqual(validate(model, { repo: dir }).findings, []);
  const vcli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/validate.mjs', import.meta.url)), out, '--repo', dir], { encoding: 'utf8' });
  assert.equal(vcli.status, 0, vcli.stdout + vcli.stderr);
});

test('m20d lines are checked at meta.commit, not in the working tree: a file shortened later still clamps to its length at the commit', () => {
  const { dir, sha } = evidenceRepo();
  writeFileSync(join(dir, 'src', 'long.js'), numbered(3));
  assert.equal(git(dir, 'commit', '-q', '-am', 'shrink').status, 0);
  const f = [frag('web', { nodes: [node('n', { evidence: ev('src/long.js', '1-30') })] })];
  const { model } = merge({ fragments: f, repo: dir, meta: slipMeta(sha) });
  assert.deepEqual(model.nodes[0].evidence, ev('src/long.js', '1-16'));
  assert.deepEqual(validate(model, { repo: dir }).findings, []);
});

test('m20e merge exits 1 only over findings it did not normalise (a kept element of --previous), lists them on stderr and writes nothing', () => {
  const { dir, sha } = evidenceRepo();
  const old = node('old-node', { zone: 'svc-zone', paths: ['old/**'], evidence: ev('src/gone.js', '1-2') });
  const previous = {
    meta: { schemaVersion: '1.0', project: 'p', commit: sha, generatedAt: '2025-01-01T00:00:00Z', profile: 'balanced', sources: [], coverage: { old: ['src/gone.js'], web: ['web/**'] } },
    zones: [{ id: 'svc-zone', kind: 'service', label: 'svc-zone' }], nodes: [old], edges: [],
  };
  const tmpDir = tmp();
  const prev = join(tmpDir, 'previous.json');
  writeFileSync(prev, JSON.stringify(previous));
  const fr = join(tmpDir, 'fragments');
  mkdirSync(fr);
  writeFileSync(join(fr, 'web.json'), JSON.stringify(slipFrags()[0]));
  const out = join(tmpDir, 'model.json');
  const r = cli([fr, '--out', out, '--previous', prev, '--areas', 'web', '--commit', sha, '--generated-at', '2026-01-01T00:00:00Z', '--repo', dir]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(existsSync(out), false, 'nothing written');
  const invalid = r.stderr.split('\n').filter((l) => l.startsWith('invalid:'));
  assert.equal(invalid.length, 1, r.stderr);
  assert.match(invalid[0], /evidence-path-missing .*src\/gone\.js/, 'what merge normalised (the web fragment) is not listed; what it left alone is');
  assert.match(r.stderr, /1 finding\(s\)/);
});

test('m20f two runs with --repo are byte-identical, whatever order the fragments arrive in; without --repo or a resolvable commit evidence is left alone', () => {
  const { dir, sha } = evidenceRepo();
  const run = (frags, extra) => {
    const fr = join(tmp(), 'fragments');
    mkdirSync(fr);
    frags.forEach((f, i) => writeFileSync(join(fr, `${f.area}-${i}.json`), JSON.stringify(f)));
    const out = join(tmp(), 'model.json');
    const r = cli([fr, '--out', out, '--project', 'p', '--profile', 'balanced', '--generated-at', '2026-01-01T00:00:00Z', ...extra]);
    return { r, text: existsSync(out) ? readFileSync(out, 'utf8') : null };
  };
  const second = frag('api', { nodes: [node('api-n', { paths: ['api/**'], evidence: ev('src/short.js', '2-99') })] });
  const a = run([...slipFrags(), second], ['--commit', sha, '--repo', dir]);
  const b = run([second, ...slipFrags()], ['--commit', sha, '--repo', dir]);
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.text, b.text);
  // a commit the repo does not have: nothing to normalise against, the evidence stays as the explorer wrote it
  const c = run(slipFrags(), ['--commit', 'deadbeef', '--repo', dir]);
  assert.equal(c.r.status, 0, c.r.stderr);
  assert.match(c.r.stderr, /not checked/);
  const model = JSON.parse(c.text);
  assert.deepEqual(model.nodes.find((x) => x.id === 'past-end').evidence, ev('src/short.js', '1-8'));
  assert.equal(rowsOf(model, 'clamped-evidence').length + rowsOf(model, 'dropped-evidence').length, 0);
});
