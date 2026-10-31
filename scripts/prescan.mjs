#!/usr/bin/env node
// prescan.mjs - the 0-token first step of /archmap:build: inventory, stacks, areas, extracts.
//
//   node scripts/prescan.mjs <repoDir> [--scope <path>] [--out <file>] [--extracts <dir>]
//
// Prints (or writes to --out) JSON:
//   { schemaVersion, repo, commit, stacks[], areas[{id,title,globs[],files,stacks[],extract,summary}],
//     sources[{kind,path,status,reason?}], extracts{<stackId>: fragment} }
// With --out <work>/prescan.json (or --extracts <dir>) it also writes two files per area. The full extract,
// <work>/extracts/<area>.json, is the record merge.mjs builds entities, relations and queue nodes from, so it is
// never cut to a budget: that area's routes (method, path, handler, file, line), every table with its fields and
// declared foreign keys (file, line and lines), environment variables read, queues with their declaration,
// producers and consumers, SDK clients, outbound calls, the import graph and the cross-area links (import, HTTP
// call to route, queue producer to consumer). The summary, <work>/extracts/<area>.summary.json, is what the
// explorer reads: counts per kind and the first rows of each, under SUMMARY_BUDGET characters, with the note that
// entities, relations and queue edges are made by script. The orchestrating session never holds or cuts JSON.
// Files come from `git ls-files -co --exclude-standard`; DB files are only listed, never opened.
// Stack extractors are plug-ins in scripts/lib/prescan/stacks/*.mjs (default export: one extractor
// or an array), each { id, detect(inventory) -> bool, scans?(inventory) -> bool, extract(files, read) -> fragment }.
// `detect` names the stack; `scans` runs the extractor without naming it (the node scanners run on any repo that
// holds .ts or .js code, whatever an area's stack label says).
// The code it scans is never executed. Output is sorted and carries no timestamps, so two runs
// over the same tree are byte-identical. Exit 0 ok, 2 usage or unreadable repo.
// Node >= 18, ESM, zero npm dependencies.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInventory, byCodeUnit } from './lib/prescan/inventory.mjs';
import { detectStacks, genericRecipe, importEdges, workspaceContainers } from './lib/prescan/generic.mjs';
import { matchAny } from './lib/glob.mjs';
import { partition } from './lib/prescan/partition.mjs';

export const SCHEMA_VERSION = 1;
export const SUMMARY_BUDGET = 4200; // characters per area summary: with the explorer agent file it stays under 12 K
const MAX_IMPORT_EDGES = 20000; // a ceiling against a pathological repo, not a budget
const STACKS_DIR = fileURLToPath(new URL('./lib/prescan/stacks/', import.meta.url));

/** Load the plug-in extractors from scripts/lib/prescan/stacks (none yet is fine). */
export async function loadExtractors(dir = STACKS_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort(byCodeUnit)) {
    const mod = await import(pathToFileURL(resolve(dir, f)).href);
    out.push(...[].concat(mod.default ?? []));
  }
  return out;
}

