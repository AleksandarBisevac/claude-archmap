#!/usr/bin/env node
// layout.mjs - lay out an archmap model with the vendored elkjs and persist the positions.
//
//   node scripts/layout.mjs <model.json> [--layout <layout.json>] [--out <file>]
//
// Reads architecture.model.json (validated first; an invalid model is refused) and, optionally, a
// previous architecture.layout.json used as seeds, and writes architecture.layout.json:
//
//   { schemaVersion: 1,
//     graph: { nodes: {id: {x,y,w,h,pinned?}}, zones: {id: {x,y,w,h}}, edges: {id: {sections}} },
//     er:    { entities: {id: {x,y,w,h,pinned?,ports:{field:{x,y,side}}}}, relations: {key: {sections}} } }
//
// All graph coordinates are absolute (zones, nodes, edge points share one frame). Entity ports are
// relative to their entity. A relation key is "<from.entity>.<from.field>-><to.entity>.<to.field>".
//
// Fresh layout: ELK "layered", compound zones (zone.parent nesting), fixed random seed and inputs
// sorted by id, so the same model always yields byte-identical output. Seeded layout: nodes that have
// a previous position and an unchanged size keep it; pinned nodes keep it unconditionally; new or
// resized nodes are "parked" in free space next to their zone (design 14.3), and only edges touching
// a moved node are re-routed. Output is the layout file unchanged when nothing changed.
//
// --out defaults to the --layout file (in-place update), else architecture.layout.json beside the model.
// Exit 0 ok, 1 the model is invalid (nothing is written), 2 usage, unreadable input or layout failure.
// Node >= 18, ESM, zero npm dependencies (elkjs is vendored: assets/viewer/ELK-NOTICE.md).

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

export const LAYOUT_SCHEMA_VERSION = 1;

const require = createRequire(import.meta.url);
const ELK = require('../assets/viewer/elk.bundled.js');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const up10 = (v) => Math.ceil(v / 10) * 10;
const EPS = 0.01;

// ---------------------------------------------------------------------------
// sizes (deterministic text metrics; no DOM)

const ZONE_PAD = { top: 36, left: 18, right: 18, bottom: 18 };
const NODE_GAP = 14; // clear space kept around a parked node
const GRID = 20;
const ENTITY_HEAD = 30;
const ENTITY_ROW = 22;

function nodeSize(n) {
  const sub = Array.isArray(n.sub) ? n.sub : [];
  const widest = Math.max(String(n.title ?? '').length * 8.2 + 36, ...sub.map((s) => String(s).length * 6.4 + 28));
  return { w: Math.min(300, Math.max(160, up10(widest))), h: Math.max(56, 36 + 16 * sub.length) };
}

function entitySize(e) {
  const fields = Array.isArray(e.fields) ? e.fields : [];
  const widest = Math.max(
    String(e.name ?? e.id).length * 8.2 + 40,
    ...fields.map((f) => (String(f.name).length + String(f.type ?? '').length) * 7.2 + 56),
  );
  return { w: Math.max(190, up10(widest)), h: ENTITY_HEAD + ENTITY_ROW * fields.length + 6 };
}

const portY = (i) => ENTITY_HEAD + ENTITY_ROW * i + ENTITY_ROW / 2;

// ---------------------------------------------------------------------------
// rectangles

const rect = (p) => ({ x: p.x, y: p.y, w: p.w, h: p.h });
const overlaps = (a, b) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
const contains = (outer, inner) =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS &&
  inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;
const grow = (r, t, rt, b, l) => ({ x: r.x - l, y: r.y - t, w: r.w + l + rt, h: r.h + t + b });
const growAll = (r, d) => grow(r, d, d, d, d);
const growZone = (r) => grow(r, ZONE_PAD.top, ZONE_PAD.right, ZONE_PAD.bottom, ZONE_PAD.left);
function union(rs) {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w));
  const y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const near = (a, b, eps = 1) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
const onBorder = (pt, r, eps = 1.5) => {
  const inX = pt.x >= r.x - eps && pt.x <= r.x + r.w + eps;
  const inY = pt.y >= r.y - eps && pt.y <= r.y + r.h + eps;
  const edgeX = Math.abs(pt.x - r.x) <= eps || Math.abs(pt.x - (r.x + r.w)) <= eps;
  const edgeY = Math.abs(pt.y - r.y) <= eps || Math.abs(pt.y - (r.y + r.h)) <= eps;
  return inX && inY && (edgeX || edgeY);
};

