// archmap viewer - renders the embedded model, layout and (internal/shared builds only) issues.
// Everything drawn comes from three JSON blocks render.mjs inlines: #archmap-model, #archmap-layout and
// the optional #archmap-issues. Positions and edge routes are the build-time ELK layout; nothing is hand-placed.
// No network access of any kind: the page is a single offline file.
//
// Layout of this file: (1) pure functions of the model (path finder, search, lineage, CRUD matrix, ER scene and
// markup, evidence links). They touch no DOM, and when the file is loaded without a `document` (node:test) they are
// handed to `module.exports` and nothing else runs. (2) The DOM: panes, tabs and event wiring.
(function(){
"use strict";

/* ═════════ (1) pure functions ═════════ */
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const codeify = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const num = v => Math.round(v * 100) / 100;

/* Figure scale (pure): the smallest scale a figure opens at. Fitting a wide drawing to a narrow panel would shrink
   its text past reading, so below FIG_MIN_SCALE the figure opens at the floor and scrolls sideways; Fit stays one click away.
   naturalW is the drawing's width in px, availW the panel's. fit is the true whole-drawing scale (never above 1). */
const FIG_MIN_SCALE = 0.5;
function figureScale(naturalW, availW){
  const nat = Math.max(1, naturalW), avail = Math.max(0, availW);
  const fit = Math.min(1, avail / nat);
  const fitted = fit >= FIG_MIN_SCALE;
  return {fit:fit, scale:fitted ? fit : FIG_MIN_SCALE, fitted:fitted, scrolls:!fitted};
}

// relation types: colour comes from the CSS (--rel-<type>); dash pattern and width make each type readable without colour.
const REL = {
  api:     {label:"HTTP API",               dash:null,      w:2},
  static:  {label:"Page or asset load",     dash:"2 4",     w:1.7},
  auth:    {label:"Identity and token",     dash:"7 4",     w:2},
  pull:    {label:"Data pull",              dash:null,      w:3.2},
  sql:     {label:"SQL",                    dash:null,      w:2},
  cache:   {label:"Cache read, write, clear", dash:null,    w:2},
  persist: {label:"Client storage",         dash:"1.5 3.5", w:2.2},
  call:    {label:"In-process call",        dash:null,      w:1.3},
  link:    {label:"Outbound link",          dash:"8 3 2 3", w:1.6},
  deploy:  {label:"Build and deploy",       dash:"10 5",    w:2},
  event:   {label:"Event",                  dash:"4 2 1 2", w:1.8},
  queue:   {label:"Queue message",          dash:"6 3",     w:2.4}
};
const relOf = k => (REL[k] ? k : "call");
const ZK = {browser:"Browser", edge:"Edge", service:"Service", data:"Data", platform:"Platform", external:"External", delivery:"Delivery"};
const SEVN = {high:"High", med:"Medium", low:"Low"};
const SEVR = {high:3, med:2, low:1};
const OPS = [["C","create"],["R","read"],["U","update"],["D","delete"]];

/* evidence links: repoUrl/blob/<commit>/<path>#L<a>-L<b> */
function repoBase(meta){
  const u = meta && meta.repoUrl; if (typeof u !== "string") return null;
  try { const p = new URL(u); return (p.protocol === "https:" || p.protocol === "http:") ? u.replace(/\/+$/, "") : null; } catch (err) { return null; }
}
function evidenceUrl(meta, path, lines){
  const base = repoBase(meta);
  if (!base || !meta.commit) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines || "");
  const frag = m ? "#L" + m[1] + (m[2] ? "-L" + m[2] : "") : "";
  return base + "/blob/" + encodeURIComponent(meta.commit) + "/" + String(path).split("/").map(encodeURIComponent).join("/") + frag;
}
function evidenceChipHtml(meta, path, lines){
  const label = path + (lines ? ":" + lines : "");
  const url = evidenceUrl(meta, path, lines);
  if (!url) return '<code>' + esc(label) + '</code>';
  return '<a class="evchip" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"><code>' + esc(label) + '</code></a>';
}
function refChipHtml(meta, ref){
  const m = /^(.*):(\d+(?:-\d+)?)$/.exec(String(ref));
  return m ? evidenceChipHtml(meta, m[1], m[2]) : '<code>' + esc(ref) + '</code>';
}

/* views: a deployment or trust view is recognised by an explicit `kind`, else by its id or title */
function viewRole(v){
  const k = v && typeof v.kind === "string" ? v.kind.toLowerCase() : "";
  if (k === "deployment" || k === "trust" || k === "graph") return k;
  const s = ((v && v.id) || "") + " " + ((v && v.title) || "");
  if (/trust|boundar/i.test(s)) return "trust";
  if (/deploy|release|topolog|infra/i.test(s)) return "deployment";
  return "graph";
}

/* path finder: breadth-first search, so the first path found is a shortest one. Edges are walked in both
   directions unless opts.directed. Ties are broken by edge order, so the result is deterministic.
   Returns {nodes:[ids], edges:[edge ids]} or null when the two nodes are not connected. */
function findPath(edges, from, to, opts){
  const directed = !!(opts && opts.directed);
  if (from === undefined || to === undefined || from === "" || to === "") return null;
  if (from === to) return {nodes:[from], edges:[]};
  const adj = new Map();
  const link = (a, b, id) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({to:b, edge:id}); };
  (edges || []).forEach(e => { link(e.from, e.to, e.id); if (!directed) link(e.to, e.from, e.id); });
  if (!adj.has(from) || !adj.has(to)) return null;
  const prev = new Map([[from, null]]);
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++){
    const cur = queue[qi];
    for (const step of adj.get(cur) || []){
      if (prev.has(step.to)) continue;
      prev.set(step.to, {node:cur, edge:step.edge});
      if (step.to === to){
        const nodes = [to], used = [];
        for (let at = to; prev.get(at); at = prev.get(at).node){ nodes.push(prev.get(at).node); used.push(prev.get(at).edge); }
        return {nodes:nodes.reverse(), edges:used.reverse()};
      }
      queue.push(step.to);
    }
  }
  return null;
}

/* lineage of an entity: its store, the components with access rows on it, the edges from those components to
   the store, and the callers upstream of the accessors up to maxDepth hops. */
function lineageOf(model, entityId, maxDepth){
  const depthLimit = maxDepth === undefined ? 2 : maxDepth;
  const ent = (model.entities || []).find(e => e.id === entityId);
  if (!ent) return null;
  const rows = (model.access || []).filter(a => a.entity === entityId);
  const edges = model.edges || [];
  const depth = new Map();
  if (ent.store) depth.set(ent.store, 0);
  rows.forEach(r => { if (!depth.has(r.node)) depth.set(r.node, 1); });
  const used = new Set();
  const accessors = new Set(rows.map(r => r.node));
  edges.forEach(e => { if (accessors.has(e.from) && e.to === ent.store) used.add(e.id); });
  let frontier = Array.from(accessors);
  for (let d = 1; d <= depthLimit && frontier.length; d++){
    const next = [];
    edges.forEach(e => {
      if (!frontier.includes(e.to) || e.from === ent.store) return;
      used.add(e.id);
      if (!depth.has(e.from)){ depth.set(e.from, d + 1); next.push(e.from); }
    });
    frontier = next;
  }
  return {entity:entityId, store:ent.store, access:rows,
          nodes:Array.from(depth.keys()), edges:edges.filter(e => used.has(e.id)).map(e => e.id)};
}

