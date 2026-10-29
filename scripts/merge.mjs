#!/usr/bin/env node
// merge.mjs - merge explorer fragments (and the synthesizer's object) into the architecture model.
//
//   node scripts/merge.mjs <fragmentsDir> --out <model.json> [--previous <model.json>] [--synth <synth.json>]
//        [--areas a,b] [--commit sha] [--project name] [--profile p] [--generated-at iso] [--repo-url url]
//        [--strict] [--json]
//
// Fragments (<fragmentsDir>/*.json, one object per area, contract in
// skills/architecture-map/references/model-schema.md): nodes, edges, entities, access (and, tolerated,
// relations and zones) are concatenated in area order. An element identical to one already present is
// deduped; one that reuses an id with different content is renamed "<id>-<area>" (then -2, -3...) and every
// reference inside that fragment is rewritten (edge from/to, entity store, fk targets, access node/entity,
// relation endpoints). Access rows dedupe on node+entity with the ops unioned. Zones the nodes use but nobody
// declared are created (kind from the zone id, else from its nodes' kinds, else "service").
//
// meta: schemaVersion, project, commit, profile and generatedAt come from the flags, else from --previous.
// generatedAt is never invented (pass --generated-at; a missing value makes the result invalid). coverage[area]
// is each fragment's coverage; sources holds one row per fragment (its skipped tally) plus any sources it lists.
//
// Update mode (--previous with --areas a,b): only fragments of the listed areas are read. The elements owned
// by those areas (first evidence path under a glob of the area's previous meta.coverage) are replaced; every
// other element, zone, relation, sequence and view is kept as it was, ids unchanged. Cross-area edges and
// access rows whose evidence sits in an affected area are replaced too: rerun the synthesizer for them.
// Globs are matched by lib/glob.mjs, the matcher diffmap.mjs uses, so both scripts agree on who owns a path
// (a bare directory glob is literal; write `dir/**` to own a subtree).
// --previous without --areas treats every area as affected (full rebuild that still carries user fields).
// --areas and the fragment directory must name the same areas: an --areas entry with no fragment, and a fragment
// whose area is not in --areas, are each reported as a conflict (exit 1 under --strict).
//
// Synthesizer object (--synth): edges, sequences, views merge by id; access and relations by key; notes and
// conflicts are passed through. Conflicts are reported and never resolved silently.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';
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

/**
 * Pure merge.
 * @param {{fragments?: object[], previous?: object, synth?: object, areas?: string[],
 *   meta?: {project?: string, commit?: string, profile?: string, generatedAt?: string, repoUrl?: string, schemaVersion?: string}}} input
 * @returns {{model: object, conflicts: {ids: string[], reason: string}[], renames: object[], notes: string[], zonesCreated: string[]}}
 */