const section = (start, bends, end) => {
  const s = { startPoint: { x: r2(start.x), y: r2(start.y) }, endPoint: { x: r2(end.x), y: r2(end.y) } };
  if (bends.length) s.bendPoints = bends.map((b) => ({ x: r2(b.x), y: r2(b.y) }));
  return s;
};

// ---------------------------------------------------------------------------
// seeds

function seedOf(layout) {
  const g = isObj(layout) && isObj(layout.graph) ? layout.graph : {};
  const e = isObj(layout) && isObj(layout.er) ? layout.er : {};
  const pick = (m) => (isObj(m) ? m : {});
  return {
    nodes: pick(g.nodes), zones: pick(g.zones), edges: pick(g.edges),
    entities: pick(e.entities), relations: pick(e.relations),
  };
}
const seedRect = (s) => (isObj(s) && num(s.x) && num(s.y) && num(s.w) && num(s.h) ? rect(s) : null);

// ---------------------------------------------------------------------------
// elk

const ELK_ROOT = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.randomSeed': '1',
  'elk.separateConnectedComponents': 'false',
  'elk.spacing.nodeNode': '32',
  'elk.spacing.edgeNode': '20',
  'elk.layered.spacing.nodeNodeBetweenLayers': '72',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
};

// absolute rectangles of every laid-out ELK element, by ELK id; edge points made absolute too
function collect(root) {
  const abs = new Map([[root.id, { x: 0, y: 0, w: root.width ?? 0, h: root.height ?? 0 }]]);
  const edges = [];
  const walk = (node, ox, oy) => {
    for (const c of node.children ?? []) {
      const r = { x: ox + (c.x ?? 0), y: oy + (c.y ?? 0), w: c.width, h: c.height };
      abs.set(c.id, r);
      walk(c, r.x, r.y);
    }
    for (const e of node.edges ?? []) edges.push({ edge: e, ox, oy });
  };
  walk(root, 0, 0);
  const routes = new Map();
  for (const { edge, ox, oy } of edges) {
    const base = edge.container && abs.has(edge.container) ? abs.get(edge.container) : { x: ox, y: oy };
    const pt = (p) => ({ x: p.x + base.x, y: p.y + base.y });
    routes.set(edge.id, (edge.sections ?? []).map((s) => section(pt(s.startPoint), (s.bendPoints ?? []).map(pt), pt(s.endPoint))));
  }
  return { abs, routes };
}

async function elkGraphLayout(model, sizes) {
  const zones = [...(model.zones ?? [])].sort(byId);
  const known = new Set(zones.map((z) => z.id));
  const zoneNode = new Map(
    zones.map((z) => [z.id, {
      id: `z:${z.id}`, children: [],
      layoutOptions: { 'elk.padding': `[top=${ZONE_PAD.top},left=${ZONE_PAD.left},bottom=${ZONE_PAD.bottom},right=${ZONE_PAD.right}]` },
    }]),
  );
  const root = { id: 'root', layoutOptions: ELK_ROOT, children: [], edges: [] };
  for (const z of zones) {
    const parent = z.parent !== undefined && known.has(z.parent) && z.parent !== z.id ? zoneNode.get(z.parent) : root;
    parent.children.push(zoneNode.get(z.id));
  }
  for (const n of [...(model.nodes ?? [])].sort(byId)) {
    const parent = zoneNode.get(n.zone) ?? root;
    parent.children.push({ id: `n:${n.id}`, width: sizes.nodes.get(n.id).w, height: sizes.nodes.get(n.id).h });
  }
  for (const e of [...(model.edges ?? [])].sort(byId)) {
    root.edges.push({ id: `e:${e.id}`, sources: [`n:${e.from}`], targets: [`n:${e.to}`] });
  }
  return collect(await new ELK().layout(root));
}

const relationKey = (r) => `${r.from.entity}.${r.from.field}->${r.to.entity}.${r.to.field}`;
function relationKeys(model) {
  const used = new Map();
  return (model.relations ?? []).map((r) => {
    const base = relationKey(r);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { key: n === 1 ? base : `${base}#${n}`, rel: r };
  });
}

