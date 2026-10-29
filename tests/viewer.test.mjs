import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (v1, v2, ...) lead every title so the suite prints them first.
// The viewer's pure functions (path finder, ER markup, CRUD matrix, evidence links, search, lineage) are
// loaded from the viewer.js INSIDE the rendered golden HTML, so what is tested is what ships. viewer.js
// hands them to `module.exports` when it runs without a `document`; nothing else of it runs then.
const GOLDEN = fileURLToPath(new URL('./fixtures/golden/', import.meta.url));
const model = JSON.parse(readFileSync(join(GOLDEN, 'architecture.model.json'), 'utf8'));
const issues = JSON.parse(readFileSync(join(GOLDEN, 'issues.json'), 'utf8'));

const { layoutModel } = await import('../scripts/layout.mjs');
const { renderHtml } = await import('../scripts/render.mjs');
const layout = await layoutModel(model);

const clean = renderHtml({ model, layout, mode: 'clean' });
const internal = renderHtml({ model, layout, issues, mode: 'internal' });

function viewerOf(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/application\/json/.test(m[1]));
  assert.equal(scripts.length, 1, 'expected exactly one inline viewer script');
  const mod = { exports: {} };
  new Function('module', scripts[0][2])(mod);
  return mod.exports;
}
const V = viewerOf(clean);

