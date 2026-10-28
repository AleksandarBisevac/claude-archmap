import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (l1, l2, ...) lead every title so the suite prints them first.
// The golden fixture is the layout input; layout.mjs vendors elkjs (assets/viewer/elk.bundled.js).
const CLI = fileURLToPath(new URL('../scripts/layout.mjs', import.meta.url));
const MODEL = fileURLToPath(new URL('./fixtures/golden/architecture.model.json', import.meta.url));
const model = JSON.parse(readFileSync(MODEL, 'utf8'));
const lazy = () => import('../scripts/layout.mjs');

const clone = (x) => JSON.parse(JSON.stringify(x));
const TOL = 2; // px: "a small tolerance" for unaffected nodes after a seeded re-layout
const inside = (inner, outer, eps = 0.01) =>
  inner.x >= outer.x - eps && inner.y >= outer.y - eps &&
  inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const tmp = mkdtempSync(join(tmpdir(), 'archmap-layout-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

const withNewNode = () => {
  const m = clone(model);
  const base = m.nodes.find((n) => n.id === 'rating-service');
  m.nodes.push({ ...clone(base), id: 'fuel-surcharge-service', title: 'Fuel surcharge service', zone: base.zone });
  return m;
};

test('l1 the layout of the golden model is deterministic: two runs are byte-identical (module and CLI)', async () => {
  const { layoutModel } = await lazy();
  const a = JSON.stringify(await layoutModel(model));
  const b = JSON.stringify(await layoutModel(clone(model)));
  assert.equal(a, b, 'two in-process runs differ');
  const out1 = join(tmp, 'one.layout.json');
  const out2 = join(tmp, 'two.layout.json');
  for (const out of [out1, out2]) {
    const r = spawnSync(process.execPath, [CLI, MODEL, '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  }
  assert.equal(readFileSync(out1, 'utf8'), readFileSync(out2, 'utf8'), 'two CLI runs differ');
  assert.equal(JSON.parse(readFileSync(out1, 'utf8')).schemaVersion, 1);
});

test('l2 every node gets x,y,w,h inside its zone bounds, and nodes do not overlap', async () => {
  const { layoutModel } = await lazy();
  const { graph } = await layoutModel(model);
  assert.deepEqual(Object.keys(graph.nodes).sort(), model.nodes.map((n) => n.id).sort());
  for (const n of model.nodes) {
    const p = graph.nodes[n.id];
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(p[k]), `${n.id}.${k} = ${p[k]}`);
    assert.ok(p.w > 0 && p.h > 0, `${n.id} has no size`);
    assert.ok(inside(p, graph.zones[n.zone]), `${n.id} lies outside zone ${n.zone}`);
  }
  const ids = Object.keys(graph.nodes).sort();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      assert.ok(!overlap(graph.nodes[ids[i]], graph.nodes[ids[j]]), `${ids[i]} overlaps ${ids[j]}`);
    }
  }
});

test('l3 zones nest per parent: a child zone box lies inside its parent zone box', async () => {
  const { layoutModel } = await lazy();
  const { graph } = await layoutModel(model);
  assert.deepEqual(Object.keys(graph.zones).sort(), model.zones.map((z) => z.id).sort());
  const nested = model.zones.filter((z) => z.parent);
  assert.ok(nested.length >= 2, 'the fixture should nest zones');
  for (const z of nested) {
    assert.ok(inside(graph.zones[z.id], graph.zones[z.parent]), `zone ${z.id} outside parent ${z.parent}`);
  }
});

test('l4 every edge is routed: sections with finite start and end points', async () => {
  const { layoutModel } = await lazy();
  const { graph } = await layoutModel(model);
  assert.deepEqual(Object.keys(graph.edges).sort(), model.edges.map((e) => e.id).sort());
  for (const e of model.edges) {
    const { sections } = graph.edges[e.id];
    assert.ok(Array.isArray(sections) && sections.length >= 1, `edge ${e.id} has no sections`);
    for (const s of sections) {
      for (const pt of [s.startPoint, s.endPoint, ...(s.bendPoints ?? [])]) {
        assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y), `edge ${e.id} has a non-finite point`);
      }
    }
  }
});

test('l5 a seeded re-layout after adding one node moves no unaffected node, and parks the new one in its zone area', async () => {
  const { layoutModel } = await lazy();
  const first = await layoutModel(model);
  const again = await layoutModel(model, { layout: first });
  assert.equal(JSON.stringify(again), JSON.stringify(first), 'seeding with its own output must be a fixed point');

  const grown = withNewNode();
  const next = await layoutModel(grown, { layout: first });
  for (const n of model.nodes) {
    const a = first.graph.nodes[n.id];
    const b = next.graph.nodes[n.id];
    assert.ok(
      Math.abs(a.x - b.x) <= TOL && Math.abs(a.y - b.y) <= TOL && a.w === b.w && a.h === b.h,
      `${n.id} moved from (${a.x},${a.y}) to (${b.x},${b.y})`,
    );
  }
  const added = next.graph.nodes['fuel-surcharge-service'];
  assert.ok(added && Number.isFinite(added.x) && Number.isFinite(added.y), 'the new node has no position');
  assert.ok(inside(added, next.graph.zones['zs-api']), 'the new node is not inside its zone');
  for (const n of model.nodes) assert.ok(!overlap(added, next.graph.nodes[n.id]), `new node overlaps ${n.id}`);
  for (const n of grown.nodes) assert.ok(inside(next.graph.nodes[n.id], next.graph.zones[n.zone]), `${n.id} left its zone`);
  assert.deepEqual(Object.keys(next.graph.edges).sort(), grown.edges.map((e) => e.id).sort());
});