// one port per field row; a field that is only ever a relation target sits on the west side
function portSides(model) {
  const sides = new Map();
  const targets = new Set((model.relations ?? []).map((r) => `${r.to.entity}\0${r.to.field}`));
  const sources = new Set((model.relations ?? []).map((r) => `${r.from.entity}\0${r.from.field}`));
  for (const e of model.entities ?? []) {
    for (const f of e.fields ?? []) {
      const k = `${e.id}\0${f.name}`;
      sides.set(k, targets.has(k) && !sources.has(k) ? 'WEST' : 'EAST');
    }
  }
  return sides;
}

async function elkErLayout(model, sizes, sides) {
  const root = { id: 'root', layoutOptions: { ...ELK_ROOT, 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.spacing.nodeNode': '40' }, children: [], edges: [] };
  const port = (e, f) => `p:${e}.${f}`;
  for (const e of [...(model.entities ?? [])].sort(byId)) {
    const { w, h } = sizes.entities.get(e.id);
    root.children.push({
      id: `en:${e.id}`, width: w, height: h,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: (e.fields ?? []).map((f, i) => {
        const side = sides.get(`${e.id}\0${f.name}`);
        return {
          id: port(e.id, f.name), x: side === 'WEST' ? 0 : w, y: portY(i), width: 0, height: 0,
          layoutOptions: { 'elk.port.side': side },
        };
      }),
    });
  }
  relationKeys(model).forEach(({ rel }, i) => {
    root.edges.push({ id: `r:${i}`, sources: [port(rel.from.entity, rel.from.field)], targets: [port(rel.to.entity, rel.to.field)] });
  });
  return collect(await new ELK().layout(root));
}

// ---------------------------------------------------------------------------
// parking (seeded mode): free space next to the zone, found by a deterministic ring search

function ringOffsets(maxRing) {
  const out = [{ dx: 0, dy: 0 }];
  for (let r = 1; r <= maxRing; r++) {
    const ring = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push({ dx, dy });
    }
    ring.sort((a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy) || a.dy - b.dy || a.dx - b.dx);
    out.push(...ring);
  }
  return out;
}
const OFFSETS = ringOffsets(70);

function park(size, prefer, ok, fallback) {
  const cx = Math.round(prefer.x / GRID) * GRID;
  const cy = Math.round(prefer.y / GRID) * GRID;
  for (const { dx, dy } of OFFSETS) {
    const r = { x: cx + dx * GRID - Math.round(size.w / 2 / GRID) * GRID, y: cy + dy * GRID - Math.round(size.h / 2 / GRID) * GRID, w: size.w, h: size.h };
    if (ok(r)) return r;
  }
  return { x: fallback.x, y: fallback.y, w: size.w, h: size.h };
}

class Zones {
  constructor(model) {
    this.ids = (model.zones ?? []).map((z) => z.id).sort();
    this.parent = new Map();
    const known = new Set(this.ids);
    for (const z of model.zones ?? []) this.parent.set(z.id, z.parent !== undefined && known.has(z.parent) && z.parent !== z.id ? z.parent : null);
    this.chainCache = new Map();
  }
  chain(id) { // self, parent, ... root (cycle safe)
    if (this.chainCache.has(id)) return this.chainCache.get(id);
    const out = [];
    for (let z = id; z != null && this.parent.has(z) && !out.includes(z); z = this.parent.get(z)) out.push(z);
    this.chainCache.set(id, out);
    return out;
  }
  related(a, b) { return this.chain(a).includes(b) || this.chain(b).includes(a); }
  // zone boxes: required box = members' union + padding; a seed box that still holds it is kept
  boxes(placed, nodeZone, seedZones) {
    const out = new Map();
    const order = [...this.ids].sort((a, b) => this.chain(b).length - this.chain(a).length || (a < b ? -1 : 1));
    for (const id of order) {
      const parts = [];
      for (const [nid, r] of placed) if (nodeZone.get(nid) === id) parts.push(r);
      for (const [cid, r] of out) if (this.parent.get(cid) === id) parts.push(r);
      const seed = seedRect(seedZones[id]);
      if (parts.length === 0) {
        if (seed) out.set(id, seed);
        continue;
      }
      const need = growZone(union(parts));
      out.set(id, seed && contains(seed, need) ? seed : need);
    }
    return out;
  }
}

function parkNode(id, size, prefer, ctx) {
  const { zones, placed, nodeZone, seedZones } = ctx;
  const zoneId = nodeZone.get(id);
  const boxes = zones.boxes(placed, nodeZone, seedZones);
  const chain = zones.chain(zoneId);
  const inChain = new Set(chain);
  const inSubtree = (nid, a) => zones.chain(nodeZone.get(nid)).includes(a);
  let anchor = null;
  for (const a of chain) if (boxes.has(a)) { anchor = boxes.get(a); break; }
  const all = placed.size ? union([...placed.values()]) : { x: 0, y: 0, w: 0, h: 0 };
  const at = prefer ?? (anchor ? centre(anchor) : { x: all.x + size.w / 2, y: all.y + all.h + size.h });
  const ok = (r) => {
    const clear = growAll(r, NODE_GAP);
    for (const m of placed.values()) if (overlaps(clear, m)) return false;
    for (const [zid, b] of boxes) if (!inChain.has(zid) && overlaps(clear, b)) return false;
    let cur = growZone(r);
    for (const a of chain) {
      const nb = boxes.has(a) ? union([boxes.get(a), cur]) : cur;
      for (const [nid, m] of placed) if (!inSubtree(nid, a) && overlaps(nb, m)) return false;
      for (const [zid, b] of boxes) if (!zones.related(zid, a) && overlaps(nb, b)) return false;
      cur = growZone(nb);
    }
    return true;
  };
  return park(size, at, ok, { x: all.x, y: all.y + all.h + 2 * GRID });
}

// ---------------------------------------------------------------------------
// simple orthogonal routing (seeded mode)

function routeBetween(a, b) {
  const ca = centre(a);
  const cb = centre(b);
  if (a.x + a.w <= b.x) { // a left of b
    const s = { x: a.x + a.w, y: ca.y };
    const t = { x: b.x, y: cb.y };
    const mx = (s.x + t.x) / 2;
    return [section(s, s.y === t.y ? [] : [{ x: mx, y: s.y }, { x: mx, y: t.y }], t)];
  }
  if (b.x + b.w <= a.x) { // a right of b
    const s = { x: a.x, y: ca.y };
    const t = { x: b.x + b.w, y: cb.y };
    const mx = (s.x + t.x) / 2;
    return [section(s, s.y === t.y ? [] : [{ x: mx, y: s.y }, { x: mx, y: t.y }], t)];
  }
  const down = ca.y <= cb.y;
  const s = { x: ca.x, y: down ? a.y + a.h : a.y };
  const t = { x: cb.x, y: down ? b.y : b.y + b.h };
  const my = (s.y + t.y) / 2;
  return [section(s, s.x === t.x ? [] : [{ x: s.x, y: my }, { x: t.x, y: my }], t)];
}

const STUB = 18;
function routePorts(s, sd, t, td) { // s,t points; sd,td = outward direction (-1 west, +1 east)
  const s1 = { x: s.x + sd * STUB, y: s.y };
  const t1 = { x: t.x + td * STUB, y: t.y };
  const mx = sd === td ? (sd > 0 ? Math.max(s1.x, t1.x) : Math.min(s1.x, t1.x)) : (s1.x + t1.x) / 2;
  return [section(s, [s1, { x: mx, y: s1.y }, { x: mx, y: t1.y }, t1], t)];
}

// ---------------------------------------------------------------------------
// graph view

async function layoutGraph(model, seed) {
  const nodes = [...(model.nodes ?? [])].sort(byId);
  const nodeZone = new Map(nodes.map((n) => [n.id, n.zone]));
  const sizes = { nodes: new Map(nodes.map((n) => [n.id, nodeSize(n)])) };
  const zones = new Zones(model);

  const seeded = nodes.some((n) => seedRect(seed.nodes[n.id]));
  let nodeRects; // id -> {x,y,w,h}
  let zoneRects;
  let routes; // edge id -> sections
  const pinned = new Set(nodes.filter((n) => seed.nodes[n.id]?.pinned === true && seedRect(seed.nodes[n.id])).map((n) => n.id));

  if (!seeded) {
    const { abs, routes: elkRoutes } = await elkGraphLayout(model, sizes);
    nodeRects = new Map(nodes.map((n) => [n.id, abs.get(`n:${n.id}`)]));
    zoneRects = new Map((model.zones ?? []).map((z) => [z.id, abs.get(`z:${z.id}`)]));
    routes = new Map((model.edges ?? []).map((e) => [e.id, elkRoutes.get(`e:${e.id}`) ?? []]));
  } else {
    const placed = new Map();
    const pending = [];
    for (const n of nodes) {
      const s = seedRect(seed.nodes[n.id]);
      const size = sizes.nodes.get(n.id);
      if (s && pinned.has(n.id)) placed.set(n.id, { x: s.x, y: s.y, w: size.w, h: size.h });
      else if (s && s.w === size.w && s.h === size.h) placed.set(n.id, s);
      else pending.push({ n, size, prefer: s ? centre(s) : null });
    }
    const ctx = { zones, placed, nodeZone, seedZones: seed.zones };
    for (const { n, size, prefer } of pending) placed.set(n.id, parkNode(n.id, size, prefer, ctx));
    nodeRects = placed;
    zoneRects = zones.boxes(placed, nodeZone, seed.zones);
    // zones without members and without a seed box: a small box below the drawing
    for (const id of zones.ids) {
      if (zoneRects.has(id)) continue;
      const all = union([...nodeRects.values(), ...zoneRects.values()].concat([{ x: 0, y: 0, w: 1, h: 1 }]));
      zoneRects.set(id, { x: all.x, y: all.y + all.h + 2 * GRID, w: 200, h: 80 });
    }
    routes = new Map();
    for (const e of model.edges ?? []) {
      const a = nodeRects.get(e.from);
      const b = nodeRects.get(e.to);
      const prev = seed.edges[e.id]?.sections;
      const keep = Array.isArray(prev) && prev.length > 0 && isObj(prev[0]?.startPoint) && isObj(prev.at(-1)?.endPoint) &&
        onBorder(prev[0].startPoint, a) && onBorder(prev.at(-1).endPoint, b);
      routes.set(e.id, keep ? prev : routeBetween(a, b));
    }
  }

  const outNodes = {};
  for (const n of nodes) {
    const r = nodeRects.get(n.id);
    outNodes[n.id] = { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) };
    if (pinned.has(n.id)) outNodes[n.id].pinned = true;
  }
  const outZones = {};
  for (const id of zones.ids) {
    const r = zoneRects.get(id);
    outZones[id] = { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) };
  }
  const outEdges = {};
  for (const e of [...(model.edges ?? [])].sort(byId)) outEdges[e.id] = { sections: routes.get(e.id) };
  return { nodes: outNodes, zones: outZones, edges: outEdges };
}