test('v1 the rendered golden HTML has tabs and panels for graph, ER, CRUD, sequences, deployment and trust (Issues tab in issue builds only)', () => {
  const tabsOf = (html) => [...html.matchAll(/<button\b[^>]*\brole="tab"[^>]*\bdata-tab="([a-z]+)"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(tabsOf(clean), ['graph', 'er', 'crud', 'sequences', 'deployment', 'trust']);
  assert.deepEqual(tabsOf(internal), ['graph', 'er', 'crud', 'sequences', 'deployment', 'trust', 'issues']);
  const panel = { graph: 'architecture', er: 'er', crud: 'crud', sequences: 'sequences', deployment: 'deployment', trust: 'trust', issues: 'issues' };
  for (const [tab, id] of Object.entries(panel)) {
    const html = tab === 'issues' ? internal : clean;
    assert.match(html, new RegExp(`<section\\b[^>]*\\bid="${id}"[^>]*\\brole="tabpanel"`), `no panel #${id} for tab ${tab}`);
    assert.match(html, new RegExp(`data-tab="${tab}"[^>]*aria-controls="${id}"`), `tab ${tab} does not control #${id}`);
  }
  assert.doesNotMatch(clean, /id="issues"/, 'a clean build carries the Issues panel');
  // The Issues switch is internal-only; the search box and the path finder are in every build.
  for (const html of [clean, internal]) {
    assert.match(html, /id="q"/, 'no search box');
    assert.match(html, /id="pf-from"/, 'no path finder');
  }
  // The golden model has a release view and a trust view for the Deployment and Trust tabs.
  assert.deepEqual(model.views.map((v) => V.viewRole(v)).sort(), ['deployment', 'graph', 'graph', 'graph', 'graph', 'trust']);
});

test('v2 the ER tab lists every golden entity with PK and FK markers and provenance classes (fields, relations, entities)', () => {
  const mk = V.erMarkup(model, layout.er);
  const ents = mk.inner.split('<g class="ent ').slice(1);
  assert.equal(ents.length, model.entities.length, 'one card per entity');
  const relationSources = new Set(model.relations.map((r) => `${r.from.entity}.${r.from.field}`));
  for (const e of model.entities) {
    const block = ents.find((b) => b.includes(`data-entity="${e.id}"`));
    assert.ok(block, `entity ${e.id} is not drawn`);
    const provs = new Set(e.fields.map((f) => f.provenance));
    const want = provs.size === 1 ? [...provs][0] : 'mixed';
    assert.match(block, /^prov-(declared|observed|inferred|mixed)\b/, `${e.id}: no entity provenance class`);
    assert.ok(block.startsWith(`prov-${want}`), `${e.id}: entity class is not prov-${want}`);
    const fields = block.split('<g class="fld ').slice(1);
    assert.equal(fields.length, e.fields.length, `${e.id}: one row per field`);
    for (const f of e.fields) {
      const row = fields.find((r) => r.includes(`data-field="${f.name}"`));
      assert.ok(row, `${e.id}.${f.name} has no row`);
      const cls = row.slice(0, row.indexOf('"')).split(' ');
      assert.ok(cls.includes(`prov-${f.provenance}`), `${e.id}.${f.name}: no prov-${f.provenance} class (${cls})`);
      assert.equal(cls.includes('pk'), f.pk === true, `${e.id}.${f.name}: pk class`);
      const isFk = f.fk !== undefined || relationSources.has(`${e.id}.${f.name}`);
      assert.equal(cls.includes('fk'), isFk, `${e.id}.${f.name}: fk class`);
      assert.equal(/>PK<\/text>/.test(row), f.pk === true, `${e.id}.${f.name}: PK marker`);
      assert.equal(/>FK<\/text>/.test(row), isFk, `${e.id}.${f.name}: FK marker`);
    }
  }
  // Every observed and inferred provenance of the golden fields is drawn as such.
  for (const p of ['observed', 'inferred']) assert.ok(mk.inner.includes(`fld prov-${p}`), `no ${p} field drawn`);
  // Relations: one per model relation, carrying its provenance, with a crow's foot per many end.
  const rels = mk.inner.split('<g class="rel ').slice(1);
  assert.equal(rels.length, model.relations.length);
  for (const [i, r] of model.relations.entries()) assert.match(rels[i], new RegExp(`^prov-${r.provenance} kind-${r.kind}`));
  assert.deepEqual(V.manyEnds('1-n'), { from: true, to: false });
  assert.deepEqual(V.manyEnds('n-m'), { from: true, to: true });
  assert.deepEqual(V.manyEnds('1-1'), { from: false, to: false });
  const foot = V.crowFoot([100, 50], [140, 50], true);
  assert.match(foot, /^M112,56 L100,50 L112,44$/, 'three-pronged foot at the end point');
  assert.match(V.crowFoot([100, 50], [140, 50], false), /^M110,56 L110,44$/, 'a bar for one');
  // The scene has no NaN anywhere: every coordinate of the markup is finite.
  assert.doesNotMatch(mk.inner, /NaN|undefined|Infinity/);
});

test('v3 the CRUD matrix has one cell per golden access row, carrying its node, entity and ops, and click-through headers', () => {
  const html = V.crudHtml(model);
  const cells = [...html.matchAll(/<td class="cell" data-node="([^"]+)" data-entity="([^"]+)" data-ops="([A-Z]+)">/g)].map((m) => ({ node: m[1], entity: m[2], ops: m[3] }));
  assert.equal(cells.length, model.access.length, 'one cell per access row');
  for (const a of model.access) {
    const c = cells.find((x) => x.node === a.node && x.entity === a.entity);
    assert.ok(c, `no cell for ${a.node} on ${a.entity}`);
    assert.equal(c.ops, a.ops, `${a.node} on ${a.entity}: ops`);
    const held = [...html.matchAll(new RegExp(`data-node="${a.node}" data-entity="${a.entity}"[^>]*>(.*?)</td>`, 'g'))][0][1];
    for (const l of 'CRUD') assert.equal(held.includes(`op-${l.toLowerCase()}">${l}<`), a.ops.includes(l), `${a.node} on ${a.entity}: letter ${l}`);
  }
  // Columns are all entities, rows the nodes with access rows; both are buttons that open the node or entity.
  for (const e of model.entities) assert.ok(html.includes(`<button class="lnk" data-entity="${e.id}">`), `no column button for ${e.id}`);
  for (const n of new Set(model.access.map((a) => a.node))) assert.ok(html.includes(`<button class="lnk" data-node="${n}">`), `no row button for ${n}`);
  assert.equal([...html.matchAll(/<tr><th scope="row">/g)].length, new Set(model.access.map((a) => a.node)).size);
  // A pair named twice is one cell with the union of its ops.
  const dup = { ...model, access: [{ node: 'order-service', entity: 'orders', ops: 'R', evidence: [] }, { node: 'order-service', entity: 'orders', ops: 'UC', evidence: [] }] };
  assert.equal(V.crudMatrix(dup).cells.get('order-service\u0000orders').ops, 'CRU');
});

test('v4 evidence chips link to repoUrl/blob/<commit>/<path>#L<start>-L<end> and degrade to plain code without a repo', () => {
  const { repoUrl, commit } = model.meta;
  const all = [...model.nodes, ...model.edges, ...model.entities].flatMap((x) => x.evidence);
  assert.ok(all.length > 10);
  for (const ev of all) {
    const [a, b] = ev.lines.split('-');
    const want = `${repoUrl}/blob/${commit}/${ev.path}#L${a}${b ? `-L${b}` : ''}`;
    assert.equal(V.evidenceUrl(model.meta, ev.path, ev.lines), want);
    const chip = V.evidenceChipHtml(model.meta, ev.path, ev.lines);
    assert.ok(chip.includes(`href="${want}"`), `chip has no href ${want}: ${chip}`);
    assert.match(chip, /rel="noopener noreferrer"/);
    assert.ok(chip.includes(`${ev.path}:${ev.lines}`), 'chip text is path:lines');
  }
  assert.equal(V.evidenceUrl(model.meta, 'a/b.py', '7'), `${repoUrl}/blob/${commit}/a/b.py#L7`);
  assert.equal(V.evidenceUrl({ ...model.meta, repoUrl: `${repoUrl}///` }, 'a b/c#d.py', '1-2'), `${repoUrl}/blob/${commit}/a%20b/c%23d.py#L1-L2`, 'trailing slashes dropped, path segments encoded');
  for (const meta of [{ commit }, { repoUrl }, { repoUrl: 'javascript:alert(1)', commit }, { repoUrl: 'not a url', commit }]) {
    assert.equal(V.evidenceUrl(meta, 'a.py', '1-2'), null, `link built for ${JSON.stringify(meta)}`);
    assert.equal(V.evidenceChipHtml(meta, 'a.py', '1-2'), '<code>a.py:1-2</code>');
  }
  assert.doesNotMatch(V.evidenceChipHtml(model.meta, '"><img src=x>', '1-2'), /<img/, 'path is escaped');
  // The viewer script itself names no URL: links are built from the embedded repoUrl only.
  assert.doesNotMatch(clean.replace(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g, ''), /https?:\/\//);
});

test('v5 the BFS path finder returns the shortest node path on the golden graph, with the edges it walked', () => {
  const ids = model.nodes.map((n) => n.id);
  // Independent reference: Floyd-Warshall hop counts over the undirected graph.
  const dist = new Map(ids.map((a) => [a, new Map(ids.map((b) => [b, a === b ? 0 : Infinity]))]));
  for (const e of model.edges) { dist.get(e.from).set(e.to, 1); dist.get(e.to).set(e.from, 1); }
  for (const k of ids) for (const i of ids) for (const j of ids) {
    const d = dist.get(i).get(k) + dist.get(k).get(j);
    if (d < dist.get(i).get(j)) dist.get(i).set(j, d);
  }
  let checked = 0;
  for (const a of ids) for (const b of ids) {
    const want = dist.get(a).get(b);
    const got = V.findPath(model.edges, a, b);
    if (want === Infinity) { assert.equal(got, null, `${a} to ${b} is not connected`); continue; }
    assert.ok(got, `no path ${a} to ${b}`);
    assert.equal(got.nodes[0], a); assert.equal(got.nodes.at(-1), b);
    assert.equal(got.nodes.length, want + 1, `${a} to ${b}: not the shortest (${got.nodes.length - 1} vs ${want} hops)`);
    assert.equal(got.edges.length, want);
    got.nodes.slice(1).forEach((n, i) => {
      const e = model.edges.find((x) => x.id === got.edges[i]);
      assert.ok(e, `edge ${got.edges[i]} is not in the model`);
      assert.ok((e.from === got.nodes[i] && e.to === n) || (e.to === got.nodes[i] && e.from === n), `edge ${e.id} does not join ${got.nodes[i]} and ${n}`);
    });
    checked++;
  }
  assert.ok(checked > ids.length * 10, 'the golden graph is mostly connected');
  assert.ok(dist.get('web-app').get('ops-db') >= 3, 'the golden pair is several hops apart');
  assert.deepEqual(V.findPath(model.edges, 'web-app', 'web-app'), { nodes: ['web-app'], edges: [] });
  assert.equal(V.findPath(model.edges, 'web-app', 'no-such-node'), null);
  // Directed mode follows the arrows only; a pure caller cannot be reached from its callee.
  assert.equal(V.findPath(model.edges, 'ops-db', 'web-app', { directed: true }), null);
  const fwd = V.findPath(model.edges, 'web-app', 'token-guard', { directed: true });
  assert.deepEqual(fwd && fwd.nodes, ['web-app', 'ingress-gw', 'token-guard'], 'the caller reaches the guard along the arrows');
  fwd.edges.forEach((id, i) => { const e = model.edges.find((x) => x.id === id); assert.equal(e.from, fwd.nodes[i]); assert.equal(e.to, fwd.nodes[i + 1]); });
  // Deterministic: the same call gives the same path.
  assert.deepEqual(V.findPath(model.edges, 'web-app', 'ops-db'), V.findPath(model.edges, 'web-app', 'ops-db'));
});

test('v6 search covers nodes, edges, entities and sequences; lineage runs from an entity through access rows and edges; trust crossings follow the outside flag', () => {
  const kinds = (q) => new Set(V.searchModel(model, q, 50).map((h) => h.kind));
  assert.ok(V.searchModel(model, 'orders', 50).some((h) => h.kind === 'entity' && h.id === 'orders'));
  assert.ok(kinds('orders').has('node') || kinds('orders').has('edge'));
  const seq = model.sequences[0];
  assert.ok(V.searchModel(model, seq.title, 5).some((h) => h.kind === 'sequence' && h.id === seq.id), 'sequence found by title');
  const edge = model.edges.find((e) => e.label);
  assert.ok(V.searchModel(model, edge.label, 50).some((h) => h.kind === 'edge' && h.id === edge.id), 'edge found by label');
  const node = model.nodes[0];
  assert.ok(V.searchModel(model, node.title.toUpperCase(), 50).some((h) => h.kind === 'node' && h.id === node.id), 'case-insensitive');
  assert.deepEqual(V.searchModel(model, '   ', 5), []);
  assert.deepEqual(V.searchModel(model, 'zzzz-nothing-matches', 5), []);
  assert.equal(V.searchModel(model, 'a', 3).length, 3, 'limit honoured');

  const lin = V.lineageOf(model, 'shipments', 2);
  const accessors = model.access.filter((a) => a.entity === 'shipments').map((a) => a.node);
  assert.equal(lin.store, model.entities.find((e) => e.id === 'shipments').store);
  for (const n of [lin.store, ...accessors]) assert.ok(lin.nodes.includes(n), `lineage lacks ${n}`);
  for (const id of lin.edges) {
    const e = model.edges.find((x) => x.id === id);
    assert.ok(lin.nodes.includes(e.from) && lin.nodes.includes(e.to), `lineage edge ${id} leaves the lineage nodes`);
  }
  assert.ok(lin.nodes.length > accessors.length + 1, 'callers upstream of the accessors are included');
  assert.equal(V.lineageOf(model, 'no-such-entity'), null);
  assert.ok(V.lineageOf(model, 'shipments', 0).nodes.length <= lin.nodes.length);

  const zoneById = Object.fromEntries(model.zones.map((z) => [z.id, z]));
  assert.equal(V.crossesTrust('zb-web', 'zg-ingress', zoneById), true, 'inside to outside crosses');
  assert.equal(V.crossesTrust('zs-api', 'zs-worker', zoneById), false, 'same root zone does not');
  assert.equal(V.crossesTrust('zs-api', 'zd-stores', zoneById), false, 'two inside zones do not');
  const rects = Object.fromEntries(model.zones.map((z) => [z.id, layout.graph.zones[z.id]]));
  const tb = V.trustBoundaries(model.zones, rects, zoneById);
  assert.equal(tb.length, model.zones.filter((z) => z.parent === undefined).length, 'one enclosure per top-level zone');
  assert.deepEqual(tb.filter((b) => !b.trusted).map((b) => b.zone).sort(), model.zones.filter((z) => z.outside).map((z) => z.id).sort());
});

test('v7 a view picks its renderer from kind when present, and falls back to the id/title name regex without kind', () => {
  // A neutral id and title: only kind can say which renderer this is.
  assert.equal(V.viewRole({ id: 'zones-overview', title: 'Zones overview', kind: 'trust' }), 'trust');
  assert.equal(V.viewRole({ id: 'zones-overview', title: 'Zones overview', kind: 'deployment' }), 'deployment');
  assert.equal(V.viewRole({ id: 'zones-overview', title: 'Zones overview', kind: 'graph' }), 'graph');
  // kind wins over a name that would match the regex.
  assert.equal(V.viewRole({ id: 'trust-boundaries', title: 'Trust boundaries', kind: 'graph' }), 'graph');
  assert.equal(V.viewRole({ id: 'release-plan', title: 'Release', kind: 'trust' }), 'trust');
  // Without kind the regex fallback is unchanged.
  assert.equal(V.viewRole({ id: 'trust-boundaries', title: 'Boundaries' }), 'trust');
  assert.equal(V.viewRole({ id: 'release', title: 'Release topology' }), 'deployment');
  assert.equal(V.viewRole({ id: 'zones-overview', title: 'Zones overview' }), 'graph');
});