/* search over nodes, edges, entities and sequences. Every word of the query must occur in the item. */
function searchModel(model, query, limit){
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const nodeTitle = {}; (model.nodes || []).forEach(n => { nodeTitle[n.id] = n.title; });
  const items = [];
  (model.nodes || []).forEach(n => items.push({kind:"node", id:n.id, title:n.title, detail:n.kind + (n.role ? " · " + n.role : ""),
    hay:[n.id, n.title, n.kind, n.role, (n.sub || []).join(" ")]}));
  (model.edges || []).forEach(e => items.push({kind:"edge", id:e.id, title:(nodeTitle[e.from] || e.from) + " → " + (nodeTitle[e.to] || e.to),
    detail:(REL[relOf(e.type)].label) + (e.label ? " · " + e.label : ""), hay:[e.id, e.type, e.label, e.desc, nodeTitle[e.from], nodeTitle[e.to]]}));
  (model.entities || []).forEach(e => items.push({kind:"entity", id:e.id, title:e.name || e.id, detail:(e.kind || "table") + " in " + e.store,
    hay:[e.id, e.name, e.store, (e.fields || []).map(f => f.name).join(" ")]}));
  (model.sequences || []).forEach(s => items.push({kind:"sequence", id:s.id, title:s.title, detail:s.summary || "",
    hay:[s.id, s.title, s.summary, (s.steps || []).map(st => [st.t, st.d].filter(Boolean).join(" ")).join(" ")]}));
  const order = {node:0, entity:1, sequence:2, edge:3};
  const out = [];
  items.forEach(it => {
    const hay = it.hay.filter(x => typeof x === "string").join(" ").toLowerCase();
    if (!words.every(w => hay.indexOf(w) >= 0)) return;
    const t = String(it.title).toLowerCase();
    const score = words.every(w => t.indexOf(w) === 0 || t.indexOf(" " + w) >= 0) ? 3 : words.every(w => t.indexOf(w) >= 0) ? 2 : 1;
    out.push({kind:it.kind, id:it.id, title:it.title, detail:it.detail, score:score});
  });
  out.sort((a, b) => (b.score - a.score) || (order[a.kind] - order[b.kind]) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return out.slice(0, limit === undefined ? 20 : limit);
}

/* CRUD matrix: nodes that have access rows (model order) by all entities (model order). One cell per
   node/entity pair that has a row; a pair given twice has its operations merged. */
function crudMatrix(model){
  const access = model.access || [];
  const withRows = new Set(access.map(a => a.node));
  const nodes = (model.nodes || []).filter(n => withRows.has(n.id));
  const entities = model.entities || [];
  const cells = new Map();
  access.forEach(a => {
    const k = a.node + "\u0000" + a.entity;
    const c = cells.get(k) || {node:a.node, entity:a.entity, ops:"", evidence:[]};
    OPS.forEach(o => { if (String(a.ops).indexOf(o[0]) >= 0 && c.ops.indexOf(o[0]) < 0) c.ops += o[0]; });
    c.ops = OPS.map(o => o[0]).filter(l => c.ops.indexOf(l) >= 0).join("");
    (a.evidence || []).forEach(ev => c.evidence.push(ev));
    cells.set(k, c);
  });
  return {nodes:nodes, entities:entities, cells:cells};
}
function opsWords(ops){ return OPS.filter(o => String(ops).indexOf(o[0]) >= 0).map(o => o[1]).join(", "); }
function crudHtml(model){
  const mx = crudMatrix(model);
  let h = '<table class="crud"><thead><tr><th class="corner" scope="col">Component</th>';
  mx.entities.forEach(e => { h += '<th scope="col"><button class="lnk" data-entity="' + esc(e.id) + '">' + esc(e.name || e.id) + '</button></th>'; });
  h += '</tr></thead><tbody>';
  mx.nodes.forEach(n => {
    h += '<tr><th scope="row"><button class="lnk" data-node="' + esc(n.id) + '">' + esc(n.title) + '</button></th>';
    mx.entities.forEach(e => {
      const c = mx.cells.get(n.id + "\u0000" + e.id);
      if (!c){ h += '<td class="empty"></td>'; return; }
      h += '<td class="cell" data-node="' + esc(n.id) + '" data-entity="' + esc(e.id) + '" data-ops="' + esc(c.ops) + '">' +
        '<button class="opb" aria-label="' + esc(n.title + " on " + (e.name || e.id) + ": " + opsWords(c.ops)) + '">' +
        c.ops.split("").map(l => '<span class="op op-' + l.toLowerCase() + '">' + l + '</span>').join("") + '</button></td>';
    });
    h += '</tr>';
  });
  return h + '</tbody></table>';
}

/* ER scene: the cards and relation routes of the layout's `er` block, joined with the model. */
const PROV_RANK = {declared:0, observed:1, inferred:2};
const provOf = p => (PROV_RANK[p] !== undefined ? p : "declared");
// Same keying as layout.mjs: "<from.entity>.<from.field>-><to.entity>.<to.field>", a repeated one gets "#n".
function relationKeys(model){
  const used = new Map();
  return (model.relations || []).map(r => {
    const base = r.from.entity + "." + r.from.field + "->" + r.to.entity + "." + r.to.field;
    const n = (used.get(base) || 0) + 1; used.set(base, n);
    return {key:n === 1 ? base : base + "#" + n, rel:r};
  });
}
// Crow's foot cardinality: the cardinality is read with the "many" end on the side that holds the key (`from`)
// for 1-n, on both ends for n-m and neither for 1-1.
function manyEnds(card){ return {from:card === "1-n" || card === "n-m", to:card === "n-m"}; }
// The glyph at point p of a line arriving from point q: three prongs for many, a bar across the line for one.
function crowFoot(p, q, many){
  const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  if (many){
    const bx = p[0] + ux * 12, by = p[1] + uy * 12;
    return "M" + num(bx + nx * 6) + "," + num(by + ny * 6) + " L" + num(p[0]) + "," + num(p[1]) + " L" + num(bx - nx * 6) + "," + num(by - ny * 6);
  }
  const bx = p[0] + ux * 10, by = p[1] + uy * 10;
  return "M" + num(bx + nx * 6) + "," + num(by + ny * 6) + " L" + num(bx - nx * 6) + "," + num(by - ny * 6);
}
function erScene(model, erLayout){
  const L = (erLayout && erLayout.entities) || {};
  const relLayout = (erLayout && erLayout.relations) || {};
  const incoming = new Set(), outgoing = new Map();
  (model.relations || []).forEach(r => { outgoing.set(r.from.entity + "\u0000" + r.from.field, r.to.entity + "." + r.to.field); incoming.add(r.to.entity + "\u0000" + r.to.field); });
  const cards = [], byId = {};
  (model.entities || []).forEach(e => {
    const p = L[e.id]; if (!p) return;
    const fields = (e.fields || []).map((f, i) => {
      const port = (p.ports && p.ports[f.name]) || {x:0, y:30 + 22 * i + 11, side:"EAST"};
      const target = f.fk ? f.fk.entity + "." + f.fk.field : (outgoing.get(e.id + "\u0000" + f.name) || null);
      return {name:f.name, type:f.type || "", pk:!!f.pk, fk:!!(f.fk || target), fkTo:target, nullable:!!f.nullable, prov:provOf(f.provenance),
              y:p.y + 30 + 22 * i, port:[p.x + port.x, p.y + port.y], referenced:incoming.has(e.id + "\u0000" + f.name)};
    });
    const provs = new Set(fields.map(f => f.prov));
    const card = {id:e.id, name:e.name || e.id, kind:e.kind || "table", store:e.store, x:p.x, y:p.y, w:p.w, h:p.h, fields:fields,
                  prov:provs.size === 1 ? Array.from(provs)[0] : provs.size === 0 ? "declared" : "mixed"};
    cards.push(card); byId[e.id] = card;
  });
  const relations = [];
  relationKeys(model).forEach(({key, rel}) => {
    const a = byId[rel.from.entity], b = byId[rel.to.entity]; if (!a || !b) return;
    const fa = a.fields.find(f => f.name === rel.from.field), fb = b.fields.find(f => f.name === rel.to.field);
    const secs = relLayout[key] && relLayout[key].sections;
    let pts = [];
    (secs || []).forEach(sec => [sec.startPoint].concat(sec.bendPoints || [], [sec.endPoint]).forEach(q => {
      if (!q) return;
      const last = pts[pts.length - 1];
      if (!last || last[0] !== q.x || last[1] !== q.y) pts.push([q.x, q.y]);
    }));
    if (pts.length < 2){
      const pa = fa ? fa.port : [a.x + a.w, a.y + a.h / 2], pb = fb ? fb.port : [b.x, b.y + b.h / 2];
      pts = [pa, pb];
    }
    const many = manyEnds(rel.cardinality);
    relations.push({key:key, rel:rel, prov:provOf(rel.provenance), kind:rel.kind, cardinality:rel.cardinality, pts:pts,
      foot:[crowFoot(pts[0], pts[1], many.from), crowFoot(pts[pts.length - 1], pts[pts.length - 2], many.to)].join(" ")});
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  cards.forEach(c => { grow(c.x, c.y); grow(c.x + c.w, c.y + c.h); });
  relations.forEach(r => r.pts.forEach(p => grow(p[0], p[1])));
  if (!isFinite(x0)){ x0 = 0; y0 = 0; x1 = 400; y1 = 120; }
  const pad = 24;
  return {cards:cards, relations:relations, box:{x:x0 - pad, y:y0 - pad, w:(x1 - x0) + 2 * pad, h:(y1 - y0) + 2 * pad}};
}
function roundedPath(pts, rad){
  let d = "M" + pts[0][0] + "," + pts[0][1];
  for (let i = 1; i < pts.length - 1; i++){
    const [x0,y0] = pts[i-1], [x1,y1] = pts[i], [x2,y2] = pts[i+1];
    const d1 = Math.hypot(x1-x0, y1-y0) || 1, d2 = Math.hypot(x2-x1, y2-y1) || 1;
    const rr = Math.min(rad, d1/2, d2/2);
    const ax = x1 + (x0-x1)/d1*rr, ay = y1 + (y0-y1)/d1*rr, bx = x1 + (x2-x1)/d2*rr, by = y1 + (y2-y1)/d2*rr;
    d += " L" + ax + "," + ay + " Q" + x1 + "," + y1 + " " + bx + "," + by;
  }
  const last = pts[pts.length-1];
  return d + " L" + last[0] + "," + last[1];
}
const PROV_WORD = {declared:"declared in the schema", observed:"observed from the live database", inferred:"inferred from names", mixed:"mixed provenance"};
// The inner SVG markup of the ER diagram. opts.issues: {entityId: {count, sev}} for badges.
function erMarkup(model, erLayout, opts){
  const sc = erScene(model, erLayout), issues = (opts && opts.issues) || {};
  let h = '<g class="er-rels">';
  sc.relations.forEach(r => {
    const d = roundedPath(r.pts, 8);
    h += '<g class="rel prov-' + r.prov + ' kind-' + esc(r.kind) + '" data-key="' + esc(r.key) + '" data-from="' + esc(r.rel.from.entity) + '" data-to="' + esc(r.rel.to.entity) + '">' +
      '<path class="hit" d="' + d + '"/><path class="ln" d="' + d + '"/><path class="cf" d="' + r.foot + '"/>' +
      '<title>' + esc(r.rel.from.entity + "." + r.rel.from.field + " → " + r.rel.to.entity + "." + r.rel.to.field + " · " + r.cardinality + " · " + r.kind + " · " + (PROV_WORD[r.prov] || r.prov)) + '</title></g>';
  });
  h += '</g><g class="er-ents">';
  sc.cards.forEach(c => {
    const hd = "M" + c.x + "," + (c.y + 30) + " V" + (c.y + 7) + " Q" + c.x + "," + c.y + " " + (c.x + 7) + "," + c.y +
      " H" + (c.x + c.w - 7) + " Q" + (c.x + c.w) + "," + c.y + " " + (c.x + c.w) + "," + (c.y + 7) + " V" + (c.y + 30) + " Z";
    h += '<g class="ent prov-' + c.prov + ' ek-' + esc(c.kind) + '" data-entity="' + esc(c.id) + '" tabindex="0" role="button" aria-label="' + esc(c.name + ", " + c.kind + " in " + c.store + ", " + c.fields.length + " fields") + '">' +
      '<rect class="eb" x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" rx="7"/>' +
      '<path class="ehd" d="' + hd + '"/>' +
      '<text class="en" x="' + (c.x + 10) + '" y="' + (c.y + 19.5) + '">' + esc(c.name) + '</text>' +
      '<text class="ek" x="' + (c.x + c.w - 9) + '" y="' + (c.y + 19.5) + '" text-anchor="end">' + esc(c.kind) + '</text>';
    c.fields.forEach((f, i) => {
      const fy = c.y + 30 + 22 * i;
      h += '<g class="fld prov-' + f.prov + (f.pk ? " pk" : "") + (f.fk ? " fk" : "") + (f.nullable ? " nullable" : "") + '" data-field="' + esc(f.name) + '">' +
        '<rect class="fr" x="' + c.x + '" y="' + fy + '" width="' + c.w + '" height="22"/>' +
        (f.prov !== "declared" ? '<line class="pbar" x1="' + (c.x + 2.5) + '" x2="' + (c.x + 2.5) + '" y1="' + (fy + 3) + '" y2="' + (fy + 19) + '"/>' : '') +
        (f.pk ? '<text class="mk mk-pk" x="' + (c.x + 9) + '" y="' + (fy + 15) + '">PK</text>' : '') +
        (f.fk ? '<text class="mk mk-fk" x="' + (c.x + 29) + '" y="' + (fy + 15) + '">FK</text>' : '') +
        '<text class="fn" x="' + (c.x + 52) + '" y="' + (fy + 15) + '">' + esc(f.name) + '</text>' +
        '<text class="ft" x="' + (c.x + c.w - 9) + '" y="' + (fy + 15) + '" text-anchor="end">' + esc(f.type) + (f.nullable ? "?" : "") + '</text>' +
        '<title>' + esc(f.name + (f.type ? " " + f.type : "") + " · " + (PROV_WORD[f.prov] || f.prov) + (f.fkTo ? " · references " + f.fkTo : "")) + '</title></g>';
    });
    const is = issues[c.id];
    if (is && is.count) h += '<circle class="bdg sev-' + esc(is.sev) + '" cx="' + (c.x + c.w - 3) + '" cy="' + (c.y + 3) + '" r="8.5"/><text class="bdt" x="' + (c.x + c.w - 3) + '" y="' + (c.y + 6.5) + '" text-anchor="middle">' + is.count + '</text>';
    h += '</g>';
  });
  return {viewBox:sc.box.x + " " + sc.box.y + " " + sc.box.w + " " + sc.box.h, width:sc.box.w, inner:h + '</g>', scene:sc};
}

/* trust boundaries: one dashed enclosure around each top-level zone of a view. A zone flagged `outside` is
   untrusted; the rest are inside the boundary. A relation crosses a boundary when its two ends differ in trust. */
function trustBoundaries(zones, rects, zoneById){
  const inView = new Set(zones.map(z => z.id));
  return zones.filter(z => !(z.parent !== undefined && inView.has(z.parent)) && rects[z.id]).map(z => {
    const r = rects[z.id];
    return {zone:z.id, label:z.label || z.id, trusted:!(zoneById[z.id] && zoneById[z.id].outside),
            x:r.x - 12, y:r.y - 18, w:r.w + 24, h:r.h + 30};
  });
}
function rootZoneOf(zoneId, zoneById){
  const seen = new Set(); let z = zoneById[zoneId], root = zoneId;
  while (z && !seen.has(z.id)){ seen.add(z.id); root = z.id; z = z.parent !== undefined ? zoneById[z.parent] : null; }
  return root;
}
function crossesTrust(zoneA, zoneB, zoneById){
  const ra = rootZoneOf(zoneA, zoneById), rb = rootZoneOf(zoneB, zoneById);
  if (ra === rb) return false;
  const trusted = id => !(zoneById[id] && zoneById[id].outside);
  return trusted(ra) !== trusted(rb);
}

if (typeof document === "undefined"){
  if (typeof module !== "undefined" && module && typeof module === "object") {
    module.exports = {findPath:findPath, lineageOf:lineageOf, searchModel:searchModel, crudMatrix:crudMatrix, crudHtml:crudHtml,
      erScene:erScene, erMarkup:erMarkup, crowFoot:crowFoot, manyEnds:manyEnds, relationKeys:relationKeys, evidenceUrl:evidenceUrl,
      evidenceChipHtml:evidenceChipHtml, viewRole:viewRole, figureScale:figureScale, FIG_MIN_SCALE:FIG_MIN_SCALE, trustBoundaries:trustBoundaries, crossesTrust:crossesTrust};
  }
  return;
}

/* ═════════ (2) the page ═════════ */
// The SVG namespace, read from an inline <svg> the HTML parser already placed in it (no URL literal in shipped code).
const NS = document.getElementById("arch").namespaceURI;
function S(tag, attrs, parent){ const e = document.createElementNS(NS, tag); if (attrs) for (const k in attrs){ const v = attrs[k]; if (v !== undefined && v !== null) e.setAttribute(k, v); } if (parent) parent.appendChild(e); return e; }
const $ = id => document.getElementById(id);
function readJson(id){ const el = $(id); if (!el) return null; try { return JSON.parse(el.textContent); } catch (err) { return null; } }

/* ───────── data ───────── */
const MODEL = readJson("archmap-model") || {meta:{}, zones:[], nodes:[], edges:[]};
const LAYOUT = readJson("archmap-layout") || {};
const ISSUE_DATA = readJson("archmap-issues");
const META = MODEL.meta || {};
const ZONES = MODEL.zones || [], NODES = MODEL.nodes || [], EDGES = MODEL.edges || [], SEQS = MODEL.sequences || [];
const ENTITIES = MODEL.entities || [], ACCESS = MODEL.access || [];
const GRAPH = LAYOUT.graph || {};
const NP = GRAPH.nodes || {}, ZP = GRAPH.zones || {}, EP = GRAPH.edges || {};
const ISSUES = ((ISSUE_DATA && ISSUE_DATA.issues) || []).slice();
const HAS_ISSUES = !!ISSUE_DATA;

const ZONE = {}; ZONES.forEach(z => { ZONE[z.id] = z; });
const NODE = {}; NODES.forEach(n => { NODE[n.id] = n; });
const ENTITY = {}; ENTITIES.forEach(e => { ENTITY[e.id] = e; });
const zoneKind = id => (ZONE[id] && ZK[ZONE[id].kind] ? ZONE[id].kind : "edge");
function zoneChain(id){ const out = []; const seen = new Set(); let z = ZONE[id]; while (z && !seen.has(z.id)){ out.push(z.id); seen.add(z.id); z = z.parent !== undefined ? ZONE[z.parent] : null; } return out; }
const zoneDepth = id => zoneChain(id).length;

/* ───────── issues index ───────── */
const ISS = {}; ISSUES.forEach(i => { ISS[i.id] = i; });
const ENTITY_STORE = {}; ENTITIES.forEach(e => { ENTITY_STORE[e.id] = e.store; });
const bySev = (a, b) => (SEVR[ISS[b].sev] - SEVR[ISS[a].sev]) || (a < b ? -1 : a > b ? 1 : 0);
function issuesOfNode(id){
  return ISSUES.filter(i => i.anchor && (i.anchor.node === id || (i.anchor.entity !== undefined && ENTITY_STORE[i.anchor.entity] === id))).map(i => i.id).sort(bySev);
}
function issuesOfEdge(id){ return ISSUES.filter(i => i.anchor && i.anchor.edge === id).map(i => i.id).sort(bySev); }
function issuesOfEntity(id){ return ISSUES.filter(i => i.anchor && i.anchor.entity === id).map(i => i.id).sort(bySev); }
function issuesOfStep(seqId, idx, st){
  const ids = new Set();
  if (st.i && ISS[st.i]) ids.add(st.i);
  ISSUES.forEach(i => { if (i.anchor && i.anchor.step === seqId + ":" + idx) ids.add(i.id); });
  return Array.from(ids).sort(bySev);
}
function maxSev(ids){
  let best = "low";
  ids.forEach(id => { const s = ISS[id] && ISS[id].sev; if (s && SEVR[s] > SEVR[best]) best = s; });
  return best;
}
function issueLink(id){
  const x = ISS[id]; if (!x) return "";
  return '<a class="ilink issues-only" href="#issue-' + esc(id) + '" data-issue="' + esc(id) + '"><span class="sev sev-' + esc(x.sev) + '">' + esc(SEVN[x.sev] || x.sev) + '</span><span class="it">' + esc(id) + ' · ' + esc(x.title) + '</span></a>';
}
function wireIssueLinks(root){
  root.querySelectorAll("a[data-issue]").forEach(a => a.addEventListener("click", ev => { ev.preventDefault(); gotoIssue(a.dataset.issue); }));
}
const evidenceChip = (path, lines) => evidenceChipHtml(META, path, lines);
const refChip = ref => refChipHtml(META, ref);

/* ───────── generic graph renderer ───────── */
function addMarkers(svg){
  const pre = svg.id;
  const defs = S("defs", null, svg);
  Object.keys(REL).forEach(t => {
    const m = S("marker", {id:pre + "-m-" + t, viewBox:"0 0 10 10", refX:"9", refY:"5", markerWidth:"9", markerHeight:"9", markerUnits:"userSpaceOnUse", orient:"auto-start-reverse"}, defs);
    S("path", {d:"M0,1 L10,5 L0,9 z", class:"mk t-" + t}, m);
    const r = S("marker", {id:pre + "-r-" + t, viewBox:"0 0 10 10", refX:"9", refY:"5", markerWidth:"9", markerHeight:"9", markerUnits:"userSpaceOnUse", orient:"auto-start-reverse"}, defs);
    S("path", {d:"M0,1 L9,5 L0,9", class:"mko t-" + t}, r);
  });
}
function anchor(r, side){
  if (side === "l") return [r.x, r.y + r.h/2];
  if (side === "r") return [r.x + r.w, r.y + r.h/2];
  if (side === "t") return [r.x + r.w/2, r.y];
  return [r.x + r.w/2, r.y + r.h];
}
function sidesFor(a, b){
  if (a.x + a.w <= b.x) return ["r","l"];
  if (b.x + b.w <= a.x) return ["l","r"];
  return (b.y + b.h/2) > (a.y + a.h/2) ? ["b","t"] : ["t","b"];
}
// The routed polyline of an edge: ELK's sections when the layout has them, else a straight
// side-to-side segment (a layout older than the model).
function edgePoints(e){
  const secs = EP[e.id] && EP[e.id].sections;
  const pts = [];
  if (secs && secs.length){
    secs.forEach(sec => {
      [sec.startPoint].concat(sec.bendPoints || [], [sec.endPoint]).forEach(q => {
        if (!q) return;
        const last = pts[pts.length - 1];
        if (!last || last[0] !== q.x || last[1] !== q.y) pts.push([q.x, q.y]);
      });
    });
  }
  if (pts.length >= 2) return pts;
  const a = NP[e.from], b = NP[e.to];
  const s = sidesFor(a, b);
  return [anchor(a, s[0]), anchor(b, s[1])];
}
function edgeGeom(e){
  const pts = edgePoints(e);
  let best = -1, bi = 0;
  for (let i = 0; i < pts.length - 1; i++){ const L = Math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]); if (L > best){ best = L; bi = i; } }
  const mid = [(pts[bi][0] + pts[bi+1][0])/2, (pts[bi][1] + pts[bi+1][1])/2];
  return {d:roundedPath(pts, 7), mid:mid, pts:pts};
}
function textWidth(t, fallbackPx){
  let w = 0;
  try { w = t.getComputedTextLength(); } catch (err) { w = 0; }
  return w > 0 ? w : t.textContent.length * fallbackPx;
}

/* ───────── views: projections of the one laid-out graph ───────── */
function buildViews(){
  const defs = (MODEL.views && MODEL.views.length) ? MODEL.views : [{id:"all", title:"All components"}];
  return defs.map(v => {
    const zoneSet = v.zones ? new Set(v.zones) : null;
    let nodes;
    if (v.nodes){ const s = new Set(v.nodes); nodes = NODES.filter(n => s.has(n.id)); }
    else if (zoneSet) nodes = NODES.filter(n => zoneChain(n.zone).some(z => zoneSet.has(z)));
    else nodes = NODES.slice();
    nodes = nodes.filter(n => NP[n.id]);
    const zs = new Set();
    if (!v.zones && !v.nodes) ZONES.forEach(z => zs.add(z.id));
    (v.zones || []).forEach(z => zoneChain(z).forEach(a => zs.add(a)));
    nodes.forEach(n => zoneChain(n.zone).forEach(a => zs.add(a)));
    const zones = ZONES.filter(z => zs.has(z.id) && ZP[z.id]).map((z, i) => ({z:z, i:i, d:zoneDepth(z.id)}))
      .sort((a, b) => (a.d - b.d) || (a.i - b.i)).map(o => o.z);
    const ids = new Set(nodes.map(n => n.id));
    const edges = EDGES.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    return {id:v.id, title:v.title || v.id, role:viewRole(v), nodes:nodes, zones:zones, edges:edges, box:null};
  });
}
// The drawing box of a view; trust views leave room for the enclosures around their zones.
function viewBox(view, extra){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
  view.zones.forEach(z => { const r = ZP[z.id]; grow(r.x, r.y, r.w, r.h); });
  view.nodes.forEach(n => { const r = NP[n.id]; grow(r.x, r.y, r.w, r.h); });
  view.edges.forEach(e => edgePoints(e).forEach(p => grow(p[0], p[1], 0, 0)));
  if (!isFinite(x0)){ x0 = 0; y0 = 0; x1 = 400; y1 = 120; }
  const pad = 16 + (extra || 0);
  return {x:x0 - pad, y:y0 - pad, w:(x1 - x0) + 2*pad, h:(y1 - y0) + 2*pad};
}
const ALL_VIEWS = buildViews();

/* Figure scale: a diagram opens fitted to its panel (whole drawing visible, nothing clipped, no sideways scroll) while
   that keeps it legible; when the fit scale would fall below FIG_MIN_SCALE it opens at the floor and scrolls sideways
   instead. Fit (the whole drawing, however small) and 100% (natural size) stay one click away. The choice is kept per figure;
   __scale is "auto" (fit above the floor, else the floor), "fit" or "full". */
function setFigureScale(svg, naturalW){
  svg.__natW = Math.max(1, Math.round(naturalW));
  if (!svg.__scale) svg.__scale = "auto";
  const fig = svg.closest("figure");
  if (fig && !fig.querySelector(".fig-scale") && svg.parentNode){
    const bar = document.createElement("div");
    bar.className = "fig-scale";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Diagram scale");
    bar.style.cssText = "display:flex;gap:6px;align-items:center;justify-content:flex-end;padding:8px 14px 0";
    [["fit", "Fit"], ["full", "100%"]].forEach(a => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.dataset.scale = a[0]; b.textContent = a[1];
      b.addEventListener("click", () => { svg.__scale = a[0]; if (a[0] === "fit") svg.parentNode.scrollLeft = 0; applyFigureScale(svg); });
      bar.appendChild(b);
    });
    fig.insertBefore(bar, svg.parentNode);
  }
  // A panel that was hidden when drawn has no width yet: re-apply when it gets one, and when the window is resized.
  if (!svg.__ro && svg.parentNode && typeof ResizeObserver !== "undefined"){
    svg.__ro = new ResizeObserver(() => applyFigureScale(svg));
    svg.__ro.observe(svg.parentNode);
  }
  applyFigureScale(svg);
}
function applyFigureScale(svg){
  const avail = svg.parentNode ? svg.parentNode.clientWidth : 0;
  const fs = avail > 0 ? figureScale(svg.__natW, avail) : null;
  let mode = svg.__scale;
  if (mode === "auto") mode = fs && !fs.fitted ? "floor" : "fit";
  svg.style.minWidth = mode === "full" ? svg.__natW + "px" : mode === "floor" ? Math.round(svg.__natW * FIG_MIN_SCALE) + "px" : "0";
  svg.dataset.scaleMode = mode;
  const fig = svg.closest("figure");
  if (fig) fig.querySelectorAll(".fig-scale button").forEach(b => {
    const on = b.dataset.scale === mode;
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.style.borderColor = on ? "var(--accent)" : "";
    b.style.fontWeight = on ? "700" : "";
  });
}

