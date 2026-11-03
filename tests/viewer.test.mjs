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

function viewerScriptOf(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/application\/json/.test(m[1]));
  assert.equal(scripts.length, 1, 'expected exactly one inline viewer script');
  return scripts[0][2];
}
function viewerOf(html) {
  const mod = { exports: {} };
  new Function('module', viewerScriptOf(html))(mod);
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

test('v8 a figure that would fit below the legibility floor opens at the floor (scrolling), one that fits above it opens fitted, and Fit stays available', () => {
  const floor = V.FIG_MIN_SCALE;
  // The floor comes from a minimum drawn font, not a fixed 0.5: the smallest svg text at the floor is still readable.
  assert.ok(V.MIN_FONT_PX >= 8 && V.MIN_FONT_PX <= 9, `the minimum drawn font is about 8-9 px (got ${V.MIN_FONT_PX})`);
  assert.ok(floor * V.SMALLEST_FIG_FONT >= V.MIN_FONT_PX - 1e-9, `floor ${floor} x smallest font ${V.SMALLEST_FIG_FONT} is below ${V.MIN_FONT_PX} px`);
  assert.ok(floor >= 0.85 && floor <= 0.95, `the legibility floor is about 0.85-0.95 (got ${floor})`);
  // SMALLEST_FIG_FONT is honest: no svg text rule in viewer.css draws smaller than it.
  const css = readFileSync(fileURLToPath(new URL('../assets/viewer/viewer.css', import.meta.url)), 'utf8');
  const svgText = /\.(?:node \.(?:nt|ns)|elabel text|msg \.(?:mt|numt)|participant \.(?:pt|ps)|bdt|frag text|note text)\{[^}]*font-size:([\d.]+)px/g;
  const sizes = [...css.matchAll(svgText)].map((m) => Number(m[1]));
  assert.ok(sizes.length >= 8, `found the svg text size rules (got ${sizes.length})`);
  assert.ok(Math.min(...sizes) >= V.SMALLEST_FIG_FONT, `an svg text rule draws at ${Math.min(...sizes)} user units, below ${V.SMALLEST_FIG_FONT}`);
  // A wide figure in a 400 px container: whole-drawing fit would be 400/1600 = 0.25, below the floor.
  const wide = V.figureScale(1600, 400);
  assert.equal(wide.fit, 0.25, 'the fit scale is still computed');
  assert.ok(wide.scale >= floor, `opens at ${wide.scale}, below the floor ${floor}`);
  assert.equal(wide.scale, floor);
  assert.equal(wide.scrolls, true, 'the floor scale needs sideways scrolling');
  assert.equal(wide.fitted, false);
  // Across many narrow widths the opening scale is never below the floor.
  for (const w of [200, 320, 400, 480, 600]) for (const nat of [900, 1200, 1600, 2400]) {
    assert.ok(V.figureScale(nat, w).scale >= floor, `${nat} in ${w}: below the floor`);
  }
  // A figure that fits above the floor still opens fitted, with no scrolling.
  const ok = V.figureScale(420, 400);
  assert.equal(ok.scale, 400 / 420);
  assert.equal(ok.fitted, true);
  assert.equal(ok.scrolls, false);
  // A figure narrower than its container is never enlarged.
  assert.equal(V.figureScale(300, 400).scale, 1);
  assert.equal(V.figureScale(300, 400).scrolls, false);
  // Fit stays available: the Fit scale is the true fit, and the Fit button is built for every figure.
  assert.equal(V.figureScale(1600, 400).fit, 0.25);
  assert.match(clean, /\["fit", "Fit"\]/, 'the Fit button is still built by the viewer script');
});

// ---------------------------------------------------------------------------------------------
// P13.11: the flow player. A sequence whose participants carry `node` can be played on the architecture graph: one
// frame per message, the two nodes and the edge between them lit, the rest dimmed. The pure parts are tested here;
// the DOM glue only calls them.

const seqOf = (id) => model.sequences.find((s) => s.id === id);
const placeOrder = seqOf('place-order');
const messages = (s) => s.steps.filter((st) => Array.isArray(st.m));

test('v9 flowFrames makes one frame per message of a node-linked sequence: its title and detail, the nodes its two participants point at, and the model edge between them when there is one', () => {
  const frames = V.flowFrames(model, placeOrder);
  const msgs = messages(placeOrder);
  assert.equal(frames.length, msgs.length, 'one frame per message, fragments and notes make none');
  const nodeOf = Object.fromEntries(placeOrder.participants.map((p) => [p.id, p.node]));
  let withEdge = 0;
  frames.forEach((f, i) => {
    const m = msgs[i];
    assert.equal(f.title, m.t);
    assert.equal(f.detail, m.d);
    assert.equal(f.step, placeOrder.steps.indexOf(m), 'the frame knows its step, for the diagram');
    assert.deepEqual(f.nodes, [...new Set(m.m.map((p) => nodeOf[p]))], `frame ${i}: the nodes are the participants' nodes, once each`);
    if (f.edge === null) {
      const joined = model.edges.some((e) => (e.from === f.nodes[0] && e.to === f.nodes[1]) || (e.to === f.nodes[0] && e.from === f.nodes[1]));
      assert.equal(f.nodes.length < 2 || !joined, true, `frame ${i}: an edge joins ${f.nodes} but none was found`);
    } else {
      const e = model.edges.find((x) => x.id === f.edge);
      assert.ok(e, `edge ${f.edge} is not in the model`);
      assert.ok(f.nodes.includes(e.from) && f.nodes.includes(e.to), `frame ${i}: edge ${e.id} does not join ${f.nodes}`);
      withEdge++;
    }
  });
  assert.ok(withEdge >= 3, `the golden flow walks several real edges (got ${withEdge})`);
  // a self-message lights its one node and no edge
  const self = frames[msgs.findIndex((m) => m.m[0] === m.m[1])];
  assert.equal(self.nodes.length, 1);
  assert.equal(self.edge, null);
  // a model edge drawn the other way still joins a returning message
  const back = V.flowFrames({ ...model, sequences: [] }, { participants: [{ id: 'a', label: 'a', node: 'web-app' }, { id: 'b', label: 'b', node: 'ingress-gw' }], steps: [{ m: ['b', 'a'], k: 'api', t: 'back', d: '', r: [] }] });
  const e = model.edges.find((x) => x.from === 'web-app' && x.to === 'ingress-gw');
  assert.ok(e, 'the golden has web-app > ingress-gw');
  assert.equal(back[0].edge, e.id);
  // no participant node: nothing to play, so no player is offered
  const plain = { participants: placeOrder.participants.map(({ node, ...p }) => p), steps: placeOrder.steps };
  assert.equal(V.flowFrames(model, plain), null);
  // a node that is not in the model is ignored, never lit
  const ghost = V.flowFrames(model, { participants: [{ id: 'a', label: 'a', node: 'no-such-node' }, { id: 'b', label: 'b', node: 'web-app' }], steps: [{ m: ['a', 'b'], k: 'call', t: 't', d: 'd', r: [] }] });
  assert.deepEqual(ghost[0].nodes, ['web-app']);
  assert.equal(V.flowFrames(model, { participants: [{ id: 'a', label: 'a', node: 'no-such-node' }], steps: [] }), null);
});

test('v10 flowMarks lights the current frame\'s nodes and edge and dims every other node and edge', () => {
  const frames = V.flowFrames(model, placeOrder);
  for (const f of frames) {
    const k = V.flowMarks(model, f);
    assert.deepEqual([...k.hotNodes].sort(), [...f.nodes].sort());
    assert.deepEqual(k.hotEdges, f.edge === null ? [] : [f.edge]);
    assert.deepEqual([...k.dimNodes].sort(), model.nodes.map((n) => n.id).filter((id) => !f.nodes.includes(id)).sort());
    assert.deepEqual([...k.dimEdges].sort(), model.edges.map((e) => e.id).filter((id) => id !== f.edge).sort());
    for (const id of k.hotNodes) assert.ok(!k.dimNodes.includes(id), 'a lit node is not dimmed');
  }
});

test('v11 next, previous, the arrow keys, Home and End move the frame and stop at the ends; play advances one frame and stops after the last', () => {
  const n = 5;
  assert.equal(V.flowMove(0, n, 'next'), 1);
  assert.equal(V.flowMove(4, n, 'next'), 4, 'next stops at the last frame');
  assert.equal(V.flowMove(3, n, 'prev'), 2);
  assert.equal(V.flowMove(0, n, 'prev'), 0, 'previous stops at the first frame');
  assert.equal(V.flowMove(2, n, 'first'), 0);
  assert.equal(V.flowMove(2, n, 'last'), 4);
  assert.equal(V.flowMove(2, n, 'nonsense'), 2);
  assert.deepEqual(['ArrowRight', 'ArrowDown', 'PageDown', 'ArrowLeft', 'ArrowUp', 'PageUp', 'Home', 'End', 'a', 'Enter'].map((k) => V.flowKeyAction(k)),
    ['next', 'next', 'next', 'prev', 'prev', 'prev', 'first', 'last', null, null]);
  assert.deepEqual(V.flowTick(1, n), { i: 2, done: false });
  assert.deepEqual(V.flowTick(3, n), { i: 4, done: true }, 'the tick that reaches the last frame stops the play');
  assert.deepEqual(V.flowTick(4, n), { i: 4, done: true });
  // a one-frame flow is already at its end
  assert.deepEqual(V.flowTick(0, 1), { i: 0, done: true });
  assert.ok(V.FLOW_TICK_MS >= 800 && V.FLOW_TICK_MS <= 3000, `a readable pace (${V.FLOW_TICK_MS} ms)`);
});

test('v12 the player adds nothing to the clean render before it is used: no overlay text or marker outside the script, and the script runs nothing from the model', () => {
  const body = clean.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(body, /flow-?bar|flowbar|play on graph|class="[^"]*\bflow/i, 'player markup in the static HTML');
  assert.doesNotMatch(body, /\bflow-(?:hot|dim)\b/, 'a flow mark in the static HTML');
  const js = clean.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? [...clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].find((m) => !/application\/json/.test(m[1]))[2];
  assert.match(js, /Play on graph/, 'the control is built by the script');
  assert.doesNotMatch(js, /\beval\s*\(|new Function\s*\(|innerHTML\s*=\s*[a-z]*\.(?:title|detail|t|d)\b/, 'a model string is handed to the DOM raw');
  // a string of the model reaches the stepbox escaped
  const evil = V.flowFrames(model, { participants: [{ id: 'a', label: 'a', node: 'web-app' }, { id: 'b', label: 'b', node: 'ingress-gw' }], steps: [{ m: ['a', 'b'], k: 'api', t: '<img src=x onerror=alert(1)>', d: '</b><script>1</script>', r: [] }] });
  const html = V.flowStepHtml(evil[0], 0, 1);
  assert.doesNotMatch(html, /<img|<script/i, 'the step title and detail are escaped');
  assert.match(html, /&lt;img/);
});

test('v13 interaction-state parity: every interactive selector the sheet styles has a hover (and, for entities and nodes, a focus) rule that changes visuals only, never the box it sits in', () => {
  const css = readFileSync(fileURLToPath(new URL('../assets/viewer/viewer.css', import.meta.url)), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].split(',').map((s) => s.trim()), body: m[2] }));
  const GEOMETRY = /^(?:width|height|min-width|min-height|max-width|max-height|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|border-width|font-size|line-height|display|position|top|left|right|bottom|flex(?:-[a-z]+)?)$/;
  const stateRule = (subject, state) => rules.filter((r) => r.sel.some((s) => s === `${subject}:${state}` || s.startsWith(`${subject}:${state} `)));
  const subjects = [
    ['#qres li', ['hover']], ['.btn', ['hover']], ['.ent', ['focus-visible', 'hover']], ['.evchip', ['hover']], ['.fld', ['hover']],
    ['.ilink', ['hover']], ['.lnk', ['hover']], ['.node', ['focus-visible', 'hover']], ['.opb', ['hover']], ['.tab', ['hover']],
    ['a', ['hover']], ['nav.sections .navtab', ['hover']],
  ];
  for (const [subject, states] of subjects) {
    for (const state of states) {
      const found = stateRule(subject, state);
      assert.ok(found.length >= 1, `${subject}:${state} has no rule`);
      for (const r of found) {
        const decls = r.body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(':')[0].trim());
        assert.ok(decls.length >= 1, `${subject}:${state} declares nothing`);
        for (const d of decls) assert.ok(!GEOMETRY.test(d), `${subject}:${state} changes ${d}, which moves the box`);
      }
    }
  }
  // the entity and node cards also lose the browser outline on plain focus, so :focus-visible is the one focus cue
  for (const s of ['.ent', '.node']) assert.ok(stateRule(s, 'focus').some((r) => /outline:none/.test(r.body)), `${s}:focus drops the outline`);
  // the player's own controls reuse the sheet's button states
  assert.match(css, /\.flowbar\b/, 'the player bar is styled');
  assert.ok(stateRule('.flowbar .btn', 'hover').length + stateRule('.btn', 'hover').length >= 1);
});

