#!/usr/bin/env node
// merge.mjs - merge explorer fragments (and the synthesizer's object) into the architecture model.
//
//   node scripts/merge.mjs <fragmentsDir> --out <model.json> [--previous <model.json>] [--synth <synth.json>]
//        [--extracts <dir>] [--repo <dir>] [--digest <digest.json>]
//        [--areas a,b [--changed <diffmap.json>]] [--commit sha] [--project name] [--profile p] [--generated-at iso]
//        [--repo-url url] [--strict] [--json]
//
// Fragments (<work>/fragments/*.json, written by the explorers; one object per area, contract in
// skills/architecture-map/references/model-schema.md): nodes, edges, entities, access (and, tolerated,
// relations and zones) are concatenated in area order. An element identical to one already present is
// deduped; a node of another area with the same `paths` is the same component and collapses into the first one
// (by area order), every reference to it rewritten; one that reuses an id with different content is renamed
// "<id>-<area>" (then -2, -3...) and every reference inside that fragment is rewritten (edge from/to, entity store,
// fk targets, access node/entity, relation endpoints). Access rows dedupe on node+entity with the ops unioned.
// Zone ids from fragments are matched by spelling ("Service", "service " and "service" are one zone); a node with
// no zone gets the zone of the deepest slice container directory (a Dockerfile's or compose file's directory, not the
// root) that holds all its paths, labelled with that directory, else one from its kind and its area's stacks; zones
// the nodes use but nobody declared are created (kind from the zone id, else from its nodes' kinds, else "service").
//
// The cross-area layer is computed here, not asked of an agent. With --extracts <work>/extracts (the per-area
// slices prescan.mjs writes; the explorers' <area>.summary.json files beside them are not read) every cross-area
// link becomes an edge between the nodes that own its two files: an HTTP call to a route an `api` edge, a queue
// producer and its consumer each a `queue` edge (async) to the queue's node (straight to the consumer when no queue
// node exists), an import a `call` edge. Each cites the link's file and line on both sides; an import link carries no
// line, so with --repo the merge finds the import statement in the file (read as text, never run) and without it the
// link is skipped. A derived edge is `verified` only on an exact match: an HTTP link prescan matched through a
// wildcard segment (`match: "wildcard"`), and an import line that names the module by its file name only, make it
// `inferred`, said in its desc; a call path of wildcards only makes no edge. SQL
// statements in the slices become access rows (select R, insert C, update U, delete D) of the node owning the file on
// the entity of that table; so do the slices' ORM models (R, for the code node declaring the model) and, where an
// entity models a queue, its producers (C) and consumers (R). Declared foreign keys (an entity field's fk, an ORM table's fk=) become `relations[]`.
// The extracts are prescan's full record, so the script also makes what the explorers used to transcribe: one entity
// per declared table (its fields with provenance declared, evidence at the declaring file and lines), merged into an
// explorer's entity of the same table or model name when there is one, its store the store node that owns or covers
// the file, else the area's one store node, else a store node made for the area; one queue node per queue name (an
// explorer's queue node of that name is the node), and a `queue` edge (async) from the node owning each producer and
// each consumer to it, at that line. A table that SQL statements in the code name and nothing declares (the schema
// of a program that creates its database file at runtime lives in its queries) becomes an entity with provenance
// "inferred", no fields and evidence at the first statement that names it. These are not held to the fragment caps.
// A workspace app the slices list (`workspaceApps`: a member of the declared workspace under apps/) that no explorer
// made a level-2 app node for gets one: kind app, paths <dir>/**, evidence at its package.json; the area's level-2 nodes
// inside the directory (a service or module the explorer took for the app) move to level 3 under it and are listed in its
// `sub`. A relation or foreign key that names its entity by table name resolves to that entity's id once the entities are
// final (a relation kept from --previous too); two spellings of one relation are emitted once.
// What cannot be cited or resolved (a file no node owns, a table no entity models) is never guessed: it is counted
// in one meta.sources row of type "derivation". The result also carries a digest (written with --digest
// <work>/digest.json, at most DIGEST_CAP characters): node ids, kinds, zones, one-line roles, the edge list,
// entity names, access rows, and sequences pre-drafted from an HTTP entry point through its route, the handler's
// access rows and its queue hops, for the synthesizer to confirm rather than discover.
//
// A fragment is never bounced back to its explorer. Before merging, each one is normalised (evidence lines given as a
// number or "L12-L14", a string `level`, a missing `paths`, `confidence` or `level`, lowercase or unordered `ops`) and
// truncated to the caps (40 nodes, 80 edges, 60 entities, 80 access rows; the first elements the explorer listed are
// kept, and elements that would dangle on a dropped one go with it). What was fixed or dropped is recorded as a
// meta.sources row of type "normalisation" or "truncation" that names the area and the counts. An unreadable fragment
// file is recorded as skipped. None of this changes the exit code: merge exits 1 only for an invalid result.
//
// Evidence is checked against the repository the same way. With --repo and a meta.commit the repository has (read with
// git at that commit, exactly as validate --repo reads it, so a working tree that has moved on changes nothing), the
// fragments' evidence is normalised before references are resolved: a range whose end is past the file's last line is
// clamped to it (a start past the end becomes the last line too), an entry whose path is not a file at the commit
// (absent, or a directory) is dropped, and a node or edge left with no evidence is dropped, its dangling references
// with it. Each change is one meta.sources row {area, type: "clamped-evidence" | "dropped-evidence", id, path, note}.
// Only what this run's fragments brought is touched; elements kept from --previous are never rewritten. The result is
// then validated with --repo, so merge exits 1 only over the findings it did not normalise, and lists them. Without
// --repo, or when the commit is not in the repository, evidence is not checked (and merge says so on stderr).
//
// meta: schemaVersion, project, commit, profile and generatedAt come from the flags, else from --previous.
// generatedAt is never invented (pass --generated-at; a missing value makes the result invalid). coverage[area]
// is each fragment's coverage; sources holds one row per fragment (its skipped tally) plus any sources it lists.
//
// Update mode (--previous with --areas a,b): only fragments of the listed areas are read. The elements owned
// by those areas (first evidence path under a glob of the area's previous meta.coverage) are replaced; every
// other element, zone, relation, sequence and view is kept as it was, ids unchanged. Cross-area edges and
// access rows whose evidence sits in an affected area are replaced too, and --extracts recomputes them.
// Globs are matched by lib/glob.mjs, the matcher diffmap.mjs uses, so both scripts agree on who owns a path
// (a bare directory glob is literal; write `dir/**` to own a subtree).
// With --changed <diffmap.json> (the diffmap.mjs --json report of the commit, whose `files` are the changed paths; a
// plain JSON array of paths is read too) an affected area is not replaced wholesale: a node, edge or entity of the
// area whose id is in --previous, that has at least one evidence file (an entity's field evidence included) and whose
// evidence files are all unchanged is carried over byte-identical from --previous, whether the fragment spells it
// differently or leaves it out; one with evidence in a changed file, or with no evidence at all (nothing shows it
// unchanged), takes the fragment's version; an id --previous lacks is added; one the fragment leaves out that is not
// carried is removed, one meta.sources row {area, type: "dropped-changed", id, note} each. Entities on
// a carried store keep its id, the extracts merge nothing into a carried entity, and a store made for the area is the
// carried one of that id, never a -2 sibling. The derivation row counts what was carried (`derived.carried`). Access
// rows and relations carry no id and are recomputed as before. Without --changed update mode is as described above.
// --previous without --areas treats every area as affected (full rebuild that still carries user fields).
// --areas and the fragment directory must name the same areas: an --areas entry with no fragment, and a fragment
// whose area is not in --areas, are each reported as a conflict (exit 1 under --strict). An area whose fragment file
// is unreadable keeps its previous elements (a conflict, and its explorer row marked skipped), and `area:<id>` of an
// area with no fragment this run resolves to its level-2 node among the previous model's nodes of that area.
//
// Synthesizer object (--synth): sequences and views merge by id; notes and conflicts are passed through. The
// synthesizer may not add nodes, edges, entities, access rows or relations: any it carries are ignored and each
// kind is reported as a conflict. Conflicts are reported and never resolved silently. A sequence step that matches no
// step shape of the schema (message, fragment or note) is dropped, and a sequence that a drop leaves under 2 steps goes
// with it, one meta.sources row {area: "synthesizer", type: "dropped-step", sequence, index, reason} each (index is the
// step's place in the synth sequence; the row of a dropped sequence has none): a slip of the synthesizer never costs the
// build a refusal, and nobody asks the agent again.
//
// User-authored fields (node locked + notes) are never overwritten or dropped. A locked node keeps its
// authored content; if the new analysis disagrees, or no longer finds it, a conflict is reported. Notes on an
// unlocked node are copied onto the re-analysed node.
//
// The result is validated (validate.mjs) and refused when invalid: nothing is written. Output is sorted and
// key-ordered, so the same inputs give byte-identical output.
// Exit 0 ok, 1 invalid result (or conflicts with --strict, nothing written), 2 usage or unreadable input.
// Node >= 18, ESM, zero npm dependencies.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';
import { validateSchema } from './lib/jsonschema.mjs';
import { matchAny } from './lib/glob.mjs';

export const SCHEMA_VERSION = '1.0';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const clone = (x) => JSON.parse(JSON.stringify(x));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a, b) => cmp(String(a.id), String(b.id));
const USER_FIELDS = ['locked', 'notes'];
const ZONE_KINDS = ['browser', 'edge', 'service', 'data', 'external', 'platform', 'delivery'];
const STORE_KINDS = new Set(['store', 'database', 'db', 'datastore', 'cache']);

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  const o = {};
  for (const k of Object.keys(v).sort(cmp)) o[k] = sortKeys(v[k]);
  return o;
}
const canon = (v) => JSON.stringify(sortKeys(v));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const zoneSlug = (s) => slug(String(s).trim());
const pathsKey = (n) => {
  const p = list(n.paths).filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()).sort(cmp);
  return p.length ? JSON.stringify(p) : null;
};
const stripUser = (n) => {
  const c = clone(n);
  for (const k of USER_FIELDS) delete c[k];
  return c;
};

// ---------------------------------------------------------------------------
// ownership by area coverage

function ownerTest(areas, coverage) {
  if (areas === null) return () => true; // every area is affected
  const globs = [];
  for (const a of areas) for (const g of list(coverage?.[a])) if (typeof g === 'string') globs.push(g);
  return (el) => {
    const p = list(el?.evidence)[0]?.path;
    return typeof p === 'string' && matchAny(globs, p);
  };
}

// ---------------------------------------------------------------------------
// normalise and truncate one fragment (never a reason to ask the explorer again)

export const CAPS = { nodes: 40, edges: 80, entities: 60, access: 80 };
const CAP_LABEL = { nodes: 'nodes', edges: 'edges', entities: 'entities', access: 'access rows' };

function fixLines(v) {
  if (Number.isInteger(v) && v >= 1) return String(v);
  if (typeof v !== 'string') return v;
  const t = v.trim().replace(/\s+/g, '');
  const range = /^L?(\d+)[-–—:]L?(\d+)$/i.exec(t);
  if (range) return range[1] === range[2] ? range[1] : `${range[1]}-${range[2]}`;
  const one = /^L?(\d+)$/i.exec(t);
  return one ? one[1] : v;
}

/** Evidence as an array of {path, lines}; `fixed.n` counts every value changed. */
function fixEvidence(ev, fixed) {
  if (ev === undefined) return ev;
  const arr = Array.isArray(ev) ? ev : [ev];
  if (!Array.isArray(ev)) fixed.n++;
  return arr.map((e) => {
    if (!isObj(e)) return e;
    const out = { ...e };
    if (out.lines === undefined && out.line !== undefined) {
      out.lines = out.line;
      delete out.line;
      fixed.n++;
    }
    const lines = fixLines(out.lines);
    if (lines !== out.lines) {
      out.lines = lines;
      fixed.n++;
    }
    return out;
  });
}

const fixOps = (ops) => (typeof ops === 'string' ? [...OPS].filter((c) => ops.toUpperCase().includes(c)).join('') || ops : ops);

/** The zone of a node its explorer left without one: from its kind, and for an app from its area's stacks. */
function zoneFor(n, stacks) {
  const kind = String(n.kind ?? '').toLowerCase();
  if (STORE_KINDS.has(kind) || kind === 'queue') return 'data';
  if (kind === 'external') return 'external';
  if (kind === 'app' && stacks.includes('ts-frontend')) return 'browser';
  return 'service';
}

/**
 * The deployment zones the slices' containers declare: one per directory holding a Dockerfile or a compose file
 * (a root one builds the whole repository and says nothing about which node it holds). The zone id is the
 * directory's name, or its whole path where two directories share a name. `zoneOf(node)` is the zone of the deepest
 * container directory that holds every path of the node (its `paths`, else its evidence), or null.
 */