function renderGraph(svg, view, opt){
  opt = opt || {};
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const b = viewBox(view, opt.trust ? 14 : 0);
  svg.setAttribute("viewBox", b.x + " " + b.y + " " + b.w + " " + b.h);
  setFigureScale(svg, b.w);
  addMarkers(svg);
  const gT = S("g", {class:"g-trust"}, svg), gZ = S("g", {class:"g-zones"}, svg), gE = S("g", {class:"g-edges"}, svg), gN = S("g", {class:"g-nodes"}, svg), gL = S("g", {class:"g-labels"}, svg), gZL = S("g", {class:"g-zlabels"}, svg);
  if (opt.trust){
    trustBoundaries(view.zones, ZP, ZONE).forEach(tb => {
      const g = S("g", {class:"tb " + (tb.trusted ? "trusted" : "untrusted"), "data-zone":tb.zone}, gT);
      S("rect", {x:tb.x, y:tb.y, width:tb.w, height:tb.h, rx:16}, g);
      const t = S("text", {x:tb.x + tb.w - 12, y:tb.y + 12, "text-anchor":"end"}, g);
      t.textContent = tb.trusted ? "Trust boundary" : "Outside the boundary";
    });
  }
  view.zones.forEach(z => {
    const r = ZP[z.id], sub = z.parent !== undefined && !!ZONE[z.parent], kind = zoneKind(z.id);
    const g = S("g", {class:"zone zc-" + kind + (sub ? " sub" : "") + (z.outside ? " outside" : ""), "data-zone":z.id}, gZ);
    S("rect", {x:r.x, y:r.y, width:r.w, height:r.h, rx:sub ? 8 : 12}, g);
    const lg = S("g", {class:"zone zc-" + kind}, gZL);
    const t = S("text", {x:r.x + 12, y:r.y + (sub ? 17 : 21), class:"zl"}, lg); t.textContent = z.label || z.id;
  });
  view.edges.forEach((e, i) => {
    const k = relOf(e.type), ty = REL[k], geo = edgeGeom(e);
    const cross = !!opt.trust && crossesTrust(NODE[e.from].zone, NODE[e.to].zone, ZONE);
    const g = S("g", {class:"edge t-" + k + (e.confidence === "inferred" ? " inferred" : "") + (cross ? " cross" : ""), "data-f":e.from, "data-t":e.to, "data-i":i, "data-k":k, "data-id":e.id}, gE);
    g.style.setProperty("--w", ty.w + "px");
    S("path", {d:geo.d, class:"hit"}, g);
    if (cross) S("path", {d:geo.d, class:"xhalo"}, g);
    S("path", {d:geo.d, class:"ln", "stroke-width":ty.w, "stroke-dasharray":ty.dash, "marker-end":"url(#" + svg.id + "-m-" + k + ")"}, g);
    const title = S("title", null, g);
    const fromN = NODE[e.from], toN = NODE[e.to];
    title.textContent = ty.label + ": " + fromN.title + " → " + toN.title + (e.desc || e.label ? " · " + (e.desc || e.label) : "") + (cross ? " · crosses a trust boundary" : "");
    const x = geo.mid[0], y = geo.mid[1];
    if (e.label){
      const lg = S("g", {class:"elabel t-" + k, "data-i":i, "data-k":k}, gL);
      const rect = S("rect", {x:x, y:y - 8.5, width:10, height:17, rx:8.5}, lg);
      const t = S("text", {x:x, y:y + 3.7, "text-anchor":"middle"}, lg); t.textContent = e.label;
      const w = textWidth(t, 5.7) + 14;
      rect.setAttribute("x", x - w/2); rect.setAttribute("width", w);
    }
    const iss = issuesOfEdge(e.id);
    if (iss.length){
      const lg = S("g", {class:"elabel t-" + k, "data-i":i, "data-k":k}, gL);
      const cx = x, cy = y - (e.label ? 14 : 0);
      S("circle", {cx:cx, cy:cy, r:7.5, class:"bdg sev-" + maxSev(iss)}, lg);
      const bt = S("text", {x:cx, y:cy + 3.5, class:"bdt", "text-anchor":"middle"}, lg); bt.textContent = iss.length;
    }
  });
  view.nodes.forEach(n => {
    const r = NP[n.id], kind = zoneKind(n.zone);
    const iss = issuesOfNode(n.id);
    const sub = (n.sub || []).filter(Boolean);
    const g = S("g", {class:"node zc-" + kind, "data-id":n.id}, gN);
    g.setAttribute("tabindex", "0"); g.setAttribute("role", "button"); g.setAttribute("aria-label", n.title + (sub.length ? ". " + sub.join(", ") : "") + (iss.length ? ". " + iss.length + " issue" + (iss.length > 1 ? "s" : "") : ""));
    S("rect", {x:r.x, y:r.y, width:r.w, height:r.h, rx:6, class:"nb"}, g);
    const single = sub.length === 0;
    const t = S("text", {x:r.x + 10, y:single ? r.y + r.h/2 + 4.4 : r.y + 19, class:"nt"}, g); t.textContent = n.title;
    sub.forEach((s, j) => { const st = S("text", {x:r.x + 10, y:r.y + 34 + j*13, class:"ns"}, g); st.textContent = s; });
    if (iss.length){
      const cx = r.x + r.w - 3, cy = r.y + 3;
      S("circle", {cx:cx, cy:cy, r:8.5, class:"bdg sev-" + maxSev(iss)}, g);
      const bt = S("text", {x:cx, y:cy + 3.5, class:"bdt", "text-anchor":"middle"}, g); bt.textContent = iss.length;
    }
  });
}

