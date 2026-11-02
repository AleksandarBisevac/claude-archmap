// data-platform.mjs - the data platform stack plug-in of prescan: static extraction from dbt projects.
//
// extractDataPlatform(files, read) -> fragment
//   { lineage[], models[], scanned, skipped{references, tests}, sources[], tests[], truncated{lineage, models, sources, tests} }
// A project is a dbt_project.yml. Its `scope` is the directory it sits in ('.' for the repo root) and `project` its `name`.
// Everything below is read from the project's model paths (`model-paths`, default ["models"]; a file inside a nested
// project belongs to the nested project):
//   models    one per *.sql file: { name, project, scope, layer, materialization, evidence }. `name` is the file name without
//             `.sql`, `layer` the directory below the model path ("staging", "marts/core"; null when the file sits directly in
//             it). `materialization` follows dbt's precedence: config(materialized=...) in the file, then the model's `config:`
//             in a schema file, then the project's `models:` block in dbt_project.yml (folder by folder, the deepest wins),
//             then "view". Evidence is the file (first line to last line with content).
//   sources   one per table of a `sources:` entry in a schema file (*.yml, *.yaml): { source, name, address, project, scope,
//             evidence } with address "source.table"; evidence is the table entry.
//   tests     one per entry of a `tests:` or `data_tests:` list on a model, a model column, a source table or a source table
//             column: { name, target, targetKind, column, project, scope, evidence }; `name` is the test as written
//             ("unique", "not_null", "pkg.custom"), `target` the model name or the source address, `targetKind` "model" or
//             "source", `column` the column name or null. A test on a model no .sql file declares is counted in
//             `skipped.tests`. Arguments of a test (accepted values, a relationship's target) are not extracted.
//   lineage   one edge per distinct (upstream, model) pair read from the ref() and source() calls of a model:
//             { from, fromKind, to, via, project, scope, evidence } with `from` the upstream model name or source address,
//             `fromKind` "model" or "source", `via` "ref" or "source", and one evidence entry per line that holds a call. A call
//             whose target the project does not declare (an unknown model or source, a package ref to another package, a
//             name that is not a string literal) is counted in `skipped.references`, never guessed.
// Only Jinja expressions and statements ({{ }}, {% %}) are read for calls; SQL comments (-- and /* */), Jinja comments
// ({# #}) and text outside Jinja hold none. Evidence of a call is the line its `ref(` or `source(` starts on.
// Items are sorted by path then line; each kind has a ceiling (MAX_ITEMS: the extract is the full record), and what it
// drops is counted in `truncated`; the evidence of one edge is capped at MAX_NESTED lines.
//
// Scanned files are only ever read as text - no import, no eval, no process spawn, no `dbt`, no warehouse. The YAML reader
// is the one containers.mjs exports. The default export is the plug-in object ({ id, detect(inventory), extract(files,
// read) }) that prescan.mjs loads. Node >= 18, ESM, zero dependencies.

import { posix } from 'node:path';
import { byCodeUnit } from './inventory.mjs';
import { parseYaml, textOf, valueOf } from './containers.mjs';

export const KINDS = ['lineage', 'models', 'sources', 'tests'];
export const MAX_ITEMS = 20000; // per kind: a ceiling against a pathological repo, not a budget (the explorer reads a summary)
export const MAX_NESTED = 2000; // evidence lines of one lineage edge

const PROJECT_FILE = 'dbt_project.yml';
const DEFAULT_MATERIALIZATION = 'view';

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const range = (a, b) => (a === b ? String(a) : `${a}-${b}`);
const isProjectFile = (p) => baseName(p) === PROJECT_FILE;
const isSql = (p) => /\.sql$/.test(p) && baseName(p).length > 4;
const isSchemaFile = (p) => /\.ya?ml$/.test(p) && !isProjectFile(p);

// ---------------------------------------------------------------------------------------------
// Jinja: the expressions and statements of a model file, with comments left out.