// ---------------------------------------------------------------------------
// ER view

async function layoutEr(model, seed) {
  const entities = [...(model.entities ?? [])].sort(byId);
  const sizes = { entities: new Map(entities.map((e) => [e.id, entitySize(e)])) };
  const sides = portSides(model);
  const keyed = relationKeys(model);
  const seeded = entities.some((e) => seedRect(seed.entities[e.id]));
  const pinned = new Set(entities.filter((e) => seed.entities[e.id]?.pinned === true && seedRect(seed.entities[e.id])).map((e) => e.id));
  let rects;
  let routes;

  if (!seeded) {
    const { abs, routes: elkRoutes } = await elkErLayout(model, sizes, sides);
    rects = new Map(entities.map((e) => [e.id, abs.get(`en:${e.id}`)]));
    routes = new Map(keyed.map(({ key }, i) => [key, elkRoutes.get(`r:${i}`) ?? []]));
  } else {
    rects = new Map();
    const pending = [];
    for (const e of entities) {
      const s = seedRect(seed.entities[e.id]);
      const size = sizes.entities.get(e.id);
      if (s && pinned.has(e.id)) rects.set(e.id, { x: s.x, y: s.y, w: size.w, h: size.h });
      else if (s && s.w === size.w && s.h === size.h) rects.set(e.id, s);
      else pending.push({ e, size, prefer: s ? centre(s) : null });
    }
    for (const { e, size, prefer } of pending) {
      const friend = keyed
        .map(({ rel }) => (rel.from.entity === e.id ? rel.to.entity : rel.to.entity === e.id ? rel.from.entity : null))
        .find((id) => id !== null && id !== e.id && rects.has(id));
      const all = rects.size ? union([...rects.values()]) : { x: 0, y: 0, w: 0, h: 0 };
      const at = prefer ?? (friend ? { x: rects.get(friend).x + rects.get(friend).w * 1.5 + 40, y: centre(rects.get(friend)).y } : { x: all.x + size.w / 2, y: all.y + all.h + size.h });
      const ok = (r) => {
        const clear = growAll(r, NODE_GAP + 10);
        for (const m of rects.values()) if (overlaps(clear, m)) return false;
        return true;
      };
      rects.set(e.id, park(size, at, ok, { x: all.x, y: all.y + all.h + 2 * GRID }));
    }
    routes = new Map();
    for (const { key, rel } of keyed) {
      const a = rects.get(rel.from.entity);
      const b = rects.get(rel.to.entity);
      const pa = portPoint(model, a, rel.from, sides);
      const pb = portPoint(model, b, rel.to, sides);
      const prev = seed.relations[key]?.sections;
      const keep = Array.isArray(prev) && prev.length > 0 && isObj(prev[0]?.startPoint) && isObj(prev.at(-1)?.endPoint) &&
        near(prev[0].startPoint, pa.pt) && near(prev.at(-1).endPoint, pb.pt);
      routes.set(key, keep ? prev : routePorts(pa.pt, pa.dir, pb.pt, pb.dir));
    }
  }

  const outEntities = {};
  for (const e of entities) {
    const r = rects.get(e.id);
    const ports = {};
    (e.fields ?? []).forEach((f, i) => {
      const side = sides.get(`${e.id}\0${f.name}`);
      ports[f.name] = { x: side === 'WEST' ? 0 : r2(r.w), y: portY(i), side };
    });
    outEntities[e.id] = { x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h), ports };
    if (pinned.has(e.id)) outEntities[e.id].pinned = true;
  }
  const outRelations = {};
  for (const { key } of [...keyed].sort((a, b) => (a.key < b.key ? -1 : 1))) outRelations[key] = { sections: routes.get(key) };
  return { entities: outEntities, relations: outRelations };
}