/* ───────── tabs ───────── */
const PANEL = {graph:"architecture", er:"er", crud:"crud", sequences:"sequences", deployment:"deployment", trust:"trust", issues:"issues"};
const drawn = {};
const DRAW = {};
let curTab = "graph";
function tabAvailable(name){ const b = document.querySelector('#navlist [data-tab="' + name + '"]'); return !!(b && !b.hidden && !(b.parentNode && b.parentNode.hidden)); }
function showTab(name, noHash){
  if (!PANEL[name] || !tabAvailable(name)) name = "graph";
  curTab = name;
  document.querySelectorAll("#navlist [data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false"));
  Object.keys(PANEL).forEach(k => { const el = $(PANEL[k]); if (el) el.hidden = k !== name; });
  if (!drawn[name]){ drawn[name] = true; if (DRAW[name]) DRAW[name](); }
  if (!noHash){ try { history.replaceState(null, "", "#" + PANEL[name]); } catch (err) { /* a sandboxed frame may refuse; the tab still changes */ } }
}

/* ───────── graph panes: architecture, deployment and trust each show their own views ───────── */
const PIN = {on:null};
function makePane(p, views, opt){
  const svg = $(p), tabsEl = $(p + "-tabs"), legendEl = $(p + "-legend"), keyEl = $(p + "-zonekey"), capEl = $(p + "-cap"), detailEl = $(p + "-detail");
  const VW = {}; views.forEach(v => { VW[v.id] = v; });
  const st = {view:views[0].id, sel:{}, hidden:new Set(), flag:[], pin:null};
  const q = sel => svg.querySelector(sel);
  const nodeEl = id => q('.node[data-id="' + CSS.escape(id) + '"]');

  function viewTypes(view){ const s = new Set(); view.edges.forEach(e => s.add(relOf(e.type))); return Object.keys(REL).filter(k => s.has(k)); }
  function chipHTML(k, pressed){
    const ty = REL[k];
    return '<button class="chip t-' + k + '" data-k="' + k + '" aria-pressed="' + (pressed ? "true" : "false") + '"><svg viewBox="0 0 26 10" aria-hidden="true"><line x1="1" y1="5" x2="19" y2="5" stroke="var(--ec)" stroke-width="' + Math.min(ty.w, 2.6) + '"' + (ty.dash ? ' stroke-dasharray="' + ty.dash + '"' : '') + ' stroke-linecap="round"/><path d="M18,1 L25,5 L18,9 z" fill="var(--ec)"/></svg><span>' + esc(ty.label) + '</span></button>';
  }
  function drawLegend(){
    const v = VW[st.view];
    legendEl.innerHTML = viewTypes(v).map(k => chipHTML(k, !st.hidden.has(k))).join("");
    legendEl.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
      const k = c.dataset.k;
      if (st.hidden.has(k)) st.hidden.delete(k); else st.hidden.add(k);
      c.setAttribute("aria-pressed", st.hidden.has(k) ? "false" : "true");
      applyHidden();
    }));
    const kinds = new Set(); v.zones.forEach(z => kinds.add(zoneKind(z.id))); v.nodes.forEach(n => kinds.add(zoneKind(n.zone)));
    keyEl.innerHTML = '<span class="zk">Zones</span>' + Object.keys(ZK).filter(k => kinds.has(k)).map(k => '<span class="zc-' + k + '"><i></i>' + esc(ZK[k]) + '</span>').join("") +
      (opt.trust ? '<span class="tbk"><i></i>Trust boundary (dashed); a haloed relation crosses it</span>' : '');
  }
  function applyHidden(){
    svg.querySelectorAll(".edge,.elabel").forEach(el => { el.style.display = st.hidden.has(el.dataset.k) ? "none" : ""; });
  }
  function clearFocus(){ svg.classList.remove("focusing"); svg.querySelectorAll(".hl").forEach(x => x.classList.remove("hl")); }
  function focusNode(id){
    clearFocus(); svg.classList.add("focusing");
    const node = nodeEl(id); if (node) node.classList.add("hl");
    svg.querySelectorAll(".edge").forEach(e => {
      if (e.dataset.f === id || e.dataset.t === id){
        e.classList.add("hl");
        svg.querySelectorAll('.elabel[data-i="' + e.dataset.i + '"]').forEach(l => l.classList.add("hl"));
        const other = e.dataset.f === id ? e.dataset.t : e.dataset.f;
        const on = nodeEl(other); if (on) on.classList.add("hl");
      }
    });
  }
  function focusEdge(i){
    clearFocus(); svg.classList.add("focusing");
    const e = q('.edge[data-i="' + i + '"]'); if (!e) return;
    e.classList.add("hl");
    svg.querySelectorAll('.elabel[data-i="' + i + '"]').forEach(l => l.classList.add("hl"));
    [e.dataset.f, e.dataset.t].forEach(id => { const n = nodeEl(id); if (n) n.classList.add("hl"); });
  }
  // A pinned highlight (path finder, lineage) stays until cleared; hover focus works on top of it.
  function applyPin(){
    svg.classList.toggle("pinning", !!st.pin);
    svg.querySelectorAll(".pin").forEach(x => x.classList.remove("pin"));
    if (!st.pin) return;
    st.pin.nodes.forEach(id => { const n = nodeEl(id); if (n) n.classList.add("pin"); });
    const ids = new Set(st.pin.edges);
    svg.querySelectorAll(".edge").forEach(e => {
      if (!ids.has(e.dataset.id)) return;
      e.classList.add("pin");
      svg.querySelectorAll('.elabel[data-i="' + e.dataset.i + '"]').forEach(l => l.classList.add("pin"));
    });
  }
  function renderDetail(id){
    const v = VW[st.view], n = v.nodes.find(x => x.id === id);
    if (!n){ detailEl.innerHTML = ""; return; }
    const iss = issuesOfNode(id);
    const conns = v.edges.map(e => {
      if (e.from !== id && e.to !== id) return "";
      const out = e.from === id, other = NODE[out ? e.to : e.from], k = relOf(e.type);
      const eiss = issuesOfEdge(e.id);
      return '<li class="t-' + k + '"><i></i><span>' + (out ? "→ " : "← ") + '<b>' + esc(other.title) + '</b> <span class="muted">· ' + esc(REL[k].label) + '</span>' +
        (e.desc || e.label ? '<br><span class="muted">' + codeify(e.desc || e.label) + '</span>' : '') +
        (eiss.length ? '<br>' + eiss.map(issueLink).join(" ") : '') + '</span></li>';
    }).join("");
    const ev = (n.evidence || []).map(x => evidenceChip(x.path, x.lines)).join("");
    const data = ACCESS.filter(a => a.node === id);
    detailEl.innerHTML =
      '<div class="d-head"><span class="zchip zc-' + zoneKind(n.zone) + '">' + esc((ZONE[n.zone] && ZONE[n.zone].label) || n.zone) + '</span><h3>' + esc(n.title) + '</h3></div>' +
      (n.role ? '<p class="d-role">' + codeify(n.role) + '</p>' : '') +
      '<div class="d-cols">' +
        '<div><h4>Facts</h4>' + ((n.facts && n.facts.length) ? '<ul>' + n.facts.map(f => '<li>' + codeify(f) + '</li>').join("") + '</ul>' : '<p class="muted">Nothing beyond the label.</p>') + '</div>' +
        '<div><h4>Connections</h4>' + (conns ? '<ul class="conn">' + conns + '</ul>' : '<p class="muted">None drawn.</p>') + '</div>' +
        (data.length ? '<div><h4>Data access</h4><ul class="dacc">' + data.map(a => '<li><button class="lnk" data-entity="' + esc(a.entity) + '">' + esc((ENTITY[a.entity] && ENTITY[a.entity].name) || a.entity) + '</button> <span class="opset">' + esc(a.ops) + '</span></li>').join("") + '</ul></div>' : '') +
        '<div><h4>Evidence</h4>' + (ev ? '<div class="refs">' + ev + '</div>' : '<p class="muted">None recorded.</p>') + '</div>' +
        (HAS_ISSUES ? '<div class="issues-only"><h4>Issues</h4>' + (iss.length ? '<ul class="conn">' + iss.map(i => '<li><span></span>' + issueLink(i) + '</li>').join("") + '</ul>' : '<p class="muted">No open issues found here.</p>') + '</div>' : '') +
      '</div>';
    wireIssueLinks(detailEl);
    detailEl.querySelectorAll("button[data-entity]").forEach(b => b.addEventListener("click", () => goEntity(b.dataset.entity)));
  }
  function select(id){
    st.sel[st.view] = id;
    svg.querySelectorAll(".node.sel").forEach(x => x.classList.remove("sel"));
    const n = id ? nodeEl(id) : null; if (n) n.classList.add("sel");
    renderDetail(id);
  }
  function draw(){
    const v = VW[st.view];
    renderGraph(svg, v, {trust:!!opt.trust});
    capEl.textContent = v.nodes.length + " components, " + v.edges.length + " relations" + (v.nodes.length ? "" : ". Run layout.mjs: this view has no positioned component.");
    drawLegend(); applyHidden();
    svg.querySelectorAll(".node").forEach(g => {
      const id = g.dataset.id;
      g.addEventListener("mouseenter", () => focusNode(id));
      g.addEventListener("mouseleave", clearFocus);
      g.addEventListener("focus", () => focusNode(id));
      g.addEventListener("blur", clearFocus);
      g.addEventListener("click", () => select(id));
      g.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); select(id); } if (ev.key === "Escape") clearFocus(); });
    });
    svg.querySelectorAll(".edge").forEach(g => {
      g.addEventListener("mouseenter", () => focusEdge(g.dataset.i));
      g.addEventListener("mouseleave", clearFocus);
    });
    st.flag.forEach(id => { const n = nodeEl(id); if (n) n.classList.add("flag"); });
    applyPin();
    select(st.sel[st.view] || (v.nodes[0] && v.nodes[0].id));
  }
  function setView(id){
    if (!VW[id]) return;
    st.view = id; st.flag = [];
    tabsEl.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.view === id ? "true" : "false"));
    if (drawn[opt.tab]) draw();
  }
  tabsEl.innerHTML = views.length > 1 ? views.map(v => '<button class="tab" role="tab" data-view="' + esc(v.id) + '" aria-selected="' + (v.id === st.view ? "true" : "false") + '">' + esc(v.title) + '</button>').join("") : "";
  tabsEl.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  return {
    views:views, st:st, draw:draw, setView:setView, select:select,
    // The view that shows most of the given nodes: the current one when it shows all of them.
    bestView(ids){
      const count = v => ids.filter(id => v.nodes.some(n => n.id === id)).length;
      if (count(VW[st.view]) === ids.length) return VW[st.view];
      return views.slice().sort((a, b) => count(b) - count(a))[0];
    },
    pin(set){ st.pin = set; applyPin(); },
    redrawIfShown(){ if (drawn[opt.tab]) draw(); }
  };
}

