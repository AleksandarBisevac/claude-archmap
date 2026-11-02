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
  // P10.10: the queue is a node of its own; the producer and the consumer each get an async edge to it
  assert.equal(edgeOf(model, 'orders-api', 'mailer-worker', 'queue').length, 0, 'no edge skips the queue node');
  const put = edgeOf(model, 'orders-api', 'send-receipt-queue', 'queue');
  const take = edgeOf(model, 'mailer-worker', 'send-receipt-queue', 'queue');
  assert.equal(put.length, 1, JSON.stringify(model.edges));
  assert.equal(take.length, 1, JSON.stringify(model.edges));
  assert.deepEqual([put[0].async, take[0].async], [true, true]);
  assert.deepEqual(put[0].evidence, [{ path: 'api/main.py', lines: '31' }]);
  assert.deepEqual(take[0].evidence, [{ path: 'worker/tasks.py', lines: '8' }]);
  assert.match(put[0].desc, /send_receipt/);
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
  assert.equal(edgeOf(model, 'orders-api', 'send-receipt-queue', 'queue').length, 1, 'edges of other areas are kept, once');
  assert.equal(edgeOf(model, 'mailer-worker', 'send-receipt-queue', 'queue').length, 1);
  assert.equal(edgeOf(model, 'mailer-worker', 'orders-api', 'call').length, 1);
  assert.equal(model.meta.sources.filter((s) => s.type === 'derivation').length, 1, 'one derivation row, the fresh one');
});