test('l6 pinned nodes keep their exact positions, even when the rest of the model changes', async () => {
  const { layoutModel } = await lazy();
  const first = await layoutModel(model);
  const seed = clone(first);
  seed.graph.nodes['token-guard'] = { ...seed.graph.nodes['token-guard'], x: 777, y: 555, pinned: true };
  const next = await layoutModel(withNewNode(), { layout: seed });
  const p = next.graph.nodes['token-guard'];
  assert.equal(p.x, 777);
  assert.equal(p.y, 555);
  assert.equal(p.pinned, true, 'the pinned flag must survive the re-layout');
  assert.ok(inside(p, next.graph.zones['zs-api']), 'the zone grows to hold the pinned node');
  assert.equal(next.graph.nodes['ingress-gw'].pinned, undefined);
});

test('l7 the ER layout gives each entity one port per field row, and relations attach to those rows', async () => {
  const { layoutModel } = await lazy();
  const { er } = await layoutModel(model);
  assert.deepEqual(Object.keys(er.entities).sort(), model.entities.map((e) => e.id).sort());
  for (const e of model.entities) {
    const p = er.entities[e.id];
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(p[k]), `${e.id}.${k}`);
    assert.deepEqual(Object.keys(p.ports).sort(), e.fields.map((f) => f.name).sort(), `${e.id} ports != fields`);
    const ys = e.fields.map((f) => p.ports[f.name].y);
    assert.equal(new Set(ys).size, ys.length, `${e.id}: two fields share a row`);
    assert.deepEqual([...ys].sort((a, b) => a - b), ys, `${e.id}: ports are not in field order`);
    for (const f of e.fields) {
      const port = p.ports[f.name];
      assert.ok(port.y > 0 && port.y < p.h, `${e.id}.${f.name} port is outside the entity`);
      assert.ok(port.x === 0 || port.x === p.w, `${e.id}.${f.name} port is not on a side`);
    }
  }
  assert.equal(Object.keys(er.relations).length, model.relations.length);
  const at = (side) => {
    const ent = er.entities[side.entity];
    const port = ent.ports[side.field];
    return { x: ent.x + port.x, y: ent.y + port.y };
  };
  for (const r of model.relations) {
    const key = `${r.from.entity}.${r.from.field}->${r.to.entity}.${r.to.field}`;
    const [s] = er.relations[key].sections;
    const from = at(r.from);
    const to = at(r.to);
    assert.ok(Math.abs(s.startPoint.y - from.y) <= 1 && Math.abs(s.startPoint.x - from.x) <= 1, `${key}: start is not at the from-field port`);
    assert.ok(Math.abs(s.endPoint.y - to.y) <= 1 && Math.abs(s.endPoint.x - to.x) <= 1, `${key}: end is not at the to-field port`);
  }
});

test('l8 CLI: refuses an invalid model (exit 1, nothing written), usage errors exit 2, a seed file is honoured', () => {
  const bad = clone(model);
  bad.edges[0].to = 'no-such-node';
  const badPath = join(tmp, 'bad.model.json');
  writeFileSync(badPath, JSON.stringify(bad));
  const badOut = join(tmp, 'bad.layout.json');
  const r1 = spawnSync(process.execPath, [CLI, badPath, '--out', badOut], { encoding: 'utf8' });
  assert.equal(r1.status, 1, r1.stderr);
  assert.equal(existsSync(badOut), false, 'an invalid model must not produce a layout');
  assert.match(r1.stdout + r1.stderr, /dangling-ref/);

  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, join(tmp, 'nope.json')], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI, MODEL, '--bogus'], { encoding: 'utf8' }).status, 2);

  const out = join(tmp, 'a.layout.json');
  assert.equal(spawnSync(process.execPath, [CLI, MODEL, '--out', out], { encoding: 'utf8' }).status, 0);
  const seeded = JSON.parse(readFileSync(out, 'utf8'));
  seeded.graph.nodes['ingress-gw'] = { ...seeded.graph.nodes['ingress-gw'], x: 901, y: 33, pinned: true };
  writeFileSync(out, JSON.stringify(seeded));
  const out2 = join(tmp, 'b.layout.json');
  const r2 = spawnSync(process.execPath, [CLI, MODEL, '--layout', out, '--out', out2], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  const pinned = JSON.parse(readFileSync(out2, 'utf8')).graph.nodes['ingress-gw'];
  assert.equal(pinned.x, 901);
  assert.equal(pinned.y, 33);
});