test('v14 every edge type of the schema has its own relation style, legend entry and colour in all three themes: depends, lineage and artifact do not fall back to the call style', () => {
  const css = readFileSync(fileURLToPath(new URL('../assets/viewer/viewer.css', import.meta.url)), 'utf8');
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/archmap-model.schema.json', import.meta.url)), 'utf8'));
  const types = schema.$defs.edge.properties.type.enum;
  for (const t of types) {
    assert.ok(V.REL[t], `REL has an entry for ${t}`);
    assert.equal(V.relOf(t), t, `${t} is not drawn as the fallback`);
    assert.ok(V.REL[t].label && typeof V.REL[t].w === 'number', `${t} has a label and a stroke width`);
    assert.match(css, new RegExp(`\\.t-${t}\\{--ec:var\\(--rel-${t}\\)\\}`), `${t} has its edge class`);
    assert.equal(css.split(new RegExp(`--rel-${t}:#[0-9A-Fa-f]{6}`)).length - 1, 3, `${t} has a colour in the light, dark-by-preference and dark-by-choice blocks`);
  }
  assert.equal(V.relOf('nonsense'), 'call', 'an unknown type still falls back to call');
  for (const t of ['depends', 'lineage', 'artifact']) {
    const same = Object.keys(V.REL).filter((k) => k !== t && V.REL[k].dash === V.REL[t].dash && V.REL[k].w === V.REL[t].w);
    assert.deepEqual(same, [], `${t} differs from every other type in dash or width`);
  }
});