/** The {{ }} / {% %} regions of `text` outside comments: [{ start, end }] (offsets of the text inside the delimiters). */
function jinjaRegions(text) {
  const regions = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === '{#') {
      const e = text.indexOf('#}', i + 2);
      i = e < 0 ? n : e + 2;
    } else if (two === '{{' || two === '{%') {
      const close = two === '{{' ? '}}' : '%}';
      let j = i + 2;
      let quote = null;
      while (j < n) {
        const c = text[j];
        if (quote) {
          if (c === '\\') j++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (text.startsWith(close, j)) break;
        j++;
      }
      regions.push({ start: i + 2, end: Math.min(j, n) });
      i = Math.min(j + 2, n);
    } else if (two === '--') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e;
    } else if (two === '/*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else i++;
  }
  return regions;
}

/** The top-level arguments of the call whose `(` is at `open`, as source text pieces; null when it never closes. */
function callArgs(text, open) {
  const pieces = [];
  let depth = 0;
  let quote = null;
  let from = open + 1;
  for (let j = open + 1; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
    else if (c === ')') {
      pieces.push(text.slice(from, j));
      return pieces.map((p) => p.trim());
    } else if (c === ',' && depth === 0) {
      pieces.push(text.slice(from, j));
      from = j + 1;
    }
  }
  return null;
}