const roleViews = role => ALL_VIEWS.filter(v => v.role === role);
const graphViews = (() => { const g = roleViews("graph"); return g.length ? g : ALL_VIEWS; })();
const PANES = {graph:makePane("arch", graphViews, {tab:"graph"})};
if (roleViews("deployment").length) PANES.deployment = makePane("dep", roleViews("deployment"), {tab:"deployment"});
if (roleViews("trust").length) PANES.trust = makePane("trs", roleViews("trust"), {tab:"trust", trust:true});
Object.keys(PANES).forEach(k => { DRAW[k] = () => PANES[k].draw(); });
const GP = PANES.graph;

function goNode(id){
  if (!NODE[id]) return;
  const view = GP.bestView([id]);
  GP.st.sel[view.id] = id;
  showTab("graph");
  GP.setView(view.id);
  GP.select(id);
  $("architecture").scrollIntoView();
}
function setPin(pin, label){
  GP.pin(pin);
  const bar = $("pinbar");
  bar.hidden = !pin;
  $("pintext").textContent = pin ? label : "";
}
$("pinclear").addEventListener("click", () => { $("pf-out").textContent = ""; setPin(null); });
function pinInGraph(nodes, edges, label){
  const view = GP.bestView(nodes);
  showTab("graph");
  GP.setView(view.id);
  setPin({nodes:nodes, edges:edges}, label);
  const shown = nodes.filter(id => view.nodes.some(n => n.id === id)).length;
  if (shown < nodes.length) $("pf-out").textContent = (nodes.length - shown) + " of " + nodes.length + " components are not part of the view '" + view.title + "'.";
}
function goEdge(id){
  const e = EDGES.find(x => x.id === id); if (!e) return;
  pinInGraph([e.from, e.to], [e.id], "Relation: " + NODE[e.from].title + " → " + NODE[e.to].title);
  $("architecture").scrollIntoView();
}