// ---------------------------------------------------------------------------------------------
// P13.17: the flow player's DOM glue (flowEnter, flowApply, flowBar, the play timer, the document keydown handler,
// flowSync, flowExit) runs here against a minimal hand-written DOM stub: elements with classList, dataset, attributes,
// listeners, querySelector and innerHTML; fake timers; the real viewer script from the rendered golden HTML. The stub
// answers the architecture svg's queries from the model's own node and edge ids, so the marks the player puts on the
// graph can be read back. Zero dependencies; nothing here touches a browser.

class StubEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.doc = doc;
    this.cls = new Set(); this.attrs = {}; this.dataset = {}; this.children = []; this.listeners = {};
    this.hidden = false; this.disabled = false; this.textContent = ''; this.innerHTML = ''; this.id = '';
    this.parentNode = null; this.picked = new Map(); this.style = { setProperty() {}, removeProperty() {} }; this.clientWidth = 1000; this.value = '';
    const me = this;
    this.classList = { add: (...c) => c.forEach((x) => me.cls.add(x)), remove: (...c) => c.forEach((x) => me.cls.delete(x)), contains: (c) => me.cls.has(c), toggle: (c, on) => ((on ?? !me.cls.has(c)) ? me.cls.add(c) : me.cls.delete(c)) };
  }
  get className() { return [...this.cls].join(' '); }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type, ev = {}) { (this.listeners[type] || []).forEach((fn) => fn(ev)); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  insertBefore(c) { c.parentNode = this; this.children.push(c); return c; }
  focus() { this.doc.focused = this; }
  closest() { return this; }
  getBoundingClientRect() { return { width: 1000, height: 600, left: 0, top: 0 }; }
  remove() {}
  contains() { return false; }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() { return null; }
  // an element a script asked for by selector is made once and handed back every time: the stub's "found" element
  querySelector(sel) {
    if (!this.picked.has(sel)) {
      const e = new StubEl('div', this.doc);
      const act = /\[data-act="([a-z]+)"\]/.exec(sel); if (act) { e.tagName = 'BUTTON'; e.dataset.act = act[1]; }
      this.picked.set(sel, e);
    }
    return this.picked.get(sel);
  }
  querySelectorAll() { return []; }
}