test('m14 nodes of different areas with the same paths collapse to one, every reference rewritten', () => {
  const { model, renames } = crossed();
  assert.deepEqual(ids(model.nodes), ['mailer-worker', 'orders-api', 'orders-db', 'send-receipt-queue', 'shared-utils', 'web-app']);
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

test('m16 access rows come from the SQL evidence (and the ORM models, P10.17) and relations from the declared foreign keys', () => {
  const { model } = crossed();
  const rows = model.access.map((a) => `${a.node} ${a.entity} ${a.ops} ${a.evidence.map((x) => `${x.path}:${x.lines}`).join(',')}`);
  assert.deepEqual(rows, [
    'mailer-worker orders R worker/tasks.py:12',
    'orders-api customers R api/main.py:22,api/models.py:14',
    'orders-api orders CR api/main.py:25,api/models.py:5',
    'orders-api orders-archive R api/main.py:27',
  ]);
  // P10.13: a SQL table no entity models is an inferred entity (no fields), cited at its statement
  const archive = model.entities.find((e) => e.name === 'orders_archive');
  assert.equal(archive.provenance, 'inferred');
  assert.deepEqual(archive.evidence, ev('api/main.py', '27'));
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
  assert.deepEqual(d.entities.map((e) => e.name).sort(), ['customers', 'orders', 'orders_archive', 'receipts']);
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

/** A repo whose hooks/hooks.json runs scripts/staleness.mjs on lines 5-12 and names two scripts on lines 13-16. */
function hookRepo() {
  const dir = tmp();
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const lines = [
    '{', '  "hooks": {', '    "SessionStart": [', '      {',
    '        "matcher": "startup",', '        "hooks": [', '          {', '            "type": "command",',
    '            "command": "node scripts/staleness.mjs",', '            "timeout": 10', '          }', '        ]',
    '        "also": "node scripts/pipeline.mjs && node scripts/staleness.mjs",', '      }', '    ]', '  }',
  ];
  writeFileSync(join(dir, 'hooks', 'hooks.json'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'scripts', 'pipeline.mjs'), numbered(4));
  writeFileSync(join(dir, 'scripts', 'staleness.mjs'), numbered(4));
  assert.equal(git(dir, 'init', '-q').status, 0);
  assert.equal(git(dir, 'add', '-A').status, 0);
  assert.equal(git(dir, 'commit', '-q', '-m', 'init').status, 0);
  return { dir, sha: git(dir, 'rev-parse', 'HEAD').stdout.trim() };
}
const hookFrags = () => [
  frag('hooks', {
    nodes: [node('hooks-config', { zone: 'z', kind: 'config', paths: ['hooks/**'], evidence: ev('hooks/hooks.json', '1-4') })],
    edges: [
      { id: 'hook-runs-staleness', from: 'hooks-config', to: 'area:scripts', type: 'call', desc: 'SessionStart runs the check', evidence: ev('hooks/hooks.json', '5-12'), confidence: 'verified' },
      { id: 'hook-runs-both', from: 'hooks-config', to: 'area:scripts', type: 'call', desc: 'names two scripts', evidence: ev('hooks/hooks.json', '13-14'), confidence: 'verified' },
    ],
  }),
  frag('scripts', {
    nodes: [
      node('scripts-pipeline', { zone: 'z', paths: ['scripts/pipeline.mjs'], evidence: ev('scripts/pipeline.mjs', '1-2') }),
      node('scripts-staleness', { zone: 'z', paths: ['scripts/staleness.mjs'], evidence: ev('scripts/staleness.mjs', '1-2') }),
    ],
  }),
];

test('m31 an edge to area:<id> whose evidence lines, read at meta.commit, name a file exactly one node of that area owns targets that node; no repo, or two owners, keep the area hub', () => {
  const { dir, sha } = hookRepo();
  const edge = (model, id) => model.edges.find((x) => x.id === id);
  const withRepo = merge({ fragments: hookFrags(), repo: dir, meta: { ...META, commit: sha } }).model;
  assert.equal(edge(withRepo, 'hook-runs-staleness').to, 'scripts-staleness', 'the node whose paths include scripts/staleness.mjs');
  assert.deepEqual(edge(withRepo, 'hook-runs-staleness').evidence, ev('hooks/hooks.json', '5-12'), 'the evidence stays');
  assert.equal(edge(withRepo, 'hook-runs-both').to, 'scripts-pipeline', 'two nodes of the area own the named files: the hub');
  assert.equal(validate(withRepo, { repo: dir }).ok, true, JSON.stringify(validate(withRepo, { repo: dir }).findings));
  const noRepo = merge({ fragments: hookFrags(), meta: { ...META, commit: sha } }).model;
  assert.equal(edge(noRepo, 'hook-runs-staleness').to, 'scripts-pipeline', 'without --repo nothing changes: the hub');
  const flipped = merge({ fragments: hookFrags().reverse(), repo: dir, meta: { ...META, commit: sha } }).model;
  assert.deepEqual(flipped.edges, withRepo.edges, 'fragment order does not change the edges');
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

// ---------------------------------------------------------------------------------------------
// P10.10: entities, relations and queues are made by the script from the full extracts, deterministically and
// with evidence at the declaring file and lines; an explorer's entity of the same table name merges into them.

const genExtracts = () => [
  {
    area: 'db', stacks: ['node-backend'], links: [], queues: [],
    tables: [
      { name: 'users', table: 'users', orm: 'drizzle', fields: ['id serial pk', 'email text'], file: 'db/schema.ts', line: 3, lines: '3-6' },
      { name: 'posts', table: 'posts', orm: 'drizzle', fields: ['id serial pk', 'authorId integer fk=users.id', 'title text'], file: 'db/schema.ts', line: 8, lines: '8-12' },
      { name: 'Comment', table: 'comments', orm: 'typeorm', fields: ['id number pk', 'postId number fk=posts'], file: 'db/comment.entity.ts', line: 4, lines: '4-12' },
    ],
  },
  {
    area: 'api', stacks: ['node-backend'], links: [], tables: [],
    queues: [{ name: 'mail', file: 'api/queue.ts', line: 2, producers: [{ job: 'welcome', file: 'api/signup.ts', line: 9 }], consumers: [] }],
  },
  {
    area: 'jobs', stacks: ['ts-frontend'], links: [], tables: [],
    queues: [{ name: 'mail', producers: [], consumers: [{ handler: 'deliver', file: 'jobs/mail.worker.ts', line: 5 }] }],
  },
];
const genFrags = () => [
  frag('api', { nodes: [node('api-svc', { zone: 'svc', kind: 'service', paths: ['api/**'] })] }),
  frag('jobs', { nodes: [node('mail-worker', { zone: 'svc', kind: 'job', paths: ['jobs/**'] })] }),
  frag('db', {
    nodes: [node('main-db', { zone: 'data', kind: 'store', paths: ['db/**'] })],
    entities: [{
      id: 'user', store: 'main-db', name: 'users', kind: 'table', desc: 'People who sign up.',
      fields: [
        { name: 'id', type: 'serial', pk: true, provenance: 'declared' },
        { name: 'lastSeen', type: 'timestamp', provenance: 'observed' },
      ],
      evidence: ev('db/schema.ts', '3-6'),
    }],
  }),
];
const generated = (extra = {}) => merge({ fragments: genFrags(), extracts: genExtracts(), meta: META, ...extra });

test('m21 merge makes one entity per declared table of the extracts, with declared fields and evidence at the schema file and lines, and one relation per declared foreign key', () => {
  const { model } = generated();
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.deepEqual(model.entities.map((e) => e.name).sort(), ['comments', 'posts', 'users'], 'one entity per table, none twice');
  const byName = Object.fromEntries(model.entities.map((e) => [e.name, e]));
  const posts = byName.posts;
  assert.equal(posts.store, 'main-db', 'the store whose paths cover the schema file');
  assert.deepEqual(posts.evidence, ev('db/schema.ts', '8-12'));
  assert.deepEqual(posts.fields.map((f) => [f.name, f.type, Boolean(f.pk), f.provenance]), [
    ['id', 'serial', true, 'declared'], ['authorId', 'integer', false, 'declared'], ['title', 'text', false, 'declared'],
  ]);
  assert.deepEqual(byName.comments.evidence, ev('db/comment.entity.ts', '4-12'));
  // the explorer's entity of the same table is merged into the generated one: its id, desc and observed field stay
  const users = byName.users;
  assert.equal(users.id, 'user');
  assert.equal(users.desc, 'People who sign up.');
  assert.deepEqual(users.fields.map((f) => `${f.name}:${f.provenance}`), ['id:declared', 'email:declared', 'lastSeen:observed']);
  const rel = (r) => `${r.from.entity}.${r.from.field} > ${r.to.entity}.${r.to.field} ${r.kind} ${r.provenance}`;
  assert.deepEqual(model.relations.map(rel).sort(), [
    `${byName.comments.id}.postId > ${posts.id}.id fk declared`,
    `${posts.id}.authorId > user.id fk declared`,
  ]);
});

test('m21b merge makes one queue node per queue name and a queue edge with async true from each producer and each consumer, at their lines', () => {
  const { model } = generated();
  const queues = model.nodes.filter((n) => n.kind === 'queue');
  assert.deepEqual(ids(queues), ['mail-queue'], 'one node for the name, though two areas list it');
  assert.deepEqual(queues[0].evidence, ev('api/queue.ts', '2'), 'the node cites the declaration');
  const qe = model.edges.filter((e) => e.type === 'queue').map((e) => `${e.from} > ${e.to} ${e.async} ${e.evidence.map((x) => `${x.path}:${x.lines}`).join(',')}`);
  assert.deepEqual(qe.sort(), [
    'api-svc > mail-queue true api/signup.ts:9',
    'mail-worker > mail-queue true jobs/mail.worker.ts:5',
  ]);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  // an explorer node of kind queue for the same name is the node, not a second one
  const withNode = genFrags();
  withNode[0].nodes.push(node('mail-queue', { zone: 'data', kind: 'queue', title: 'Mail queue', paths: ['api/queue.ts'], evidence: ev('api/queue.ts', '1-3') }));
  const m2 = merge({ fragments: withNode, extracts: genExtracts(), meta: META }).model;
  assert.deepEqual(ids(m2.nodes.filter((n) => n.kind === 'queue')), ['mail-queue']);
  assert.equal(m2.nodes.find((n) => n.id === 'mail-queue').title, 'Mail queue', "the explorer's content is kept");
});

test('m21c generation is deterministic whatever order fragments and extracts arrive in, and a table no store node covers gets a generated store', () => {
  const fwd = JSON.stringify(generated().model);
  const rev = JSON.stringify(merge({ fragments: genFrags().reverse(), extracts: genExtracts().reverse(), meta: META }).model);
  assert.equal(fwd, rev);
  assert.equal(JSON.stringify(generated().model), fwd, 'two runs are identical');
  const lone = [{ area: 'pkg', stacks: [], links: [], queues: [], tables: [{ name: 'events', table: 'events', orm: 'drizzle', fields: ['id serial pk'], file: 'pkg/db.ts', line: 1, lines: '1-3' }] }];
  const { model } = merge({ fragments: [frag('pkg', { nodes: [node('pkg-svc', { zone: 'svc', paths: ['pkg/**'] })] })], extracts: lone, meta: META });
  const events = model.entities.find((e) => e.name === 'events');
  assert.ok(events, JSON.stringify(model.entities));
  const store = model.nodes.find((n) => n.id === events.store);
  assert.equal(store && store.kind, 'store', `entity store ${events.store} is a store node`);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  // through the CLI the explorer summaries beside the extracts are not read as extracts
  const dir = tmp();
  for (const [sub, items] of [['fragments', genFrags()], ['extracts', genExtracts()]]) {
    mkdirSync(join(dir, sub));
    for (const x of items) writeFileSync(join(dir, sub, `${x.area}.json`), JSON.stringify(x));
  }
  writeFileSync(join(dir, 'extracts', 'db.summary.json'), JSON.stringify({ area: 'db', tables: [{ name: 'ghost', table: 'ghost', fields: ['id serial pk'], file: 'db/schema.ts', line: 1 }] }));
  const r = cli([join(dir, 'fragments'), '--out', join(dir, 'model.json'), '--extracts', join(dir, 'extracts'), '--commit', 'abc123', '--project', 'shop', '--generated-at', '2026-01-01T00:00:00Z']);
  assert.equal(r.status, 0, r.stderr);
  const viaCli = readJson(join(dir, 'model.json'));
  assert.deepEqual(viaCli.entities.map((e) => e.name).sort(), ['comments', 'posts', 'users'], 'no table from a summary file');
  rmSync(dir, { recursive: true, force: true });
});

test('m21d 150 generated entities are not held to the fragment caps, and the digest stays under its cap and counts what it left out', async () => {
  const { buildDigest, digestText, DIGEST_CAP } = await import('../scripts/merge.mjs');
  const tables = Array.from({ length: 150 }, (_, i) => ({
    name: `table_${pad(i, 3)}`, table: `table_${pad(i, 3)}`, orm: 'drizzle', file: 'db/schema.ts', line: i * 10 + 1, lines: `${i * 10 + 1}-${i * 10 + 8}`,
    fields: ['id serial pk', 'name text', 'created_at timestamp', 'updated_at timestamp', ...(i ? [`parent_id integer fk=table_${pad(i - 1, 3)}.id`] : [])],
  }));
  const { model } = merge({
    fragments: [frag('db', { nodes: [node('main-db', { zone: 'data', kind: 'store', paths: ['db/**'] })] })],
    extracts: [{ area: 'db', stacks: [], links: [], queues: [], tables }], meta: META,
  });
  assert.equal(model.entities.length, 150);
  assert.equal(model.relations.length, 149);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings).slice(0, 500));
  const d = buildDigest(model, { drafts: [] });
  const text = digestText(d);
  assert.ok(text.length <= DIGEST_CAP, `${text.length} > ${DIGEST_CAP}`);
  assert.equal((d.entities ?? []).length + ((d.truncated && d.truncated.entities) || 0), 150, 'every entity is in the digest or counted out');
});

// P10.12: a synthesizer slip is normalised, not refused. Real build: one sequence step matched no step shape and the
// model was refused, so the orchestrator re-asked the agent. merge drops the step and says so in meta.sources.
const goodStep = (t) => ({ m: ['ui', 'svc'], k: 'api', t, d: 'a call', r: ['web/app.js:3'] });
const synthWith = (sequences) => ({ sequences, views: [{ id: 'system', title: 'System', nodes: ['ui', 'svc', 'store'] }], notes: [], conflicts: [] });
const seqOf = (id, steps) => ({
  id, title: id, summary: id,
  participants: [{ id: 'ui', label: 'UI', node: 'ui' }, { id: 'svc', label: 'Service', node: 'svc' }],
  steps,
});

test('m22 a synth step that matches no step shape is dropped with a dropped-step row naming the sequence, the index and the reason; the rest of the sequence is kept and the model validates', () => {
  const synth = synthWith([seqOf('place-order', [goodStep('A'), goodStep('B'), { t: 'no shape here', d: 7 }, goodStep('C')])]);
  const { model } = merge({ fragments: buildFrags(), synth, meta: META });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.deepEqual(model.sequences.find((s) => s.id === 'place-order').steps.map((s) => s.t), ['A', 'B', 'C']);
  const rows = model.meta.sources.filter((r) => r.type === 'dropped-step');
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].sequence, 'place-order');
  assert.equal(rows[0].index, 2, 'the index in the synth sequence');
  assert.equal(typeof rows[0].reason, 'string');
  assert.ok(rows[0].reason.length > 0);
  // the other step shapes are untouched
  const mixed = synthWith([seqOf('s2', [goodStep('A'), { frag: 'alt', t: 'cond' }, goodStep('B'), { frag: 'end', t: '' }, { note: ['n'], t: 'x', tone: 'info' }])]);
  const r2 = merge({ fragments: buildFrags(), synth: mixed, meta: META });
  assert.equal(r2.model.sequences.find((s) => s.id === 's2').steps.length, 5);
  assert.deepEqual(r2.model.meta.sources.filter((r) => r.type === 'dropped-step'), []);
});

test('m22b a sequence left with fewer than 2 steps by a drop is dropped the same way, and a clean one-step sequence is not touched', () => {
  const synth = synthWith([
    seqOf('left-one', [goodStep('A'), { bogus: true }]),
    seqOf('left-none', [{ bogus: 1 }, 'text']),
    seqOf('plain-one', [goodStep('A')]),
  ]);
  const { model } = merge({ fragments: buildFrags(), synth, meta: META });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.deepEqual(ids(model.sequences), ['plain-one']);
  const rows = model.meta.sources.filter((r) => r.type === 'dropped-step');
  assert.deepEqual(rows.filter((r) => r.index !== undefined).map((r) => [r.sequence, r.index]), [['left-none', 0], ['left-none', 1], ['left-one', 1]]);
  for (const seq of ['left-one', 'left-none']) {
    assert.ok(rows.some((r) => r.sequence === seq && r.index === undefined && /fewer than 2|under 2/i.test(r.reason)), `${seq}: a row for the dropped sequence ${JSON.stringify(rows)}`);
  }
});

test('m22c through the CLI a synth with an unplaceable step exits 0 and writes a valid model; the same dropped-step rows come out byte-identically on a second run', () => {
  const dir = tmp();
  const synthPath = join(dir, 'synth.json');
  writeFileSync(synthPath, JSON.stringify(synthWith([seqOf('place-order', [goodStep('A'), goodStep('B'), { nonsense: true }])])));
  const args = [join(FIX, 'build'), '--synth', synthPath, '--commit', 'abc123', '--project', 'shop', '--profile', 'balanced', '--generated-at', '2026-01-01T00:00:00Z'];
  const out1 = join(dir, 'a.json');
  const out2 = join(dir, 'b.json');
  const r = cli([...args, '--out', out1]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(cli([...args, '--out', out2]).status, 0);
  assert.equal(readFileSync(out1, 'utf8'), readFileSync(out2, 'utf8'));
  const model = readJson(out1);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.equal(model.meta.sources.filter((x) => x.type === 'dropped-step').length, 1);
  assert.deepEqual(model.sequences.find((s) => s.id === 'place-order').steps.map((s) => s.t), ['A', 'B']);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// P10.13: a repository whose only schema is the SQL its code runs (the database file is made at runtime) still gets
// entities: the CREATE TABLE statements are declared tables, and a table that queries name and nothing declares is an
// inferred entity with no fields, cited at its first statement, with access rows from the node that runs the queries.

const sqlExtracts = () => [
  {
    area: 'app', stacks: ['python'], links: [], queues: [],
    tables: [{ name: 'shelves', table: 'shelves', orm: 'sql', fields: ['id INTEGER pk', 'label TEXT'], file: 'app/stock.py', line: 4, lines: '4-8' }],
    sqlTables: [
      'shelves ddl app/stock.py:4',
      'shelves select app/stock.py:30',
      'shelves update app/stock.py:41',
      'returns_desk select app/stock.py:50',
      'returns_desk insert app/stock.py:51',
      'returns_desk delete app/stock.py:52',
      'price_checks select app/stock.py:53',
      'main.shelves select app/stock.py:60',
    ],
  },
];
const sqlFrags = () => [frag('app', { nodes: [node('stock-svc', { zone: 'svc', paths: ['app/**'] })] })];
const sqlMerged = (extra = {}) => merge({ fragments: sqlFrags(), extracts: sqlExtracts(), meta: META, ...extra });

test('m23 a table named by SQL and declared nowhere becomes an entity with provenance inferred, no fields and evidence at its first statement, with one access row from the node that owns the file carrying the CRUD letters of its ops; a declared table keeps its fields and gains access rows', () => {
  const { model } = sqlMerged();
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.deepEqual(model.entities.map((e) => e.name).sort(), ['price_checks', 'returns_desk', 'shelves'], 'one entity per table, a schema-qualified name is the same table');
  const byName = Object.fromEntries(model.entities.map((e) => [e.name, e]));
  assert.equal(byName.returns_desk.provenance, 'inferred');
  assert.deepEqual(byName.returns_desk.fields, []);
  assert.deepEqual(byName.returns_desk.evidence, ev('app/stock.py', '50'), 'the first citing statement');
  assert.equal(byName.price_checks.provenance, 'inferred');
  assert.deepEqual(byName.price_checks.evidence, ev('app/stock.py', '53'));
  assert.equal(byName.shelves.provenance, undefined, 'a declared table is not marked');
  assert.deepEqual(byName.shelves.fields.map((f) => `${f.name}:${f.provenance}`), ['id:declared', 'label:declared']);
  const store = model.nodes.find((n) => n.id === byName.returns_desk.store);
  assert.equal(store && store.kind, 'store', 'an entity has a store, made for the area when no node is one');
  assert.equal(byName.shelves.store, byName.returns_desk.store);
  const rows = Object.fromEntries(model.access.map((a) => [model.entities.find((e) => e.id === a.entity).name, a]));
  assert.equal(rows.returns_desk.node, 'stock-svc');
  assert.equal(rows.returns_desk.ops, 'CRD');
  assert.deepEqual(rows.returns_desk.evidence.map((e) => e.lines), ['50', '51', '52']);
  assert.equal(rows.price_checks.ops, 'R');
  assert.equal(rows.shelves.ops, 'RU', 'ddl is not an access; both spellings of the table are one entity');
  assert.equal(model.access.length, 3);
  const row = model.meta.sources.find((s) => s.type === 'derivation');
  assert.equal(row.derived.entitiesInferred, 2);
  assert.match(row.note, /2 inferred/);
});

test('m23b an explorer entity named like a queried table is the table\'s entity (not a second, inferred one); the digest lists inferred entities and marks them; two runs and either input order are byte-identical', async () => {
  const mine = sqlFrags();
  mine[0].nodes.push(node('app-db', { zone: 'data', kind: 'store', paths: ['db/**'] }));
  mine[0].entities.push({ id: 'desk', store: 'app-db', name: 'Returns_Desk', kind: 'table', fields: [], evidence: ev('app/stock.py', '50') });
  const { model } = merge({ fragments: mine, extracts: sqlExtracts(), meta: META });
  assert.deepEqual(model.entities.map((e) => e.name).sort(), ['Returns_Desk', 'price_checks', 'shelves']);
  assert.equal(model.entities.find((e) => e.id === 'desk').provenance, undefined);
  assert.ok(model.access.some((a) => a.entity === 'desk' && a.ops === 'CRD'), JSON.stringify(model.access));

  const { buildDigest, digestText } = await import('../scripts/merge.mjs');
  const m = sqlMerged().model;
  const d = buildDigest(m, { drafts: [] });
  assert.deepEqual(d.entities.map((e) => `${e.name}${e.provenance ? ` ${e.provenance}` : ''}`).sort(), ['price_checks inferred', 'returns_desk inferred', 'shelves']);
  assert.ok(digestText(d).includes('"provenance":"inferred"'));

  const fwd = JSON.stringify(sqlMerged().model);
  const rev = JSON.stringify(merge({ fragments: sqlFrags(), extracts: [{ ...sqlExtracts()[0], sqlTables: sqlExtracts()[0].sqlTables.slice().reverse() }], meta: META }).model);
  assert.equal(fwd, rev, 'the order of the statements does not change the model');
  assert.equal(JSON.stringify(sqlMerged().model), fwd, 'two runs are identical');
});

// ---------------------------------------------------------------------------------------------
// P10.14: a level-2 app node per workspace app the explorers did not produce, and relations resolved by table name.

const appSlice = (area, apps, extra = {}) => ({ area, stacks: ['node-backend'], links: [], queues: [], tables: [], workspaceApps: apps, ...extra });
const HUB = { name: '@fict/hub', dir: 'apps/hub', manifest: 'apps/hub/package.json' };
const ATLAS = { name: '@fict/atlas', dir: 'apps/atlas', manifest: 'apps/atlas/package.json' };
const appFrags = () => [
  frag('misc', {
    nodes: [
      node('hub-svc', { zone: 'svc', kind: 'service', title: 'Hub service', paths: ['apps/hub/**'], level: 2, evidence: ev('apps/hub/src/main.ts', '1-5') }),
      node('hub-routes', { zone: 'svc', kind: 'route-group', title: 'Hub routes', paths: ['apps/hub/src/routes/**'], level: 3, evidence: ev('apps/hub/src/routes/index.ts') }),
      node('hub-jobs', { zone: 'svc', kind: 'job', title: 'Hub jobs', paths: ['apps/hub/src/jobs/**'], level: 2, evidence: ev('apps/hub/src/jobs/run.ts') }),
      node('hub-db', { zone: 'data', kind: 'store', title: 'Hub store', paths: ['apps/hub/db/**'], level: 2, evidence: ev('apps/hub/db/schema.ts') }),
      node('atlas-app', { zone: 'svc', kind: 'app', title: 'Atlas', paths: ['apps/atlas/**'], level: 2, evidence: ev('apps/atlas/src/main.ts') }),
      node('atlas-api', { zone: 'svc', kind: 'module', title: 'Atlas API', paths: ['apps/atlas/src/api/**'], level: 3, evidence: ev('apps/atlas/src/api/a.ts') }),
      node('shared-kit', { zone: 'svc', kind: 'module', title: 'Shared kit', paths: ['packages/kit/**'], level: 2, evidence: ev('packages/kit/index.ts') }),
    ],
    edges: [{ id: 'hub-to-atlas', from: 'hub-svc', to: 'area:misc', type: 'call', desc: 'x', evidence: ev('apps/hub/src/main.ts'), confidence: 'inferred' }],
  }),
];
const appMerged = (frags = appFrags(), apps = [HUB, ATLAS]) =>
  merge({ fragments: frags, extracts: [appSlice('misc', apps)], meta: META });

test('m24 merge generates a level-2 app node for each workspace app the explorers made none for (kind app, paths dir/**, evidence at its package.json) and reparents that area\'s nodes of the app under it; an app the explorers did make is left as it is', () => {
  const { model } = appMerged();
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const hub = model.nodes.find((n) => n.kind === 'app' && n.paths.includes('apps/hub/**'));
  assert.ok(hub, ids(model.nodes).join());
  assert.equal(hub.level, 2);
  assert.equal(hub.title, 'hub');
  assert.deepEqual(hub.paths, ['apps/hub/**']);
  assert.deepEqual(hub.evidence, ev('apps/hub/package.json', '1'));
  const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
  assert.equal(byId['hub-svc'].level, 3, 'the explorer service of the app sits under the app now');
  assert.equal(byId['hub-jobs'].level, 3);
  assert.equal(byId['hub-routes'].level, 3);
  assert.deepEqual(hub.sub, ['Hub jobs', 'Hub routes', 'Hub service'], 'the app lists its parts');
  assert.equal(byId['hub-db'].level, 2, 'a store stays a container');
  assert.equal(byId['shared-kit'].level, 2, 'a node outside the app stays where it is');
  assert.equal(byId['atlas-app'].level, 2);
  assert.equal(model.nodes.filter((n) => n.kind === 'app').length, 2, 'no second node for the app the explorer made');
  assert.equal(byId['atlas-api'].level, 3);
  assert.equal(byId['atlas-app'].sub, undefined, 'the explorer\'s own node is not rewritten');
  // an area name in an edge resolves to the area's main node, which is now the app node when the area has one first
  const e = model.edges.find((x) => x.id === 'hub-to-atlas');
  assert.equal(byId[e.to].kind, 'app');
  // deterministic: two runs, and either order of apps
  const a = JSON.stringify(appMerged().model);
  assert.equal(JSON.stringify(appMerged().model), a);
  assert.equal(JSON.stringify(appMerged(appFrags(), [ATLAS, HUB]).model), a);
  // a second app-less run adds nothing when the slice lists no app
  assert.equal(merge({ fragments: appFrags(), extracts: [appSlice('misc', [])], meta: META }).model.nodes.filter((n) => n.kind === 'app').length, 1);
});

const relExtracts = () => [
  {
    area: 'db', stacks: ['node-backend'], links: [], queues: [],
    tables: [
      { name: 'users', table: 'users', orm: 'drizzle', fields: ['id serial pk', 'email text'], file: 'db/schema.ts', line: 3, lines: '3-6' },
      { name: 'posts', table: 'posts', orm: 'drizzle', fields: ['id serial pk', 'authorId integer fk=users.id'], file: 'db/schema.ts', line: 8, lines: '8-11' },
    ],
  },
];
const relFrags = () => [
  frag('db', {
    nodes: [node('main-db', { zone: 'data', kind: 'store', paths: ['db/**'] })],
    entities: [{
      id: 'user-account', store: 'main-db', name: 'users', kind: 'table',
      fields: [{ name: 'id', type: 'serial', pk: true, provenance: 'declared' }, { name: 'orgId', type: 'integer', provenance: 'observed', fk: { entity: 'orgs', field: 'id' } }],
    }, {
      id: 'org-record', store: 'main-db', name: 'orgs', kind: 'table',
      fields: [{ name: 'id', type: 'serial', pk: true, provenance: 'declared' }],
    }],
    relations: [
      { from: { entity: 'posts', field: 'authorId' }, to: { entity: 'users', field: 'id' }, cardinality: '1-n', kind: 'fk', provenance: 'declared' },
      { from: { entity: 'posts', field: 'authorId' }, to: { entity: 'user-account', field: 'id' }, cardinality: '1-n', kind: 'fk', provenance: 'declared' },
    ],
  }),
];

test('m24b a relation or foreign key that names its target by table name resolves to the entity id the merge ended with (generated or the explorer\'s), is not dropped as dangling while the entity exists, and a relation repeated by name and by id is emitted once', () => {
  const { model } = merge({ fragments: relFrags(), extracts: relExtracts(), meta: META });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const dropped = model.meta.sources.filter((s) => s.type === 'dropped-ref');
  assert.deepEqual(dropped, [], JSON.stringify(dropped));
  const posts = model.entities.find((e) => e.name === 'posts');
  const rel = (r) => `${r.from.entity}.${r.from.field} > ${r.to.entity}.${r.to.field}`;
  assert.deepEqual(model.relations.map(rel).sort(), [
    `${posts.id}.authorId > user-account.id`,
    'user-account.orgId > org-record.id',
  ].sort(), 'the declared key, the explorer\'s by name and by id are one relation; the explorer\'s field fk is a relation too');
  assert.equal(model.entities.find((e) => e.id === 'user-account').fields.find((f) => f.name === 'orgId').fk.entity, 'org-record', 'the field\'s own fk now names the id');
  // an entity that does not exist still drops, with the row naming what is missing
  const missing = relFrags();
  missing[0].relations.push({ from: { entity: 'posts', field: 'authorId' }, to: { entity: 'ghosts', field: 'id' }, cardinality: '1-n', kind: 'fk', provenance: 'declared' });
  const m2 = merge({ fragments: missing, extracts: relExtracts(), meta: META }).model;
  const rows = m2.meta.sources.filter((s) => s.type === 'dropped-ref');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, 'ghosts');
  assert.equal(m2.relations.length, 2);
  assert.equal(JSON.stringify(merge({ fragments: relFrags(), extracts: relExtracts(), meta: META }).model), JSON.stringify(model));
});

// ---------------------------------------------------------------------------------------------
// P10.17: merge correctness. Zones from the slice containers, access rows from the ORM and queue rows of the
// slices, wildcard http matches inferred, and an update that neither erases an area whose fragment is unreadable
// nor loses the edges a re-explored area draws to an untouched one.

const rowOf = (model) => (a) => {
  const name = model.entities.find((e) => e.id === a.entity)?.name ?? `?${a.entity}`;
  return `${a.node} ${name} ${a.ops} ${(a.evidence ?? []).map((x) => `${x.path}:${x.lines}`).join(',')}`;
};

test('m25 a node in a slice container directory gets that container\'s zone, a node outside any falls back to kind and stack, and no zone id repeats', () => {
  const bare = (id, kind, dir, extra = {}) => node(id, { zone: undefined, kind, paths: [`${dir}/**`], evidence: ev(`${dir}/main.py`), ...extra });
  const fragments = [
    frag('a', { nodes: [
      bare('billing-api', 'service', 'a/billing'),
      bare('billing-jobs', 'job', 'a/billing/jobs', { level: 3 }),
      bare('mailer', 'service', 'a/mail'),
      bare('cache', 'store', 'a/cache'),
      bare('tools', 'service', 'a/tools'),
    ] }),
    frag('b', { nodes: [
      bare('pay', 'service', 'b/billing'),
      node('gate', { zone: 'gateway', kind: 'service', paths: ['b/billing/gate/**'], evidence: ev('b/billing/gate/main.py') }),
    ], zones: [{ id: 'gateway', kind: 'edge', label: 'Gateway' }] }),
  ];
  const slices = [
    // a Dockerfile at the root says nothing about which node it builds, so it makes no zone
    { area: 'a', stacks: ['python'], containers: ['Dockerfile', 'a/billing/Dockerfile', 'a/mail/docker-compose.yml'], links: [] },
    { area: 'b', stacks: ['python'], containers: ['b/billing/Dockerfile'], links: [] },
  ];
  const run = (f, s) => merge({ fragments: f, extracts: s, meta: META }).model;
  const model = run(fragments, slices);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.deepEqual(model.nodes.map((n) => `${n.id}:${n.zone}`), [
    'billing-api:a-billing', 'billing-jobs:a-billing', 'cache:data', 'gate:gateway', 'mailer:mail', 'pay:b-billing', 'tools:service',
  ]);
  const zoneIds = ids(model.zones);
  assert.equal(new Set(zoneIds).size, zoneIds.length, `duplicate zone ids: ${zoneIds}`);
  assert.deepEqual(zoneIds, ['a-billing', 'b-billing', 'data', 'gateway', 'mail', 'service']);
  const z = (id) => model.zones.find((x) => x.id === id);
  assert.deepEqual([z('a-billing').kind, z('a-billing').label], ['service', 'a/billing']);
  assert.deepEqual([z('mail').kind, z('mail').label], ['service', 'a/mail']);
  assert.deepEqual([z('gateway').kind, z('gateway').label], ['edge', 'Gateway'], 'the declared zone is the explorer\'s');
  assert.equal(JSON.stringify(run([...fragments].reverse(), [...slices].reverse())), JSON.stringify(model), 'input order does not matter');
  // without containers in the slice, the kind and stack fallback is all there is
  const plain = run(fragments, slices.map((s) => ({ ...s, containers: [] })));
  assert.deepEqual(ids(plain.zones), ['data', 'gateway', 'service']);
});

test('m26 the ORM table rows and the queue producer and consumer rows of a slice become access rows with evidence at their lines', () => {
  const fragments = [
    frag('api', { nodes: [node('api-svc', { zone: 'svc', kind: 'service', paths: ['api/**'], evidence: ev('api/main.py') })] }),
    frag('db', {
      nodes: [node('db', { zone: 'data', kind: 'store', paths: ['db/**'], evidence: ev('db/schema.sql') })],
      entities: [{ id: 'job-rows', store: 'db', name: 'mail_jobs', kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }] }],
    }),
    frag('jobs', { nodes: [node('worker', { zone: 'svc', kind: 'job', paths: ['jobs/**'], evidence: ev('jobs/run.py') })] }),
  ];
  const slices = [
    {
      area: 'api', stacks: ['python'], links: [],
      tables: [{ name: 'Order', table: 'orders', orm: 'sqlalchemy', fields: ['id int pk'], file: 'api/models.py', line: 5 }],
      queues: [{ name: 'mail_jobs', producers: [{ file: 'api/main.py', line: 31 }], consumers: [] }],
    },
    { area: 'db', stacks: ['python'], links: [], queues: [] },
    { area: 'jobs', stacks: ['python'], links: [], queues: [{ name: 'mail_jobs', producers: [], consumers: [{ handler: 'send', file: 'jobs/run.py', line: 8 }] }] },
  ];
  const run = (f, s) => merge({ fragments: f, extracts: s, meta: META }).model;
  const model = run(fragments, slices);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.deepEqual((model.access ?? []).map(rowOf(model)), [
    'api-svc mail_jobs C api/main.py:31',
    'api-svc orders R api/models.py:5',
    'worker mail_jobs R jobs/run.py:8',
  ]);
  assert.equal(JSON.stringify(run([...fragments].reverse(), [...slices].reverse())), JSON.stringify(model), 'input order does not matter');
});

test('m27 an http edge matched through a wildcard segment is inferred and says so, an all-wildcard call path makes no edge, a literal match stays verified', () => {
  const fragments = [
    frag('web', { nodes: [node('web-app', { zone: 'browser', kind: 'app', paths: ['web/**'], evidence: ev('web/main.ts') })] }),
    frag('api', { nodes: [
      node('api-orders', { zone: 'svc', kind: 'service', paths: ['api/orders/**'], evidence: ev('api/orders/r.py') }),
      node('api-items', { zone: 'svc', kind: 'service', paths: ['api/items/**'], evidence: ev('api/items/r.py') }),
      node('api-health', { zone: 'svc', kind: 'service', paths: ['api/health/**'], evidence: ev('api/health/r.py') }),
    ] }),
  ];
  const links = [
    { kind: 'http', from: 'web/a.ts:3', to: 'api/orders/r.py:10', via: 'GET /orders', match: 'exact', call: 'GET /orders' },
    { kind: 'http', from: 'web/b.ts:4', to: 'api/items/r.py:20', via: 'GET /items/{id}', match: 'wildcard', call: 'GET /items/*' },
    { kind: 'http', from: 'web/c.ts:5', to: 'api/health/r.py:30', via: 'GET /health', match: 'wildcard', call: 'GET /*' },
  ];
  const slices = [
    { area: 'web', stacks: ['ts-frontend'], links: links.map((l) => ({ ...l, dir: 'out', other: 'api' })) },
    { area: 'api', stacks: ['python'], links: links.map((l) => ({ ...l, dir: 'in', other: 'web' })) },
  ];
  const { model } = merge({ fragments, extracts: slices, meta: META });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const literal = edgeOf(model, 'web-app', 'api-orders', 'api');
  assert.equal(literal.length, 1, JSON.stringify(model.edges));
  assert.equal(literal[0].confidence, 'verified');
  assert.doesNotMatch(literal[0].desc, /wildcard/i);
  const wild = edgeOf(model, 'web-app', 'api-items', 'api');
  assert.equal(wild.length, 1, JSON.stringify(model.edges));
  assert.equal(wild[0].confidence, 'inferred');
  assert.match(wild[0].desc, /wildcard/i);
  assert.deepEqual(wild[0].evidence, [{ path: 'web/b.ts', lines: '4' }, { path: 'api/items/r.py', lines: '20' }]);
  assert.equal(edgeOf(model, 'web-app', 'api-health', 'api').length, 0, 'a call path of wildcards only links nothing');
  const row = model.meta.sources.find((s) => s.type === 'derivation');
  assert.ok(row && row.skipped.reasons.some((r) => /web\/c\.ts/.test(r)), JSON.stringify(row));
});

test('m28 in update mode an area whose fragment is unreadable keeps its previous nodes, edges, entities and access rows, is marked skipped and gets a conflict', () => {
  const frags = {
    web: frag('web', { nodes: [node('web-app', { zone: 'z', kind: 'app', paths: ['web/**'] })] }),
    api: frag('api', {
      nodes: [node('api-svc', { zone: 'z', kind: 'service', paths: ['api/**'] }), node('api-db', { zone: 'z', kind: 'store', paths: ['api/db/**'] })],
      edges: [{ id: 'api-reads-db', from: 'api-svc', to: 'api-db', type: 'sql', desc: 'reads', evidence: ev('x/api.js', '3-4'), confidence: 'verified' }],
      entities: [{ id: 'orders', store: 'api-db', name: 'orders', kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }] }],
      access: [{ node: 'api-svc', entity: 'orders', ops: 'R', evidence: ev('x/api.js', '5-6') }],
    }),
  };
  const { r, out, model: before } = runDir(frags);
  assert.equal(r.status, 0, r.stderr);
  const dir = join(tmp(), 'fragments');
  mkdirSync(dir);
  writeFileSync(join(dir, 'api.json'), '{"area": "api", "nodes": [');
  const up = cli([dir, '--out', out, '--previous', out, '--areas', 'api', '--commit', 'c2']);
  assert.equal(up.status, 0, up.stderr);
  const after = readJson(out);
  assert.equal(validate(after).ok, true, JSON.stringify(validate(after).findings));
  assert.deepEqual(ids(after.nodes), ids(before.nodes));
  assert.deepEqual(after.nodes, before.nodes, 'the area\'s previous nodes survive unchanged');
  assert.deepEqual(after.edges, before.edges);
  assert.deepEqual(after.entities, before.entities);
  assert.deepEqual(after.access, before.access);
  assert.deepEqual(after.meta.coverage.api, before.meta.coverage.api);
  const row = after.meta.sources.find((s) => s.area === 'api' && s.skipped && s.skipped.count >= 1);
  assert.ok(row, JSON.stringify(after.meta.sources));
  assert.match(row.skipped.reasons.join(' '), /api\.json unreadable/);
  assert.match(up.stderr, /api/);
  assert.match(up.stderr, /kept/i);
  // the same through merge(): the stub fragment of an unreadable file is a conflict, not an empty area
  const stub = { area: 'api', unreadable: true, skipped: { count: 1, reasons: ['api.json unreadable: x'] } };
  const res = merge({ fragments: [stub], previous: before, areas: ['api'], meta: {} });
  assert.deepEqual(res.model.nodes, before.nodes);
  assert.ok(res.conflicts.some((c) => /api/.test(JSON.stringify(c)) && /kept/i.test(JSON.stringify(c))), JSON.stringify(res.conflicts));
});