function portPoint(model, rectOf, side, sides) {
  const e = (model.entities ?? []).find((x) => x.id === side.entity);
  const i = (e?.fields ?? []).findIndex((f) => f.name === side.field);
  const west = sides.get(`${side.entity}\0${side.field}`) === 'WEST';
  return { pt: { x: west ? rectOf.x : rectOf.x + rectOf.w, y: rectOf.y + portY(Math.max(0, i)) }, dir: west ? -1 : 1 };
}

// ---------------------------------------------------------------------------
// public API

/**
 * Lay out a model. The model is assumed valid (the CLI validates first).
 * @param {object} model parsed architecture.model.json
 * @param {{layout?: object}} [opts] layout = a previous architecture.layout.json, used as seeds
 * @returns {Promise<object>} the architecture.layout.json content
 */
export async function layoutModel(model, { layout } = {}) {
  const seed = seedOf(layout);
  const graph = await layoutGraph(model, seed);
  const er = await layoutEr(model, seed);
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, graph, er };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = 'usage: node scripts/layout.mjs <model.json> [--layout <layout.json>] [--out <file>]';

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { model: undefined, layout: undefined, out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--layout' || a === '--out') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (o.model === undefined) o.model = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!o.help && o.model === undefined) throw new UsageError('missing <model.json>');
  return o;
}