/* ───────── path finder ───────── */
(function(){
  const from = $("pf-from"), to = $("pf-to"), out = $("pf-out");
  const sorted = NODES.slice().sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const opts = '<option value="">…</option>' + sorted.map(n => '<option value="' + esc(n.id) + '">' + esc(n.title) + '</option>').join("");
  from.innerHTML = opts; to.innerHTML = opts;
  function go(){
    out.textContent = "";
    if (!from.value || !to.value){ out.textContent = "Choose two components."; return; }
    const res = findPath(EDGES, from.value, to.value);
    if (!res){ setPin(null); out.textContent = "No path between " + NODE[from.value].title + " and " + NODE[to.value].title + "."; return; }
    const names = res.nodes.map(id => NODE[id].title).join(" → ");
    pinInGraph(res.nodes, res.edges, "Path (" + res.edges.length + (res.edges.length === 1 ? " hop" : " hops") + "): " + names);
  }
  $("pf-go").addEventListener("click", go);
  [from, to].forEach(s => s.addEventListener("keydown", ev => { if (ev.key === "Enter") go(); }));
})();

/* ───────── ER ───────── */
const ER = {sel:null, scene:null};
const erSvg = $("ersvg");
function entityIssueMap(){
  const m = {};
  ENTITIES.forEach(e => { const ids = issuesOfEntity(e.id); if (ids.length) m[e.id] = {count:ids.length, sev:maxSev(ids)}; });
  return m;
}
function drawEr(){
  const mk = erMarkup(MODEL, LAYOUT.er, {issues:entityIssueMap()});
  erSvg.setAttribute("viewBox", mk.viewBox);
  setFigureScale(erSvg, mk.width);
  erSvg.innerHTML = mk.inner;
  ER.scene = mk.scene;
  $("er-cap").textContent = mk.scene.cards.length + " entities, " + mk.scene.relations.length + " relations" + (mk.scene.cards.length < ENTITIES.length ? ". Run layout.mjs: " + (ENTITIES.length - mk.scene.cards.length) + " entities have no position." : "");
  erSvg.querySelectorAll(".ent").forEach(g => {
    const id = g.dataset.entity;
    g.addEventListener("mouseenter", () => erFocus(id));
    g.addEventListener("mouseleave", () => erFocus(null));
    g.addEventListener("focus", () => erFocus(id));
    g.addEventListener("blur", () => erFocus(null));
    g.addEventListener("click", () => erSelect(id));
    g.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); erSelect(id); } });
  });
  erSelect(ER.sel && ENTITY[ER.sel] ? ER.sel : (mk.scene.cards[0] && mk.scene.cards[0].id));
}
function erFocus(id){
  erSvg.classList.toggle("focusing", !!id);
  erSvg.querySelectorAll(".hl").forEach(x => x.classList.remove("hl"));
  if (!id) return;
  const card = erSvg.querySelector('.ent[data-entity="' + CSS.escape(id) + '"]'); if (card) card.classList.add("hl");
  erSvg.querySelectorAll(".rel").forEach(r => {
    if (r.dataset.from !== id && r.dataset.to !== id) return;
    r.classList.add("hl");
    const other = r.dataset.from === id ? r.dataset.to : r.dataset.from;
    const oc = erSvg.querySelector('.ent[data-entity="' + CSS.escape(other) + '"]'); if (oc) oc.classList.add("hl");
  });
}
function erSelect(id){
  ER.sel = id || null;
  erSvg.querySelectorAll(".ent.sel").forEach(x => x.classList.remove("sel"));
  const card = id ? erSvg.querySelector('.ent[data-entity="' + CSS.escape(id) + '"]') : null; if (card) card.classList.add("sel");
  renderEntityDetail(id);
}
function provChip(p){ return '<span class="pchip prov-' + esc(p) + '">' + esc(p) + '</span>'; }
function renderEntityDetail(id){
  const el = $("er-detail"), e = ENTITY[id];
  if (!e){ el.innerHTML = ""; return; }
  const scene = ER.scene, card = scene && scene.cards.find(c => c.id === id);
  const iss = issuesOfEntity(id);
  const store = NODE[e.store];
  const rows = (card ? card.fields : []).map((f, i) => {
    const src = (e.fields || [])[i] || {};
    return '<tr class="prov-' + esc(f.prov) + '"><td>' + (f.pk ? '<span class="mkb mk-pk">PK</span>' : '') + (f.fk ? '<span class="mkb mk-fk">FK</span>' : '') + '</td><td><code>' + esc(f.name) + '</code></td><td>' + esc(f.type) + (f.nullable ? " · nullable" : "") + '</td><td>' + provChip(f.prov) + '</td><td>' +
      (f.fkTo ? '→ <code>' + esc(f.fkTo) + '</code> ' : '') + (src.evidence || []).map(x => evidenceChip(x.path, x.lines)).join("") + '</td></tr>';
  }).join("");
  const rels = relationKeys(MODEL).filter(r => r.rel.from.entity === id || r.rel.to.entity === id).map(({rel}) => {
    const out = rel.from.entity === id, other = out ? rel.to : rel.from;
    return '<li><span>' + (out ? "→ " : "← ") + '<button class="lnk" data-entity="' + esc(other.entity) + '">' + esc((ENTITY[other.entity] && ENTITY[other.entity].name) || other.entity) + '</button> <span class="muted">· <code>' + esc(out ? rel.from.field : rel.to.field) + '</code> ' + (out ? "references" : "is referenced by") + ' <code>' + esc(other.field) + '</code> · ' + esc(rel.cardinality) + ' · ' + esc(rel.kind) + '</span> ' + provChip(rel.provenance || "declared") + '</span></li>';
  }).join("");
  const acc = ACCESS.filter(a => a.entity === id).map(a => '<li><button class="lnk" data-node="' + esc(a.node) + '">' + esc((NODE[a.node] && NODE[a.node].title) || a.node) + '</button> <span class="opset">' + esc(a.ops) + '</span> <span class="refs">' + (a.evidence || []).map(x => evidenceChip(x.path, x.lines)).join("") + '</span></li>').join("");
  const idx = (e.indexes || []).map(x => '<li><code>' + esc(x.name) + '</code> (' + esc((x.fields || []).join(", ")) + ')' + (x.unique ? ' · unique' : '') + '</li>').join("");
  const ev = (e.evidence || []).map(x => evidenceChip(x.path, x.lines)).join("");
  el.innerHTML =
    '<div class="d-head"><span class="zchip zc-data">' + esc(e.kind || "table") + '</span><h3>' + esc(e.name || e.id) + '</h3>' +
      '<span class="muted">in ' + (store ? '<button class="lnk" data-node="' + esc(e.store) + '">' + esc(store.title) + '</button>' : esc(e.store)) + '</span>' +
      (ACCESS.some(a => a.entity === id) ? '<button class="btn" id="lin-go">Highlight lineage in the graph</button>' : '') + '</div>' +
    '<div class="tablewrap"><table class="ftable"><thead><tr><th>Key</th><th>Field</th><th>Type</th><th>Provenance</th><th>References and evidence</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="d-cols">' +
      '<div><h4>Relations</h4>' + (rels ? '<ul class="conn plain">' + rels + '</ul>' : '<p class="muted">None.</p>') + '</div>' +
      '<div><h4>Accessed by</h4>' + (acc ? '<ul class="conn plain">' + acc + '</ul>' : '<p class="muted">No access rows.</p>') + '</div>' +
      '<div><h4>Indexes</h4>' + (idx ? '<ul class="plain">' + idx + '</ul>' : '<p class="muted">None.</p>') + '</div>' +
      '<div><h4>Evidence</h4>' + (ev ? '<div class="refs">' + ev + '</div>' : '<p class="muted">None recorded.</p>') + '</div>' +
      (HAS_ISSUES ? '<div class="issues-only"><h4>Issues</h4>' + (iss.length ? '<ul class="conn">' + iss.map(i => '<li><span></span>' + issueLink(i) + '</li>').join("") + '</ul>' : '<p class="muted">No open issues found here.</p>') + '</div>' : '') +
    '</div>';
  wireIssueLinks(el);
  el.querySelectorAll("button[data-entity]").forEach(b => b.addEventListener("click", () => goEntity(b.dataset.entity)));
  el.querySelectorAll("button[data-node]").forEach(b => b.addEventListener("click", () => goNode(b.dataset.node)));
  const lg = $("lin-go"); if (lg) lg.addEventListener("click", () => goLineage(id));
}
function goEntity(id){
  if (!ENTITY[id]) return;
  ER.sel = id;
  showTab("er");
  erSelect(id);
  const c = erSvg.querySelector('.ent[data-entity="' + CSS.escape(id) + '"]'); if (c && c.scrollIntoView) c.scrollIntoView({block:"nearest", inline:"center"});
}
function goLineage(id){
  const lin = lineageOf(MODEL, id, 2); if (!lin) return;
  $("pf-out").textContent = "";
  pinInGraph(lin.nodes, lin.edges, "Lineage of " + ((ENTITY[id] && ENTITY[id].name) || id) + ": " + lin.access.length + " accessing component" + (lin.access.length === 1 ? "" : "s") + ", with their callers upstream");
  $("architecture").scrollIntoView();
}
$("er-key").innerHTML =
  '<span class="ekey"><svg viewBox="0 0 34 12" aria-hidden="true"><path d="M2,6 H22" class="ln"/><path d="M22,6 L32,0 M22,6 L32,6 M22,6 L32,12" class="cf"/></svg>many</span>' +
  '<span class="ekey"><svg viewBox="0 0 34 12" aria-hidden="true"><path d="M2,6 H32" class="ln"/><path d="M26,0 V12" class="cf"/></svg>one</span>' +
  '<span class="ekey"><span class="mkb mk-pk">PK</span> primary key</span><span class="ekey"><span class="mkb mk-fk">FK</span> foreign key or reference</span>' +
  '<span class="ekey prov-declared"><i></i>declared</span><span class="ekey prov-observed"><i></i>observed</span><span class="ekey prov-inferred"><i></i>inferred</span>';
DRAW.er = drawEr;