function containerZones(slices) {
  const dirs = new Set();
  for (const s of slices) {
    for (const c of list(s.containers)) {
      if (typeof c !== 'string') continue;
      const d = posix.dirname(posix.normalize(c));
      if (d && d !== '.' && d !== '/' && !d.startsWith('..')) dirs.add(d);
    }
  }
  const sorted = [...dirs].sort(cmp);
  const named = new Map();
  for (const d of sorted) named.set(slug(posix.basename(d)), (named.get(slug(posix.basename(d))) ?? 0) + 1);
  const idOf = new Map();
  for (const d of sorted) {
    const b = slug(posix.basename(d));
    idOf.set(d, b && named.get(b) === 1 ? b : slug(d));
  }
  const deepest = [...sorted].sort((a, b) => b.split('/').length - a.split('/').length || cmp(a, b));
  const literal = (p) => {
    const segs = String(p).trim().replace(/^\.\//, '').split('/');
    const k = segs.findIndex((s) => /[*?[{]/.test(s));
    return (k === -1 ? segs : segs.slice(0, k)).join('/');
  };
  const zoneOf = (n) => {
    if (!sorted.length) return null;
    let paths = list(n.paths).filter((p) => typeof p === 'string' && p.trim());
    if (!paths.length) paths = list(n.evidence).filter((e) => isObj(e) && typeof e.path === 'string').map((e) => e.path);
    const pre = paths.map(literal).filter(Boolean);
    if (!pre.length) return null;
    const d = deepest.find((dir) => pre.every((p) => p === dir || p.startsWith(`${dir}/`)));
    return d === undefined ? null : idOf.get(d);
  };
  const dirOf = new Map([...idOf].map(([d, id]) => [id, d]));
  return { zoneOf, dirOf };
}

function normaliseFragment(raw, area, stacks = [], containerZoneOf = () => null) {
  const fixed = { n: 0 };
  const f = clone(raw);
  const nodes = list(f.nodes).filter(isObj).map((n) => {
    if (typeof n.zone !== 'string' || !n.zone.trim()) {
      n.zone = containerZoneOf(n) ?? zoneFor(n, stacks);
      fixed.n++;
    }
    if (n.evidence !== undefined) n.evidence = fixEvidence(n.evidence, fixed);
    if (typeof n.level === 'string' && /^\d+$/.test(n.level.trim())) {
      n.level = Number(n.level);
      fixed.n++;
    } else if (n.level === undefined) {
      n.level = 2;
      fixed.n++;
    }
    const path = list(n.evidence).find((e) => isObj(e) && typeof e.path === 'string')?.path;
    if (!Array.isArray(n.paths) && path !== undefined) {
      n.paths = [path];
      fixed.n++;
    }
    return n;
  });
  const edges = list(f.edges).filter(isObj).map((e) => {
    if (e.evidence !== undefined) e.evidence = fixEvidence(e.evidence, fixed);
    if (e.confidence === undefined) {
      e.confidence = 'inferred';
      fixed.n++;
    }
    return e;
  });
  const entities = list(f.entities).filter(isObj).map((e) => {
    if (e.evidence !== undefined) e.evidence = fixEvidence(e.evidence, fixed);
    return e;
  });
  const access = list(f.access).filter(isObj).map((a) => {
    if (a.evidence !== undefined) a.evidence = fixEvidence(a.evidence, fixed);
    const ops = fixOps(a.ops);
    if (ops !== a.ops) {
      a.ops = ops;
      fixed.n++;
    }
    return a;
  });

  // caps: the first elements the explorer listed are the ones kept
  const dropped = {};
  const drop = (kind, n) => {
    if (n > 0) dropped[kind] = (dropped[kind] ?? 0) + n;
  };
  const cut = (kind, arr) => {
    drop(kind, arr.length - CAPS[kind]);
    return arr.slice(0, CAPS[kind]);
  };
  const keptNodes = cut('nodes', nodes);
  const goneNodes = new Set(nodes.slice(CAPS.nodes).map((n) => n.id));
  const liveEntities = entities.filter((e) => !goneNodes.has(e.store));
  drop('entities', entities.length - liveEntities.length);
  const keptEntities = cut('entities', liveEntities);
  const goneEntities = new Set([...entities.filter((e) => !keptEntities.includes(e)).map((e) => e.id)]);
  const liveEdges = edges.filter((e) => !goneNodes.has(e.from) && !goneNodes.has(e.to));
  drop('edges', edges.length - liveEdges.length);
  const keptEdges = cut('edges', liveEdges);
  const liveAccess = access.filter((a) => !goneNodes.has(a.node) && !goneEntities.has(a.entity));
  drop('access', access.length - liveAccess.length);
  const keptAccess = cut('access', liveAccess);

  const notes = [];
  if (fixed.n > 0) notes.push({ area, type: 'normalisation', fixed: fixed.n, note: `area ${area}: ${fixed.n} fragment field(s) normalised (evidence lines, level, paths, zone, confidence, ops)` });
  if (Object.keys(dropped).length) {
    const parts = Object.keys(CAPS).filter((k) => dropped[k]).map((k) => `${dropped[k]} ${CAP_LABEL[k]}`);
    notes.push({
      area,
      type: 'truncation',
      dropped,
      note: `area ${area}: fragment over the caps (${Object.values(CAPS).join('/')} nodes/edges/entities/access rows); dropped ${parts.join(', ')}; split the area to see them`,
    });
  }
  return { f: { ...f, nodes: keptNodes, edges: keptEdges, entities: keptEntities, access: keptAccess }, notes };
}

// ---------------------------------------------------------------------------
// merge

const OPS = 'CRUD';
const unionOps = (a, b) => [...OPS].filter((c) => String(a).includes(c) || String(b).includes(c)).join('');
const accessKey = (a) => `${a.node}\u0000${a.entity}`;
const relKey = (r) => `${r?.from?.entity}.${r?.from?.field}->${r?.to?.entity}.${r?.to?.field}`;

function unionEvidence(a, b) {
  const seen = new Set();
  const out = [];
  for (const e of [...list(a), ...list(b)]) {
    const k = canon(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

function addAccess(map, row) {
  const k = accessKey(row);
  const have = map.get(k);
  if (!have) return void map.set(k, clone(row));
  have.ops = unionOps(have.ops, row.ops);
  const evidence = unionEvidence(have.evidence, row.evidence);
  if (evidence.length) have.evidence = evidence;
}

// What the synthesizer may not supply, and how a refused element is named in the conflict.
const SYNTH_REFUSED = {
  nodes: (x) => x.id,
  edges: (x) => x.id,
  entities: (x) => x.id,
  access: (x) => `${x.node}>${x.entity}`,
  relations: (x) => relKey(x),
};

// ---------------------------------------------------------------------------
// the cross-area layer, derived from the prescan slices: nothing here is guessed

const MAX_EDGE_EVIDENCE = 4;
const MAX_REASONS = 20;
const SQL_OPS = { select: 'R', insert: 'C', update: 'U', delete: 'D' };
const SQL_TARGETS = new Set(['store', 'database', 'db', 'datastore']); // node kinds an import or an ORM call reaches over sql
const PROVENANCES = new Set(['declared', 'observed', 'inferred']);
const byLoc = (a, b) => cmp(a.path, b.path) || Number(String(a.lines).split('-')[0]) - Number(String(b.lines).split('-')[0]) || cmp(a.lines, b.lines);
const splitLoc = (loc) => {
  const m = /^(.*):(\d+)$/.exec(String(loc));
  return m ? { path: m[1], lines: m[2] } : { path: String(loc), lines: null };
};
const locText = (e) => `${e.path}:${e.lines}`;

/** file path -> id of the node that owns it: the deepest level, then the longest glob; evidence paths only as a fallback. */
function nodeResolver(nodes) {
  const all = [...nodes.values()].sort(byId);
  const cache = new Map();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    let best = null;
    let score = null;
    let fallback = null;
    for (const n of all) {
      const hits = list(n.paths).filter((g) => typeof g === 'string' && matchAny([g], path));
      if (hits.length) {
        const s = [Number(n.level) || 0, Math.max(...hits.map((g) => g.length))];
        if (score === null || s[0] > score[0] || (s[0] === score[0] && s[1] > score[1])) {
          best = n.id;
          score = s;
        }
      } else if (fallback === null && list(n.evidence).some((e) => isObj(e) && e.path === path)) fallback = n.id;
    }
    const id = best ?? fallback;
    cache.set(path, id);
    return id;
  };
}

/**
 * The line of the import statement in `from` that names `to`, read as text under `repo`, as {line, exact}; null when
 * none is found. `exact` when the line names the module itself: a relative specifier that resolves to `to`, or its
 * dotted module path (a python relative import resolved against the package). A line that only shares the file's
 * base name may import another module of that name, so it is not exact; an exact line is preferred over it.
 */
function importLine(repo, from, to) {
  if (typeof repo !== 'string' || from.startsWith('/') || from.split('/').includes('..')) return null;
  const root = resolve(repo);
  const file = resolve(root, from);
  if (!file.startsWith(root + sep)) return null;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const noExt = to.replace(/\.[^./]+$/, '');
  const stem = basename(noExt);
  const names = new Set([stem, noExt.replace(/\//g, '.')]);
  if (stem === 'index' || stem === '__init__') names.add(basename(dirname(noExt)));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = [...names].filter(Boolean).map((s) => new RegExp(`(^|[^\\w])${esc(s)}([^\\w]|$)`));
  const isImport = /^\s*(import|from)\b|\brequire\s*\(|\bimport\s*\(/;
  const dropExt = (p) => p.replace(/\.[^./]+$/, '');
  const targets = new Set([noExt, noExt.replace(/\/(index|__init__)$/, '')]);
  const here = posix.dirname(from);
  const resolvesTo = (spec) => targets.has(dropExt(posix.normalize(posix.join(here, spec))));
  // the module path from its root: the whole path, or its last two or more segments (a src/ layout, an alias)
  const segs = noExt.replace(/\/(index|__init__)$/, '').split('/');
  const tails = segs.length < 2 ? [segs.join('/')] : segs.slice(0, -1).map((_, k) => segs.slice(k).join('/'));
  const exactLine = (line) => {
    for (const t of tails) if (new RegExp(`(^|[^\\w.])${esc(t.replace(/\//g, '.'))}([^\\w.]|$)`).test(line)) return true;
    for (const m of line.matchAll(/['"`]([^'"`]+)['"`]/g)) {
      const spec = m[1];
      if (spec.startsWith('./') || spec.startsWith('../')) {
        if (resolvesTo(spec)) return true;
      } else if (tails.some((t) => t.includes('/') && (dropExt(spec) === t || dropExt(spec).endsWith(`/${t}`)))) return true;
    }
    // python: from .models import X, from ..pkg import models, from . import models
    const py = /^\s*from\s+(\.+)([\w.]*)\s+import\s+(.+)$/.exec(line);
    if (py) {
      let base = here;
      for (let k = 1; k < py[1].length; k++) base = posix.dirname(base);
      const mod = py[2] ? posix.join(base, py[2].replace(/\./g, '/')) : base;
      if (targets.has(mod)) return true;
      for (const name of py[3].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+/)[0])) {
        if (name && targets.has(posix.join(mod, name))) return true;
      }
    }
    return false;
  };
  const lines = text.split('\n');
  let first = null;
  for (let i = 0; i < lines.length; i++) {
    if (!isImport.test(lines[i]) || !named.some((re) => re.test(lines[i]))) continue;
    if (exactLine(lines[i])) return { line: String(i + 1), exact: true };
    if (first === null) first = String(i + 1);
  }
  return first === null ? null : { line: first, exact: false };
}

// ---------------------------------------------------------------------------
// entities, store and queue nodes made from the full extracts: one entity per declared table, one queue node per
// queue name, each with evidence at the declaring file and lines. Nothing here is guessed or asked of an agent.

const kindOf = (n) => String(n?.kind ?? '').toLowerCase();
const queueId = (name) => {
  const s = slug(name) || 'queue';
  return /(^|-)queue$/.test(s) ? s : `${s}-queue`;
};
/** A node of kind queue named for `name`: its id or title reads as the name, "<name>-queue" or "queue-<name>". */
const isQueueOf = (n, name) => {
  if (kindOf(n) !== 'queue') return false;
  const want = new Set([slug(name), queueId(name), `queue-${slug(name)}`]);
  return [n.id, n.title].some((x) => typeof x === 'string' && want.has(slug(x)));
};
/** A meta.sources row that records introspection not run (the pipeline's `introspection-skipped`, or a skipped row of the introspection area). */
const isSkippedIntrospection = (r) => isObj(r) && r.status === 'skipped' && (r.area === 'introspection' || /^introspection/.test(String(r.type ?? '')));
/** A meta.sources row that records introspection run: a row of the introspection area with status ok. */
const isRunIntrospection = (r) => isObj(r) && r.status === 'ok' && r.area === 'introspection';

/** "<name> <type...> [pk] [fk=<target>]", the field row of a prescan table; null for a "+N more" row. */
function parseFieldRow(row) {
  const parts = String(row).trim().split(/\s+/);
  if (!parts[0] || parts[0].startsWith('+')) return null;
  let pk = false;
  if (parts.length > 1 && parts[parts.length - 1].startsWith('fk=')) parts.pop();
  if (parts.length > 1 && parts[parts.length - 1] === 'pk') {
    parts.pop();
    pk = true;
  }
  const [name, ...type] = parts;
  return { name, type: type.join(' ') || 'unknown', ...(pk ? { pk: true } : {}), provenance: 'declared' };
}
const declaredAt = (t) => {
  const lines = typeof t.lines === 'string' && /^\d+(-\d+)?$/.test(t.lines) ? t.lines : Number.isInteger(t.line) && t.line > 0 ? String(t.line) : null;
  return lines === null ? [] : [{ path: t.file, lines }];
};

// ---------------------------------------------------------------------------
// workspace apps: one level-2 app node per app of the workspace, made by script

const appId = (name, dir) => {
  const last = String(name).split('/').pop();
  const s = slug(last) || slug(dir.split('/').pop()) || 'app';
  return /(^|-)app$/.test(s) ? s : `${s}-app`;
};
// kinds of an area's nodes that stay containers of their own beside the app
const BESIDE_APP = new Set([...STORE_KINDS, 'queue', 'external', 'app']);

/**
 * For each workspace app a slice lists ({name, dir, manifest}) that no level-2 node of kind app covers (its paths match
 * the manifest, or it cites a file under the app's directory), add the node: kind app, level 2, paths <dir>/**,
 * evidence at the manifest. The explorers' level-2 nodes of the same area that sit inside the app's directory (a service,
 * a module or a job the explorer took for the app) become level 3 and are listed in the app's `sub`; stores, queues and
 * external parties stay containers. The new node heads the area's list, so an area name in an edge finds it first.
 * Returns the number of nodes made.
 */
function makeAppNodes({ nodes, placed, slices, stacksOf, zoneId }) {
  const apps = [];
  for (const s of slices) {
    for (const a of list(s.workspaceApps)) {
      if (isObj(a) && typeof a.dir === 'string' && a.dir && typeof a.manifest === 'string' && a.manifest) {
        apps.push({ area: String(s.area ?? ''), name: typeof a.name === 'string' && a.name ? a.name : a.dir.split('/').pop(), dir: a.dir, manifest: a.manifest });
      }
    }
  }
  apps.sort((a, b) => cmp(a.dir, b.dir) || cmp(a.area, b.area));
  let made = 0;
  for (const app of apps) {
    const covers = (n) =>
      kindOf(n) === 'app' && Number(n.level) === 2 &&
      (matchAny(list(n.paths).filter((g) => typeof g === 'string'), app.manifest) ||
        list(n.evidence).some((e) => isObj(e) && typeof e.path === 'string' && e.path.startsWith(`${app.dir}/`)));
    if ([...nodes.values()].some(covers)) continue;
    let id = appId(app.name, app.dir);
    for (let n = 2; nodes.has(id); n++) id = `${appId(app.name, app.dir)}-${n}`;
    const mine = list(placed.get(app.area)).filter((x) => nodes.has(x));
    const inside = (n) => list(n.paths).length > 0 && list(n.paths).every((g) => typeof g === 'string' && (g === `${app.dir}/**` || g.startsWith(`${app.dir}/`)));
    const parts = mine.map((x) => nodes.get(x)).filter((n) => inside(n) && !BESIDE_APP.has(kindOf(n)) && [2, 3].includes(Number(n.level)));
    for (const n of parts) n.level = 3;
    const title = String(app.name).split('/').pop();
    const node = {
      id, zone: zoneId(zoneFor({ kind: 'app' }, stacksOf.get(app.area) ?? [])), kind: 'app', title,
      role: `Workspace app ${app.name} (${app.dir}); made by merge.mjs from the workspace declaration.`,
      paths: [`${app.dir}/**`], level: 2, evidence: [{ path: app.manifest, lines: '1' }],
    };
    if (parts.length) node.sub = [...new Set(parts.map((n) => String(n.title ?? n.id)))].sort(cmp);
    nodes.set(id, node);
    if (!placed.has(app.area)) placed.set(app.area, []);
    placed.get(app.area).unshift(id);
    made++;
  }
  return made;
}

/**
 * The entity id a reference means: the id itself, else the entity of that name (a schema prefix and case dropped), else
 * null. Ids win over names; among entities, the lowest id wins a shared name.
 */
function entityResolver(entities) {
  const index = new Map();
  const ents = [...entities.values()].sort(byId);
  const put = (k, id) => {
    if (typeof k === 'string' && k && !index.has(k.toLowerCase())) index.set(k.toLowerCase(), id);
  };
  for (const e of ents) put(e.id, e.id);
  for (const e of ents) put(e.name, e.id);
  return (ref) => {
    if (typeof ref !== 'string' || !ref) return null;
    if (entities.has(ref)) return ref;
    const k = ref.toLowerCase();
    return index.get(k) ?? index.get(k.split('.').pop()) ?? null;
  };
}

// ---------------------------------------------------------------------------
// containers, pipelines, infrastructure as code and data platform projects: nodes and edges made from the slices' rows
// (prescan's `images`, `services`, `pipelines`, `jobs`, `passes`, `resources`, `iacModules`, `iacReferences`, `dbtModels`,
// `dbtSources`, `dbtTests`, `lineage`). Everything here is declared in a file the extractor read, so each node and edge
// cites that block and is verified; no agent judgement is needed or asked.

const PLATFORM_NODE_CAP = 150; // nodes made per stack; the rest are counted in the derivation row, never silently dropped
const STORE_IMAGE = /(?:^|\/)(?:postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|valkey|memcached|mssql\/server|clickhouse[\w-]*|cassandra|couchdb|neo4j|influxdb|elasticsearch|opensearch|minio)(?:[:@]|$)/i;
const QUEUE_IMAGE = /(?:^|\/)(?:rabbitmq|kafka|redpanda|nats|activemq|pulsar)(?:[:@]|$)/i;
const SERVICE_LIKE = new Set(['service', 'app', 'store', 'queue', 'edge', 'external', 'database', 'db', 'datastore', 'cache']);
const PIPELINE_LABEL = { 'github-actions': 'GitHub Actions', 'azure-pipelines': 'Azure Pipelines' };

/** The places a prescan row cites: its own `evidence` when it holds several, else file and lines. */
const rowEvidence = (r) => {
  const own = list(r.evidence).filter((e) => isObj(e) && typeof e.path === 'string' && typeof e.lines === 'string' && /^\d+(-\d+)?$/.test(e.lines));
  if (own.length) return own;
  return declaredAt(r);
};

/**
 * Add the nodes the platform rows declare to `nodes`, in place, and return the edges between them as `links`
 * ({from, to, type, evidence, via, text}, node ids) for deriveLayer to draw, the counts in `made` and what could not be
 * resolved in `skipped`. A node an explorer already made for the same thing (the same id or title for its kind, the same
 * cited block, or the very paths) is used as it is, never repeated or rewritten; an update-mode carried node is such a node.
 */
function makePlatformNodes({ nodes, slices, zoneId }) {
  const made = { containers: 0, pipelines: 0, iac: 0, 'data-platform': 0 };
  const links = [];
  const skipped = [];
  const byRow = (a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(canon(a), canon(b));
  const rows = (key) => {
    const seen = new Set();
    return slices
      .flatMap((s) => list(s[key]))
      .filter((r) => isObj(r) && typeof r.file === 'string' && Number.isInteger(r.line) && r.line > 0 && typeof r.lines === 'string')
      .sort(byRow)
      .filter((r) => !seen.has(canon(r)) && seen.add(canon(r)));
  };
  const existing = [...nodes.values()].sort(byId);
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  /** The explorer's node for a row: kind and name match, or it cites the row's block, or it has the row's paths. */
  const find = ({ kinds = null, names = [], row, paths = [] }) =>
    existing.find((n) => {
      if (kinds !== null && kinds.has(kindOf(n)) && [n.id, n.title].some((x) => typeof x === 'string' && names.includes(slug(x)))) return true;
      if (list(n.evidence).some((e) => isObj(e) && e.path === row.file && e.lines === row.lines)) return true;
      return paths.length > 0 && sameList(list(n.paths), paths);
    })?.id ?? null;
  const unique = (id) => {
    let cand = id || 'node';
    for (let n = 2; nodes.has(cand); n++) cand = `${id || 'node'}-${n}`;
    return cand;
  };
  const place = (stack, row, spec) => {
    if (made[stack] >= PLATFORM_NODE_CAP) {
      skipped.push(`${stack}: more than ${PLATFORM_NODE_CAP} nodes, the rest (from ${row.file}:${row.line}) are not made`);
      return null;
    }
    const { id: wanted, zone, ...rest } = spec;
    const id = unique(wanted);
    nodes.set(id, { id, zone: zoneId(zone), ...rest });
    made[stack]++;
    return id;
  };
  const link = (from, to, type, row, via, text) => {
    if (from !== null && to !== null && from !== to) links.push({ from, to, type, evidence: rowEvidence(row), via, text });
  };
  const dirOf = (file) => posix.dirname(file);
  const portText = (p) => (isObj(p) ? [p.host, p.container ?? p.port].filter(Boolean).join(':') : String(p));

  // --- containers: a compose service is a node (its Dockerfile cited with it), a Dockerfile no service builds a node of its own
  const images = rows('images');
  const services = rows('services');
  const built = new Set();
  const serviceNode = new Map(); // `<compose dir>\0<name>` -> node id
  for (const s of services) {
    const key = `${dirOf(s.file)}\0${s.name}`;
    if (typeof s.name !== 'string' || !s.name || serviceNode.has(key)) continue; // an override file repeats a base service
    const build = isObj(s.build) ? s.build : null;
    const context = typeof build?.context === 'string' && build.context !== '.' && !build.context.startsWith('..') ? build.context.replace(/\/+$/, '') : null;
    const paths = context ? [`${context}/**`] : [];
    const found = find({ kinds: SERVICE_LIKE, names: [slug(s.name)], row: s, paths });
    if (found !== null) {
      serviceNode.set(key, found);
      if (typeof build?.dockerfile === 'string') built.add(build.dockerfile);
      continue;
    }
    const docker = typeof build?.dockerfile === 'string' ? images.find((i) => i.file === build.dockerfile) : undefined;
    if (typeof build?.dockerfile === 'string') built.add(build.dockerfile);
    const image = typeof s.image === 'string' ? s.image : null;
    const kind = build !== null ? 'service' : image !== null && STORE_IMAGE.test(image) ? 'store' : image !== null && QUEUE_IMAGE.test(image) ? 'queue' : 'service';
    const ports = list(s.ports).map(portText).filter(Boolean);
    const id = place('containers', s, {
      id: slug(s.name), zone: kind === 'service' ? 'service' : 'data', kind, title: s.name, paths, level: 2,
      role: `Compose service ${s.name}: ${build !== null ? `built from ${build.dockerfile ?? `${context ?? '.'}/Dockerfile`}` : `runs image ${image ?? 'unnamed'}`}${ports.length ? `, ports ${ports.join(', ')}` : ''}; made by merge.mjs from the prescan extract.`,
      evidence: unionEvidence(rowEvidence(s), docker ? rowEvidence(docker) : []),
    });
    if (id !== null) serviceNode.set(key, id);
  }
  for (const i of images) {
    if (built.has(i.file)) continue;
    built.add(i.file);
    const dir = dirOf(i.file);
    const paths = dir === '.' ? [] : [`${dir}/**`];
    if (find({ row: i, paths }) !== null) continue;
    const ports = list(i.ports).map(portText).filter(Boolean);
    place('containers', i, {
      id: slug(posix.basename(dir === '.' ? 'image' : dir)), zone: 'service', kind: 'service', title: dir === '.' ? 'Container image' : posix.basename(dir), paths, level: 2,
      role: `Container image built from ${i.file} (base ${i.base ?? 'unknown'})${ports.length ? `, exposes ${ports.join(', ')}` : ''}; no compose service builds it; made by merge.mjs from the prescan extract.`,
      evidence: rowEvidence(i),
    });
  }
  for (const s of services) {
    const from = serviceNode.get(`${dirOf(s.file)}\0${s.name}`) ?? null;
    for (const dep of list(s.dependsOn).filter((d) => typeof d === 'string')) {
      const to = serviceNode.get(`${dirOf(s.file)}\0${dep}`) ?? null;
      if (from !== null && to === null) skipped.push(`compose ${s.name} depends_on ${dep} at ${s.file}:${s.line}: no service of that name was made`);
      link(from, to, 'depends', s, 'depends_on', `Starts after ${dep} (compose depends_on): start order, not a call.`);
    }
  }

  // --- pipelines: a node per pipeline file and one per job or stage; needs and artefact hand-offs between the jobs
  const pipeNode = new Map(); // pipeline file -> node id
  for (const p of rows('pipelines')) {
    if (pipeNode.has(p.file)) continue;
    const name = typeof p.name === 'string' && p.name ? p.name : posix.basename(p.file);
    const found = find({ kinds: new Set(['pipeline']), names: [slug(name), slug(p.file)], row: p });
    if (found !== null) {
      pipeNode.set(p.file, found);
      continue;
    }
    const id = place('pipelines', p, {
      id: slug(name) || slug(p.file), zone: 'delivery', kind: 'pipeline', title: name, paths: [p.file], level: 2,
      role: `${PIPELINE_LABEL[p.kind] ?? p.kind} pipeline ${name}, ${list(p.triggers).length ? `triggered by ${list(p.triggers).join(', ')}` : 'with no declared trigger'}; made by merge.mjs from the prescan extract.`,
      evidence: rowEvidence(p),
    });
    if (id !== null) pipeNode.set(p.file, id);
  }
  const jobs = rows('jobs');
  const jobNode = new Map(); // `<pipeline file>\0<job or stage id>` -> node id
  for (const j of jobs) {
    const key = `${j.pipeline}\0${j.id}`;
    if (typeof j.id !== 'string' || !j.id || typeof j.pipeline !== 'string' || jobNode.has(key)) continue;
    const found = find({ row: j });
    if (found !== null) {
      jobNode.set(key, found);
      continue;
    }
    const head = pipeNode.has(j.pipeline) ? pipeNode.get(j.pipeline) : slug(j.pipeline);
    const what = j.kind === 'stage' ? 'stage' : 'job';
    const id = place('pipelines', j, {
      id: slug(`${head}-${j.id}`), zone: 'delivery', kind: 'job', title: j.kind === 'stage' ? `${j.id} (stage)` : String(j.id), paths: [], level: 3,
      role: `Pipeline ${what} ${j.id} of ${j.pipeline}${j.stage ? ` (stage ${j.stage})` : ''}${list(j.needs).length ? `, after ${list(j.needs).join(', ')}` : ''}; made by merge.mjs from the prescan extract.`,
      evidence: rowEvidence(j),
    });
    if (id !== null) jobNode.set(key, id);
  }
  for (const j of jobs) {
    const from = jobNode.get(`${j.pipeline}\0${j.id}`) ?? null;
    for (const need of list(j.needs).filter((d) => typeof d === 'string')) {
      const to = jobNode.get(`${j.pipeline}\0${need}`) ?? null;
      if (from !== null && to === null) skipped.push(`pipeline ${j.id} needs ${need} at ${j.file}:${j.line}: no job or stage of that name was made`);
      link(from, to, 'depends', j, 'needs', `Runs after ${need} (needs); the pipeline orders the two, nothing is called.`);
    }
  }
  for (const p of rows('passes')) {
    const from = jobNode.get(`${p.pipeline}\0${p.from}`) ?? null;
    const to = jobNode.get(`${p.pipeline}\0${p.to}`) ?? null;
    if ((from === null || to === null) && typeof p.name === 'string') skipped.push(`artifact ${p.name} at ${p.file}:${p.line}: no job node for ${from === null ? p.from : p.to}`);
    link(from, to, 'artifact', p, p.name, `Hands the ${p.name} artifact from ${p.from} to ${p.to}: uploaded by one job, downloaded by the other.`);
  }

  // --- infrastructure as code: a node per module and per resource; a reference is a depends edge, from the referrer
  const iacNode = new Map(); // `<scope>\0<address>` -> node id
  const flavour = (r) => (r.kind === 'bicep' ? 'Bicep' : 'Terraform');
  for (const m of rows('iacModules')) {
    const key = `${m.scope}\0${m.address}`;
    if (typeof m.address !== 'string' || iacNode.has(key)) continue;
    const paths = typeof m.target === 'string' && m.target && m.target !== '.' ? [`${m.target.replace(/\/+$/, '')}/**`] : [];
    const found = find({ kinds: new Set(['module']), names: [slug(m.address)], row: m, paths });
    if (found !== null) {
      iacNode.set(key, found);
      continue;
    }
    const id = place('iac', m, {
      id: slug(m.address), zone: 'platform', kind: 'module', title: m.address, paths, level: 2,
      role: `${flavour(m)} module ${m.name ?? m.address} from ${m.source ?? 'an unnamed source'}; made by merge.mjs from the prescan extract.`,
      evidence: rowEvidence(m),
    });
    if (id !== null) iacNode.set(key, id);
  }
  for (const r of rows('resources')) {
    const key = `${r.scope}\0${r.address}`;
    if (typeof r.address !== 'string' || iacNode.has(key)) continue;
    const found = find({ kinds: new Set(['resource']), names: [slug(r.address)], row: r });
    if (found !== null) {
      iacNode.set(key, found);
      continue;
    }
    const id = place('iac', r, {
      id: slug(r.address), zone: 'platform', kind: 'resource', title: r.address, paths: [], level: 3,
      role: `${flavour(r)} ${r.mode ?? 'managed'} resource ${r.address}${r.type ? ` of type ${r.type}` : ''} in ${r.scope}; made by merge.mjs from the prescan extract.`,
      evidence: rowEvidence(r),
    });
    if (id !== null) iacNode.set(key, id);
  }
  for (const r of rows('iacReferences')) {
    // a reference to a variable, a local or an output names nothing the extract made a node of: no edge, and no complaint
    const from = iacNode.get(`${r.scope}\0${r.from}`) ?? null;
    const to = iacNode.get(`${r.scope}\0${r.to}`) ?? null;
    const attrs = list(r.attributes).filter((a) => typeof a === 'string');
    link(from, to, 'depends', r, r.via ?? 'reference', `References ${r.to}${attrs.length ? ` (${attrs.join(', ')})` : ''} through ${r.via ?? 'a reference'}.`);
  }

  // --- dbt: a node per model and per source table; lineage runs from the upstream to the model that reads it
  const tests = new Map(); // `<scope>\0<kind>\0<target>` -> tests on it
  for (const t of rows('dbtTests')) tests.set(`${t.scope}\0${t.targetKind}\0${t.target}`, (tests.get(`${t.scope}\0${t.targetKind}\0${t.target}`) ?? 0) + 1);
  const dbtNode = new Map(); // `<scope>\0<model|source>\0<name or address>` -> node id
  for (const m of rows('dbtModels')) {
    const key = `${m.scope}\0model\0${m.name}`;
    if (typeof m.name !== 'string' || dbtNode.has(key)) continue;
    const found = find({ kinds: new Set(['model']), names: [slug(m.name)], row: m, paths: [m.file] });
    if (found !== null) {
      dbtNode.set(key, found);
      continue;
    }
    const n = tests.get(`${m.scope}\0model\0${m.name}`) ?? 0;
    const id = place('data-platform', m, {
      id: slug(m.name), zone: 'data', kind: 'model', title: m.name, paths: [m.file], level: 3,
      role: `dbt model ${m.name}${m.layer ? ` in the ${m.layer} layer` : ''}, materialized as ${m.materialization ?? 'view'}${n ? `, ${n} test${n === 1 ? '' : 's'}` : ''}; made by merge.mjs from the prescan extract.`,
      evidence: rowEvidence(m),
    });
    if (id !== null) dbtNode.set(key, id);
  }
  for (const s of rows('dbtSources')) {
    const key = `${s.scope}\0source\0${s.address}`;
    if (typeof s.address !== 'string' || dbtNode.has(key)) continue;
    const found = find({ kinds: new Set(['source']), names: [slug(s.address)], row: s });
    if (found !== null) {
      dbtNode.set(key, found);
      continue;
    }
    const n = tests.get(`${s.scope}\0source\0${s.address}`) ?? 0;
    const id = place('data-platform', s, {
      id: slug(s.address), zone: 'data', kind: 'source', title: s.address, paths: [], level: 3,
      role: `dbt source table ${s.address}, read by the project and loaded by something outside it${n ? `; ${n} test${n === 1 ? '' : 's'}` : ''}; made by merge.mjs from the prescan extract.`,
      evidence: rowEvidence(s),
    });
    if (id !== null) dbtNode.set(key, id);
  }
  for (const l of rows('lineage')) {
    const from = dbtNode.get(`${l.scope}\0${l.fromKind === 'source' ? 'source' : 'model'}\0${l.from}`) ?? null;
    const to = dbtNode.get(`${l.scope}\0model\0${l.to}`) ?? null;
    link(from, to, 'lineage', l, l.via ?? 'ref', `Model ${l.to} reads ${l.from} (${l.via ?? 'ref'}()): the data flows from the upstream into it.`);
  }
  return { made, links, skipped };
}

/**
 * Make the entities and queue nodes the extracts declare, in place. An explorer's entity of the same table (or model)
 * name is merged into: its id, store and extra fields stay, the declared fields and the declaring lines are added.
 * A new entity goes to the store node that owns its file, else a store node whose paths cover it, else the store of
 * an entity declared in the same file, else its area's one store node, else a store node made for the area. An
 * explorer's queue node of the same name is the queue's node. Returns the queues, for deriveLayer to draw the
 * producer and consumer edges, and the counts.
 */
function generateFromExtracts({ nodes, entities, slices, placed, zoneId, carried = { nodes: new Set(), entities: new Set() } }) {
  const made = { entities: 0, merged: 0, inferred: 0, stores: 0, queues: 0 };
  const owner = nodeResolver(nodes);
  const storeOwner = nodeResolver(new Map([...nodes].filter(([, n]) => STORE_KINDS.has(kindOf(n)))));
  const uniq = (pool, id) => {
    let cand = id;
    for (let n = 2; pool.has(cand); n++) cand = `${id}-${n}`;
    return cand;
  };

  // --- entities
  const byName = new Map();
  const nameIt = (name, id) => {
    if (typeof name === 'string' && name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), id);
  };
  for (const e of [...entities.values()].sort(byId)) nameIt(e.name, e.id);
  const madeStores = new Map(); // area -> id of the store node made for it
  const storeFor = (area, t) => {
    const o = owner(t.file);
    if (o !== null && STORE_KINDS.has(kindOf(nodes.get(o)))) return o;
    const so = storeOwner(t.file);
    if (so !== null) return so;
    const twin = [...entities.values()].sort(byId).find((e) => nodes.has(e.store) && list(e.evidence).some((x) => isObj(x) && x.path === t.file));
    if (twin) return twin.store;
    const own = [...new Set(list(placed.get(area)).filter((id) => STORE_KINDS.has(kindOf(nodes.get(id)))))];
    if (own.length === 1) return own[0];
    // the store an earlier run made for the area, carried from --previous: the same node, never a -2 sibling of it
    const kept = slug(`${area}-db`) || 'db';
    if (!madeStores.has(area) && carried.nodes.has(kept) && STORE_KINDS.has(kindOf(nodes.get(kept)))) madeStores.set(area, kept);
    if (!madeStores.has(area)) {
      const id = uniq(nodes, slug(`${area}-db`) || 'db');
      nodes.set(id, {
        id, zone: zoneId('data'), kind: 'store', title: `${area} database`,
        role: `Holds the tables the ${area} area declares or queries; made by merge.mjs from the prescan extract.`,
        paths: [], level: 2, evidence: declaredAt(t).length ? declaredAt(t) : [{ path: t.file, lines: '1' }],
      });
      madeStores.set(area, id);
      made.stores++;
    }
    return madeStores.get(area);
  };
  for (const s of slices) {
    const area = String(s.area ?? '');
    for (const t of list(s.tables)) {
      const table = typeof t?.table === 'string' && t.table ? t.table : typeof t?.name === 'string' && t.name ? t.name : null;
      if (!isObj(t) || table === null || typeof t.file !== 'string') continue;
      const fields = [];
      for (const row of list(t.fields)) {
        const f = parseFieldRow(row);
        if (f !== null && !fields.some((x) => x.name === f.name)) fields.push(f);
      }
      const evidence = declaredAt(t);
      const id = byName.get(table.toLowerCase()) ?? (typeof t.name === 'string' ? byName.get(t.name.toLowerCase()) : undefined);
      if (id !== undefined && entities.has(id) && carried.entities.has(id)) {
        // carried from --previous byte-identical: its declaring file did not change, so nothing is merged into it
        nameIt(t.name, id);
        nameIt(table, id);
        continue;
      }
      if (id !== undefined && entities.has(id)) {
        const e = entities.get(id);
        const theirs = list(e.fields).filter(isObj);
        const merged = fields.map((f) => {
          const had = theirs.find((x) => x.name === f.name);
          return had ? { ...had, ...f, ...(had.pk || f.pk ? { pk: true } : {}) } : f;
        });
        e.fields = [...merged, ...theirs.filter((x) => !fields.some((f) => f.name === x.name))];
        const ev = unionEvidence(evidence, e.evidence);
        if (ev.length) e.evidence = ev;
        nameIt(t.name, id);
        nameIt(table, id);
        made.merged++;
        continue;
      }
      const eid = uniq(entities, slug(table) || 'table');
      const e = { id: eid, store: storeFor(area, t), name: table, kind: 'table', fields };
      if (evidence.length) e.evidence = evidence;
      entities.set(eid, e);
      nameIt(table, eid);
      nameIt(t.name, eid);
      made.entities++;
    }
  }

  // --- entities the SQL names and nothing declares: provenance inferred, no fields, cited at the first statement that
  // names the table (a select, insert, update or delete; a ddl statement is not a use). An entity of that name, id or
  // table (a schema prefix is dropped) is the table's, declared or an explorer's, and nothing is added.
  const entityIds = new Set([...entities.keys()].map((k) => k.toLowerCase()));
  const queried = new Map(); // lowercased table (no schema) -> { name, area, at } of the earliest statement
  for (const s of slices) {
    const area = String(s.area ?? '');
    for (const row of list(s.sqlTables)) {
      const m = /^(\S+)\s+(\S+)\s+(.+):(\d+)$/.exec(String(row));
      if (!m || SQL_OPS[m[2].toLowerCase()] === undefined) continue;
      const key = m[1].toLowerCase().split('.').pop();
      if (!key || byName.has(m[1].toLowerCase()) || byName.has(key) || entityIds.has(key)) continue;
      const at = { path: m[3], lines: m[4] };
      const have = queried.get(key);
      if (!have || byLoc(at, have.at) < 0) queried.set(key, { name: m[1], area, at });
    }
  }
  for (const key of [...queried.keys()].sort(cmp)) {
    const q = queried.get(key);
    const eid = uniq(entities, slug(key) || 'table');
    const store = storeFor(q.area, { file: q.at.path, line: Number(q.at.lines) });
    entities.set(eid, { id: eid, store, name: q.name, kind: 'table', fields: [], provenance: 'inferred', evidence: [q.at] });
    nameIt(q.name, eid);
    nameIt(key, eid);
    made.entities++;
    made.inferred++;
  }

  // --- queue nodes: one per name, however many areas list it
  const queues = new Map();
  const loc = (x) => (isObj(x) && typeof x.file === 'string' && Number.isInteger(x.line) && x.line > 0 ? { path: x.file, lines: String(x.line) } : null);
  for (const s of slices) {
    for (const q of list(s.queues)) {
      if (!isObj(q) || typeof q.name !== 'string' || !q.name) continue;
      if (!queues.has(q.name)) queues.set(q.name, { name: q.name, decl: null, producers: [], consumers: [] });
      const g = queues.get(q.name);
      const d = loc(q);
      if (d !== null && (g.decl === null || byLoc(d, g.decl) < 0)) g.decl = d;
      for (const p of list(q.producers)) if (loc(p) !== null) g.producers.push(loc(p));
      for (const c of list(q.consumers)) if (loc(c) !== null) g.consumers.push(loc(c));
    }
  }
  const specs = [];
  for (const name of [...queues.keys()].sort(cmp)) {
    const g = queues.get(name);
    g.producers.sort(byLoc);
    g.consumers.sort(byLoc);
    let id = [...nodes.values()].sort(byId).find((n) => isQueueOf(n, name))?.id;
    if (id === undefined) {
      const at = g.decl ?? g.producers[0] ?? g.consumers[0];
      if (!at) continue;
      id = uniq(nodes, queueId(name));
      nodes.set(id, {
        id, zone: zoneId('data'), kind: 'queue', title: name,
        role: `Queue ${name}: ${g.producers.length} producer(s) and ${g.consumers.length} consumer(s) in the code; made by merge.mjs from the prescan extract.`,
        paths: [], level: 2, evidence: [at],
      });
      made.queues++;
    }
    specs.push({ id, name, producers: g.producers, consumers: g.consumers });
  }

  // --- containers, pipelines, infrastructure and data platform projects
  const platform = makePlatformNodes({ nodes, slices, zoneId });
  made.platform = Object.values(platform.made).reduce((a, b) => a + b, 0);
  return { queues: specs, made, platform };
}

/**
 * Add the derived edges, access rows and relations to the maps in place. Returns the meta.sources row and the
 * flows (http and queue hops, and scheduled entries, with their node ends) the sequence drafts are built from.
 */
function deriveLayer({ nodes, edges, entities, access, relations, slices, repo, queues = [], platform = null, made = null, carried = null }) {
  const owner = nodeResolver(nodes);
  const skipped = [];
  const count = { edges: 0, access: 0, relations: 0 };
  const flows = [];

  // --- edges from the links; each link is listed in the slices of both its areas, so key it without the side
  const links = new Map();
  for (const s of slices) {
    if (typeof s.unreadable === 'string') skipped.push(s.unreadable);
    for (const l of list(s.links)) {
      if (!isObj(l) || typeof l.from !== 'string' || typeof l.to !== 'string') continue;
      const key = `${l.kind}\u0000${l.from}\u0000${l.to}\u0000${l.via ?? ''}`;
      if (!links.has(key)) {
        links.set(key, {
          kind: String(l.kind), from: l.from, to: l.to, via: typeof l.via === 'string' ? l.via : null,
          wildcard: l.match === 'wildcard', call: typeof l.call === 'string' ? l.call : null,
        });
      }
    }
  }
  // --- entity lookup: id, name, and the ORM class and table names the slices map to an entity
  const entityOf = new Map();
  const nameIt = (name, id) => {
    if (typeof name === 'string' && name && !entityOf.has(name.toLowerCase())) entityOf.set(name.toLowerCase(), id);
  };
  const ents = [...entities.values()].sort(byId);
  for (const e of ents) nameIt(e.id, e.id);
  for (const e of ents) nameIt(e.name, e.id);
  const tableRows = slices.flatMap((s) => list(s.tables).filter(isObj));
  const lookup = (name) => {
    if (typeof name !== 'string' || !name) return null;
    const n = name.toLowerCase();
    return entityOf.get(n) ?? entityOf.get(n.split('.').pop()) ?? null;
  };
  for (const t of tableRows) {
    const id = lookup(t.table) ?? lookup(t.name);
    if (id !== null) nameIt(t.name, id);
  }

  const queueNodes = [...nodes.values()].filter((n) => kindOf(n) === 'queue').sort(byId);
  const queueNode = (name) => queueNodes.find((n) => isQueueOf(n, name))?.id ?? null;
  // the explorers' own edges, read before anything is derived: which queue nodes they gave a producer or a consumer
  const drawn = { producer: new Set(), consumer: new Set() };
  for (const e of edges.values()) {
    if (queueNodes.some((n) => n.id === e.to) && e.from !== e.to) drawn.producer.add(e.to);
    if (queueNodes.some((n) => n.id === e.from) && e.from !== e.to) drawn.consumer.add(e.from);
  }
  const groups = new Map();
  // `guess` is what makes a link inferred (a route matched through a wildcard segment, an import line found by its
  // file name only); a pair of nodes is verified as soon as one of its links is exact. `src` says what drew the
  // pair: a prescan row ('row', the default), an import ('import') or an ORM call ('orm').
  const add = (from, type, to, evidence, via, extra = {}, guess = null, src = 'row') => {
    const key = `${from}\u0000${type}\u0000${to}`;
    if (!groups.has(key)) groups.set(key, { from, type, to, evidence: [], vias: [], exact: false, guesses: [], srcs: new Set(), ...extra });
    const g = groups.get(key);
    g.srcs.add(src);
    g.evidence = unionEvidence(g.evidence, evidence);
    if (via && !g.vias.includes(via)) g.vias.push(via);
    if (guess === null) g.exact = true;
    else if (!g.guesses.includes(guess)) g.guesses.push(guess);
  };
  // the producers and consumers of each queue the extracts declare, each with its own line, to the queue's node
  for (const q of queues) {
    for (const [side, places] of [['producer', q.producers], ['consumer', q.consumers]]) {
      for (const at of places) {
        const from = owner(at.path);
        if (from === null) {
          skipped.push(`queue ${q.name} ${side} ${locText(at)}: no node owns ${at.path}`);
          continue;
        }
        if (from !== q.id) add(from, 'queue', q.id, [at], q.name, { async: true, consume: side === 'consumer' });
      }
    }
  }
  for (const key of [...links.keys()].sort(cmp)) {
    const l = links.get(key);
    const a = splitLoc(l.from);
    const b = splitLoc(l.to);
    const from = owner(a.path);
    const to = owner(b.path);
    const what = `${l.kind} ${l.from} > ${l.to}`;
    if (from === null || to === null) {
      skipped.push(`${what}: no node owns ${from === null ? a.path : b.path}`);
      continue;
    }
    if (l.kind === 'cron' || l.kind === 'hook') {
      // a scheduled entry: no edge (the schedule and its handler are often one node), only a flow for the drafts
      if (a.lines === null || b.lines === null) {
        skipped.push(`${what}: no line to cite`);
        continue;
      }
      flows.push({ kind: 'pull', trigger: l.kind, from, to, a, b, via: l.via ?? `${l.kind} ${from} > ${to}` });
      continue;
    }
    if (from === to) continue; // inside one node: not a cross-node edge
    if (l.kind === 'http' || l.kind === 'queue') {
      if (a.lines === null || b.lines === null) {
        skipped.push(`${what}: no line to cite`);
        continue;
      }
      if (l.kind === 'http') {
        const callSegs = l.call === null ? [] : l.call.replace(/^\S+\s+/, '').split('/').filter(Boolean);
        if (l.wildcard && callSegs.every((s) => s === '*')) {
          skipped.push(`${what}: the call path ${l.call ?? '(unknown)'} has no literal segment, so it names no route`);
          continue;
        }
        const guess = l.wildcard ? 'the call path matched the route through a wildcard segment' : null;
        add(from, 'api', to, [a, b], l.via ?? 'a route', {}, guess);
        flows.push({ kind: 'http', from, to, a, b, via: l.via ?? `${from} > ${to}` });
      } else {
        const q = l.via ? queueNode(l.via) : null;
        if (q !== null && q !== from && q !== to) {
          add(from, 'queue', q, [a], l.via, { async: true, consume: false });
          add(to, 'queue', q, [b], l.via, { async: true, consume: true });
        } else add(from, 'queue', to, [a, b], l.via ?? 'a queue', { async: true });
        flows.push({ kind: 'queue', from, to, a, b, via: l.via ?? 'queue' });
      }
    } else if (l.kind === 'import') {
      const found = importLine(repo, a.path, b.path);
      if (found === null) {
        skipped.push(`${what}: no import line to cite${typeof repo === 'string' ? '' : ' (no --repo)'}`);
        continue;
      }
      const guess = found.exact ? null : `the import line names ${basename(b.path).replace(/\.[^.]+$/, '')} by its file name only`;
      // typed by the node the import reaches: a store is sql, a queue is queue, anything else a call. Never `link`:
      // that stays for the navigational links an explorer writes.
      const reach = kindOf(nodes.get(to));
      const type = SQL_TARGETS.has(reach) ? 'sql' : reach === 'queue' ? 'queue' : 'call';
      add(from, type, to, [{ path: a.path, lines: found.line }], b.path, {}, guess, 'import');
    } else skipped.push(`${what}: unknown link kind`);
  }

  // --- ORM calls the slices list ({orm, target, ops, file, line}): the node that owns the file, the entity the target
  // names (by table, model or id), and the entity's store. Each call is one access row (applied below, with the other
  // access rows) and the pair node > store is one sql edge, the call lines its evidence.
  const ormUses = [];
  const ormRows = [];
  for (const s of slices) {
    for (const r of list(s.ormCalls)) {
      if (isObj(r) && typeof r.target === 'string' && typeof r.file === 'string' && Number.isInteger(r.line) && r.line > 0 && typeof r.ops === 'string') ormRows.push(r);
    }
  }
  ormRows.sort((p, q) => cmp(p.file, q.file) || p.line - q.line || cmp(p.target, q.target) || cmp(p.ops, q.ops) || cmp(String(p.orm), String(q.orm)));
  for (const r of ormRows) {
    const entity = lookup(r.target);
    const node = owner(r.file);
    const where = `${r.file}:${r.line}`;
    if (entity === null || node === null) {
      skipped.push(`orm ${r.orm ?? ''} ${r.target} at ${where}: ${entity === null ? `no entity models ${r.target}` : `no node owns ${r.file}`}`.replace(/\s{2,}/g, ' '));
      continue;
    }
    const ops = unionOps('', r.ops.toUpperCase());
    if (ops === '') continue; // no CRUD letter: nothing to record
    const at = [{ path: r.file, lines: typeof r.lines === 'string' && /^\d+(-\d+)?$/.test(r.lines) ? r.lines : String(r.line) }];
    ormUses.push({ node, entity, ops, evidence: at });
    const store = entities.get(entity)?.store;
    if (typeof store === 'string' && nodes.has(store) && store !== node) {
      add(node, 'sql', store, at, null, {}, null, 'orm');
      const g = groups.get(`${node}\u0000sql\u0000${store}`);
      g.tables ??= [];
      if (!g.tables.includes(entities.get(entity).name)) g.tables.push(entities.get(entity).name);
    }
  }
  // --- the edges between the nodes made from the container, pipeline, IaC and data platform rows: each cites the block
  // that declares it, so each is verified; the same pair of nodes joined twice by one type is one edge with both places
  for (const l of [...(platform?.links ?? [])].sort((p, q) => cmp(`${p.from}\u0000${p.type}\u0000${p.to}`, `${q.from}\u0000${q.type}\u0000${q.to}`) || cmp(String(p.via), String(q.via)))) {
    add(l.from, l.type, l.to, l.evidence, l.via, { text: l.text }, null, 'platform');
  }
  skipped.push(...(platform?.skipped ?? []));
  const mapped = new Set([...edges.values()].map((e) => `${e.from}\u0000${e.type}\u0000${e.to}`));
  for (const [key, g] of [...groups].sort((p, q) => cmp(p[0], q[0]))) {
    if (mapped.has(key)) continue; // the explorer already drew it
    const more = g.vias.length > 1 ? ` and ${g.vias.length - 1} more` : '';
    const imported = g.srcs.size === 1 && g.srcs.has('import');
    const desc =
      g.srcs.has('platform') ? `${g.text}${g.vias.length > 1 ? ` ${g.vias.length - 1} more place${g.vias.length === 2 ? '' : 's'} join the same two.` : ''}`
      : g.type === 'api' ? `Calls ${g.vias[0]}${more} over HTTP.`
      : g.srcs.has('orm') ? `Queries ${g.tables.slice(0, 3).join(', ')}${g.tables.length > 3 ? ` and ${g.tables.length - 3} more` : ''} through the ORM.`
      : g.type === 'queue' && g.consume ? `Takes ${g.vias[0]}${more} jobs off the queue and works them.`
      : g.type === 'queue' && !imported ? `Enqueues ${g.vias[0]}${more}; the sender does not wait.`
      : `Imports ${g.vias[0]}${more}.`;
    const inferred = !g.exact && g.guesses.length > 0;
    let id = slug(`${g.from}-${g.type}-${g.to}`);
    for (let n = 2; edges.has(id); n++) id = slug(`${g.from}-${g.type}-${g.to}-${n}`);
    const edge = {
      id, from: g.from, to: g.to, type: g.type,
      desc: inferred ? `${desc} Inferred: ${g.guesses.join('; ')}.` : desc,
      // the caller's side first: update mode gives an edge to the area of its first evidence path, its source
      evidence: g.evidence.slice(0, MAX_EDGE_EVIDENCE), confidence: inferred ? 'inferred' : 'verified', foundBy: 'static',
    };
    if (g.vias.length === 1 && g.type !== 'call' && !imported) edge.label = g.vias[0];
    if (g.async) edge.async = true;
    edges.set(id, edge);
    count.edges++;
  }

  // --- access rows from the SQL the slices list ("<table> <op> <path>:<line>"), in file and line order so the evidence
  // of a row does not depend on the order the slices or their rows arrive in
  const statements = [];
  for (const s of slices) {
    for (const row of list(s.sqlTables)) {
      const m = /^(\S+)\s+(\S+)\s+(.+):(\d+)$/.exec(String(row));
      if (m) statements.push({ table: m[1], op: m[2], path: m[3], line: m[4] });
    }
  }
  statements.sort((p, q) => cmp(p.path, q.path) || Number(p.line) - Number(q.line) || cmp(p.table, q.table) || cmp(p.op, q.op));
  for (const { table, op, path, line } of statements) {
    const ops = SQL_OPS[op.toLowerCase()];
    if (ops === undefined) continue; // ddl shapes the schema; it is not an access
    const entity = lookup(table);
    const node = owner(path);
    if (entity === null || node === null) {
      skipped.push(`sql ${table} ${op} at ${path}:${line}: ${entity === null ? 'no entity models the table' : `no node owns ${path}`}`);
      continue;
    }
    addAccess(access, { node, entity, ops, evidence: [{ path, lines: line }] });
    count.access++;
  }

  // --- access rows from the ORM calls (resolved above, in file and line order): ops unioned per node and entity
  for (const u of ormUses) {
    addAccess(access, u);
    count.access++;
  }

  // --- access rows from the ORM models the slices declare: the code node that declares a model of a table maps it,
  // so it reads it (R, the least the declaration shows; its SQL rows add the rest). A table created by DDL in a string
  // shapes the schema and is no access; a store node declaring a table is the table's home, not a reader of it.
  const isStore = (id) => STORE_KINDS.has(kindOf(nodes.get(id)));
  const declared = tableRows
    .filter((t) => t.orm !== 'sql' && typeof t.file === 'string' && Number.isInteger(t.line) && t.line > 0)
    .sort((p, q) => cmp(p.file, q.file) || p.line - q.line || cmp(String(p.table), String(q.table)));
  for (const t of declared) {
    const entity = lookup(t.table) ?? lookup(t.name);
    const node = owner(t.file);
    if (entity === null || node === null) {
      skipped.push(`orm ${t.name ?? t.table} at ${t.file}:${t.line}: ${entity === null ? 'no entity models the table' : `no node owns ${t.file}`}`);
      continue;
    }
    if (isStore(node)) continue;
    addAccess(access, { node, entity, ops: 'R', evidence: [{ path: t.file, lines: String(t.line) }] });
    count.access++;
  }
  // --- access rows from the queue rows, when an entity models the queue (a job table, a collection): the producer
  // writes a row of it (C), the consumer reads it (R). A queue with no entity is its queue node and edges only.
  const queueSides = [];
  for (const s of slices) {
    for (const q of list(s.queues)) {
      if (!isObj(q) || typeof q.name !== 'string' || !q.name) continue;
      for (const [ops, rows] of [['C', q.producers], ['R', q.consumers]]) {
        for (const r of list(rows)) {
          if (isObj(r) && typeof r.file === 'string' && Number.isInteger(r.line) && r.line > 0) queueSides.push({ name: q.name, ops, path: r.file, line: r.line });
        }
      }
    }
  }
  queueSides.sort((p, q) => cmp(p.path, q.path) || p.line - q.line || cmp(p.name, q.name) || cmp(p.ops, q.ops));
  for (const { name, ops, path, line } of queueSides) {
    const entity = lookup(name);
    if (entity === null) continue;
    const node = owner(path);
    if (node === null || isStore(node)) continue; // the queue edge pass already counts a side no node owns
    addAccess(access, { node, entity, ops, evidence: [{ path, lines: String(line) }] });
    count.access++;
  }

  // --- relations from declared foreign keys: a model field's fk, then an ORM table's fk=
  const hasField = (e, name) => list(e?.fields).some((f) => isObj(f) && f.name === name);
  const pkOf = (e) => list(e?.fields).find((f) => isObj(f) && f.pk === true)?.name ?? null;
  const addRel = (fromId, field, toId, toField, provenance) => {
    const from = entities.get(fromId);
    const to = entities.get(toId);
    const tf = toField ?? pkOf(to);
    if (!from || !to || !tf || !hasField(from, field) || !hasField(to, tf)) return;
    const r = { from: { entity: fromId, field }, to: { entity: toId, field: tf }, cardinality: '1-n', kind: 'fk', provenance };
    if (relations.has(relKey(r))) return;
    relations.set(relKey(r), r);
    count.relations++;
  };
  for (const e of ents) {
    for (const f of list(e.fields)) {
      if (!isObj(f) || !isObj(f.fk) || typeof f.fk.entity !== 'string') continue;
      addRel(e.id, f.name, f.fk.entity, typeof f.fk.field === 'string' ? f.fk.field : null, PROVENANCES.has(f.provenance) ? f.provenance : 'declared');
    }
  }
  for (const t of tableRows) {
    const fromId = lookup(t.table) ?? lookup(t.name);
    if (fromId === null) continue;
    for (const fs of list(t.fields)) {
      const m = /^(\S+)\s.*\bfk=(\S+)$/.exec(String(fs));
      if (!m) continue;
      const target = m[2];
      const dot = target.lastIndexOf('.');
      const toId = lookup(dot > 0 ? target.slice(0, dot) : target);
      if (toId !== null) addRel(fromId, m[1], toId, dot > 0 ? target.slice(dot + 1) : null, 'declared');
    }
  }

  // --- a queue the code feeds but nothing in it works, or the reverse, is named in one queue-unpaired source row so the
  // gap is visible; nothing is added to the model for it. A side the explorers drew (an edge into the queue node is a
  // producer, an edge out of it a consumer) is known, whatever the prescan rows say.
  const sides = new Map(); // queue name -> {producers: [loc], consumers: [loc]}
  for (const s of slices) {
    for (const q of list(s.queues)) {
      if (!isObj(q) || typeof q.name !== 'string' || !q.name) continue;
      if (!sides.has(q.name)) sides.set(q.name, { producers: [], consumers: [] });
      const g = sides.get(q.name);
      for (const [key, rows] of [['producers', q.producers], ['consumers', q.consumers]]) {
        for (const r of list(rows)) if (isObj(r) && typeof r.file === 'string' && Number.isInteger(r.line) && r.line > 0) g[key].push({ path: r.file, lines: String(r.line) });
      }
    }
  }
  const unpaired = [];
  for (const name of [...sides.keys()].sort(cmp)) {
    const g = sides.get(name);
    const id = queueNode(name);
    if (id === null) continue;
    const producers = g.producers.length > 0 || drawn.producer.has(id);
    const consumers = g.consumers.length > 0 || drawn.consumer.has(id);
    if (producers === consumers) continue; // paired, or no side seen at all: nothing to say
    const present = (producers ? g.producers : g.consumers).slice().sort(byLoc).map(locText);
    unpaired.push({
      type: 'queue-unpaired', queue: name, node: id, missing: producers ? 'consumer' : 'producer',
      note: `queue ${name} (node ${id}) has a ${producers ? 'producer' : 'consumer'}${present.length ? ` (${present.slice(0, 3).join(', ')})` : ''} in the code and no ${producers ? 'consumer' : 'producer'}: ` +
        `the other side is not in the checkout, or the queue is fed or worked from elsewhere`,
    });
  }

  const reasons = [...new Set(skipped)].sort(cmp);
  const tally = made ?? { entities: 0, merged: 0, inferred: 0, stores: 0, queues: 0 };
  const source = {
    type: 'derivation',
    derived: {
      ...count, entities: tally.entities, entitiesMerged: tally.merged, entitiesInferred: tally.inferred, stores: tally.stores, queues: tally.queues,
      ...(tally.apps ? { apps: tally.apps } : {}),
      ...(tally.platform ? { platformNodes: tally.platform } : {}),
      ...(carried !== null ? { carried: carried.total } : {}),
    },
    skipped: { count: skipped.length, reasons: reasons.slice(0, MAX_REASONS) },
    note:
      `merge.mjs made ${tally.entities} entit${tally.entities === 1 ? 'y' : 'ies'}${tally.inferred ? ` (${tally.inferred} inferred from the SQL the code runs)` : ''} (and merged ${tally.merged} into the explorers'), ` +
      `${tally.stores} store node(s) and ${tally.queues} queue node(s) from the declared tables and queues, ` +
      `${tally.apps ? `${tally.apps} app node(s) from the workspace declaration, ` : ''}` +
      `${tally.platform ? `${tally.platform} node(s) from the container, pipeline, infrastructure and data platform extracts, ` : ''}and derived ` +
      `${count.edges} edge(s), ${count.access} access row(s) from the SQL, ORM models and queues and ${count.relations} fk relation(s) from the prescan extracts; ` +
      `${skipped.length} link(s) or statement(s) could not be cited or resolved` +
      (carried !== null ? `; ${carriedText(carried)}` : ''),
  };
  return { source, flows, unpaired };
}

/** The update-mode carry-over, said in the derivation row's note. */
function carriedText(c) {
  return `update: ${c.total} carried from the previous model unchanged (${c.nodes} node(s), ${c.edges} edge(s), ${c.entities} entit${c.entities === 1 ? 'y' : 'ies'}): ` +
    `their evidence files are not among the ${c.changed} changed file(s)`;
}

// ---------------------------------------------------------------------------
// sequence drafts and the digest the synthesizer reads instead of the model

const MAX_DRAFTS = 12;
const MAX_PARTICIPANTS = 7;
const OPS_WORD = { C: 'insert', R: 'read', U: 'update', D: 'delete' };

/**
 * The flows merge drafts, each a sequence in the step grammar with every message citing its lines; the synthesizer
 * confirms, edits or drops them. One per HTTP entry point: the call to the route, the access rows cited in the handler's
 * file, each queue hop that file starts with the consumer's own access rows, and the response back to the caller. One per
 * queue whose producer and consumer are both known and no HTTP draft already shows as a hop: the producer enqueues, the
 * consumer handles, then the consumer's access rows. One per scheduled entry (a `cron` or `hook` link): the trigger
 * reaching its handler, then the handler's first access row. At most MAX_DRAFTS, taken in id order.
 */
export function draftSequences({ flows, model }) {
  const nodes = new Map(list(model.nodes).map((n) => [n.id, n]));
  const entities = new Map(list(model.entities).map((e) => [e.id, e]));
  const access = list(model.access);
  const title = (id) => nodes.get(id)?.title ?? id;
  const drafts = new Map();
  const covered = new Set(); // queue hops an HTTP draft already shows: producer, consumer and queue name
  const hopKey = (q) => `${q.from}\u0000${q.to}\u0000${q.via}`;
  // A draft under construction: msg adds a message (and the lanes it needs, within MAX_PARTICIPANTS), dataSteps the
  // access rows of a node cited in a file, `limit` of them at most.
  const flow = () => {
    const parts = new Map();
    const steps = [];
    const msg = (from, to, k, t, d, r, ret) => {
      const fresh = [from, to].filter((x) => !parts.has(x));
      if (parts.size + new Set(fresh).size > MAX_PARTICIPANTS) return;
      for (const x of [from, to]) {
        if (parts.has(x)) continue;
        const n = nodes.get(x);
        parts.set(x, { id: x, label: title(x), node: x, ...(typeof n?.zone === 'string' ? { zone: n.zone } : {}) });
      }
      steps.push({ m: [from, to], k, t, d, r, ...(ret === undefined ? {} : { ret }) });
    };
    const dataSteps = (nodeId, file, limit = Infinity) => {
      let made = 0;
      for (const a of access.filter((x) => x.node === nodeId).sort((p, q) => cmp(accessKey(p), accessKey(q)))) {
        if (made >= limit) break;
        const at = list(a.evidence).filter((e) => isObj(e) && e.path === file);
        const ent = entities.get(a.entity);
        if (!at.length || !ent || !nodes.has(ent.store) || ent.store === nodeId) continue;
        const verb = [...a.ops].map((c) => OPS_WORD[c]).join('/');
        const before = steps.length;
        msg(nodeId, ent.store, 'sql', `${verb} ${ent.name}`, `${title(nodeId)} runs ${verb} on ${ent.name} (ops ${a.ops}).`, at.sort(byLoc).map(locText));
        if (steps.length > before) made++;
      }
    };
    return { parts, steps, msg, dataSteps };
  };
  const keep = (id, flowTitle, summary, f) => {
    drafts.set(id, { id, title: flowTitle, summary, participants: [...f.parts.values()], steps: f.steps });
  };
  const byVia = (p, q) => cmp(p.via, q.via) || cmp(p.from, q.from) || cmp(p.to, q.to);

  for (const h of flows.filter((x) => x.kind === 'http').sort((p, q) => cmp(p.via, q.via) || cmp(p.from, q.from))) {
    const id = `draft-${slug(h.via) || slug(`${h.from}-${h.to}`)}`;
    if (drafts.has(id)) continue;
    const f = flow();
    f.msg(h.from, h.to, 'api', h.via, `${title(h.from)} calls ${h.via}.`, [locText(h.a), locText(h.b)]);
    f.dataSteps(h.to, h.b.path);
    const hops = flows.filter((q) => q.kind === 'queue' && q.from === h.to && q.a.path === h.b.path).sort((p, q) => cmp(p.via, q.via) || cmp(p.to, q.to));
    for (const q of hops) {
      f.msg(h.to, q.to, 'queue', q.via, `${title(h.to)} enqueues ${q.via} for ${title(q.to)}; it does not wait.`, [locText(q.a), locText(q.b)]);
      f.dataSteps(q.to, q.b.path);
    }
    if (f.steps.length < 2) continue; // a lone call is an edge, not a flow
    f.msg(h.to, h.from, 'api', 'response', `${title(h.to)} answers ${title(h.from)}.`, [locText(h.b)], 'response');
    for (const q of hops) covered.add(hopKey(q));
    keep(id, h.via, `Drafted by merge.mjs from the prescan links and access rows: ${title(h.from)} to ${title(h.to)}${hops.length ? ' and its queue hops' : ''}. Confirm against the code.`, f);
  }

  for (const q of flows.filter((x) => x.kind === 'queue' && !covered.has(hopKey(x))).sort(byVia)) {
    let id = `draft-queue-${slug(q.via) || slug(`${q.from}-${q.to}`)}`;
    if (drafts.has(id)) id = `${id}-${slug(`${q.from}-${q.to}`)}`;
    if (drafts.has(id)) continue;
    const f = flow();
    f.msg(q.from, q.to, 'queue', q.via, `${title(q.from)} enqueues ${q.via} for ${title(q.to)}; it does not wait.`, [locText(q.a), locText(q.b)]);
    f.msg(q.to, q.to, 'call', `handle ${q.via}`, `${title(q.to)} takes the message off ${q.via} and handles it.`, [locText(q.b)]);
    f.dataSteps(q.to, q.b.path);
    keep(id, `queue ${q.via}`, `Drafted by merge.mjs from the prescan queue links and access rows: ${title(q.from)} enqueues, ${title(q.to)} handles. Confirm against the code.`, f);
  }

  for (const p of flows.filter((x) => x.kind === 'pull').sort(byVia)) {
    let id = `draft-pull-${slug(p.via) || slug(`${p.from}-${p.to}`)}`;
    if (drafts.has(id)) id = `${id}-${slug(`${p.from}-${p.to}`)}`;
    if (drafts.has(id)) continue;
    const f = flow();
    const cron = p.trigger === 'cron';
    f.msg(p.from, p.to, cron ? 'pull' : 'event', p.via, `${cron ? 'The schedule' : 'The hook'} ${p.via} starts ${title(p.to)}.`, [locText(p.a), locText(p.b)]);
    f.dataSteps(p.to, p.b.path, 1);
    if (f.steps.length < 2) continue; // a trigger with no data step shows nothing the graph does not
    keep(id, `${cron ? 'scheduled' : 'hook'} ${p.via}`, `Drafted by merge.mjs from a ${p.trigger} link and the access rows of its handler's file: ${title(p.from)} to ${title(p.to)} and its first data step. Confirm against the code.`, f);
  }
  return [...drafts.values()].sort(byId).slice(0, MAX_DRAFTS);
}

export const DIGEST_CAP = 29000; // characters of digest.json: under 30 K with room for the brief
// A synth step is placed when it matches exactly one step shape of the model schema, the rule validate applies to it.
const STEP_SCHEMA = (() => {
  const schema = JSON.parse(readFileSync(new URL('../schema/archmap-model.schema.json', import.meta.url), 'utf8'));
  return { $defs: schema.$defs, ...schema.$defs.sequence.properties.steps.items };
})();

/**
 * Keep the steps of a synth sequence that match a step shape. Returns the sequence (or null when a drop left it under
 * 2 steps) and the meta.sources rows for what was dropped. A sequence nothing was dropped from is returned as it came.
 */
function placeSteps(seq) {
  if (!Array.isArray(seq.steps)) return { seq, rows: [] };
  const rows = [];
  const kept = [];
  seq.steps.forEach((step, index) => {
    const problems = validateSchema(STEP_SCHEMA, step);
    if (problems.length === 0) kept.push(step);
    else rows.push({ area: 'synthesizer', type: 'dropped-step', sequence: seq.id, index, reason: `step matches no step shape: ${problems[0].message}` });
  });
  if (rows.length === 0) return { seq, rows };
  if (kept.length < 2) {
    rows.push({ area: 'synthesizer', type: 'dropped-step', sequence: seq.id, reason: `sequence left with ${kept.length} step(s) after ${rows.length} unplaceable step(s) were dropped, fewer than 2: sequence dropped` });
    return { seq: null, rows };
  }
  return { seq: { ...seq, steps: kept }, rows };
}

const DIGEST_ORDER = ['about', 'project', 'commit', 'counts', 'zones', 'nodes', 'edges', 'entities', 'access', 'sequences', 'drafts', 'truncated'];
// kinds the cap trims, with the weight that protects the ones the synthesizer needs most
const DIGEST_TRIM = { access: 1, edges: 2, drafts: 2, entities: 3, nodes: 6 };
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 3)}...` : s);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** The text of digest.json: one top-level key per line, one array element per line. */
export function digestText(d) {
  const keys = [...DIGEST_ORDER.filter((k) => k in d), ...Object.keys(d).filter((k) => !DIGEST_ORDER.includes(k)).sort(cmp)];
  const line = (k) => {
    const v = d[k];
    if (Array.isArray(v) && v.length) return `${JSON.stringify(k)}:[\n${v.map((x) => JSON.stringify(x)).join(',\n')}\n]`;
    return `${JSON.stringify(k)}:${JSON.stringify(v)}`;
  };
  return `{\n${keys.filter((k) => d[k] !== undefined).map(line).join(',\n')}\n}\n`;
}

/** How many nodes no edge starts or ends at: the gaps a build report shows. */
function nodesWithoutEdges(model) {
  const touched = new Set();
  for (const e of list(model.edges)) {
    touched.add(e?.from);
    touched.add(e?.to);
  }
  return list(model.nodes).filter((n) => !touched.has(n?.id)).length;
}

/** The compact digest of a merged model, cut to DIGEST_CAP characters; what the cut drops is counted in `truncated`. */
export function buildDigest(model, { drafts = [] } = {}) {
  const d = compact({
    about: 'archmap digest of the merged model. Ids are final: reference them, never add nodes, edges, entities or access rows. drafts are sequences merge.mjs derived from the prescan links and access rows.',
    project: model.meta?.project,
    commit: model.meta?.commit,
    counts: {
      nodes: list(model.nodes).length, edges: list(model.edges).length, entities: list(model.entities).length,
      access: list(model.access).length, sequences: list(model.sequences).length, drafts: drafts.length,
      nodesWithoutEdges: nodesWithoutEdges(model),
    },
    zones: list(model.zones).map((z) => compact({ id: z.id, kind: z.kind })),
    nodes: list(model.nodes).map((n) => compact({ id: n.id, kind: n.kind, zone: n.zone, level: n.level, title: clip(n.title, 80), role: clip(n.role, 140) })),
    edges: list(model.edges).map((e) => compact({ id: e.id, from: e.from, to: e.to, type: e.type, async: e.async === true ? true : undefined })),
    entities: list(model.entities).map((e) => compact({ id: e.id, name: e.name, store: e.store, provenance: e.provenance === 'inferred' ? 'inferred' : undefined })),
    access: list(model.access).map((a) => `${a.node} ${a.entity} ${a.ops}`),
    sequences: list(model.sequences).map((s) => compact({ id: s.id, title: s.title })),
    drafts: clone(drafts),
  });
  d.truncated = {};
  const size = (x) => JSON.stringify(x).length + 2;
  const sizes = Object.fromEntries(Object.keys(DIGEST_TRIM).map((k) => [k, d[k].reduce((n, x) => n + size(x), 0)]));
  let over = digestText(d).length - DIGEST_CAP;
  while (over > 0) {
    let best = null;
    for (const k of Object.keys(DIGEST_TRIM)) {
      if (!d[k].length) continue;
      if (best === null || sizes[k] / DIGEST_TRIM[k] > sizes[best] / DIGEST_TRIM[best]) best = k;
    }
    if (best === null) break;
    const gone = d[best].pop();
    sizes[best] -= size(gone);
    d.truncated[best] = (d.truncated[best] ?? 0) + 1;
    over -= size(gone);
    if (over <= 0) over = digestText(d).length - DIGEST_CAP; // the estimate is close; the text decides
  }
  return d;
}

// ---------------------------------------------------------------------------
// evidence against the repository at meta.commit (mirrors validate.mjs, which reads the same way)

const LINES = /^([0-9]+)(?:-([0-9]+))?$/;
const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });

/**
 * A reader of `repo` at `commit`, or null when there is none to read (no repo, not a git repository, commit unknown).
 * `lineCount(path)` is the file's line count at the commit, or null when the path is not a file there; `text(path)` is
 * the file's text at the commit, or null likewise.
 */
export function evidenceReader(repo, commit) {
  if (typeof repo !== 'string' || typeof commit !== 'string' || !commit || commit.startsWith('-')) return null;
  try {
    git(repo, ['rev-parse', '--git-dir']);
    git(repo, ['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    return null;
  }
  const texts = new Map();
  const counts = new Map();
  const text = (path) => {
    if (texts.has(path)) return texts.get(path);
    let t = null;
    try {
      git(repo, ['cat-file', '-e', `${commit}:${path}`]);
      t = git(repo, ['cat-file', 'blob', `${commit}:${path}`]); // fails for a directory
    } catch { /* absent */ }
    texts.set(path, t);
    return t;
  };
  return {
    short: commit.slice(0, 12),
    text,
    lineCount(path) {
      if (counts.has(path)) return counts.get(path);
      const t = text(path);
      const n = t === null ? null : t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
      counts.set(path, n);
      return n;
    },
  };
}

/**
 * Clamp and drop the evidence entries of one element in place. Returns false when the element is left without any
 * (and `required`), so the caller drops it. Rows go to `rows`.
 */
function normaliseEvidence(el, { id, area, required, reader, rows }) {
  if (!Array.isArray(el.evidence) || el.evidence.length === 0) return true;
  const kept = [];
  const mine = [];
  for (const e of el.evidence) {
    const m = isObj(e) && typeof e.path === 'string' && typeof e.lines === 'string' ? LINES.exec(e.lines) : null;
    if (m === null) {
      kept.push(e); // not a {path, lines} the repository can answer for: validate has the say
      continue;
    }
    const total = reader.lineCount(e.path);
    if (total === null || total === 0) {
      const why = total === null ? 'is not a file' : 'is an empty file';
      const row = { area, type: 'dropped-evidence', id, path: e.path, note: `area ${area}: ${id}: evidence "${e.path}" ${why} at ${reader.short}; entry dropped` };
      mine.push(row);
      continue;
    }
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (start < 1 || end < start || end <= total) {
      kept.push(e); // in range (or malformed, which merge cannot mend)
      continue;
    }
    const lo = Math.min(start, total);
    const lines = lo === total ? String(total) : `${lo}-${total}`;
    mine.push({ area, type: 'clamped-evidence', id, path: e.path, note: `area ${area}: ${id}: lines ${e.lines} of "${e.path}" clamped to ${lines} (${total} lines at ${reader.short})` });
    kept.push({ ...e, lines });
  }
  const survives = kept.length > 0 || !required;
  if (!survives) mine[mine.length - 1].note += `; ${id} dropped: no evidence left`;
  rows.push(...mine);
  if (kept.length > 0) el.evidence = kept;
  else delete el.evidence;
  return survives;
}

/**
 * Pure merge (it reads files only under `repo`, as text, to cite an import line, and with git at meta.commit to check evidence).
 * @param {{fragments?: object[], previous?: object, synth?: object, areas?: string[], extracts?: object[], repo?: string, changed?: string[],
 *   meta?: {project?: string, commit?: string, profile?: string, generatedAt?: string, repoUrl?: string, schemaVersion?: string}}} input
 *   `extracts` are the per-area prescan slices (<work>/extracts/*.json); `repo` is the analysed tree. `changed`
 *   (update mode only) lists the files the commit changed: an affected area's unchanged elements are carried over.
 * @returns {{model: object, digest: object, conflicts: {ids: string[], reason: string}[], renames: object[], notes: string[], zonesCreated: string[], evidenceChecked: boolean}}
 *   `evidenceChecked`: evidence was read at meta.commit in `repo` (so the caller validates with --repo)
 */
export function merge({ fragments = [], previous, synth, areas, meta = {}, extracts, repo, changed } = {}) {
  const conflicts = [];
  const renames = [];
  const notes = [];
  const prev = isObj(previous) ? clone(previous) : null;
  const affected = prev && Array.isArray(areas) ? new Set(areas) : null; // null with prev = all areas
  const updateMode = prev !== null && affected !== null;
  // update with the commit's changed files: inside an affected area only what the change touched is the fragment's
  const changedFiles = updateMode && Array.isArray(changed) ? new Set(changed.filter((p) => typeof p === 'string')) : null;
  const slices = list(extracts)
    .filter(isObj)
    .map(clone)
    .sort((a, b) => cmp(String(a.area ?? ''), String(b.area ?? '')) || cmp(canon(a), canon(b)));
  const stacksOf = new Map(slices.map((s) => [s.area, list(s.stacks).map(String)]));
  const containers = containerZones(slices);

  // update mode: an affected area whose fragment file could not be read (the CLI's stub, `unreadable: true`, and no
  // readable fragment of the area beside it) is not replaced by nothing: its previous elements stay, as if it were
  // not in --areas, and a conflict says so
  const isStub = (f) => isObj(f) && f.unreadable === true;
  const unreadableAreas = new Map();
  if (updateMode) {
    const readable = new Set(fragments.filter((f) => isObj(f) && !isStub(f)).map((f) => f.area));
    for (const f of fragments.filter(isStub)) {
      if (typeof f.area === 'string' && affected.has(f.area) && !readable.has(f.area) && !unreadableAreas.has(f.area)) unreadableAreas.set(f.area, f);
    }
  }
  const replaced = updateMode ? new Set([...affected].filter((a) => !unreadableAreas.has(a))) : null;

  // fragments in area order; in update mode only the affected areas
  const fixNotes = [];
  const frags = fragments
    .map((f, i) => ({ f, area: typeof f?.area === 'string' && f.area ? f.area : `fragment${i}` }))
    .filter((x) => isObj(x.f) && (!updateMode || replaced.has(x.area)))
    .map((x) => {
      const n = normaliseFragment(x.f, x.area, stacksOf.get(x.area) ?? [], containers.zoneOf);
      fixNotes.push(...n.notes);
      return { f: n.f, area: x.area };
    })
    .sort((a, b) => cmp(a.area, b.area) || cmp(canon(a.f), canon(b.f)));

  // update mode: --areas and the fragment directory must name the same areas, or an area's elements vanish
  // (listed, no fragment) or a fragment is dropped (present, not listed) with nothing said
  if (updateMode) {
    const present = new Set(fragments.filter(isObj).map((f, i) => (typeof f.area === 'string' && f.area ? f.area : `fragment${i}`)));
    for (const a of [...affected].sort(cmp)) {
      if (!present.has(a)) {
        conflicts.push({ ids: [a], reason: `area '${a}' is in --areas but has no fragment; what it owned is removed and nothing replaces it` });
      }
    }
    for (const a of [...present].sort(cmp)) {
      if (!affected.has(a)) {
        conflicts.push({ ids: [a], reason: `fragment of area '${a}' is not in --areas and was ignored; list it in --areas to merge it` });
      }
    }
    for (const a of [...unreadableAreas.keys()].sort(cmp)) {
      conflicts.push({ ids: [a], reason: `fragment of area '${a}' is unreadable; the area's previous nodes, edges, entities and access rows were kept unchanged; re-run its explorer to update it` });
    }
  }

  // --- the part of the previous model that stays
  const isOwned = prev ? ownerTest(updateMode ? [...replaced] : null, prev.meta?.coverage) : () => false;
  const keep = (arr, owned) => {
    const kept = [];
    const gone = [];
    for (const el of list(arr)) (prev && isOwned(el) && owned(el) ? gone : kept).push(el);
    return { kept, gone };
  };
  const nodePart = keep(prev?.nodes, () => true);
  const goneNodeIds = new Set(nodePart.gone.map((n) => n.id));
  const edgePart = keep(prev?.edges, () => true);
  const entityPart = prev
    ? (() => {
        const kept = [];
        const gone = [];
        for (const e of list(prev.entities)) {
          const own = list(e.evidence).length ? isOwned(e) : goneNodeIds.has(e.store);
          (own ? gone : kept).push(e);
        }
        return { kept, gone };
      })()
    : { kept: [], gone: [] };
  const goneEntityIds = new Set(entityPart.gone.map((e) => e.id));
  const accessPart = prev
    ? (() => {
        const kept = [];
        const gone = [];
        for (const a of list(prev.access)) {
          const own = list(a.evidence).length ? isOwned(a) : goneNodeIds.has(a.node) || goneEntityIds.has(a.entity);
          (own ? gone : kept).push(a);
        }
        return { kept, gone };
      })()
    : { kept: [], gone: [] };

  const zones = new Map(list(prev?.zones).map((z) => [z.id, clone(z)]));
  const nodes = new Map(nodePart.kept.map((n) => [n.id, clone(n)]));
  const edges = new Map(edgePart.kept.map((e) => [e.id, clone(e)]));
  const entities = new Map(entityPart.kept.map((e) => [e.id, clone(e)]));
  const access = new Map();
  for (const a of accessPart.kept) access.set(accessKey(a), clone(a));
  const relations = new Map(list(prev?.relations).map((r) => [relKey(r), clone(r)]));
  const sequences = new Map(list(prev?.sequences).map((s) => [s.id, clone(s)]));
  const views = new Map(list(prev?.views).map((v) => [v.id, clone(v)]));

  const uniqueId = (pool, id, area) => {
    let cand = `${id}-${area}`;
    for (let n = 2; pool.has(cand); n++) cand = `${id}-${area}-${n}`;
    return cand;
  };
  // one zone per spelling: an exact id first, then any zone whose id reads the same once case and separators go
  const seenZones = new Set([...zones.keys(), ...[...nodes.values()].map((n) => n.zone).filter((z) => typeof z === 'string')]);
  const resolveZone = (id) => {
    if (typeof id !== 'string') return id;
    if (!seenZones.has(id)) {
      const s = zoneSlug(id);
      const twin = [...seenZones].sort(cmp).find((z) => zoneSlug(z) === s);
      id = twin ?? (id.trim().toLowerCase().replace(/\s+/g, '-') || id);
    }
    seenZones.add(id);
    return id;
  };
  const byPaths = new Map(); // paths key -> {id, area} of the first node this run that covers exactly those paths
  const collapsed = new Map(); // node id dropped as a same-paths twin -> the id kept
  const placed = new Map(); // area -> ids of the nodes it ended up with, in the explorer's order
  const origin = { edges: new Map(), entities: new Map(), access: new Map(), relations: new Map() }; // element key -> area

  // --- fragments
  const sources = list(prev?.meta?.sources).filter(
    (s) => !(isObj(s) && typeof s.area === 'string' && (replaced === null || replaced.has(s.area) || (unreadableAreas.has(s.area) && s.type === 'explorer'))),
  );
  // an area kept for an unreadable fragment: its explorer row says this run's file was skipped and the old elements stay
  for (const [area, stub] of [...unreadableAreas].sort((a, b) => cmp(a[0], b[0]))) {
    const sk = isObj(stub.skipped) ? stub.skipped : {};
    sources.push({
      area,
      type: 'explorer',
      skipped: { count: Number.isInteger(sk.count) ? sk.count : 1, reasons: list(sk.reasons).map(String) },
      note: `area ${area}: fragment unreadable; the previous elements of the area were kept`,
    });
  }
  const coverage = {};
  for (const [a, g] of Object.entries(prev?.meta?.coverage ?? {})) {
    if (updateMode && !replaced.has(a)) coverage[a] = g;
  }

  for (const { f, area } of frags) {
    const nodeMap = new Map();
    const entityMap = new Map();
    const mine = [];
    placed.set(area, mine);
    const note = (kind, from, to) => {
      renames.push({ area, kind, from, to });
    };

    for (const raw of list(f.zones)) {
      if (!isObj(raw) || typeof raw.id !== 'string') continue;
      const id = resolveZone(raw.id);
      if (!zones.has(id)) zones.set(id, { ...clone(raw), id });
    }

    for (const raw of list(f.nodes)) {
      if (!isObj(raw)) continue;
      const n = stripUser(raw);
      n.zone = resolveZone(n.zone);
      const have = nodes.get(n.id);
      if (have !== undefined && canon(stripUser(have)) === canon(n)) {
        mine.push(n.id);
        continue; // identical: deduped
      }
      // the same paths in another area: one component two explorers both described; the first area's node stays
      const key = pathsKey(n);
      const twin = key === null ? undefined : byPaths.get(key);
      if (twin !== undefined && twin.area !== area) {
        mine.push(twin.id);
        if (twin.id !== n.id) {
          nodeMap.set(n.id, twin.id);
          collapsed.set(n.id, twin.id);
          renames.push({ area, kind: 'node', from: n.id, to: twin.id, reason: `same paths as node "${twin.id}" of area ${twin.area}` });
        }
        continue;
      }
      let id = n.id;
      if (have !== undefined) {
        id = uniqueId(nodes, n.id, area);
        nodeMap.set(n.id, id);
        note('node', n.id, id);
      }
      nodes.set(id, { ...n, id });
      mine.push(id);
      if (key !== null && !byPaths.has(key)) byPaths.set(key, { id, area });
    }
    const mapNode = (id) => nodeMap.get(id) ?? id;

    const incoming = [];
    for (const raw of list(f.entities)) {
      if (!isObj(raw)) continue;
      const e = clone(raw);
      if (typeof e.store === 'string') e.store = mapNode(e.store);
      const have = entities.get(e.id);
      if (have !== undefined && canon(have) !== canon(e)) {
        const id = uniqueId(entities, e.id, area);
        entityMap.set(e.id, id);
        note('entity', e.id, id);
        e.id = id;
      }
      incoming.push(e);
    }
    const mapEntity = (id) => entityMap.get(id) ?? id;
    for (const e of incoming) {
      for (const fld of list(e.fields)) if (isObj(fld?.fk)) fld.fk.entity = mapEntity(fld.fk.entity);
      if (!entities.has(e.id)) {
        entities.set(e.id, e);
        origin.entities.set(e.id, area);
      }
    }

    for (const raw of list(f.edges)) {
      if (!isObj(raw)) continue;
      const e = clone(raw);
      e.from = mapNode(e.from);
      e.to = mapNode(e.to);
      const have = edges.get(e.id);
      if (have === undefined) {
        edges.set(e.id, e);
        origin.edges.set(e.id, area);
      } else if (canon(have) === canon(e)) continue;
      else {
        const id = uniqueId(edges, e.id, area);
        note('edge', e.id, id);
        edges.set(id, { ...e, id });
        origin.edges.set(id, area);
      }
    }

    for (const raw of list(f.access)) {
      if (!isObj(raw)) continue;
      const row = { ...clone(raw), node: mapNode(raw.node), entity: mapEntity(raw.entity) };
      addAccess(access, row);
      if (!origin.access.has(accessKey(row))) origin.access.set(accessKey(row), area);
    }
    for (const raw of list(f.relations)) {
      if (!isObj(raw)) continue;
      const r = clone(raw);
      for (const side of ['from', 'to']) if (isObj(r[side])) r[side].entity = mapEntity(r[side].entity);
      if (!relations.has(relKey(r))) {
        relations.set(relKey(r), r);
        origin.relations.set(relKey(r), area);
      }
    }

    coverage[area] = list(f.coverage).filter((g) => typeof g === 'string');
    const sk = isObj(f.skipped) ? f.skipped : {};
    sources.push({
      area,
      type: 'explorer',
      skipped: { count: Number.isInteger(sk.count) ? sk.count : 0, reasons: list(sk.reasons).map(String) },
    });
    for (const s of list(f.sources)) if (isObj(s)) sources.push({ ...clone(s), area });
  }
  sources.push(...fixNotes);

  // --- evidence the repository cannot back at meta.commit: clamped or dropped here, so validate --repo has nothing
  // to refuse over it. Only what this run's fragments brought; a dropped node or edge takes its references along
  // in the pass below.
  const reader = evidenceReader(repo, meta.commit ?? prev?.meta?.commit);
  if (reader !== null) {
    const rows = [];
    const nodeArea = new Map();
    for (const [area, ids] of placed) for (const id of ids) if (!nodeArea.has(id)) nodeArea.set(id, area);
    // nodes and edges must keep one entry; entity and access evidence is optional
    for (const id of [...nodes.keys()]) {
      if (nodeArea.has(id) && !normaliseEvidence(nodes.get(id), { id, area: nodeArea.get(id), required: true, reader, rows })) nodes.delete(id);
    }
    for (const [id, e] of [...edges]) {
      if (origin.edges.has(id) && !normaliseEvidence(e, { id, area: origin.edges.get(id), required: true, reader, rows })) edges.delete(id);
    }
    for (const [id, e] of entities) {
      if (!origin.entities.has(id)) continue;
      const area = origin.entities.get(id);
      normaliseEvidence(e, { id, area, required: false, reader, rows });
      for (const fld of list(e.fields)) {
        if (isObj(fld)) normaliseEvidence(fld, { id: `${id}.${fld.name}`, area, required: false, reader, rows });
      }
    }
    for (const [k, a] of access) {
      if (origin.access.has(k)) normaliseEvidence(a, { id: `access:${a.node}/${a.entity}`, area: origin.access.get(k), required: false, reader, rows });
    }
    sources.push(...rows);
  }

  const dropRow = (area, id, target, what) => {
    sources.push({ area, type: 'dropped-ref', id, target: String(target), note: `area ${area}: ${what} dropped: "${target}" does not exist` });
  };
  const areaOf = (map, key) => map.get(key) ?? 'previous';

  // --- update with --changed: an element of an affected area whose evidence files are all unchanged is the previous
  // model's, byte for byte, whatever the fragment made of it; one whose files changed and that the fragment left out
  // is removed, and said. Before the app nodes and the references, so both see the carried nodes.
  const carried = { nodes: new Set(), edges: new Set(), entities: new Set() };
  const leftOut = []; // touched by the change and not in the fragment: removed unless the extracts make it again
  if (changedFiles !== null) {
    const globsOf = new Map([...replaced].sort(cmp).map((a) => [a, list(prev.meta?.coverage?.[a]).filter((g) => typeof g === 'string')]));
    const areaOwning = (el) => {
      const p = list(el?.evidence)[0]?.path;
      for (const [a, g] of globsOf) if (typeof p === 'string' && matchAny(g, p)) return a;
      return 'previous';
    };
    const files = (el) => [
      ...list(el.evidence), ...list(el.fields).flatMap((f) => (isObj(f) ? list(f.evidence) : [])),
    ].filter(isObj).map((e) => e.path);
    const touched = (el) => files(el).some((p) => changedFiles.has(p));
    // carried only on evidence: an element that cites no file has nothing to show it unchanged, so the fragment decides
    const carriable = (el) => files(el).length > 0 && !touched(el);
    const what = { nodes: 'node', edges: 'edge', entities: 'entity' };
    for (const [kind, part, map] of [['nodes', nodePart.gone, nodes], ['edges', edgePart.gone, edges], ['entities', entityPart.gone, entities]]) {
      for (const p of part) {
        if (!isObj(p) || typeof p.id !== 'string') continue;
        if (carriable(p)) {
          map.set(p.id, clone(p));
          carried[kind].add(p.id);
        } else if (!map.has(p.id)) {
          const why = touched(p) ? 'its evidence changed' : 'it cites no evidence that could show it unchanged';
          leftOut.push({ map, id: p.id, area: areaOwning(p), what: what[kind], why });
        }
      }
    }
  }

  // a level-2 app node per workspace app the explorers made none for, before the references are resolved so that an
  // area name in an edge ("area:api") finds the app node first
  const appsMade = makeAppNodes({
    nodes, placed, zoneId: resolveZone, stacksOf,
    slices: updateMode ? slices.filter((s) => replaced.has(s.area)) : slices,
  });
  // the carried nodes are their area's, after the fragment's own, for `area:<id>` and the area's one store node
  if (carried.nodes.size) {
    const globsOf = [...replaced].sort(cmp).map((a) => [a, list(prev.meta?.coverage?.[a]).filter((g) => typeof g === 'string')]);
    for (const id of [...carried.nodes].sort(cmp)) {
      const p = list(nodes.get(id)?.evidence)[0]?.path;
      const area = globsOf.find(([, g]) => typeof p === 'string' && matchAny(g, p))?.[0];
      if (area === undefined) continue;
      if (!placed.has(area)) placed.set(area, []);
      if (!placed.get(area).includes(id)) placed.get(area).push(id);
    }
  }

  // a reference from another fragment to a node that collapsed into its same-paths twin follows it
  const follow = (id) => (collapsed.has(id) && !nodes.has(id) ? collapsed.get(id) : id);

  // --- references that point at nothing. An explorer cannot know another area's node ids, so it names the area
  // (`to: "api"` or `to: "area:api"`): that is the area's level-2 app or service node, else its first node. What
  // still resolves to nothing is dropped, one dropped-ref row each, so a stray reference never costs the build.
  {
    const isHub = (n) => Number(n.level) === 2 && ['app', 'service'].includes(String(n.kind).toLowerCase());
    // an area with no fragment this run (update mode: an unaffected one) is the previous model's nodes of that area,
    // those with a path or an evidence file in its meta.coverage globs, in id order
    const prevIds = new Map();
    const previousOf = (area) => {
      if (!prevIds.has(area)) {
        const globs = list(prev?.meta?.coverage?.[area]).filter((g) => typeof g === 'string');
        // a path glob is in the area when it is one of the area's globs or its literal directory lies inside them
        const pathIn = (p) => {
          if (globs.includes(p)) return true;
          const segs = p.split('/');
          const k = segs.findIndex((s) => /[*?[{]/.test(s));
          if (k === -1) return matchAny(globs, p);
          return k > 0 && matchAny(globs, `${segs.slice(0, k).join('/')}/-`);
        };
        const inArea = (n) =>
          list(n.evidence).some((e) => isObj(e) && typeof e.path === 'string' && matchAny(globs, e.path)) ||
          list(n.paths).some((p) => typeof p === 'string' && pathIn(p));
        prevIds.set(area, globs.length ? nodePart.kept.filter((n) => isObj(n) && inArea(n)).map((n) => n.id).sort(cmp) : []);
      }
      return prevIds.get(area);
    };
    const areaIds = (area) => (placed.has(area) ? list(placed.get(area)) : previousOf(area)).filter((id) => nodes.has(id));
    const hubOf = (area) => {
      const ids = areaIds(area);
      return ids.find((id) => isHub(nodes.get(id))) ?? ids[0] ?? null;
    };
    // The node of `area` that owns a file the edge's own evidence lines name, read at meta.commit, when exactly one
    // does; null otherwise (no reader, no file named, or more than one node), and the caller keeps the hub.
    const PATH_TOKEN = /[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]+/g;
    const ownerOf = new Map();
    const namedOwner = (area, e) => {
      if (reader === null) return null;
      if (!ownerOf.has(area)) ownerOf.set(area, nodeResolver(new Map(areaIds(area).map((nid) => [nid, nodes.get(nid)]))));
      const owner = ownerOf.get(area);
      const found = new Set();
      for (const cite of list(e.evidence)) {
        const m = isObj(cite) && typeof cite.path === 'string' && typeof cite.lines === 'string' ? LINES.exec(cite.lines) : null;
        const text = m === null ? null : reader.text(cite.path);
        if (text === null) continue;
        const start = Number(m[1]);
        const end = m[2] === undefined ? start : Number(m[2]);
        for (const line of text.split('\n').slice(Math.max(start, 1) - 1, end)) {
          for (const token of line.match(PATH_TOKEN) ?? []) {
            const path = token.replace(/^(\.\/)+/, '');
            const id = reader.lineCount(path) ? owner(path) : null;
            if (id !== null) found.add(id);
          }
        }
      }
      return found.size === 1 ? [...found][0] : null;
    };
    const resolveNode = (ref, e = null) => {
      if (typeof ref !== 'string') return null;
      if (nodes.has(follow(ref))) return ref;
      const area = ref.startsWith('area:') ? ref.slice('area:'.length) : ref;
      return (e !== null ? namedOwner(area, e) : null) ?? hubOf(area);
    };
    for (const [id, e] of [...edges]) {
      const from = resolveNode(e.from, e);
      const to = resolveNode(e.to, e);
      if (from === null || to === null) {
        edges.delete(id);
        dropRow(areaOf(origin.edges, id), id, from === null ? e.from : e.to, `edge ${id}`);
        continue;
      }
      e.from = from;
      e.to = to;
    }
    for (const [id, e] of [...entities]) {
      const store = resolveNode(e.store);
      if (store === null) {
        entities.delete(id);
        dropRow(areaOf(origin.entities, id), id, e.store, `entity ${id}`);
        continue;
      }
      e.store = store;
    }
    for (const [k, a] of [...access]) {
      const node = resolveNode(a.node);
      const missing = node === null ? a.node : !entities.has(a.entity) ? a.entity : null;
      if (missing !== null) {
        access.delete(k);
        dropRow(areaOf(origin.access, k), `access:${a.node}/${a.entity}`, missing, `access row ${a.node}/${a.entity}`);
      } else if (node !== a.node) {
        access.delete(k);
        addAccess(access, { ...a, node });
        origin.access.set(accessKey({ ...a, node }), areaOf(origin.access, k));
      }
    }
  }
  if (collapsed.size) {
    for (const e of edges.values()) {
      e.from = follow(e.from);
      e.to = follow(e.to);
    }
    for (const e of entities.values()) if (typeof e.store === 'string') e.store = follow(e.store);
    for (const [k, a] of [...access]) {
      const node = follow(a.node);
      if (node === a.node) continue;
      access.delete(k);
      addAccess(access, { ...a, node });
    }
  }

  // --- user-authored fields of the nodes the affected areas owned
  for (const p of nodePart.gone) {
    const now = nodes.get(p.id);
    const authored = p.locked === true || p.notes !== undefined;
    if (now === undefined) {
      if (!authored) continue; // the explorer dropped a node nobody authored anything on
      nodes.set(p.id, clone(p));
      conflicts.push({
        ids: [p.id],
        reason: `node "${p.id}" carries ${p.locked ? 'locked/' : ''}user-authored fields but its explorer no longer reports it; kept as authored`,
      });
    } else if (p.locked === true) {
      if (canon(stripUser(now)) !== canon(stripUser(p))) {
        conflicts.push({
          ids: [p.id],
          reason: `locked node "${p.id}" disagrees with the new analysis; authored content kept`,
        });
      }
      nodes.set(p.id, clone(p));
    } else {
      for (const k of USER_FIELDS) if (p[k] !== undefined) now[k] = p[k];
    }
  }

  // --- entities, stores and queues the extracts declare (in update mode, those of the affected areas), then the
  // cross-area layer, computed from the prescan slices and the declared keys
  const gen = generateFromExtracts({
    nodes, entities, placed, zoneId: resolveZone, carried,
    slices: updateMode ? slices.filter((s) => replaced.has(s.area)) : slices,
  });
  gen.made.apps = appsMade;
  // a foreign key that names its table (an explorer's field) means the entity of that name, whatever its id is now
  {
    const resolve = entityResolver(entities);
    for (const e of entities.values()) {
      for (const fld of list(e.fields)) {
        if (isObj(fld) && isObj(fld.fk) && resolve(fld.fk.entity) !== null) fld.fk.entity = resolve(fld.fk.entity);
      }
    }
  }
  const carriedCount = changedFiles === null ? null : {
    nodes: carried.nodes.size, edges: carried.edges.size, entities: carried.entities.size,
    total: carried.nodes.size + carried.edges.size + carried.entities.size, changed: changedFiles.size,
  };
  const derived = deriveLayer({ nodes, edges, entities, access, relations, slices, repo, queues: gen.queues, platform: gen.platform, made: gen.made, carried: carriedCount });
  // what pointed at an entity that does not exist, or at a field it does not have, goes with it (one dropped-ref row
  // each). The entities are final only now, so a relation kept from --previous or written by an explorer is resolved
  // here: its entity by id, else by table name; two spellings of one relation are emitted once.
  {
    const resolve = entityResolver(entities);
    const hasField = (ent, field) => entities.has(ent) && list(entities.get(ent).fields).some((f) => isObj(f) && f.name === field);
    const settled = [];
    for (const [k, r] of [...relations].sort((a, b) => cmp(a[0], b[0]))) {
      relations.delete(k);
      const sides = ['from', 'to'].map((side) => r?.[side]);
      const bad = sides.find((side) => isObj(side) && (resolve(side.entity) === null || !hasField(resolve(side.entity), side.field)));
      if (bad !== undefined) {
        dropRow(areaOf(origin.relations, k), `relation:${k}`, bad.entity, `relation ${k}`);
        continue;
      }
      for (const side of sides) if (isObj(side)) side.entity = resolve(side.entity);
      settled.push({ key: relKey(r), canonical: relKey(r) === k, r, k });
    }
    // a relation already spelled with entity ids is kept over a spelling by name
    for (const x of settled.sort((a, b) => Number(b.canonical) - Number(a.canonical))) {
      if (!relations.has(x.key)) relations.set(x.key, x.r);
    }
    for (const [id, e] of entities) {
      for (const fld of list(e.fields)) {
        if (!isObj(fld) || !isObj(fld.fk) || hasField(fld.fk.entity, fld.fk.field)) continue;
        dropRow(areaOf(origin.entities, id), `${id}.${fld.name}`, fld.fk.entity, `foreign key ${id}.${fld.name}`);
        delete fld.fk;
      }
    }
  }
  // introspection recorded as skipped and no run of it recorded as ok: nothing observed any field, so the static
  // sources (unioned into the entities above, as declared) are all the fields have. A field an explorer marked
  // observed that no static source named is relabelled inferred, once, in one normalisation row.
  if (!prev && sources.some(isSkippedIntrospection) && !sources.some(isRunIntrospection)) {
    const relabelled = [];
    for (const [id, e] of [...entities].sort(([a], [b]) => cmp(a, b))) {
      for (const fld of list(e.fields)) {
        if (isObj(fld) && fld.provenance === 'observed') {
          fld.provenance = 'inferred';
          relabelled.push(`${id}.${fld.name}`);
        }
      }
    }
    if (relabelled.length) {
      sources.push({
        area: 'merge', type: 'normalisation', fields: relabelled,
        note: `introspection was skipped, so nothing observed a field: ${relabelled.length} field(s) marked observed and named by no static source relabelled inferred (${relabelled.slice(0, 5).join(', ')}${relabelled.length > 5 ? ', ...' : ''})`,
      });
    }
  }
  for (const x of leftOut) {
    if (x.map.has(x.id)) continue;
    sources.push({ area: x.area, type: 'dropped-changed', id: x.id, note: `area ${x.area}: ${x.what} ${x.id} removed: ${x.why} and the explorer no longer reports it` });
  }
  if (extracts !== undefined || carriedCount !== null) {
    for (let i = sources.length - 1; i >= 0; i--) if (isObj(sources[i]) && sources[i].type === 'derivation') sources.splice(i, 1);
    // without extracts nothing was derived: the row counts the carry-over only
    sources.push(extracts !== undefined ? derived.source : {
      type: 'derivation', derived: { carried: carriedCount.total }, skipped: { count: 0, reasons: [] }, note: carriedText(carriedCount),
    });
  }
  // the unpaired-queue rows are recomputed with the extracts, so those of an earlier run go when fresh ones come
  if (extracts !== undefined) {
    for (let i = sources.length - 1; i >= 0; i--) if (isObj(sources[i]) && sources[i].type === 'queue-unpaired') sources.splice(i, 1);
    sources.push(...derived.unpaired);
  }

  // --- synthesizer: sequences and views only; the structure is the script's
  if (isObj(synth)) {
    for (const [key, idOf] of Object.entries(SYNTH_REFUSED)) {
      const items = list(synth[key]).filter(isObj);
      if (!items.length) continue;
      conflicts.push({
        ids: [...new Set(items.map((x) => String(idOf(x))))].sort(cmp),
        reason: `synthesizer may not add ${key}: ${items.length} ignored (merge.mjs computes nodes, edges, entities, access rows and relations; the synthesizer returns sequences, views, notes and conflicts only)`,
      });
    }
    const synthSeqs = list(synth.sequences).filter((s) => isObj(s) && typeof s.id === 'string');
    const staleIds = new Set(synthSeqs.map((s) => s.id));
    for (let i = sources.length - 1; i >= 0; i--) {
      if (isObj(sources[i]) && sources[i].type === 'dropped-step' && staleIds.has(sources[i].sequence)) sources.splice(i, 1);
    }
    for (const s of synthSeqs) {
      const placed = placeSteps(clone(s));
      sources.push(...placed.rows);
      if (placed.seq !== null) sequences.set(s.id, placed.seq);
    }
    for (const v of list(synth.views)) if (isObj(v) && typeof v.id === 'string') views.set(v.id, clone(v));
    for (const n of list(synth.notes)) if (typeof n === 'string') notes.push(n);
    for (const c of list(synth.conflicts)) if (isObj(c)) conflicts.push(clone(c));
  }

  // --- zones the nodes use but nobody declared
  const zonesCreated = [];
  const usedBy = new Map();
  for (const n of nodes.values()) {
    if (typeof n.zone !== 'string' || zones.has(n.zone)) continue;
    if (!usedBy.has(n.zone)) usedBy.set(n.zone, []);
    usedBy.get(n.zone).push(n);
  }
  const areaOfNode = new Map();
  for (const [area, ids] of placed) for (const nid of ids) if (!areaOfNode.has(nid)) areaOfNode.set(nid, area);
  for (const [id, members] of [...usedBy].sort((a, b) => cmp(a[0], b[0]))) {
    if (containers.dirOf.has(id)) {
      // a container's zone: labelled with its directory, of the kind most of its nodes would have had on their own
      const votes = new Map();
      for (const n of members) {
        const k = zoneFor(n, stacksOf.get(areaOfNode.get(n.id)) ?? []);
        votes.set(k, (votes.get(k) ?? 0) + 1);
      }
      const kind = [...votes].sort((a, b) => b[1] - a[1] || ZONE_KINDS.indexOf(a[0]) - ZONE_KINDS.indexOf(b[0]))[0][0];
      zones.set(id, { id, kind, label: containers.dirOf.get(id) });
      zonesCreated.push(id);
      continue;
    }
    let kind = ZONE_KINDS.includes(id) ? id : null;
    if (!kind && members.some((n) => STORE_KINDS.has(String(n.kind).toLowerCase()))) kind = 'data';
    if (!kind && members.every((n) => String(n.kind).toLowerCase() === 'external')) kind = 'external';
    zones.set(id, { id, kind: kind ?? 'service', label: id });
    zonesCreated.push(id);
  }

  // --- meta
  const pm = prev?.meta ?? {};
  const outMeta = {
    schemaVersion: meta.schemaVersion ?? pm.schemaVersion ?? SCHEMA_VERSION,
    project: meta.project ?? pm.project,
    commit: meta.commit ?? pm.commit,
    generatedAt: meta.generatedAt ?? pm.generatedAt,
    repoUrl: meta.repoUrl ?? pm.repoUrl,
    profile: meta.profile ?? pm.profile ?? 'balanced',
    sources: sources.sort((a, b) => cmp(String(a.area ?? ''), String(b.area ?? '')) || cmp(canon(a), canon(b))),
    coverage,
  };
  for (const k of Object.keys(outMeta)) if (outMeta[k] === undefined) delete outMeta[k];
  const META_KNOWN = new Set(['schemaVersion', 'project', 'commit', 'generatedAt', 'repoUrl', 'profile', 'sources', 'coverage']);
  const unknownMeta = isObj(pm) ? Object.keys(pm).filter((k) => !META_KNOWN.has(k)).sort(cmp) : [];
  for (const k of unknownMeta) outMeta[k] = clone(pm[k]);

  const vals = (m, sorter) => [...m.values()].sort(sorter);
  const model = {
    meta: outMeta,
    zones: vals(zones, byId),
    nodes: vals(nodes, byId),
    edges: vals(edges, byId),
  };
  const optional = {
    entities: vals(entities, byId),
    relations: vals(relations, (a, b) => cmp(relKey(a), relKey(b))),
    access: vals(access, (a, b) => cmp(accessKey(a), accessKey(b))),
    sequences: vals(sequences, byId),
    views: vals(views, byId),
  };
  for (const [k, v] of Object.entries(optional)) if (v.length) model[k] = v;
  // Keys this version does not know (a newer schema's additions) ride through from --previous unchanged.
  const TOP_KNOWN = new Set(['meta', 'zones', 'nodes', 'edges', 'entities', 'relations', 'access', 'sequences', 'views']);
  const unknownTop = isObj(prev) ? Object.keys(prev).filter((k) => !TOP_KNOWN.has(k)).sort(cmp) : [];
  for (const k of unknownTop) model[k] = clone(prev[k]);

  const META_ORDER = ['schemaVersion', 'project', 'commit', 'generatedAt', 'repoUrl', 'profile', 'sources', 'coverage'];
  const sorted = sortKeys(model);
  sorted.meta = Object.fromEntries([...META_ORDER, ...unknownMeta].filter((k) => k in sorted.meta).map((k) => [k, sorted.meta[k]]));
  const TOP_ORDER = ['meta', 'zones', 'nodes', 'edges', 'entities', 'relations', 'access', 'sequences', 'views'];
  const ordered = Object.fromEntries([...TOP_ORDER, ...unknownTop].filter((k) => k in sorted).map((k) => [k, sorted[k]]));

  const sortRenames = renames.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.from, b.from) || cmp(a.area, b.area));
  const drafts = draftSequences({ flows: derived.flows, model: ordered });
  const digest = buildDigest(ordered, { drafts });
  return { model: ordered, digest, conflicts, renames: sortRenames, notes, zonesCreated, evidenceChecked: reader !== null };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE =
  'usage: node scripts/merge.mjs <fragmentsDir> --out <model.json> [--previous <model.json>] [--synth <synth.json>] ' +
  '[--extracts <dir>] [--repo <dir>] [--digest <digest.json>] ' +
  '[--areas a,b [--changed <diffmap.json>]] [--commit sha] [--project name] [--profile p] [--generated-at iso] [--repo-url url] [--strict] [--json]';

class UsageError extends Error {}

const VALUE_FLAGS = new Set([
  '--out', '--previous', '--synth', '--areas', '--commit', '--project', '--profile', '--generated-at', '--repo-url',
  '--extracts', '--repo', '--digest', '--changed',
]);

function parseArgs(argv) {
  const o = { dir: undefined, strict: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (o.dir === undefined) o.dir = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (o.help) return o;
  if (o.dir === undefined) throw new UsageError('missing <fragmentsDir>');
  if (o.out === undefined) throw new UsageError('missing --out <model.json>');
  if (o.areas !== undefined && o.previous === undefined) throw new UsageError('--areas needs --previous');
  if (o.changed !== undefined && o.areas === undefined) throw new UsageError('--changed needs --previous and --areas');
  if (o.profile !== undefined && !['max', 'balanced', 'economy'].includes(o.profile)) {
    throw new UsageError('--profile must be max, balanced or economy');
  }
  return o;
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} ${path} is not valid JSON: ${e.message}`);
  }
}

function main(argv) {
  let o;
  let result;
  let verdict;
  try {
    o = parseArgs(argv);
    if (o.help) {
      console.log(USAGE);
      return 0;
    }
    let isDir = false;
    try { isDir = statSync(o.dir).isDirectory(); } catch { /* not a dir */ }
    if (!isDir) throw new UsageError(`${o.dir} is not a directory`);
    const fragments = readdirSync(o.dir)
      .filter((f) => f.endsWith('.json'))
      .sort(cmp)
      .map((f) => {
        const stem = f.replace(/\.json$/, '');
        let frag;
        try {
          frag = readJson(join(o.dir, f), 'fragment');
          if (!isObj(frag)) throw new UsageError('not a JSON object');
        } catch (e) {
          if (!(e instanceof UsageError)) throw e;
          // an explorer that wrote a broken file is not asked again: the area is recorded as skipped (and in update
          // mode keeps its previous elements: merge() reads `unreadable`)
          return { area: stem, unreadable: true, skipped: { count: 1, reasons: [`fragment ${f} unreadable: ${e.message.replace(/^.*?is not valid JSON: /, 'not valid JSON: ')}`.slice(0, 200)] } };
        }
        if (typeof frag.area !== 'string' || !frag.area) frag.area = stem;
        return frag;
      });
    const previous = o.previous === undefined ? undefined : readJson(o.previous, 'previous model');
    if (previous !== undefined && !isObj(previous)) throw new UsageError('previous model is not a JSON object');
    const synth = o.synth === undefined ? undefined : readJson(o.synth, 'synthesizer output');
    if (synth !== undefined && !isObj(synth)) throw new UsageError('synthesizer output is not a JSON object');
    const areas = o.areas === undefined ? undefined : o.areas.split(',').map((s) => s.trim()).filter(Boolean);
    let changed;
    if (o.changed !== undefined) {
      const report = readJson(o.changed, '--changed report');
      changed = Array.isArray(report) ? report : isObj(report) && Array.isArray(report.files) ? report.files : null;
      if (changed === null || !changed.every((p) => typeof p === 'string')) {
        throw new UsageError(`--changed ${o.changed} holds no list of changed files (a diffmap.mjs --json report, or an array of paths)`);
      }
    }
    let extracts;
    if (o.extracts !== undefined) {
      let isExtractDir = false;
      try { isExtractDir = statSync(o.extracts).isDirectory(); } catch { /* not a dir */ }
      if (!isExtractDir) throw new UsageError(`--extracts ${o.extracts} is not a directory`);
      // a slice that cannot be read only costs its links: the derivation row says so. <area>.summary.json is the
      // explorer's capped view of the same slice, not a slice of its own
      extracts = readdirSync(o.extracts).filter((f) => f.endsWith('.json') && !f.endsWith('.summary.json')).sort(cmp).map((f) => {
        try {
          const s = readJson(join(o.extracts, f), 'extract');
          return isObj(s) ? s : { area: f.replace(/\.json$/, ''), unreadable: `extract ${f} is not a JSON object` };
        } catch (e) {
          if (!(e instanceof UsageError)) throw e;
          return { area: f.replace(/\.json$/, ''), unreadable: `extract ${f} unreadable` };
        }
      });
    }
    if (o.repo !== undefined) {
      let isRepo = false;
      try { isRepo = statSync(o.repo).isDirectory(); } catch { /* not a dir */ }
      if (!isRepo) throw new UsageError(`--repo ${o.repo} is not a directory`);
    }
    result = merge({
      fragments,
      previous,
      synth,
      areas,
      changed,
      extracts,
      repo: o.repo,
      meta: {
        project: o.project, commit: o.commit, profile: o.profile, generatedAt: o.generatedAt, repoUrl: o.repoUrl,
      },
    });
    verdict = validate(result.model, result.evidenceChecked ? { repo: o.repo } : {});
    if (o.repo !== undefined && !result.evidenceChecked) {
      console.error(`merge: evidence not checked: ${o.repo} is not a git repository or does not have commit "${result.model.meta.commit ?? ''}"`);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`merge: ${e.message}\n${USAGE}`);
    return 2;
  }

  const { model, conflicts, renames, notes } = result;
  let code = 0;
  if (!verdict.ok) code = 1;
  else if (o.strict && conflicts.length) code = 1;

  if (o.json) {
    console.log(JSON.stringify({ ok: code === 0, written: code === 0, conflicts, renames, notes, findings: verdict.findings }, null, 2));
  }
  for (const c of conflicts) console.error(`conflict: ${list(c.ids).join(', ')}: ${c.reason}`);
  if (!verdict.ok) {
    for (const f of verdict.findings) console.error(`invalid: ${f.code}  ${f.pointer || '/'}  ${f.message}`);
    console.error(`merge: result is invalid (${verdict.findings.length} finding(s)); nothing written`);
    return 1;
  }
  if (code === 1) {
    console.error(`merge: ${conflicts.length} conflict(s) with --strict; nothing written`);
    return 1;
  }
  mkdirSync(dirname(o.out), { recursive: true });
  writeFileSync(o.out, JSON.stringify(model, null, 2) + '\n');
  if (o.digest !== undefined) {
    mkdirSync(dirname(o.digest), { recursive: true });
    writeFileSync(o.digest, digestText(result.digest));
  }
  if (!o.json) {
    console.log(
      `merged ${model.nodes.length} nodes, ${model.edges.length} edges, ${list(model.entities).length} entities, ` +
        `${list(model.access).length} access rows into ${o.out} (${renames.length} renamed, ${conflicts.length} conflict(s))` +
        (o.digest !== undefined ? `; digest with ${result.digest.drafts.length} drafted sequence(s) in ${o.digest}` : ''),
    );
  }
  return 0;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