test('m29 in update mode an edge from a re-explored area to area:<id> of an unaffected area lands on that area\'s level-2 node of the previous model, with no dropped-ref row', () => {
  const first = merge({
    fragments: [
      frag('web', { nodes: [node('web-app', { zone: 'z', kind: 'app', paths: ['web/**'] })] }),
      frag('api', { nodes: [
        node('api-db', { zone: 'z', kind: 'store', paths: ['api/db/**'] }),
        node('api-handler', { zone: 'z', kind: 'service', level: 3, paths: ['api/h/**'] }),
        node('api-svc', { zone: 'z', kind: 'service', paths: ['api/**'] }),
      ] }),
    ],
    meta: META,
  }).model;
  const web = frag('web', {
    nodes: [node('web-app', { zone: 'z', kind: 'app', paths: ['web/**'] })],
    edges: [
      { id: 'w-to-api', from: 'web-app', to: 'area:api', type: 'api', desc: 'calls the api', evidence: ev('x/web.js', '3-4'), confidence: 'inferred' },
      { id: 'api-to-w', from: 'api', to: 'web-app', type: 'call', desc: 'pushes', evidence: ev('x/web.js', '5-6'), confidence: 'inferred' },
    ],
  });
  const { model } = merge({ fragments: [web], previous: first, areas: ['web'], meta: {} });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const e = (id) => model.edges.find((x) => x.id === id);
  assert.ok(e('w-to-api'), JSON.stringify(model.edges));
  assert.equal(e('w-to-api').to, 'api-svc');
  assert.equal(e('api-to-w').from, 'api-svc');
  assert.deepEqual(model.meta.sources.filter((s) => s.type === 'dropped-ref'), []);
});