/* ───────── CRUD matrix ───────── */
function drawCrud(){
  const wrap = $("crud-wrap");
  wrap.innerHTML = crudHtml(MODEL);
  wrap.querySelectorAll("button[data-entity]").forEach(b => b.addEventListener("click", () => goEntity(b.dataset.entity)));
  wrap.querySelectorAll("th button[data-node]").forEach(b => b.addEventListener("click", () => goNode(b.dataset.node)));
  wrap.querySelectorAll("td.cell").forEach(td => td.addEventListener("click", () => crudCell(td)));
  const mx = crudMatrix(MODEL);
  $("crud-cap").textContent = mx.nodes.length + " components, " + mx.entities.length + " entities, " + mx.cells.size + " access rows.";
  crudCell(wrap.querySelector("td.cell"));
}
function crudCell(td){
  const el = $("crud-detail");
  $("crud-wrap").querySelectorAll("td.sel").forEach(x => x.classList.remove("sel"));
  if (!td){ el.innerHTML = ""; return; }
  td.classList.add("sel");
  const node = NODE[td.dataset.node], ent = ENTITY[td.dataset.entity];
  const c = crudMatrix(MODEL).cells.get(td.dataset.node + "\u0000" + td.dataset.entity);
  el.innerHTML =
    '<div class="d-head"><h3><button class="lnk" data-node="' + esc(node.id) + '">' + esc(node.title) + '</button> on <button class="lnk" data-entity="' + esc(ent.id) + '">' + esc(ent.name || ent.id) + '</button></h3><span class="opset">' + esc(c.ops) + '</span> <span class="muted">' + esc(opsWords(c.ops)) + '</span>' +
    '<button class="btn" id="crud-lin">Highlight lineage in the graph</button></div>' +
    '<div><h4>Evidence</h4>' + (c.evidence.length ? '<div class="refs">' + c.evidence.map(x => evidenceChip(x.path, x.lines)).join("") + '</div>' : '<p class="muted">None recorded.</p>') + '</div>';
  el.querySelectorAll("button[data-entity]").forEach(b => b.addEventListener("click", () => goEntity(b.dataset.entity)));
  el.querySelectorAll("button[data-node]").forEach(b => b.addEventListener("click", () => goNode(b.dataset.node)));
  $("crud-lin").addEventListener("click", () => goLineage(ent.id));
}
$("crud-key").innerHTML = OPS.map(o => '<span class="ekey"><span class="op op-' + o[0].toLowerCase() + '">' + o[0] + '</span>' + o[1] + '</span>').join("");
DRAW.crud = drawCrud;

/* ───────── sequences ───────── */
const seqSvg = $("seq");
const seqState = {id:SEQS.length ? SEQS[0].id : null, cur:{}};
const SEQ = {}; SEQS.forEach(s => { SEQ[s.id] = s; });
function wrapText(s, max){
  const words = String(s).split(" "), lines = []; let line = "";
  words.forEach(w => { if ((line + " " + w).trim().length > max){ if (line) lines.push(line); line = w; } else line = (line + " " + w).trim(); });
  if (line) lines.push(line);
  return lines;
}
function renderSeq(seq){
  const svg = seqSvg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  addMarkers(svg);
  const P = seq.participants || [], n = Math.max(1, P.length), M = 92;
  const colW = n > 1 ? Math.min(196, Math.max(150, (1200 - 2*M) / (n - 1))) : 196;
  const W = 2*M + colW*(n - 1);
  const X = {}; P.forEach((p, i) => { X[p.id] = M + i*colW; });
  let y = 82; const rows = [], frags = [], stack = []; let no = 0;
  (seq.steps || []).forEach((st, idx) => {
    if (st.frag){
      if (st.frag === "end"){ const f = stack.pop(); if (f){ f.y1 = y + 2; y += 12; } }
      else if (st.frag === "else"){ if (stack.length){ stack[stack.length - 1].elses.push({y:y + 4, t:st.t}); y += 24; } }
      else { const f = {kind:st.frag, t:st.t, y0:y, depth:stack.length, elses:[]}; stack.push(f); frags.push(f); y += 30; }
      return;
    }
    if (st.note){
      const ids = [].concat(st.note).filter(id => X[id] !== undefined); if (!ids.length) return;
      const xs = ids.map(id => X[id]);
      let x0 = Math.min.apply(null, xs) - 64, x1 = Math.max.apply(null, xs) + 64;
      if (ids.length === 1){ x0 = X[ids[0]] - 90; x1 = X[ids[0]] + 90; }
      const lines = wrapText(st.t, Math.max(20, Math.floor((x1 - x0 - 26) / 5.9)));
      const h = 12 + lines.length*15;
      rows.push({type:"note", idx:idx, x0:x0, x1:x1, y:y + 4, h:h, lines:lines, tone:st.tone, iss:issuesOfStep(seq.id, idx, st)});
      y += h + 16; return;
    }
    if (!st.m || X[st.m[0]] === undefined || X[st.m[1]] === undefined) return;
    no++;
    const self = st.m[0] === st.m[1];
    rows.push(Object.assign({type:"msg", idx:idx, no:no, y0:y, yy:y + (self ? 20 : 26), rh:self ? 48 : 38, iss:issuesOfStep(seq.id, idx, st)}, st));
    y += self ? 48 : 38;
  });
  stack.forEach(f => { f.y1 = y + 2; });
  const H = y + 26;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  setFigureScale(svg, W);
  const gB = S("g", null, svg), gF = S("g", null, svg), gLf = S("g", null, svg), gM = S("g", null, svg), gH = S("g", null, svg);
  P.forEach(p => S("line", {x1:X[p.id], y1:58, x2:X[p.id], y2:H - 10, class:"life"}, gLf));
  frags.forEach(f => {
    const x0 = 16 + f.depth*8, x1 = W - 16 - f.depth*8;
    const g = S("g", {class:"frag"}, gF);
    S("rect", {class:"box", x:x0, y:f.y0, width:x1 - x0, height:f.y1 - f.y0, rx:4}, g);
    const lab = S("text", {x:x0 + 8, y:f.y0 + 14}, g);
    const kb = S("tspan", {class:"fk"}, lab); kb.textContent = f.kind.toUpperCase();
    const kt = S("tspan", {dx:"6"}, lab); kt.textContent = "[" + f.t + "]";
    f.elses.forEach(e => {
      S("line", {x1:x0, y1:e.y, x2:x1, y2:e.y}, g);
      const et = S("text", {x:x0 + 8, y:e.y + 14}, g); et.textContent = "[" + e.t + "]";
    });
  });
  rows.forEach(r => {
    if (r.type === "note"){
      const g = S("g", {class:"note" + (r.tone === "warn" ? " warn" : "")}, gM);
      S("rect", {x:r.x0, y:r.y, width:r.x1 - r.x0, height:r.h, rx:5}, g);
      r.lines.forEach((ln, j) => { const t = S("text", {x:r.x0 + 10, y:r.y + 18 + j*15}, g); t.textContent = ln; });
      if (r.iss.length) S("circle", {cx:r.x1 - 2, cy:r.y + 2, r:6.5, class:"idot sev-" + maxSev(r.iss)}, g);
      return;
    }
    const ty = relOf(r.k), x1 = X[r.m[0]], x2 = X[r.m[1]], self = r.m[0] === r.m[1];
    const g = S("g", {class:"msg t-" + ty + (r.ret ? " ret" : ""), "data-no":r.no, tabindex:"-1"}, gM);
    S("rect", {class:"rowbg t-" + ty, x:8, y:r.y0 + 2, width:W - 16, height:r.rh - 4, rx:4, "data-no":r.no}, gB);
    S("rect", {class:"hit", x:Math.min(x1, x2) - 14, y:r.y0 + 2, width:Math.abs(x2 - x1) + (self ? 220 : 28), height:r.rh - 4}, g);
    let d;
    if (self) d = "M" + x1 + "," + (r.yy - 6) + " h34 v16 h-29";
    else { const dir = x2 > x1 ? 1 : -1; d = "M" + (x1 + dir*3) + "," + r.yy + " L" + (x2 - dir*4) + "," + r.yy; }
    S("path", {d:d, class:"ln", "marker-end":"url(#" + seqSvg.id + (r.ret ? "-r-" : "-m-") + ty + ")"}, g);
    const pill = S("rect", {class:"pill", height:18, rx:9}, g);
    const circ = S("circle", {class:"num", r:7.5}, g);
    const ct = S("text", {class:"numt", "text-anchor":"middle"}, g); ct.textContent = r.no;
    const t = S("text", {class:"mt"}, g); t.textContent = r.t;
    const tw = textWidth(t, 6.1);
    const extra = r.iss.length ? 16 : 0;
    const pw = tw + 30 + extra;
    let px, py;
    if (self){ px = x1 + 42; py = r.yy - 7; if (px + pw > W - 8) px = x1 - 8 - pw; }
    else { px = (x1 + x2)/2 - pw/2; py = r.yy - 22; }
    px = Math.max(8, Math.min(px, W - 8 - pw));
    pill.setAttribute("x", px); pill.setAttribute("y", py); pill.setAttribute("width", pw);
    circ.setAttribute("cx", px + 10); circ.setAttribute("cy", py + 9);
    ct.setAttribute("x", px + 10); ct.setAttribute("y", py + 12.3);
    t.setAttribute("x", px + 22); t.setAttribute("y", py + 13);
    if (r.iss.length) S("circle", {class:"idot sev-" + maxSev(r.iss), cx:px + pw - 10, cy:py + 9, r:4.5}, g);
    g.addEventListener("click", () => setStep(r.no));
  });
  P.forEach(p => {
    const g = S("g", {class:"participant" + (p.zone && ZONE[p.zone] ? " zc-" + zoneKind(p.zone) : "")}, gH);
    S("rect", {x:X[p.id] - 70, y:12, width:140, height:46, rx:7}, g);
    const t = S("text", {x:X[p.id], y:31, class:"pt", "text-anchor":"middle"}, g); t.textContent = p.label;
    const s = S("text", {x:X[p.id], y:46, class:"ps", "text-anchor":"middle"}, g); s.textContent = p.sub || "";
  });
  seq._rows = rows.filter(r => r.type === "msg");
}
function setStep(no){
  const seq = SEQ[seqState.id]; if (!seq) return;
  const msgs = seq._rows; if (!msgs || !msgs.length){ $("stepbox").innerHTML = '<p class="muted">This sequence has no messages.</p>'; return; }
  no = Math.max(1, Math.min(msgs.length, no));
  seqState.cur[seq.id] = no;
  seqSvg.querySelectorAll(".msg.cur,.rowbg.cur").forEach(x => x.classList.remove("cur"));
  seqSvg.querySelectorAll('[data-no="' + no + '"]').forEach(x => x.classList.add("cur"));
  const r = msgs[no - 1], k = relOf(r.k);
  const P = seq.participants || [];
  const from = P.find(p => p.id === r.m[0]), to = P.find(p => p.id === r.m[1]);
  const box = $("stepbox");
  box.className = "stepbox t-" + k;
  const refs = (r.r || []).map(refChip).join("") + r.iss.map(issueLink).join("");
  box.innerHTML =
    '<div class="sl"><span class="sn">Step ' + no + ' of ' + msgs.length + '</span><span class="sm">' + esc(r.t) + '</span></div>' +
    '<p class="muted">' + esc(from.label) + (from === to ? " (internal)" : " → " + esc(to.label)) + ' · ' + esc(REL[k].label) + (r.ret ? " · response" : "") + '</p>' +
    (r.d ? '<p>' + codeify(r.d) + '</p>' : '') +
    (refs ? '<div class="refs">' + refs + '</div>' : '');
  wireIssueLinks(box);
  $("seqprev").disabled = no <= 1;
  $("seqnext").disabled = no >= msgs.length;
}
// The message number of a step index (a fragment or note maps to the next message).
function stepNo(seq, idx){
  const msgs = seq._rows || [];
  const r = msgs.find(m => m.idx >= idx);
  return r ? r.no : msgs.length;
}
function setSeq(id){
  const seq = SEQ[id]; if (!seq) return;
  seqState.id = id;
  document.querySelectorAll("#seqtabs .tab").forEach(b => b.setAttribute("aria-selected", b.dataset.seq === id ? "true" : "false"));
  $("seqsum").textContent = seq.summary || "";
  renderSeq(seq);
  setStep(seqState.cur[id] || 1);
}
$("seqtabs").innerHTML = SEQS.map(s => '<button class="tab" role="tab" data-seq="' + esc(s.id) + '" aria-selected="false">' + esc(s.title) + '</button>').join("");
document.querySelectorAll("#seqtabs .tab").forEach(b => b.addEventListener("click", () => setSeq(b.dataset.seq)));
$("seqprev").addEventListener("click", () => setStep((seqState.cur[seqState.id] || 1) - 1));
$("seqnext").addEventListener("click", () => setStep((seqState.cur[seqState.id] || 1) + 1));
seqSvg.addEventListener("keydown", ev => {
  if (ev.key === "ArrowRight" || ev.key === "ArrowDown"){ ev.preventDefault(); setStep((seqState.cur[seqState.id] || 1) + 1); }
  if (ev.key === "ArrowLeft" || ev.key === "ArrowUp"){ ev.preventDefault(); setStep((seqState.cur[seqState.id] || 1) - 1); }
});
if (!SEQS.length){
  $("stepbox").innerHTML = '<p class="muted">The model has no sequences.</p>';
  $("seqprev").disabled = true; $("seqnext").disabled = true;
}
DRAW.sequences = () => { if (seqState.id) setSeq(seqState.id); };