const literalOf = (piece) => /^(['"])([^'"\\]*)\1$/.exec(piece)?.[2] ?? null;
const isKeyword = (piece) => /^[A-Za-z_]\w*\s*=(?!=)/.test(piece);

/** { calls: [{ fn: 'ref'|'source', args: [string]|null, line }], materialized } read from one model file. */
function readModel(text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const calls = [];
  let materialized = null;
  for (const { start, end } of jinjaRegions(text)) {
    const inner = text.slice(start, end);
    const re = /(?<![\w.])(ref|source|config)\s*\(/g;
    let m;
    while ((m = re.exec(inner))) {
      const pieces = callArgs(inner, m.index + m[0].length - 1);
      if (pieces === null) continue;
      if (m[1] === 'config') {
        const value = /\bmaterialized\s*=\s*(['"])([A-Za-z_][\w-]*)\1/.exec(pieces.join(','))?.[2];
        if (value) materialized = value;
        continue;
      }
      const positional = pieces.filter((p) => p !== '' && !isKeyword(p));
      const literals = positional.map(literalOf);
      calls.push({ fn: m[1], args: literals.every((l) => l !== null) ? literals : null, line: lineAt(start + m.index) });
    }
  }
  return { calls, materialized };
}

// ---------------------------------------------------------------------------------------------
// dbt_project.yml

const asList = (node) => (node?.t === 'seq' ? node.items.map((it) => textOf(it.v)).filter((s) => s !== null) : []);

function readProject(path, text) {
  const doc = parseYaml(text);
  const name = textOf(valueOf(doc, 'name'));
  if (name === null) return null;
  let paths = asList(valueOf(doc, 'model-paths'));
  if (!paths.length) paths = asList(valueOf(doc, 'model_paths'));
  if (!paths.length) paths = asList(valueOf(doc, 'source-paths'));
  if (!paths.length) paths = ['models'];
  const root = dirOf(path);
  return {
    name,
    root,
    scope: root === '' ? '.' : root,
    modelPaths: paths.map((p) => posix.normalize(p).replace(/\/+$/, '')).filter((p) => p !== '' && p !== '.' && !p.startsWith('..')),
    folders: valueOf(valueOf(doc, 'models'), name) ?? null,
  };
}

/** The materialization the project's `models:` block gives a model in `segments` (folders below the model path), or null. */
function folderMaterialization(folders, segments) {
  let found = null;
  const apply = (node) => {
    for (const e of node?.t === 'map' ? node.entries : []) {
      if ((e.key === '+materialized' || e.key === 'materialized') && textOf(e.v) !== null) found = textOf(e.v);
    }
  };
  let node = folders;
  apply(node);
  for (const seg of segments) {
    node = valueOf(node, seg);
    if (node?.t !== 'map') break;
    apply(node);
  }
  return found;
}

/** The project whose model paths hold `path`, with the folders below that model path; the deepest project root wins. */
function ownerOf(projects, path) {
  let best = null;
  for (const p of projects) {
    const prefix = p.root === '' ? '' : `${p.root}/`;
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    const mp = p.modelPaths.find((m) => rel.startsWith(`${m}/`));
    if (mp === undefined) continue;
    if (best === null || p.root.length > best.project.root.length) {
      best = { project: p, segments: rel.slice(mp.length + 1).split('/').slice(0, -1) };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Schema files

const TEST_KEYS = ['tests', 'data_tests'];

function testsOf(node, target, targetKind, column, ctx, out) {
  for (const key of TEST_KEYS) {
    const list = valueOf(node, key);
    for (const it of list?.t === 'seq' ? list.items : []) {
      const name = it.v?.t === 'map' ? it.v.entries[0]?.key : textOf(it.v);
      if (typeof name !== 'string' || name === '') continue;
      out.push({ name, target, targetKind, column, project: ctx.project.name, scope: ctx.project.scope, evidence: [{ path: ctx.path, lines: range(it.line, it.end) }] });
    }
  }
}

function columnTests(node, target, targetKind, ctx, out) {
  testsOf(node, target, targetKind, null, ctx, out);
  const cols = valueOf(node, 'columns');
  for (const c of cols?.t === 'seq' ? cols.items : []) {
    const name = textOf(valueOf(c.v, 'name'));
    if (name !== null) testsOf(c.v, target, targetKind, name, ctx, out);
  }
}

function readSchema(path, text, ctx, acc) {
  const doc = parseYaml(text);
  const sources = valueOf(doc, 'sources');
  for (const group of sources?.t === 'seq' ? sources.items : []) {
    const source = textOf(valueOf(group.v, 'name'));
    const tables = valueOf(group.v, 'tables');
    if (source === null) continue;
    for (const t of tables?.t === 'seq' ? tables.items : []) {
      const name = textOf(valueOf(t.v, 'name'));
      if (name === null) continue;
      const address = `${source}.${name}`;
      acc.sources.push({ source, name, address, project: ctx.project.name, scope: ctx.project.scope, evidence: [{ path, lines: range(t.line, t.end) }] });
      columnTests(t.v, address, 'source', ctx, acc.tests);
    }
  }
  const models = valueOf(doc, 'models');
  for (const m of models?.t === 'seq' ? models.items : []) {
    const name = textOf(valueOf(m.v, 'name'));
    if (name === null) continue;
    const materialized = textOf(valueOf(valueOf(m.v, 'config'), 'materialized'));
    if (materialized !== null) acc.configs.set(`${ctx.project.scope}\u0000${name}`, materialized);
    columnTests(m.v, name, 'model', ctx, acc.tests);
  }
}

// ---------------------------------------------------------------------------------------------

export function extractDataPlatform(files, read) {
  const sorted = [...files].sort(byCodeUnit);
  let scanned = 0;
  const skipped = { references: 0, tests: 0 };
  const projects = [];
  for (const path of sorted.filter(isProjectFile)) {
    const text = read(path);
    if (typeof text !== 'string') continue;
    scanned++;
    const project = readProject(path, text);
    if (project) projects.push(project);
  }

  const acc = { lineage: [], models: [], sources: [], tests: [], configs: new Map() };
  const sqlFiles = [];
  for (const path of sorted) {
    if (!isSql(path) && !isSchemaFile(path)) continue;
    const owner = ownerOf(projects, path);
    if (owner === null) continue;
    const text = read(path);
    if (typeof text !== 'string') continue;
    scanned++;
    if (isSql(path)) sqlFiles.push({ path, text, ...owner });
    else readSchema(path, text, { project: owner.project, path }, acc);
  }

  const declared = new Map(); // scope -> { models: Set(name), sources: Set(address) }
  const scopeOf = (scope) => {
    if (!declared.has(scope)) declared.set(scope, { models: new Set(), sources: new Set() });
    return declared.get(scope);
  };
  for (const s of acc.sources) scopeOf(s.scope).sources.add(s.address);

  const parsed = [];
  for (const f of sqlFiles) {
    const name = baseName(f.path).slice(0, -4);
    const { calls, materialized } = readModel(f.text);
    const lines = f.text.replace(/\s+$/, '').split('\n').length;
    const { project } = f;
    scopeOf(project.scope).models.add(name);
    parsed.push({ name, project, calls });
    acc.models.push({
      name,
      project: project.name,
      scope: project.scope,
      layer: f.segments.length ? f.segments.join('/') : null,
      materialization:
        materialized ??
        acc.configs.get(`${project.scope}\u0000${name}`) ??
        folderMaterialization(project.folders, f.segments) ??
        DEFAULT_MATERIALIZATION,
      evidence: [{ path: f.path, lines: range(1, Math.max(1, lines)) }],
    });
  }

  // lineage: a call whose target the project declares is an edge, merged per (upstream, model) with every call line
  const edges = new Map();
  for (const [k, f] of sqlFiles.entries()) {
    const { project } = f;
    const known = scopeOf(project.scope);
    for (const call of parsed[k].calls) {
      let from = null;
      let fromKind = null;
      if (call.args !== null && call.fn === 'ref' && (call.args.length === 1 || (call.args.length === 2 && call.args[0] === project.name))) {
        from = call.args[call.args.length - 1];
        fromKind = 'model';
        if (!known.models.has(from)) from = null;
      } else if (call.args !== null && call.fn === 'source' && call.args.length === 2) {
        from = `${call.args[0]}.${call.args[1]}`;
        fromKind = 'source';
        if (!known.sources.has(from)) from = null;
      }
      if (from === null) {
        skipped.references++;
        continue;
      }
      const key = [project.scope, fromKind, from, parsed[k].name, call.fn].join('\u0000');
      if (!edges.has(key)) edges.set(key, { from, fromKind, to: parsed[k].name, via: call.fn, project: project.name, scope: project.scope, at: new Map() });
      edges.get(key).at.set(`${f.path}:${call.line}`, { path: f.path, line: call.line });
    }
  }
  for (const e of edges.values()) {
    const { at, ...edge } = e;
    acc.lineage.push({
      ...edge,
      evidence: [...at.values()]
        .sort((a, b) => byCodeUnit(a.path, b.path) || a.line - b.line)
        .slice(0, MAX_NESTED)
        .map((x) => ({ path: x.path, lines: String(x.line) })),
    });
  }

  // tests on a model no .sql file declares are counted, not kept
  acc.tests = acc.tests.filter((t) => {
    const keep = t.targetKind === 'source' || scopeOf(t.scope).models.has(t.target);
    if (!keep) skipped.tests++;
    return keep;
  });

  const lineAt = (i) => Number(i.evidence[0].lines.split('-')[0]);
  const truncated = {};
  const out = { scanned };
  for (const kind of KINDS) {
    // Array.prototype.sort is stable, so items on one line keep their discovery order.
    const items = acc[kind].slice().sort(
      (a, b) =>
        byCodeUnit(a.evidence[0].path, b.evidence[0].path) ||
        lineAt(a) - lineAt(b) ||
        (kind === 'lineage' ? byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to) || byCodeUnit(a.via, b.via) : 0),
    );
    truncated[kind] = Math.max(0, items.length - MAX_ITEMS);
    out[kind] = items.slice(0, MAX_ITEMS);
  }
  out.skipped = skipped;
  out.truncated = truncated;
  return Object.fromEntries(Object.keys(out).sort(byCodeUnit).map((k) => [k, out[k]]));
}

const plugin = {
  id: 'data-platform',
  detect: (inventory) => inventory.files.some(isProjectFile),
  extract: extractDataPlatform,
};

export default plugin;