test('m27b an import edge whose line names the module only by its file name is inferred; a relative specifier or dotted path that resolves to the file stays verified', () => {
  const repo = tmp();
  mkdirSync(join(repo, 'worker'), { recursive: true });
  writeFileSync(join(repo, 'worker', 'a.js'), "// worker a\nimport { Order } from '../api/models.js';\n");
  writeFileSync(join(repo, 'worker', 'b.js'), "const models = require('models');\n");
  writeFileSync(join(repo, 'worker', 'c.py'), 'import os\nfrom models import Thing\nfrom lib.util.models import Other\n');
  const fragments = [
    frag('worker', { nodes: [node('worker-svc', { zone: 'svc', paths: ['worker/**'], evidence: ev('worker/a.js') })] }),
    frag('api', { nodes: [node('api-svc', { zone: 'svc', paths: ['api/**'], evidence: ev('api/models.js') })] }),
    frag('lib', { nodes: [node('lib-mod', { zone: 'svc', kind: 'module', paths: ['lib/**'], evidence: ev('lib/models.js') })] }),
    frag('util', { nodes: [node('util-mod', { zone: 'svc', kind: 'module', paths: ['util/**'], evidence: ev('util/models.py') })] }),
  ];
  const imp = (from, to, other) => ({ kind: 'import', dir: 'out', from, to, other });
  const slices = [{
    area: 'worker', stacks: [], links: [
      imp('worker/a.js', 'api/models.js', 'api'), imp('worker/b.js', 'lib/models.js', 'lib'), imp('worker/c.py', 'util/models.py', 'util'),
    ],
  }];
  const { model } = merge({ fragments, extracts: slices, repo, meta: META });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const one = (to) => {
    const es = edgeOf(model, 'worker-svc', to, 'call');
    assert.equal(es.length, 1, JSON.stringify(model.edges));
    return es[0];
  };
  assert.equal(one('api-svc').confidence, 'verified');
  assert.deepEqual(one('api-svc').evidence, [{ path: 'worker/a.js', lines: '2' }]);
  assert.equal(one('lib-mod').confidence, 'inferred');
  assert.match(one('lib-mod').desc, /file name only/);
  // `from models import` names a different module of that file name; `lib.util.models` is not util/models.py either
  assert.equal(one('util-mod').confidence, 'inferred');
  assert.deepEqual(one('util-mod').evidence, [{ path: 'worker/c.py', lines: '2' }]);
  rmSync(repo, { recursive: true, force: true });
});