function readJson(path, what, { optional = false } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (optional && e.code === 'ENOENT') return undefined;
    throw new UsageError(`cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} ${path} is not valid JSON: ${e.message}`);
  }
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      console.log(USAGE);
      return 0;
    }
    const model = readJson(opts.model, 'model');
    let layout;
    if (opts.layout !== undefined) {
      layout = readJson(opts.layout, 'layout file', { optional: true });
      if (layout === undefined) console.error(`layout: no seed file at ${opts.layout}; laying out from scratch`);
      else if (!isObj(layout) || layout.schemaVersion !== LAYOUT_SCHEMA_VERSION) {
        throw new UsageError(`layout file ${opts.layout} is not a schemaVersion ${LAYOUT_SCHEMA_VERSION} layout`);
      }
    }
    const result = validate(model);
    if (!result.ok) {
      for (const f of result.findings) console.log(`${f.code}  ${f.pointer || '/'}  ${f.message}`);
      console.log(`FAIL: ${result.findings.length} finding(s); the model is invalid, no layout written`);
      return 1;
    }
    let out;
    try {
      out = await layoutModel(model, { layout });
    } catch (e) {
      throw new UsageError(`layout failed: ${e?.message ?? e}`);
    }
    const target = opts.out ?? opts.layout ?? join(dirname(opts.model), 'architecture.layout.json');
    writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`OK: layout of ${Object.keys(out.graph.nodes).length} nodes, ${Object.keys(out.graph.zones).length} zones, ${Object.keys(out.er.entities).length} entities written to ${target}`);
    return 0;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`layout: ${e.message}\n${USAGE}`);
    return 2;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