export function merge({ fragments = [], previous, synth, areas, meta = {} } = {}) {
  const conflicts = [];
  const renames = [];
  const notes = [];
  const prev = isObj(previous) ? clone(previous) : null;
  const affected = prev && Array.isArray(areas) ? new Set(areas) : null; // null with prev = all areas
  const updateMode = prev !== null && affected !== null;

  // fragments in area order; in update mode only the affected areas
  const frags = fragments
    .map((f, i) => ({ f, area: typeof f?.area === 'string' && f.area ? f.area : `fragment${i}` }))
    .filter((x) => isObj(x.f) && (!updateMode || affected.has(x.area)))
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
  }

  // --- the part of the previous model that stays
  const isOwned = prev ? ownerTest(updateMode ? [...affected] : null, prev.meta?.coverage) : () => false;
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

  // --- fragments
  const sources = list(prev?.meta?.sources).filter(
    (s) => !(isObj(s) && typeof s.area === 'string' && (affected === null || affected.has(s.area))),
  );
  const coverage = {};
  for (const [a, g] of Object.entries(prev?.meta?.coverage ?? {})) {
    if (updateMode && !affected.has(a)) coverage[a] = g;
  }

  for (const { f, area } of frags) {
    const nodeMap = new Map();
    const entityMap = new Map();
    const note = (kind, from, to) => {
      renames.push({ area, kind, from, to });
    };

    for (const raw of list(f.zones)) {
      if (isObj(raw) && typeof raw.id === 'string' && !zones.has(raw.id)) zones.set(raw.id, clone(raw));
    }

    for (const raw of list(f.nodes)) {
      if (!isObj(raw)) continue;
      const n = stripUser(raw);
      const have = nodes.get(n.id);
      if (have === undefined) nodes.set(n.id, n);
      else if (canon(stripUser(have)) === canon(n)) continue; // identical: deduped
      else {
        const id = uniqueId(nodes, n.id, area);
        nodeMap.set(n.id, id);
        note('node', n.id, id);
        nodes.set(id, { ...n, id });
      }
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
      if (!entities.has(e.id)) entities.set(e.id, e);
    }

    for (const raw of list(f.edges)) {
      if (!isObj(raw)) continue;
      const e = clone(raw);
      e.from = mapNode(e.from);
      e.to = mapNode(e.to);
      const have = edges.get(e.id);
      if (have === undefined) edges.set(e.id, e);
      else if (canon(have) === canon(e)) continue;
      else {
        const id = uniqueId(edges, e.id, area);
        note('edge', e.id, id);
        edges.set(id, { ...e, id });
      }
    }

    for (const raw of list(f.access)) {
      if (!isObj(raw)) continue;
      addAccess(access, { ...clone(raw), node: mapNode(raw.node), entity: mapEntity(raw.entity) });
    }
    for (const raw of list(f.relations)) {
      if (!isObj(raw)) continue;
      const r = clone(raw);
      for (const side of ['from', 'to']) if (isObj(r[side])) r[side].entity = mapEntity(r[side].entity);
      if (!relations.has(relKey(r))) relations.set(relKey(r), r);
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

  // --- synthesizer
  if (isObj(synth)) {
    for (const raw of list(synth.nodes)) {
      if (!isObj(raw) || typeof raw.id !== 'string') continue;
      const have = nodes.get(raw.id);
      const n = stripUser(raw);
      if (have === undefined) nodes.set(n.id, n);
      else if (have.locked === true) {
        if (canon(stripUser(have)) !== canon(n)) {
          conflicts.push({
            ids: [n.id],
            reason: `synthesizer disagrees with locked node "${n.id}"; authored content kept`,
          });
        }
      } else {
        const next = { ...n };
        for (const k of USER_FIELDS) if (have[k] !== undefined) next[k] = have[k];
        nodes.set(n.id, next);
      }
    }
    for (const e of list(synth.edges)) if (isObj(e) && typeof e.id === 'string') edges.set(e.id, clone(e));
    for (const s of list(synth.sequences)) if (isObj(s) && typeof s.id === 'string') sequences.set(s.id, clone(s));
    for (const v of list(synth.views)) if (isObj(v) && typeof v.id === 'string') views.set(v.id, clone(v));
    for (const a of list(synth.access)) if (isObj(a)) access.set(accessKey(a), clone(a));
    for (const r of list(synth.relations)) if (isObj(r)) relations.set(relKey(r), clone(r));
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
  for (const [id, members] of [...usedBy].sort((a, b) => cmp(a[0], b[0]))) {
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
  return { model: ordered, conflicts, renames: sortRenames, notes, zonesCreated };
}

// ---------------------------------------------------------------------------
// CLI

const USAGE =
  'usage: node scripts/merge.mjs <fragmentsDir> --out <model.json> [--previous <model.json>] [--synth <synth.json>] ' +
  '[--areas a,b] [--commit sha] [--project name] [--profile p] [--generated-at iso] [--repo-url url] [--strict] [--json]';

class UsageError extends Error {}

const VALUE_FLAGS = new Set([
  '--out', '--previous', '--synth', '--areas', '--commit', '--project', '--profile', '--generated-at', '--repo-url',
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
        const frag = readJson(join(o.dir, f), 'fragment');
        if (!isObj(frag)) throw new UsageError(`fragment ${join(o.dir, f)} is not a JSON object`);
        if (typeof frag.area !== 'string' || !frag.area) frag.area = f.replace(/\.json$/, '');
        return frag;
      });
    const previous = o.previous === undefined ? undefined : readJson(o.previous, 'previous model');
    if (previous !== undefined && !isObj(previous)) throw new UsageError('previous model is not a JSON object');
    const synth = o.synth === undefined ? undefined : readJson(o.synth, 'synthesizer output');
    if (synth !== undefined && !isObj(synth)) throw new UsageError('synthesizer output is not a JSON object');
    const areas = o.areas === undefined ? undefined : o.areas.split(',').map((s) => s.trim()).filter(Boolean);
    result = merge({
      fragments,
      previous,
      synth,
      areas,
      meta: {
        project: o.project, commit: o.commit, profile: o.profile, generatedAt: o.generatedAt, repoUrl: o.repoUrl,
      },
    });
    verdict = validate(result.model);
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
  if (!o.json) {
    console.log(
      `merged ${model.nodes.length} nodes, ${model.edges.length} edges, ${list(model.entities).length} entities, ` +
        `${list(model.access).length} access rows into ${o.out} (${renames.length} renamed, ${conflicts.length} conflict(s))`,
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