// P8.7: update mode with the files the commit changed. Inside an affected area an element whose evidence files are all
// unchanged is the previous model's, byte for byte; only what the change touched takes the fragment's version.
const carryPrev = () => merge({
  fragments: [
    frag('web', { nodes: [node('web-app', { zone: 'z', kind: 'app', paths: ['web/**'], evidence: ev('web/app.js') })] }),
    frag('api', {
      nodes: [
        node('api-svc', { zone: 'z', paths: ['api/**'], role: 'serves orders', desc: 'the orders api', evidence: ev('api/svc.js', '1-20') }),
        node('api-db', { zone: 'z', kind: 'store', paths: ['api/db/**'], evidence: ev('api/db/schema.sql', '1-9') }),
        node('api-fixture-store', { zone: 'z', kind: 'store', level: 3, paths: ['api/fixtures/**'], evidence: ev('api/fixtures/seed.sql', '1-4') }),
        node('api-handler', { zone: 'z', level: 3, paths: ['api/h/**'], title: 'Handler', evidence: ev('api/h/handler.js', '1-5') }),
        node('api-old', { zone: 'z', level: 3, paths: ['api/old/**'], evidence: ev('api/old/legacy.js', '1-3') }),
      ],
      edges: [
        { id: 'svc-reads-db', from: 'api-svc', to: 'api-db', type: 'sql', desc: 'reads orders', evidence: ev('api/svc.js', '4-6'), confidence: 'verified' },
        { id: 'handler-calls-svc', from: 'api-handler', to: 'api-svc', type: 'call', desc: 'calls', evidence: ev('api/h/handler.js', '2-3'), confidence: 'verified' },
      ],
      entities: [
        { id: 'orders', store: 'api-db', name: 'orders', kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }], evidence: ev('api/db/schema.sql', '2-5') },
        { id: 'seed-rows', store: 'api-fixture-store', name: 'seed_rows', kind: 'table', fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }], evidence: ev('api/fixtures/seed.sql', '1-4') },
      ],
    }),
  ],
  meta: META,
}).model;
// the re-explored api area: api-svc spelled differently, the two stores and both entities left out, the changed handler
// re-described, a new node in a new file, and api-old (whose file changed) not emitted again
const carryFrag = () => frag('api', {
  nodes: [
    node('api-svc', { zone: 'z', paths: ['api/**'], role: 'handles orders and more', desc: 'reworded', evidence: ev('api/svc.js', '1-31') }),
    node('api-handler', { zone: 'z', level: 3, paths: ['api/h/**'], title: 'Handler v2', evidence: ev('api/h/handler.js', '1-8') }),
    node('api-extra', { zone: 'z', level: 3, paths: ['api/h/extra/**'], evidence: ev('api/h/extra.js', '1-2') }),
  ],
  edges: [
    { id: 'svc-reads-db', from: 'api-svc', to: 'api-db', type: 'sql', desc: 'reads the orders table', evidence: ev('api/svc.js', '4-9'), confidence: 'verified' },
    { id: 'handler-calls-svc', from: 'api-handler', to: 'api-svc', type: 'call', desc: 'calls the service', evidence: ev('api/h/handler.js', '2-7'), confidence: 'verified' },
  ],
});
const CHANGED = ['api/h/handler.js', 'api/h/extra.js', 'api/old/legacy.js'];
const json = (x) => JSON.stringify(x);