function flowRig(script) {
  const jsons = Object.fromEntries([...clean.matchAll(/<script\b([^>]*application\/json[^>]*)>([\s\S]*?)<\/script>/g)].map((m) => [/\bid="([^"]+)"/.exec(m[1])[1], m[2]]));
  const doc = { focused: null, created: [], byId: new Map(), listeners: {}, tabs: [] };
  const timers = { list: [], next: 1 };
  const env = {
    setInterval: (fn, ms) => { const t = { id: timers.next++, fn, ms }; timers.list.push(t); return t.id; },
    clearInterval: (id) => { timers.list = timers.list.filter((t) => t.id !== id); },
    setTimeout: () => 0, clearTimeout: () => {}, location: { hash: '' }, history: { replaceState() {} }, CSS: { escape: (s) => String(s) },
  };
  const svg = new StubEl('svg', doc); svg.namespaceURI = 'svg-ns'; svg.id = 'arch';
  const marked = []; // the nodes, edges and edge labels the player may light
  for (const n of model.nodes) { const e = new StubEl('g', doc); e.cls.add('node'); e.dataset.id = n.id; marked.push(e); }
  model.edges.forEach((x, i) => { const e = new StubEl('g', doc); e.cls.add('edge'); e.dataset.id = x.id; e.dataset.i = String(i); marked.push(e); const l = new StubEl('text', doc); l.cls.add('elabel'); l.dataset.i = String(i); marked.push(l); });
  const nodeEl = (id) => marked.find((e) => e.cls.has('node') && e.dataset.id === id);
  const hotIds = () => marked.filter((e) => e.cls.has('flow-hot')).map((e) => `${[...e.cls].filter((c) => c !== 'flow-hot')[0]}:${e.dataset.id ?? e.dataset.i}`).sort();
  const matches = (e, sel) => (sel === '.flow-hot' ? e.cls.has('flow-hot') : sel === '.edge' ? e.cls.has('edge') : (m => m && e.cls.has('node') && e.dataset.id === m[1])(/^\.node\[data-id="(.*)"\]$/.exec(sel)) || (m => m && e.cls.has('elabel') && e.dataset.i === m[1])(/^\.elabel\[data-i="(.*)"\]$/.exec(sel)));
  svg.querySelectorAll = (sel) => marked.filter((e) => matches(e, sel));
  svg.querySelector = (sel) => svg.querySelectorAll(sel)[0] ?? null;
  doc.byId.set('arch', svg);
  const document = {
    getElementById(id) {
      if (id in jsons) { const j = new StubEl('script', doc); j.textContent = jsons[id]; return j; }
      if (!doc.byId.has(id)) { const e = new StubEl('div', doc); e.id = id; e.parentNode = new StubEl('div', doc); doc.byId.set(id, e); }
      return doc.byId.get(id);
    },
    createElement(tag) { const e = new StubEl(tag, doc); doc.created.push(e); return e; },
    createElementNS(ns, tag) { return new StubEl(tag, doc); },
    querySelector(sel) {
      const m = /^#navlist \[data-tab="([a-z]+)"\]$/.exec(sel);
      if (!m) return null;
      if (!doc.navs) doc.navs = {};
      return (doc.navs[m[1]] ||= Object.assign(new StubEl('button', doc), { dataset: { tab: m[1] } }));
    },
    querySelectorAll(sel) {
      if (sel !== '#seqtabs .tab') return [];
      if (!doc.tabs.length) for (const s of model.sequences) { const b = new StubEl('button', doc); b.dataset.seq = s.id; doc.tabs.push(b); }
      return doc.tabs;
    },
    addEventListener(type, fn) { (doc.listeners[type] ||= []).push(fn); },
    documentElement: new StubEl('html', doc), body: new StubEl('body', doc),
  };
  const mod = { exports: {} };
  new Function('module', 'document', 'window', ...Object.keys(env), script)(mod, document, { addEventListener() {} }, ...Object.values(env));
  const key = (k, extra = {}) => {
    const ev = { key: k, defaultPrevented: false, target: new StubEl('body', doc), preventDefault() { this.defaultPrevented = true; }, ...extra };
    (doc.listeners.keydown || []).forEach((fn) => fn(ev));
    return ev;
  };
  const clickBar = (bar, act) => { const b = bar.querySelector(`[data-act="${act}"]`); bar.dispatch('click', { target: { closest: () => b } }); return b; };
  return { doc, timers, svg, marked, nodeEl, hotIds, key, clickBar, playBtn: () => doc.created.find((e) => e.id === 'seqplay'), bar: () => doc.created.find((e) => e.className.split(' ').includes('flowbar')) };
}

// Plays place-order on the stub and asserts what a person sees at each step; throws an AssertionError the moment
// the glue does not do what the player promises.
function driveFlow(script) {
  const frames = V.flowFrames(model, placeOrder);
  const last = frames.length - 1;
  const hotNodes = (f) => f.nodes.map((n) => `node:${n}`);
  const r = flowRig(script);
  const play = r.playBtn();
  assert.ok(play, 'the script builds the Play on graph control');
  assert.equal(play.hidden, false, 'a node-linked sequence is offered the player');
  assert.equal(r.bar(), undefined, 'no bar exists before the player is used');
  assert.deepEqual(r.hotIds(), [], 'nothing is lit before the player is used');

  // enter: the first frame is lit, the bar opens, the graph tab is shown, previous is off and next is on
  play.dispatch('click');
  const bar = r.bar();
  assert.ok(bar, 'entering builds the flow bar');
  assert.equal(bar.hidden, false, 'the bar is open');
  assert.ok(r.svg.cls.has('flowing'), 'the graph is marked as flowing');
  const lit = () => r.hotIds().filter((x) => x.startsWith('node:'));
  assert.deepEqual(lit(), hotNodes(frames[0]).sort(), 'the first frame lights its nodes');
  const stepbox = () => bar.querySelector('.stepbox');
  assert.match(stepbox().innerHTML, new RegExp(frames[0].title.replace(/[^\w ]/g, '.').slice(0, 12)), 'the stepbox shows the first message');
  assert.equal(r.doc.byId.get('architecture').hidden, false, 'the graph tab is shown');
  assert.match(stepbox().className, /\bt-[a-z]+\b/, 'the stepbox carries the relation class');
  assert.equal(bar.querySelector('[data-act="prev"]').disabled, true, 'previous is off on the first frame');
  assert.equal(bar.querySelector('[data-act="next"]').disabled, false);
  assert.equal(bar.querySelector('.flowname').textContent, placeOrder.title, 'the bar names the sequence');
  assert.equal(r.doc.focused, bar.querySelector('[data-act="play"]'), 'focus moves to the Play button');

  // next: the lit step moves on and the old step's marks go
  r.clickBar(bar, 'next');
  assert.deepEqual(lit(), hotNodes(frames[1]).sort(), 'next lights the second frame');
  assert.deepEqual(r.hotIds().filter((x) => x.startsWith('edge:')), frames[1].edge === null ? [] : [`edge:${frames[1].edge}`], 'the frame edge is lit, and only it');
  assert.equal(bar.querySelector('[data-act="prev"]').disabled, false, 'previous is on after a step');
  // every frame, in turn: its nodes and its edge lit and nothing else, so a frame with an edge shows it
  const edgesLit = () => r.hotIds().filter((x) => x.startsWith('edge:') || x.startsWith('elabel:'));
  for (let i = 2; i <= last; i++) {
    r.key('ArrowRight');
    assert.deepEqual(lit(), hotNodes(frames[i]).sort(), `frame ${i}: its nodes are lit`);
    assert.equal(edgesLit().some((x) => x.startsWith('edge:')), frames[i].edge !== null, `frame ${i}: its edge is lit exactly when it has one`);
  }
  assert.ok(frames.some((f) => f.edge !== null), 'place-order walks real edges');
  r.key('Home'); r.clickBar(bar, 'next');

  // the keys, while the player is open: handled keys are prevented, the others are left alone
  assert.equal(r.key('ArrowLeft').defaultPrevented, true);
  assert.deepEqual(lit(), hotNodes(frames[0]).sort(), 'ArrowLeft goes back one frame');
  assert.equal(r.key('End').defaultPrevented, true);
  assert.deepEqual(lit(), hotNodes(frames[last]).sort(), 'End jumps to the last frame');
  assert.equal(bar.querySelector('[data-act="next"]').disabled, true, 'next is off on the last frame');
  assert.equal(r.key('Home').defaultPrevented, true);
  assert.deepEqual(lit(), hotNodes(frames[0]).sort(), 'Home jumps to the first frame');
  assert.equal(r.key('PageDown').defaultPrevented, true);
  assert.deepEqual(lit(), hotNodes(frames[1]).sort(), 'PageDown steps forward');
  assert.equal(r.key('x').defaultPrevented, false, 'an unrelated key is not swallowed');
  assert.equal(r.key('ArrowRight', { ctrlKey: true }).defaultPrevented, false, 'a modified key is left to the browser');
  assert.equal(r.key('ArrowRight', { target: new StubEl('input', r.doc) }).defaultPrevented, false, 'typing in a field is left alone');
  assert.deepEqual(lit(), hotNodes(frames[1]).sort(), 'none of those moved the frame');
  r.clickBar(bar, 'prev');

  // play: one frame per tick at the viewer's pace, Pause while it runs, the timer gone after the last frame
  assert.equal(r.timers.list.length, 0, 'no timer runs before Play');
  r.clickBar(bar, 'play');
  assert.equal(r.timers.list.length, 1, 'Play starts one timer');
  assert.equal(r.timers.list[0].ms, V.FLOW_TICK_MS);
  assert.equal(bar.querySelector('[data-act="play"]').textContent, 'Pause');
  r.timers.list[0].fn();
  assert.deepEqual(lit(), hotNodes(frames[1]).sort(), 'a tick advances one frame');
  r.clickBar(bar, 'play');
  assert.equal(r.timers.list.length, 0, 'Pause stops the timer');
  assert.equal(bar.querySelector('[data-act="play"]').textContent, 'Play');
  r.clickBar(bar, 'play');
  for (let i = 1; i < last; i++) r.timers.list[0].fn();
  assert.deepEqual(lit(), hotNodes(frames[last]).sort(), 'ticks reach the last frame');
  assert.equal(r.timers.list.length, 0, 'the tick that reaches the last frame stops the timer');
  assert.equal(bar.querySelector('[data-act="play"]').textContent, 'Replay');

  // exit on Escape: the marks go, the bar closes, the sequences tab is back on the step the player stopped at, and the keys are free again
  const esc = r.key('Escape');
  assert.equal(esc.defaultPrevented, true, 'Escape is handled while the player is open');
  assert.equal(bar.hidden, true, 'the bar closes');
  assert.equal(r.svg.cls.has('flowing'), false, 'the graph is no longer flowing');
  assert.deepEqual(r.hotIds(), [], 'no mark is left on the graph');
  assert.equal(r.doc.byId.get('sequences').hidden, false, 'the sequences tab is shown again');
  assert.equal(r.doc.byId.get('architecture').hidden, true);
  assert.match(r.doc.byId.get('stepbox').innerHTML, new RegExp(`Step ${last + 1} of`), 'the sequence view is back on the last step');
  assert.equal(r.key('ArrowRight').defaultPrevented, false, 'a closed player lets the arrow keys through');
  assert.equal(r.key('Escape').defaultPrevented, false);

  // enter again, leave by the Back button, enter again and change sequence: flowSync closes the player
  play.dispatch('click');
  assert.equal(bar.hidden, false, 'the same bar reopens');
  assert.deepEqual(lit(), hotNodes(frames[last]).sort(), 'the player starts at the step the sequence view was on');
  r.clickBar(bar, 'exit');
  assert.equal(bar.hidden, true, 'the Back button closes the player');
  assert.deepEqual(r.hotIds(), []);
  play.dispatch('click');
  assert.equal(bar.hidden, false);
  r.doc.tabs.find((b) => b.dataset.seq === 'rate-quote').dispatch('click');
  assert.equal(bar.hidden, true, 'selecting another sequence closes the player');
  assert.deepEqual(r.hotIds(), [], 'and clears its marks');
  assert.equal(play.hidden, false, 'the other node-linked sequence is still offered the player');
  return r;
}

test('v15 the flow player\'s glue, on a minimal DOM stub: enter lights the first frame, next, the keys and a play tick move the lit step, Escape, the Back button and a sequence change close it', () => {
  driveFlow(viewerScriptOf(clean));
});

test('v16 the flow player test can fail: a viewer whose glue is broken in any of five places is caught by it', () => {
  const src = viewerScriptOf(clean);
  const breaks = {
    'the first frame is not lit': ['n.classList.add("flow-hot")', 'n.classList.add("flow-hotx")'],
    'an arrow key is not prevented': ['if (action){ ev.preventDefault(); flowGo(action); }', 'if (action){ flowGo(action); }'],
    'the last tick leaves the timer running': ['if (t.done) flowStopTimer();', ''],
    'exit leaves the bar open': ['if (flow.bar) flow.bar.hidden = true;', ''],
    'a sequence change leaves the player open': ['if (flow.frames && (!frames || seqState.id !== flow.seqId)) flowExit(false);', ''],
  };
  assert.doesNotThrow(() => driveFlow(src), 'the unbroken viewer passes');
  for (const [what, [from, to]] of Object.entries(breaks)) {
    assert.ok(src.includes(from), `the viewer no longer has the text this case breaks (${what})`);
    assert.throws(() => driveFlow(src.replace(from, to)), assert.AssertionError, `broken (${what}) was not caught`);
  }
});