/* ───────── issues (internal and shared builds only) ───────── */
const findingsEl = $("findings");
function anchorText(a){
  if (!a) return "";
  if (a.node !== undefined) return NODE[a.node] ? NODE[a.node].title : a.node;
  if (a.edge !== undefined){ const e = EDGES.find(x => x.id === a.edge); return e && NODE[e.from] && NODE[e.to] ? NODE[e.from].title + " → " + NODE[e.to].title : a.edge; }
  if (a.entity !== undefined) return a.entity;
  if (a.step !== undefined){ const cut = a.step.lastIndexOf(":"), s = SEQ[a.step.slice(0, cut)]; return s ? s.title + ", step" : a.step; }
  return "";
}
function renderIssues(){
  if (!findingsEl) return;
  const list = ISSUES.map(i => i.id).sort(bySev).map(id => ISS[id]);
  findingsEl.innerHTML = list.length ? list.map(x =>
    '<article class="finding sev-' + esc(x.sev) + '" id="issue-' + esc(x.id) + '" data-sev="' + esc(x.sev) + '">' +
      '<div class="fh"><span class="sev sev-' + esc(x.sev) + '">' + esc(SEVN[x.sev] || x.sev) + '</span><span class="iid">' + esc(x.id) + '</span><h3>' + esc(x.title) + '</h3>' +
      '<span class="area">' + esc(x.category) + '</span>' + (x.track ? '<span class="track">' + esc(x.track) + '</span>' : '') +
      (anchorText(x.anchor) ? '<button class="btn showon" data-id="' + esc(x.id) + '">Show: ' + esc(anchorText(x.anchor)) + '</button>' : '') + '</div>' +
      '<dl><dt>Summary</dt><dd>' + codeify(x.summary || "") + '</dd><dt>Impact</dt><dd>' + codeify(x.impact || "") + '</dd></dl>' +
      '<dl><dt>Fix</dt><dd>' + codeify(x.fix || "") + '</dd>' +
        ((x.evidence && x.evidence.length) ? '<dt>Evidence</dt><dd class="refs">' + x.evidence.map(e => evidenceChip(e.path, e.lines)).join("") + '</dd>' : '') + '</dl>' +
      (x.detail ? '<dl class="full"><dt>Detail</dt><dd>' + codeify(x.detail) + '</dd></dl>' : '') +
    '</article>').join("") : '<p class="empty">No issues recorded.</p>';
  const counts = {high:0, med:0, low:0}; ISSUES.forEach(x => { if (counts[x.sev] !== undefined) counts[x.sev]++; });
  $("tally").innerHTML = ["high","med","low"].map(s => '<span class="sev-' + s + '"><b>' + counts[s] + '</b>' + SEVN[s] + '</span>').join("");
  document.querySelectorAll("#sevtabs .tab").forEach(b => b.addEventListener("click", () => {
    const s = b.dataset.sev;
    document.querySelectorAll("#sevtabs .tab").forEach(x => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    findingsEl.querySelectorAll(".finding").forEach(f => { f.hidden = !(s === "all" || f.dataset.sev === s); });
  }));
  findingsEl.querySelectorAll(".showon").forEach(b => b.addEventListener("click", () => showAnchor(ISS[b.dataset.id])));
}
DRAW.issues = renderIssues;
// Bring an issue's anchor into view: its component on the first view that holds it, flagged and selected;
// its entity in the ER tab; or its sequence step.
function showAnchor(x){
  const a = x && x.anchor; if (!a) return;
  if (a.step !== undefined){
    const cut = a.step.lastIndexOf(":"), seq = SEQ[a.step.slice(0, cut)]; if (!seq) return;
    showTab("sequences");
    setSeq(seq.id); setStep(stepNo(seq, Number(a.step.slice(cut + 1))));
    $("sequences").scrollIntoView(); return;
  }
  if (a.entity !== undefined && ENTITY[a.entity] && tabAvailable("er")){ goEntity(a.entity); $("er").scrollIntoView(); return; }
  let ids = [];
  if (a.node !== undefined) ids = [a.node];
  else if (a.entity !== undefined && ENTITY_STORE[a.entity]) ids = [ENTITY_STORE[a.entity]];
  else if (a.edge !== undefined){ const e = EDGES.find(y => y.id === a.edge); if (e) ids = [e.from, e.to]; }
  if (!ids.length) return;
  const v = GP.bestView(ids);
  showTab("graph");
  GP.setView(v.id);
  GP.st.flag = ids.slice(); GP.st.sel[v.id] = ids[0];
  GP.draw();
  $("architecture").scrollIntoView();
}
function gotoIssue(id){
  if (!findingsEl) return;
  showTab("issues");
  document.querySelectorAll("#sevtabs .tab").forEach(x => x.setAttribute("aria-selected", x.dataset.sev === "all" ? "true" : "false"));
  findingsEl.querySelectorAll(".finding").forEach(f => { f.hidden = false; });
  const el = $("issue-" + id); if (!el) return;
  el.scrollIntoView({block:"start"});
  el.classList.add("ping"); setTimeout(() => el.classList.remove("ping"), 1600);
}
const issueSwitch = $("issues-switch");
if (issueSwitch) issueSwitch.addEventListener("change", () => {
  document.body.classList.toggle("issues-off", !issueSwitch.checked);
  // the Issues tab and panel are hidden while the switch is off; do not leave the user on a blank page
  if (!issueSwitch.checked && curTab === "issues") showTab("graph");
});

/* ───────── search ───────── */
(function(){
  const input = $("q"), box = $("qres");
  let hits = [], cur = -1;
  const KIND = {node:"Component", edge:"Relation", entity:"Entity", sequence:"Sequence"};
  function close(){ box.hidden = true; cur = -1; input.setAttribute("aria-expanded", "false"); }
  function mark(){ box.querySelectorAll("li").forEach((li, i) => li.classList.toggle("cur", i === cur)); }
  function open(h){
    close(); input.value = "";
    if (h.kind === "node") goNode(h.id);
    else if (h.kind === "edge") goEdge(h.id);
    else if (h.kind === "entity") goEntity(h.id);
    else if (h.kind === "sequence"){ showTab("sequences"); setSeq(h.id); $("sequences").scrollIntoView(); }
  }
  function run(){
    hits = searchModel(MODEL, input.value, 12); cur = hits.length ? 0 : -1;
    if (!input.value.trim()){ close(); return; }
    box.innerHTML = hits.length ? hits.map((h, i) => '<li role="option" data-i="' + i + '"><span class="rk">' + esc(KIND[h.kind]) + '</span><span class="rt">' + esc(h.title) + '</span>' + (h.detail ? '<span class="rd">' + esc(h.detail) + '</span>' : '') + '</li>').join("") : '<li class="none">Nothing matches.</li>';
    box.hidden = false; input.setAttribute("aria-expanded", "true"); mark();
    box.querySelectorAll("li[data-i]").forEach(li => li.addEventListener("mousedown", ev => { ev.preventDefault(); open(hits[Number(li.dataset.i)]); }));
  }
  input.addEventListener("input", run);
  input.addEventListener("focus", () => { if (input.value.trim()) run(); });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", ev => {
    if (ev.key === "ArrowDown" && hits.length){ ev.preventDefault(); cur = (cur + 1) % hits.length; mark(); }
    else if (ev.key === "ArrowUp" && hits.length){ ev.preventDefault(); cur = (cur - 1 + hits.length) % hits.length; mark(); }
    else if (ev.key === "Enter" && hits[cur]){ ev.preventDefault(); open(hits[cur]); }
    else if (ev.key === "Escape"){ input.value = ""; close(); }
  });
})();

/* ───────── header, footer, tabs ───────── */
$("title").textContent = META.project || "Architecture";
$("eyebrow").textContent = "Architecture map" + (META.commit ? " · commit " + String(META.commit).slice(0, 7) : "") + (META.generatedAt ? " · " + String(META.generatedAt).slice(0, 10) : "");
$("foot").textContent = "Generated by archmap from the model" + (META.commit ? " at commit " + String(META.commit).slice(0, 12) : "") + ". Evidence references point at that commit.";
function hideTab(name){ const b = document.querySelector('#navlist [data-tab="' + name + '"]'); if (b) b.hidden = true; }
if (!ENTITIES.length) hideTab("er");
if (!ACCESS.length) hideTab("crud");
if (!PANES.deployment) hideTab("deployment");
if (!PANES.trust) hideTab("trust");
document.querySelectorAll("#navlist [data-tab]").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

/* ───────── boot ───────── */
function tabFromHash(){
  const h = decodeURIComponent((location.hash || "").slice(1));
  if (/^issue-/.test(h)) return "issues";
  return Object.keys(PANEL).find(k => PANEL[k] === h) || "graph";
}
showTab(tabFromHash(), true);
// Text widths are measured on the drawn page: once the fonts are in, redraw what is on screen.
if (document.fonts && document.fonts.ready){
  document.fonts.ready.then(() => {
    Object.keys(drawn).forEach(k => { if (k !== "issues" && k !== "crud") drawn[k] = false; });
    drawn[curTab] = true;
    if (curTab !== "issues" && curTab !== "crud" && DRAW[curTab]) DRAW[curTab]();
  });
}
window.addEventListener("hashchange", () => { const t = tabFromHash(); if (t !== curTab) showTab(t, true); });
})();