const normaliseScope = (scope) => {
  const s = String(scope ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (s === '.' ) return '';
  if (s.startsWith('/') || s.split('/').includes('..')) throw new Error(`--scope must be a path inside the repo: ${scope}`);
  return s;
};

/**
 * Run the pre-scan over `repoDir`. `extractors` replaces the stacks/ plug-in directory (tests).
 * Throws on a missing directory or a directory git cannot list.
 */
export async function prescan(repoDir, { scope = '', extractors } = {}) {
  const root = resolve(repoDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${repoDir}`);
  const sc = normaliseScope(scope);
  let inv;
  try {
    inv = buildInventory(root, { scope: sc });
  } catch (e) {
    throw new Error(`cannot list files with git in ${repoDir}: ${String(e.message).split('\n')[0]}`);
  }
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* no commits yet */
  }

  const plugins = (extractors ?? (await loadExtractors())).slice().sort((a, b) => byCodeUnit(a.id, b.id));
  const detected = plugins.filter((p) => p.detect(inv));
  const active = plugins.filter((p) => detected.includes(p) || (typeof p.scans === 'function' && p.scans(inv)));
  const stacks = [...new Set([...detectStacks(inv.files, inv.read), ...detected.map((p) => p.id)])].sort(byCodeUnit);

  // Partition relative to the scope directory, then put the scope prefix back on the globs.
  const cut = sc ? sc.length + 1 : 0;
  const rel = (p) => p.slice(cut);
  const relFiles = inv.files.map(rel);
  const relRead = (p) => inv.read(sc ? `${sc}/${p}` : p);
  const pre = sc ? `${sc}/` : '';
  const areas = partition(relFiles, { containers: workspaceContainers(relFiles, relRead) }).map((a) => ({
    id: a.id,
    title: a.title,
    globs: a.globs.map((g) => pre + g),
    files: a.paths.length,
    stacks: detectStacks(a.paths, relRead),
    extract: `extracts/${a.id}.json`,
    summary: `extracts/${a.id}.summary.json`,
  }));

  const generic = genericRecipe(inv.files, inv.read);
  const edges = importEdges(inv.files, inv.read);
  generic.imports = edges.slice(0, MAX_IMPORT_EDGES);
  if (edges.length > MAX_IMPORT_EDGES) generic.importsTruncated = edges.length - MAX_IMPORT_EDGES;
  const extracts = { generic };
  for (const p of active) {
    try {
      extracts[p.id] = await p.extract(inv.files, inv.read);
    } catch (e) {
      extracts[p.id] = { error: String(e?.message ?? e) };
    }
  }
  const sorted = Object.fromEntries(Object.keys(extracts).sort(byCodeUnit).map((k) => [k, extracts[k]]));

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: basename(root),
    commit,
    stacks,
    areas,
    sources: inv.sources,
    extracts: sorted,
  };
}

// ---------------------------------------------------------------------------------------------
// Per-area slices.

const at = (item) => item.evidence[0];
const firstLine = (item) => Number(at(item).lines.split('-')[0]);
const where = (item) => ({ file: at(item).path, line: firstLine(item) });
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const fieldStr = (f) => `${f.name} ${f.type}${f.pk ? ' pk' : ''}${f.fk ? ` fk=${f.fk}` : ''}`;
const MAX_TABLE_FIELDS = 30; // fields of a pydantic schema row (tables keep every field the extractor found)
const normSegs = (u) =>
  String(u)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => (/^(?:\{.*\}|:.+|<.+>|\$\{.*\}|\[.+\]|\*+)$/.test(s) ? '*' : s));
const sameMethod = (a, b) => !a || !b || a === 'ANY' || b === 'ANY' || a === b;

const KEY_ORDER = [
  'area', 'title', 'globs', 'stacks', 'files', 'entryPoints', 'manifests', 'containers', 'ci', 'sources', 'routes',
  'tables', 'schemas', 'migrations', 'sqlTables', 'openapi', 'envKeys', 'queues', 'clients', 'httpCalls', 'stores',
  'imports', 'links', 'truncated',
];
const ALWAYS = new Set(['area', 'title', 'globs', 'stacks', 'files', 'routes', 'tables', 'envKeys', 'queues', 'imports', 'links', 'truncated']);

/** The text of one slice file: one key per line. */
export const sliceText = (slice) =>
  '{\n' +
  KEY_ORDER.filter((k) => ALWAYS.has(k) || (Array.isArray(slice[k]) ? slice[k].length : slice[k] !== undefined))
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(slice[k])}`)
    .join(',\n') +
  '\n}\n';

/**
 * Cut a prescan result into one slice per area: [{id, text, slice}], sorted by area id. Every row sits in the
 * area that owns its file; edges that cross areas are listed on both sides.
 */
export function areaExtracts(out) {
  const matchers = out.areas.map((a) => ({ id: a.id, globs: a.globs }));
  const cache = new Map();
  const areaOf = (path) => {
    if (!cache.has(path)) cache.set(path, matchers.find((m) => matchAny(m.globs, path))?.id ?? null);
    return cache.get(path);
  };
  const x = out.extracts;
  const py = x.python ?? {};
  const nb = x['node-backend'] ?? {};
  const ts = x['ts-frontend'] ?? {};
  const gen = x.generic ?? {};
  const slices = new Map(
    out.areas.map((a) => [
      a.id,
      {
        area: a.id, title: a.title, globs: a.globs, stacks: a.stacks, files: a.files,
        routes: [], tables: [], schemas: [], migrations: [], sqlTables: [], openapi: [], envKeys: [], queues: [],
        clients: [], httpCalls: [], stores: [], imports: [], links: [], truncated: {},
      },
    ]),
  );
  const put = (item, kind, row) => {
    const s = slices.get(areaOf(at(item).path));
    if (s) s[kind].push(row);
  };

  // routes (and the list the HTTP links match against)
  const routes = [];
  for (const r of [...(py.routes ?? []), ...(nb.routes ?? [])]) routes.push({ item: r, method: r.method, path: r.url, handler: r.handler });
  for (const r of ts.routes ?? []) routes.push({ item: r, method: r.method ?? (r.kind === 'page' ? 'PAGE' : 'ANY'), path: r.url, handler: r.component ?? r.name, page: r.kind === 'page' });
  for (const r of routes) put(r.item, 'routes', compact({ method: r.method, path: r.path, handler: r.handler, ...where(r.item) }));

  for (const e of [...(py.entities ?? []), ...(nb.entities ?? [])]) {
    const rels = (e.relations ?? []).map((r) => `${r.field} ${r.kind} ${r.target}`);
    put(e, 'tables', compact({
      name: e.name, table: e.table, orm: e.orm ?? e.framework, fields: (e.fields ?? []).map(fieldStr), rels: rels.length ? rels : null, ...where(e),
      lines: at(e).lines,
    }));
  }
  for (const s of py.schemas ?? []) {
    const plain = s.bases.length === 1 && s.bases[0] === 'BaseModel';
    put(s, 'schemas', compact({ name: s.name, bases: plain ? null : s.bases, fields: s.fields.slice(0, MAX_TABLE_FIELDS).map((f) => `${f.name} ${f.type}`), ...where(s) }));
  }
  for (const m of py.migrations ?? []) put(m, 'migrations', `${m.revision} ${m.direction} ${m.op} ${m.table ?? '-'} ${at(m).path}:${firstLine(m)}`);
  for (const t of py.sqlTables ?? []) put(t, 'sqlTables', `${t.table} ${t.op} ${at(t).path}:${firstLine(t)}`);
  for (const d of nb.openapi ?? []) {
    put(d, 'openapi', compact({ title: d.title, servers: d.servers?.length ? d.servers : null, operations: (d.operations ?? []).length, ...where(d) }));
  }
  for (const c of [...(py.clients ?? []), ...(nb.clients ?? []), ...(ts.clients ?? [])]) {
    put(c, 'clients', compact({ client: c.client, kind: c.kind, target: c.target, ...where(c) }));
  }
  const calls = [...(py.httpCalls ?? []), ...(ts.apiCalls ?? [])];
  for (const c of calls) put(c, 'httpCalls', compact({ method: c.method, url: c.url, client: c.client, ...where(c) }));
  // state stores (ts) and file databases opened by path (python, js): a database row carries the path literal,
  // which the build's finish step looks for on disk and reads when it can, or records as skipped
  for (const s of [...(py.stores ?? []), ...(gen.stores ?? []), ...(ts.stores ?? [])]) {
    put(s, 'stores', compact({ library: s.library, kind: s.kind, name: s.name, path: s.path, ...where(s) }));
  }

  // env keys: one row per name and area, with up to four places
  const envBy = new Map();
  for (const k of [...(py.envKeys ?? []), ...(nb.envKeys ?? []), ...(ts.envKeys ?? [])]) {
    const a = areaOf(at(k).path);
    if (!slices.has(a)) continue;
    const key = `${a}\0${k.name}`;
    if (!envBy.has(key)) envBy.set(key, { a, name: k.name, at: [] });
    const place = `${at(k).path}:${firstLine(k)}`;
    const row = envBy.get(key);
    if (!row.at.includes(place)) row.at.push(place);
  }
  for (const { a, name, at: places } of [...envBy.values()].sort((p, q) => byCodeUnit(p.name, q.name))) {
    slices.get(a).envKeys.push({ name, at: places.length > 4 ? [...places.slice(0, 4), `+${places.length - 4}`] : places });
  }

  // queues: each area gets the producers and consumers whose files it owns
  const queueSide = []; // {name, area, kind, file, line}
  for (const q of [...(py.queues ?? []), ...(nb.queues ?? [])]) {
    const per = new Map();
    const row = (a) => {
      if (!per.has(a)) per.set(a, { name: q.name, file: undefined, line: undefined, producers: [], consumers: [] });
      return per.get(a);
    };
    // the area that owns the declaration (or the first producer or worker) carries its file and line
    const defArea = areaOf(at(q).path);
    if (slices.has(defArea)) Object.assign(row(defArea), where(q));
    for (const p of q.producers ?? []) {
      const a = areaOf(at(p).path);
      if (!slices.has(a)) continue;
      row(a).producers.push(compact({ job: p.job, ...where(p) }));
      queueSide.push({ name: q.name, area: a, kind: 'producer', ...where(p) });
    }
    for (const w of q.workers ?? []) {
      const a = areaOf(at(w).path);
      if (!slices.has(a)) continue;
      row(a).consumers.push(compact({ handler: w.handler, ...where(w) }));
      queueSide.push({ name: q.name, area: a, kind: 'consumer', ...where(w) });
    }
    for (const [a, r] of per) slices.get(a).queues.push(compact(r));
  }

  // imports, then the cross-area links
  const edgeKey = (l) => `${l.kind}\0${l.dir}\0${l.from}\0${l.to}\0${l.other}`;
  const addLink = (a, l) => {
    const s = slices.get(a);
    if (s && !s.links.some((o) => edgeKey(o) === edgeKey(l))) s.links.push(l);
  };
  for (const e of gen.imports ?? []) {
    const [from, to] = e.split(' > ');
    const a = areaOf(from);
    const b = areaOf(to);
    if (a === null || b === null) continue;
    if (a === b) slices.get(a).imports.push(e);
    else {
      addLink(a, { kind: 'import', dir: 'out', from, to, other: b });
      addLink(b, { kind: 'import', dir: 'in', from, to, other: a });
    }
  }
  const served = routes.filter((r) => !r.page && typeof r.path === 'string' && !r.path.startsWith('^')).map((r) => ({ ...r, segs: normSegs(r.path) }));
  for (const c of calls) {
    const from = areaOf(at(c).path);
    if (from === null || typeof c.url !== 'string') continue;
    const segs = normSegs(c.url);
    if (segs.length === 0) continue;
    const hit = served.find(
      (r) => r.segs.length === segs.length && areaOf(at(r.item).path) !== from && sameMethod(c.method, r.method) &&
        r.segs.every((s, i) => s === segs[i] || s === '*' || segs[i] === '*'),
    );
    if (!hit) continue;
    const to = areaOf(at(hit.item).path);
    const f = `${at(c).path}:${firstLine(c)}`;
    const t = `${at(hit.item).path}:${firstLine(hit.item)}`;
    const via = `${hit.method ?? 'ANY'} ${hit.path}`;
    addLink(from, { kind: 'http', dir: 'out', from: f, to: t, other: to, via });
    addLink(to, { kind: 'http', dir: 'in', from: f, to: t, other: from, via });
  }
  for (const p of queueSide.filter((q) => q.kind === 'producer')) {
    for (const c of queueSide.filter((q) => q.kind === 'consumer' && q.name === p.name && q.area !== p.area)) {
      const f = `${p.file}:${p.line}`;
      const t = `${c.file}:${c.line}`;
      addLink(p.area, { kind: 'queue', dir: 'out', from: f, to: t, other: c.area, via: p.name });
      addLink(c.area, { kind: 'queue', dir: 'in', from: f, to: t, other: p.area, via: p.name });
    }
  }

  // generic hints, per area
  const owned = (list) => (list ?? []).map((p) => [areaOf(p), p]).filter(([a]) => slices.has(a));
  for (const [key, list] of [['entryPoints', gen.entryPoints], ['manifests', gen.manifests], ['containers', gen.containers], ['ci', gen.ci]]) {
    for (const [a, p] of owned(list)) (slices.get(a)[key] ??= []).push(p);
  }
  for (const src of out.sources ?? []) {
    const a = areaOf(src.path);
    if (slices.has(a)) (slices.get(a).sources ??= []).push({ kind: src.kind, path: src.path });
  }

  const result = [];
  for (const id of [...slices.keys()].sort(byCodeUnit)) {
    const s = slices.get(id);
    s.links.sort((p, q) => byCodeUnit(edgeKey(p), edgeKey(q)));
    const summary = areaSummary(s);
    result.push({ id, text: sliceText(s), slice: s, summary, summaryText: summaryText(summary) });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The explorer's summary of one area: counts per kind, the first rows of each, under SUMMARY_BUDGET.

const SUMMARY_NOTE =
  'The explorer summary of this area: counts are the full extract\'s, rows are its first ones. Entities, relations and ' +
  'queue edges are made by script (merge.mjs) from the full extract, every table with its fields and foreign keys: ' +
  'never transcribe tables, fields or foreign keys into the fragment, and do not read the full extract.';
const SUMMARY_ROWS = 12; // rows of one kind before the budget loop starts
// Kinds trimmed to fit the budget, with the weight that protects the ones an explorer needs most: tables are the
// script's, so they go first.
const SUMMARY_WEIGHT = {
  tables: 1, imports: 1, sqlTables: 1, migrations: 1, schemas: 1, stores: 2, httpCalls: 2, envKeys: 2, openapi: 2,
  sources: 2, manifests: 2, containers: 2, ci: 2, entryPoints: 3, clients: 3, links: 3, queues: 3, routes: 4,
};
const SUMMARY_KEYS = ['area', 'title', 'globs', 'stacks', 'files', 'extract', 'note', 'counts'];

/** The kinds a slice lists, in the order its file prints them. */
const kindsOf = (slice) =>
  KEY_ORDER.filter((k) => Array.isArray(slice[k]) && k !== 'globs' && k !== 'stacks' && (ALWAYS.has(k) || slice[k].length));

export function areaSummary(slice) {
  const kinds = kindsOf(slice);
  const sum = {
    area: slice.area, title: slice.title, globs: slice.globs, stacks: slice.stacks, files: slice.files,
    extract: `extracts/${slice.area}.json`, note: SUMMARY_NOTE,
    counts: Object.fromEntries(kinds.map((k) => [k, slice[k].length])),
  };
  for (const k of kinds) sum[k] = slice[k].slice(0, SUMMARY_ROWS);
  let text = summaryText(sum);
  while (text.length > SUMMARY_BUDGET) {
    let best = null;
    let bestScore = 0;
    for (const k of kinds) {
      if (!sum[k].length) continue;
      const score = JSON.stringify(sum[k]).length / (SUMMARY_WEIGHT[k] ?? 2);
      if (score > bestScore) {
        best = k;
        bestScore = score;
      }
    }
    if (best === null) break;
    sum[best].pop();
    text = summaryText(sum);
  }
  return sum;
}

/** The text of one summary file: one key per line. */
export const summaryText = (sum) =>
  '{\n' +
  [...SUMMARY_KEYS, ...KEY_ORDER.filter((k) => !SUMMARY_KEYS.includes(k))]
    .filter((k) => sum[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(sum[k])}`)
    .join(',\n') +
  '\n}\n';

/** Write the slices into `dir` (created if missing). Files of an earlier partition are left alone: `areas[].extract` names the live ones. */
export function writeExtracts(out, dir) {
  mkdirSync(dir, { recursive: true });
  const slices = areaExtracts(out);
  for (const s of slices) {
    writeFileSync(join(dir, `${s.id}.json`), s.text);
    writeFileSync(join(dir, `${s.id}.summary.json`), s.summaryText);
  }
  return slices.length;
}

function parseArgs(argv) {
  const opts = { repo: null, scope: '', out: null, extracts: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope' || a === '--out' || a === '--extracts') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.repo === null) opts.repo = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.repo === null) throw new Error('missing <repoDir>');
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`prescan: ${e.message}\nusage: node scripts/prescan.mjs <repoDir> [--scope <path>] [--out <file>] [--extracts <dir>]\n`);
    return 2;
  }
  try {
    const result = await prescan(opts.repo, { scope: opts.scope });
    const text = JSON.stringify(result, null, 2) + '\n';
    if (opts.out) {
      mkdirSync(dirname(resolve(opts.out)), { recursive: true });
      writeFileSync(opts.out, text);
    } else process.stdout.write(text);
    const extractsDir = opts.extracts ?? (opts.out ? join(dirname(resolve(opts.out)), 'extracts') : null);
    if (extractsDir) writeExtracts(result, extractsDir);
    return 0;
  } catch (e) {
    process.stderr.write(`prescan: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
