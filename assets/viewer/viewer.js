// archmap viewer - renders the embedded model, layout and (internal/shared builds only) issues.
// Everything drawn comes from three JSON blocks render.mjs inlines: #archmap-model, #archmap-layout and
// the optional #archmap-issues. Positions and edge routes are the build-time ELK layout; nothing is hand-placed.
// No network access of any kind: the page is a single offline file.
(function(){
"use strict";
// The SVG namespace, read from an inline <svg> the HTML parser already placed in it (no URL literal in shipped code).
const NS = document.getElementById("arch").namespaceURI;
function S(tag, attrs, parent){ const e = document.createElementNS(NS, tag); if (attrs) for (const k in attrs){ const v = attrs[k]; if (v !== undefined && v !== null) e.setAttribute(k, v); } if (parent) parent.appendChild(e); return e; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const codeify = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const $ = id => document.getElementById(id);
function readJson(id){ const el = $(id); if (!el) return null; try { return JSON.parse(el.textContent); } catch (err) { return null; } }

/* ───────── data ───────── */
const MODEL = readJson("archmap-model") || {meta:{}, zones:[], nodes:[], edges:[]};
const LAYOUT = readJson("archmap-layout") || {};
const ISSUE_DATA = readJson("archmap-issues");
const META = MODEL.meta || {};
const ZONES = MODEL.zones || [], NODES = MODEL.nodes || [], EDGES = MODEL.edges || [], SEQS = MODEL.sequences || [];
const GRAPH = LAYOUT.graph || {};
const NP = GRAPH.nodes || {}, ZP = GRAPH.zones || {}, EP = GRAPH.edges || {};
const ISSUES = ((ISSUE_DATA && ISSUE_DATA.issues) || []).slice();
const HAS_ISSUES = !!ISSUE_DATA;

/* ───────── relation types, zone kinds, severity ───────── */
// Colour comes from the CSS (--rel-<type>); dash pattern and width make each type readable without colour.
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

const ZONE = {}; ZONES.forEach(z => { ZONE[z.id] = z; });
const NODE = {}; NODES.forEach(n => { NODE[n.id] = n; });
const zoneKind = id => (ZONE[id] && ZK[ZONE[id].kind] ? ZONE[id].kind : "edge");
function zoneChain(id){ const out = []; const seen = new Set(); let z = ZONE[id]; while (z && !seen.has(z.id)){ out.push(z.id); seen.add(z.id); z = z.parent !== undefined ? ZONE[z.parent] : null; } return out; }
const zoneDepth = id => zoneChain(id).length;

/* ───────── issues index ───────── */
const ISS = {}; ISSUES.forEach(i => { ISS[i.id] = i; });
const ENTITY_STORE = {}; (MODEL.entities || []).forEach(e => { ENTITY_STORE[e.id] = e.store; });
const bySev = (a, b) => (SEVR[ISS[b].sev] - SEVR[ISS[a].sev]) || (a < b ? -1 : a > b ? 1 : 0);
function issuesOfNode(id){
  return ISSUES.filter(i => i.anchor && (i.anchor.node === id || (i.anchor.entity !== undefined && ENTITY_STORE[i.anchor.entity] === id))).map(i => i.id).sort(bySev);
}
function issuesOfEdge(id){ return ISSUES.filter(i => i.anchor && i.anchor.edge === id).map(i => i.id).sort(bySev); }
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

/* ───────── evidence links ───────── */
const REPO = (function(){
  const u = META.repoUrl; if (typeof u !== "string") return null;
  try { const p = new URL(u); return (p.protocol === "https:" || p.protocol === "http:") ? u.replace(/\/+$/, "") : null; } catch (err) { return null; }
})();
function evidenceChip(path, lines){
  const label = path + (lines ? ":" + lines : "");
  if (!REPO || !META.commit) return '<code>' + esc(label) + '</code>';
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines || "");
  const frag = m ? "#L" + m[1] + (m[2] ? "-L" + m[2] : "") : "";
  const url = REPO + "/blob/" + encodeURIComponent(META.commit) + "/" + String(path).split("/").map(encodeURIComponent).join("/") + frag;
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"><code>' + esc(label) + '</code></a>';
}
function refChip(ref){
  const m = /^(.*):(\d+(?:-\d+)?)$/.exec(String(ref));
  return m ? evidenceChip(m[1], m[2]) : '<code>' + esc(ref) + '</code>';
}

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
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
    zones.forEach(z => { const r = ZP[z.id]; grow(r.x, r.y, r.w, r.h); });
    nodes.forEach(n => { const r = NP[n.id]; grow(r.x, r.y, r.w, r.h); });
    edges.forEach(e => edgePoints(e).forEach(p => grow(p[0], p[1], 0, 0)));
    if (!isFinite(x0)){ x0 = 0; y0 = 0; x1 = 400; y1 = 120; }
    const pad = 16;
    return {id:v.id, title:v.title || v.id, nodes:nodes, zones:zones, edges:edges,
            box:{x:x0 - pad, y:y0 - pad, w:(x1 - x0) + 2*pad, h:(y1 - y0) + 2*pad}};
  });
}
const VIEWS = buildViews();
const VIEW = {}; VIEWS.forEach(v => { VIEW[v.id] = v; });