test('m30 update with --changed: an element of the affected area whose evidence files are all unchanged is carried over byte-identical, spelt differently or left out; a changed one takes the fragment; a new id is added; a dropped changed one is removed with a row', () => {
  const first = carryPrev();
  const { model } = merge({ fragments: [carryFrag()], previous: first, areas: ['api'], changed: CHANGED, meta: { commit: 'c2' } });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  const n = (m, id) => m.nodes.find((x) => x.id === id);
  const e = (m, id) => m.edges.find((x) => x.id === id);
  const en = (m, id) => m.entities.find((x) => x.id === id);
  // carried: spelt differently by the fragment (evidence lines, role, desc) and left out by it
  for (const id of ['api-svc', 'api-db', 'api-fixture-store']) assert.equal(json(n(model, id)), json(n(first, id)), `node ${id} carried byte-identical`);
  assert.equal(json(e(model, 'svc-reads-db')), json(e(first, 'svc-reads-db')), 'edge carried byte-identical');
  for (const id of ['orders', 'seed-rows']) assert.equal(json(en(model, id)), json(en(first, id)), `entity ${id} carried byte-identical`);
  // entities homed on a carried store keep its id, and no sibling store is invented
  assert.equal(en(model, 'seed-rows').store, 'api-fixture-store');
  assert.equal(en(model, 'orders').store, 'api-db');
  assert.equal(model.nodes.some((x) => /-2$/.test(x.id)), false, JSON.stringify(ids(model.nodes)));
  // evidence in a changed file: the fragment's version
  assert.equal(n(model, 'api-handler').title, 'Handler v2');
  assert.deepEqual(n(model, 'api-handler').evidence, ev('api/h/handler.js', '1-8'));
  assert.equal(e(model, 'handler-calls-svc').desc, 'calls the service');
  // a new id is added
  assert.ok(n(model, 'api-extra'), JSON.stringify(ids(model.nodes)));
  // dropped by the fragment, its file changed: removed, with a row naming it
  assert.equal(n(model, 'api-old'), undefined);
  assert.ok(model.meta.sources.some((s) => s.id === 'api-old' && /dropped/.test(s.type)), JSON.stringify(model.meta.sources));
  // the unaffected area is untouched, as before
  assert.equal(json(n(model, 'web-app')), json(n(first, 'web-app')));
  // the derivation row counts the carried elements: 3 nodes, 1 edge, 2 entities
  const row = model.meta.sources.find((s) => s.type === 'derivation');
  assert.ok(row, JSON.stringify(model.meta.sources));
  assert.equal(row.derived.carried, 6, JSON.stringify(row));
  assert.match(row.note, /6 carried/);
  // deterministic
  assert.equal(json(merge({ fragments: [carryFrag()], previous: first, areas: ['api'], changed: [...CHANGED].reverse(), meta: { commit: 'c2' } }).model), json(model));
});