function renderGraph(svg, view, opt){
  opt = opt || {};
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const b = view.box;
  svg.setAttribute("viewBox", b.x + " " + b.y + " " + b.w + " " + b.h);
  // Keep text legible on wide layouts: the figure scrolls rather than shrinking below ~60% scale.
  svg.style.minWidth = Math.max(980, Math.round(b.w * 0.6)) + "px";
  addMarkers(svg);
  const gZ = S("g", {class:"g-zones"}, svg), gE = S("g", {class:"g-edges"}, svg), gN = S("g", {class:"g-nodes"}, svg), gL = S("g", {class:"g-labels"}, svg), gZL = S("g", {class:"g-zlabels"}, svg);
  view.zones.forEach(z => {
    const r = ZP[z.id], sub = z.parent !== undefined && !!ZONE[z.parent], kind = zoneKind(z.id);
    const g = S("g", {class:"zone zc-" + kind + (sub ? " sub" : "") + (z.outside ? " outside" : ""), "data-zone":z.id}, gZ);
    S("rect", {x:r.x, y:r.y, width:r.w, height:r.h, rx:sub ? 8 : 12}, g);
    const lg = S("g", {class:"zone zc-" + kind}, gZL);
    const t = S("text", {x:r.x + 12, y:r.y + (sub ? 17 : 21), class:"zl"}, lg); t.textContent = z.label || z.id;
  });
  view.edges.forEach((e, i) => {
    const k = relOf(e.type), ty = REL[k], geo = edgeGeom(e);
    const g = S("g", {class:"edge t-" + k + (e.confidence === "inferred" ? " inferred" : ""), "data-f":e.from, "data-t":e.to, "data-i":i, "data-k":k, "data-id":e.id}, gE);
    g.style.setProperty("--w", ty.w + "px");
    S("path", {d:geo.d, class:"hit"}, g);
    S("path", {d:geo.d, class:"ln", "stroke-width":ty.w, "stroke-dasharray":ty.dash, "marker-end":"url(#" + svg.id + "-m-" + k + ")"}, g);
    const title = S("title", null, g);
    const fromN = NODE[e.from], toN = NODE[e.to];
    title.textContent = ty.label + ": " + fromN.title + " → " + toN.title + (e.desc || e.label ? " · " + (e.desc || e.label) : "");
    const x = geo.mid[0], y = geo.mid[1];
    if (e.label){
      const lg = S("g", {class:"elabel t-" + k, "data-i":i, "data-k":k}, gL);
      const rect = S("rect", {x:x, y:y - 8.5, width:10, height:17, rx:8.5}, lg);
      const t = S("text", {x:x, y:y + 3.7, "text-anchor":"middle"}, lg); t.textContent = e.label;
      const w = textWidth(t, 5.7) + 14;
      rect.setAttribute("x", x - w/2); rect.setAttribute("width", w);
    }
    const iss = opt.noIssues ? [] : issuesOfEdge(e.id);
    if (iss.length){
      const lg = S("g", {class:"elabel t-" + k, "data-i":i, "data-k":k}, gL);
      const cx = x, cy = y - (e.label ? 14 : 0);
      S("circle", {cx:cx, cy:cy, r:7.5, class:"bdg sev-" + maxSev(iss)}, lg);
      const bt = S("text", {x:cx, y:cy + 3.5, class:"bdt", "text-anchor":"middle"}, lg); bt.textContent = iss.length;
    }
  });
  view.nodes.forEach(n => {
    const r = NP[n.id], kind = zoneKind(n.zone);
    const iss = opt.noIssues ? [] : issuesOfNode(n.id);
    const sub = (n.sub || []).filter(Boolean);
    const g = S("g", {class:"node zc-" + kind, "data-id":n.id}, gN);
    if (opt.interactive){ g.setAttribute("tabindex", "0"); g.setAttribute("role", "button"); g.setAttribute("aria-label", n.title + (sub.length ? ". " + sub.join(", ") : "") + (iss.length ? ". " + iss.length + " issue" + (iss.length > 1 ? "s" : "") : "")); }
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

/* ───────── architecture interactivity ───────── */
const state = {view:VIEWS[0].id, sel:{}, hidden:new Set(), flag:[]};
const arch = $("arch");
function viewTypes(view){ const s = new Set(); view.edges.forEach(e => s.add(relOf(e.type))); return Object.keys(REL).filter(k => s.has(k)); }
function chipHTML(k, pressed){
  const ty = REL[k];
  return '<button class="chip t-' + k + '" data-k="' + k + '" aria-pressed="' + (pressed ? "true" : "false") + '"><svg viewBox="0 0 26 10" aria-hidden="true"><line x1="1" y1="5" x2="19" y2="5" stroke="var(--ec)" stroke-width="' + Math.min(ty.w, 2.6) + '"' + (ty.dash ? ' stroke-dasharray="' + ty.dash + '"' : '') + ' stroke-linecap="round"/><path d="M18,1 L25,5 L18,9 z" fill="var(--ec)"/></svg><span>' + esc(ty.label) + '</span></button>';
}
function drawLegend(){
  const v = VIEW[state.view], el = $("legend");
  el.innerHTML = viewTypes(v).map(k => chipHTML(k, !state.hidden.has(k))).join("");
  el.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
    const k = c.dataset.k;
    if (state.hidden.has(k)) state.hidden.delete(k); else state.hidden.add(k);
    c.setAttribute("aria-pressed", state.hidden.has(k) ? "false" : "true");
    applyHidden();
  }));
  const kinds = new Set(); v.zones.forEach(z => kinds.add(zoneKind(z.id))); v.nodes.forEach(n => kinds.add(zoneKind(n.zone)));
  $("zonekey").innerHTML = '<span class="zk">Zones</span>' + Object.keys(ZK).filter(k => kinds.has(k)).map(k => '<span class="zc-' + k + '"><i></i>' + esc(ZK[k]) + '</span>').join("");
}
function applyHidden(){
  arch.querySelectorAll(".edge,.elabel").forEach(el => { el.style.display = state.hidden.has(el.dataset.k) ? "none" : ""; });
}
function clearFocus(){ arch.classList.remove("focusing"); arch.querySelectorAll(".hl").forEach(x => x.classList.remove("hl")); }
function focusNode(id){
  clearFocus(); arch.classList.add("focusing");
  const node = arch.querySelector('.node[data-id="' + CSS.escape(id) + '"]'); if (node) node.classList.add("hl");
  arch.querySelectorAll(".edge").forEach(e => {
    if (e.dataset.f === id || e.dataset.t === id){
      e.classList.add("hl");
      arch.querySelectorAll('.elabel[data-i="' + e.dataset.i + '"]').forEach(l => l.classList.add("hl"));
      const other = e.dataset.f === id ? e.dataset.t : e.dataset.f;
      const on = arch.querySelector('.node[data-id="' + CSS.escape(other) + '"]'); if (on) on.classList.add("hl");
    }
  });
}
function focusEdge(i){
  clearFocus(); arch.classList.add("focusing");
  const e = arch.querySelector('.edge[data-i="' + i + '"]'); if (!e) return;
  e.classList.add("hl");
  arch.querySelectorAll('.elabel[data-i="' + i + '"]').forEach(l => l.classList.add("hl"));
  [e.dataset.f, e.dataset.t].forEach(id => { const n = arch.querySelector('.node[data-id="' + CSS.escape(id) + '"]'); if (n) n.classList.add("hl"); });
}
function renderDetail(id){
  const v = VIEW[state.view], n = v.nodes.find(x => x.id === id), el = $("detail");
  if (!n){ el.innerHTML = ""; return; }
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
  el.innerHTML =
    '<div class="d-head"><span class="zchip zc-' + zoneKind(n.zone) + '">' + esc((ZONE[n.zone] && ZONE[n.zone].label) || n.zone) + '</span><h3>' + esc(n.title) + '</h3></div>' +
    (n.role ? '<p class="d-role">' + codeify(n.role) + '</p>' : '') +
    '<div class="d-cols">' +
      '<div><h4>Facts</h4>' + ((n.facts && n.facts.length) ? '<ul>' + n.facts.map(f => '<li>' + codeify(f) + '</li>').join("") + '</ul>' : '<p class="muted">Nothing beyond the label.</p>') + '</div>' +
      '<div><h4>Connections</h4>' + (conns ? '<ul class="conn">' + conns + '</ul>' : '<p class="muted">None drawn.</p>') + '</div>' +
      '<div><h4>Evidence</h4>' + (ev ? '<div class="refs">' + ev + '</div>' : '<p class="muted">None recorded.</p>') + '</div>' +
      (HAS_ISSUES ? '<div class="issues-only"><h4>Issues</h4>' + (iss.length ? '<ul class="conn">' + iss.map(i => '<li><span></span>' + issueLink(i) + '</li>').join("") + '</ul>' : '<p class="muted">No open issues found here.</p>') + '</div>' : '') +
    '</div>';
  wireIssueLinks(el);
}
function select(id){
  state.sel[state.view] = id;
  arch.querySelectorAll(".node.sel").forEach(x => x.classList.remove("sel"));
  const n = id ? arch.querySelector('.node[data-id="' + CSS.escape(id) + '"]') : null; if (n) n.classList.add("sel");
  renderDetail(id);
}
function drawArch(){
  const v = VIEW[state.view];
  renderGraph(arch, v, {interactive:true});
  $("archcap").textContent = v.nodes.length + " components, " + v.edges.length + " relations" + (v.nodes.length ? "" : ". Run layout.mjs: this view has no positioned component.");
  drawLegend(); applyHidden();
  arch.querySelectorAll(".node").forEach(g => {
    const id = g.dataset.id;
    g.addEventListener("mouseenter", () => focusNode(id));
    g.addEventListener("mouseleave", clearFocus);
    g.addEventListener("focus", () => focusNode(id));
    g.addEventListener("blur", clearFocus);
    g.addEventListener("click", () => select(id));
    g.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); select(id); } if (ev.key === "Escape") clearFocus(); });
  });
  arch.querySelectorAll(".edge").forEach(g => {
    g.addEventListener("mouseenter", () => focusEdge(g.dataset.i));
    g.addEventListener("mouseleave", clearFocus);
  });
  state.flag.forEach(id => { const n = arch.querySelector('.node[data-id="' + CSS.escape(id) + '"]'); if (n) n.classList.add("flag"); });
  select(state.sel[state.view] || (v.nodes[0] && v.nodes[0].id));
}
function setView(id){
  state.view = id; state.flag = [];
  document.querySelectorAll("#viewtabs .tab").forEach(b => b.setAttribute("aria-selected", b.dataset.view === id ? "true" : "false"));
  drawArch();
}
$("viewtabs").innerHTML = VIEWS.map(v => '<button class="tab" role="tab" data-view="' + esc(v.id) + '" aria-selected="' + (v.id === state.view ? "true" : "false") + '">' + esc(v.title) + '</button>').join("");
document.querySelectorAll("#viewtabs .tab").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));

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
  svg.style.minWidth = Math.max(760, W*0.82) + "px";
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
// Bring an issue's anchor into view: its component (or the store of its entity) on the first view
// that holds it, flagged and selected; or its sequence step.
function showAnchor(x){
  const a = x && x.anchor; if (!a) return;
  if (a.step !== undefined){
    const cut = a.step.lastIndexOf(":"), seq = SEQ[a.step.slice(0, cut)]; if (!seq) return;
    setSeq(seq.id); setStep(stepNo(seq, Number(a.step.slice(cut + 1))));
    $("sequences").scrollIntoView(); return;
  }
  let ids = [];
  if (a.node !== undefined) ids = [a.node];
  else if (a.entity !== undefined && ENTITY_STORE[a.entity]) ids = [ENTITY_STORE[a.entity]];
  else if (a.edge !== undefined){ const e = EDGES.find(y => y.id === a.edge); if (e) ids = [e.from, e.to]; }
  if (!ids.length) return;
  const holds = v => ids.every(id => v.nodes.some(n => n.id === id));
  const v = holds(VIEW[state.view]) ? VIEW[state.view] : (VIEWS.find(holds) || VIEW[state.view]);
  state.view = v.id;
  document.querySelectorAll("#viewtabs .tab").forEach(t => t.setAttribute("aria-selected", t.dataset.view === v.id ? "true" : "false"));
  state.flag = ids.slice(); state.sel[v.id] = ids[0];
  drawArch();
  $("architecture").scrollIntoView();
}
function gotoIssue(id){
  if (!findingsEl) return;
  document.querySelectorAll("#sevtabs .tab").forEach(x => x.setAttribute("aria-selected", x.dataset.sev === "all" ? "true" : "false"));
  findingsEl.querySelectorAll(".finding").forEach(f => { f.hidden = false; });
  const el = $("issue-" + id); if (!el) return;
  el.scrollIntoView({block:"start"});
  el.classList.add("ping"); setTimeout(() => el.classList.remove("ping"), 1600);
}
const issueSwitch = $("issues-switch");
if (issueSwitch) issueSwitch.addEventListener("change", () => document.body.classList.toggle("issues-off", !issueSwitch.checked));

/* ───────── header, footer, nav highlight ───────── */
$("title").textContent = META.project || "Architecture";
$("eyebrow").textContent = "Architecture map" + (META.commit ? " · commit " + String(META.commit).slice(0, 7) : "") + (META.generatedAt ? " · " + String(META.generatedAt).slice(0, 10) : "");
$("foot").textContent = "Generated by archmap from the model" + (META.commit ? " at commit " + String(META.commit).slice(0, 12) : "") + ". Evidence references point at that commit.";
const navLinks = Array.from(document.querySelectorAll("#navlist a"));
const secs = navLinks.map(a => document.querySelector(a.getAttribute("href")));
function onScroll(){
  let idx = 0; const yy = window.scrollY + 90;
  secs.forEach((s, i) => { if (s && s.offsetTop <= yy) idx = i; });
  navLinks.forEach((a, i) => a.classList.toggle("on", i === idx));
}
window.addEventListener("scroll", onScroll, {passive:true});

/* ───────── boot ───────── */
drawArch();
if (seqState.id) setSeq(seqState.id);
renderIssues();
onScroll();
if (document.fonts && document.fonts.ready){ document.fonts.ready.then(() => { drawArch(); if (seqState.id) setSeq(seqState.id); }); }
})();