test('m30b without --changed update mode stays as it was: the affected area is the fragment\'s, wholesale', () => {
  const first = carryPrev();
  const { model } = merge({ fragments: [carryFrag()], previous: first, areas: ['api'], meta: { commit: 'c2' } });
  const svc = model.nodes.find((x) => x.id === 'api-svc');
  assert.deepEqual(svc.evidence, ev('api/svc.js', '1-31'), 'the fragment\'s spelling');
  assert.equal(model.nodes.some((x) => x.id === 'api-fixture-store'), false, 'left out by the fragment, gone');
  const row = model.meta.sources.find((s) => s.type === 'derivation');
  assert.equal(row ? row.derived.carried ?? 0 : 0, 0);
});

test('m30c stores the re-explored fragment leaves out are carried when their files did not change: the extract-made entities keep their store ids and no store is made in their place', () => {
  const tables = [{ area: 'pkg', stacks: [], links: [], queues: [], tables: [
    { name: 'events', table: 'events', orm: 'sql', fields: ['id serial pk'], file: 'pkg/fixtures/a.sql', line: 1, lines: '1-3' },
    { name: 'audits', table: 'audits', orm: 'sql', fields: ['id serial pk'], file: 'pkg/fixtures/b.sql', line: 1, lines: '1-3' },
    { name: 'jobs', table: 'jobs', orm: 'drizzle', fields: ['id serial pk'], file: 'pkg/db.ts', line: 1, lines: '1-3' },
  ] }];
  const store = (id, file) => node(id, { zone: 'data', kind: 'store', level: 3, paths: [file], evidence: ev(file, '1-3') });
  const svc = (title) => node('pkg-svc', { zone: 'svc', paths: ['pkg/**'], title, evidence: ev('pkg/svc.ts') });
  const first = merge({ fragments: [frag('pkg', { nodes: [svc('Pkg'), store('fixture-a', 'pkg/fixtures/a.sql'), store('fixture-b', 'pkg/fixtures/b.sql')] })], extracts: tables, meta: META }).model;
  const storeOf = (m, name) => m.entities.find((x) => x.name === name).store;
  assert.deepEqual([storeOf(first, 'events'), storeOf(first, 'audits')], ['fixture-a', 'fixture-b']);
  // the re-explored fragment describes the changed service only and leaves both fixture stores out
  const { model } = merge({ fragments: [frag('pkg', { nodes: [svc('Pkg v2')] })], extracts: tables, previous: first, areas: ['pkg'], changed: ['pkg/svc.ts'], meta: { commit: 'c2' } });
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  for (const id of ['fixture-a', 'fixture-b']) {
    assert.equal(json(model.nodes.find((x) => x.id === id)), json(first.nodes.find((x) => x.id === id)), `store ${id} carried byte-identical`);
  }
  assert.deepEqual([storeOf(model, 'events'), storeOf(model, 'audits')], ['fixture-a', 'fixture-b'], 'the entities keep their store ids');
  assert.equal(json(model.entities), json(first.entities));
  assert.deepEqual(ids(model.nodes), ids(first.nodes), 'no store made in place of a carried one');
  assert.equal(model.nodes.find((x) => x.id === 'pkg-svc').title, 'Pkg v2');
});

test('m30d through the CLI --changed takes the diffmap report: its files list is the changed set', () => {
  const dir = tmp();
  const prevPath = join(dir, 'prev.json');
  writeFileSync(prevPath, JSON.stringify(carryPrev()));
  mkdirSync(join(dir, 'fragments'));
  writeFileSync(join(dir, 'fragments', 'api.json'), JSON.stringify(carryFrag()));
  const report = join(dir, 'diffmap.json');
  writeFileSync(report, JSON.stringify({ base: 'a', head: 'b', behind: 1, files: CHANGED, areas: ['api'], nodes: [], dependents: [], entities: [], sequences: [], uncovered: [] }));
  const out = join(dir, 'model.json');
  const r = cli([join(dir, 'fragments'), '--out', out, '--previous', prevPath, '--areas', 'api', '--changed', report, '--commit', 'c2']);
  assert.equal(r.status, 0, r.stderr);
  const m = readJson(out);
  const first = readJson(prevPath);
  assert.equal(json(m.nodes.find((x) => x.id === 'api-svc')), json(first.nodes.find((x) => x.id === 'api-svc')));
  assert.equal(m.meta.sources.find((s) => s.type === 'derivation').derived.carried, 6);
  assert.equal(cli([join(dir, 'fragments'), '--out', out, '--previous', prevPath, '--areas', 'api', '--changed', join(dir, 'nope.json')]).status, 2, 'an unreadable report is a usage error');
  rmSync(dir, { recursive: true, force: true });
});

test('m30e update with --changed: an entity with no evidence is never carried, so the re-explored fragment\'s version wins and one the fragment leaves out is gone; an element with evidence in unchanged files is still carried', () => {
  const field = (name, type = 'int') => ({ name, type, provenance: 'declared' });
  const svc = (title, lines) => node('api-svc', { zone: 'z', paths: ['api/**'], title, evidence: ev('api/svc.js', lines) });
  const db = node('api-db', { zone: 'z', kind: 'store', paths: ['api/db/**'], evidence: ev('api/db/schema.sql') });
  const bare = (id, fields) => ({ id, store: 'api-db', name: id, kind: 'table', fields });
  const first = merge({
    fragments: [frag('api', { nodes: [svc('Svc', '1-2'), db], entities: [bare('orders', [field('id')]), bare('notes', [field('id')])] })],
    meta: META,
  }).model;
  const en = (m, id) => m.entities.find((x) => x.id === id);
  assert.ok(en(first, 'orders') && en(first, 'orders').evidence === undefined, `the previous model holds an entity with no evidence: ${json(first.entities)}`);
  // the re-explored fragment re-describes orders with a new field, leaves notes and the store out; only svc.js changed
  const again = frag('api', { nodes: [svc('Svc v2', '1-9')], entities: [bare('orders', [field('id'), field('total', 'numeric')])] });
  const run = (changed) => merge({ fragments: [again], previous: first, areas: ['api'], changed, meta: { commit: 'c2' } }).model;
  const model = run(['api/svc.js']);
  assert.equal(validate(model).ok, true, JSON.stringify(validate(model).findings));
  assert.deepEqual(en(model, 'orders').fields.map((f) => f.name), ['id', 'total'], `no evidence, so the fragment's version: ${json(en(model, 'orders'))}`);
  assert.equal(en(model, 'notes'), undefined, 'no evidence and left out by the fragment: not carried forever');
  // with evidence, all of it unchanged: carried byte-identical, as before
  assert.equal(json(model.nodes.find((x) => x.id === 'api-db')), json(first.nodes.find((x) => x.id === 'api-db')));
  assert.equal(model.nodes.find((x) => x.id === 'api-svc').title, 'Svc v2');
  const row = model.meta.sources.find((s) => s.type === 'derivation');
  assert.equal(row && row.derived.carried, 1, `only the store is carried: ${json(model.meta.sources)}`);
  // an empty changed set does not make an evidence-less entity untouched either
  assert.deepEqual(en(run([]), 'orders').fields.map((f) => f.name), ['id', 'total']);
  assert.equal(json(run(['api/svc.js'])), json(model), 'deterministic');
});
