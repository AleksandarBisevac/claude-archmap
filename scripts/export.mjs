#!/usr/bin/env node
// export.mjs - write the architecture model as diagram-as-code files.
//
//   node scripts/export.mjs <model.json> <format> [--view <id>] [--layout <layout.json>] [--out <path>]
//
// Formats: mermaid | plantuml | md | svg | png. This build implements mermaid; the others are refused
// with exit 2 ("not yet implemented") until their tasks land.
//
//   mermaid  one flowchart per view (nodes grouped in subgraphs by zone, every edge labelled with its type
//            and label), an erDiagram of the entities (fields with type, PK/FK markers, crow's-foot
//            cardinality) and one sequenceDiagram per sequence (messages, dashed returns, alt/else/opt/loop
//            blocks, notes). --view selects the flowchart of one view; without it every view is written.
//
// Exports are ALWAYS clean: no issue id, no step issue ref (steps[].i) and no issue text ever appears in
// any output, because the exporters never read them. Every label taken from the model is escaped for
// Mermaid (quotes, brackets, braces, pipes, semicolons, angle brackets, '#', '%' and newlines become numeric
// entity codes or <br/>), so model text cannot break out of its token or inject a statement. Ids are
// reduced to Mermaid-safe identifiers, collision-free, and never a reserved word.
//
// The model is validated first (validate.mjs); an invalid model is refused and nothing is written.
// Files go to <model dir>/exports/ (with the model in docs/architecture/ that is docs/architecture/exports/)
// as <view-id>.flowchart.mmd, er.mmd and <sequence-id>.sequence.mmd; --out <dir> overrides the directory.
// --layout is accepted for a uniform command line and is not needed by the text formats.
// Output is deterministic: the same model gives byte-identical files.
// Exit 0 ok, 1 the model is invalid (nothing is written), 2 usage or unreadable input.
// Node >= 18, ESM, zero npm dependencies.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

export const FORMATS = ['mermaid', 'plantuml', 'md', 'svg', 'png'];
const IMPLEMENTED = ['mermaid'];

const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

// ---------------------------------------------------------------------------
// escaping and identifiers

// Anything that can end a token or start a statement in a flowchart label, an edge label, a sequence
// message or a note becomes a numeric entity code (#NN;), which Mermaid decodes when it draws the text.
// One pass, so a code we emit is never escaped again. Line breaks become <br/> (or a space for the
// one-line positions: block titles).
const UNSAFE = /\r\n|[\n\r\u0085\u2028\u2029]|[\u0000-\u001f\u007f]|["#&;<>[\]{}|\\`%]/g;
function esc(s, { br = '<br/>' } = {}) {
  return str(s).replace(UNSAFE, (c) => {
    if (/^(\r\n|[\n\r\u0085\u2028\u2029])$/.test(c)) return br;
    if (c.charCodeAt(0) < 32 || c === '\u007f') return ' ';
    return `#${c.codePointAt(0)};`;
  });
}

/** A stable allocator: the same raw id always gets the same identifier, different raw ids never share one. */
function idAllocator(prefix, { keep = /[^A-Za-z0-9_]/g, lead = /^[A-Za-z_]/ } = {}) {
  const byRaw = new Map();
  const taken = new Set();
  return (raw) => {
    const key = str(raw);
    if (byRaw.has(key)) return byRaw.get(key);
    let base = key.replace(keep, '_');
    if (prefix) base = prefix + base;
    else if (!lead.test(base)) base = `x_${base}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    byRaw.set(key, id);
    return id;
  };
}

const quote = (s) => `"${esc(s)}"`;

// ---------------------------------------------------------------------------
// flowchart

const zoneIndex = (model) => new Map(list(model.zones).map((z) => [z.id, z]));
function zoneChain(zones, id) {
  const out = [];
  const seen = new Set();
  for (let z = zones.get(id); z && !seen.has(z.id); z = zones.get(z.parent)) {
    seen.add(z.id);
    out.push(z.id);
  }
  return out;
}

/** The nodes, zones and edges a view shows (the viewer's reading: explicit nodes, else the zones, else all). */
function viewScope(model, view) {
  const zones = zoneIndex(model);
  const nodes = list(model.nodes);
  let picked;
  if (view && Array.isArray(view.nodes)) {
    const s = new Set(view.nodes);
    picked = nodes.filter((n) => s.has(n.id));
  } else if (view && Array.isArray(view.zones)) {
    const s = new Set(view.zones);
    picked = nodes.filter((n) => zoneChain(zones, n.zone).some((z) => s.has(z)));
  } else picked = nodes.slice();
  const zoneSet = new Set();
  if (!view || (!view.zones && !view.nodes)) for (const z of list(model.zones)) zoneSet.add(z.id);
  for (const z of list(view && view.zones)) for (const a of zoneChain(zones, z)) zoneSet.add(a);
  for (const n of picked) for (const a of zoneChain(zones, n.zone)) zoneSet.add(a);
  const ids = new Set(picked.map((n) => n.id));
  return {
    nodes: picked,
    zones: list(model.zones).filter((z) => zoneSet.has(z.id)),
    edges: list(model.edges).filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}

/**
 * Mermaid flowchart of one view (every node and zone when viewId is omitted).
 * @param {object} model a valid model
 * @param {string} [viewId]
 * @returns {string}
 */
export function toMermaidFlowchart(model, viewId) {
  let view;
  if (viewId !== undefined) {
    view = list(model.views).find((v) => v.id === viewId);
    if (!view) throw new Error(`unknown view ${viewId}`);
  }
  const scope = viewScope(model, view);
  const nid = idAllocator('n_');
  const zid = idAllocator('z_');
  const inScope = new Set(scope.zones.map((z) => z.id));
  const children = new Map();
  const roots = [];
  for (const z of scope.zones) {
    if (z.parent !== undefined && inScope.has(z.parent) && z.parent !== z.id) {
      if (!children.has(z.parent)) children.set(z.parent, []);
      children.get(z.parent).push(z);
    } else roots.push(z);
  }
  const byZone = new Map();
  const loose = [];
  for (const n of scope.nodes) {
    if (n.zone !== undefined && inScope.has(n.zone)) {
      if (!byZone.has(n.zone)) byZone.set(n.zone, []);
      byZone.get(n.zone).push(n);
    } else loose.push(n);
  }
  const out = ['flowchart LR'];
  const nodeLine = (n, pad) => `${pad}${nid(n.id)}[${quote(n.title || n.id)}]`;
  const emitted = new Set();
  const emit = (z, pad) => {
    if (emitted.has(z.id)) return;
    emitted.add(z.id);
    out.push(`${pad}subgraph ${zid(z.id)}[${quote(z.label || z.id)}]`);
    for (const n of byZone.get(z.id) ?? []) out.push(nodeLine(n, `${pad}  `));
    for (const c of children.get(z.id) ?? []) emit(c, `${pad}  `);
    out.push(`${pad}end`);
  };
  for (const z of roots) emit(z, '  ');
  for (const n of loose) out.push(nodeLine(n, '  '));
  for (const e of scope.edges) {
    const label = e.label ? `${str(e.type)}: ${e.label}` : str(e.type);
    out.push(`  ${nid(e.from)} -->|${quote(label)}| ${nid(e.to)}`);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// erDiagram

const attrName = (s) => {
  const v = str(s).replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(v) ? v : `f_${v}`;
};
const attrType = (s) => {
  const v = str(s).replace(/[^A-Za-z0-9_()]/g, '_');
  if (v === '') return 'unknown';
  return /^[A-Za-z_]/.test(v) ? v : `t_${v}`;
};

/**
 * Mermaid erDiagram of the model's entities and relations. Cardinality is read as the viewer reads it:
 * for 1-n the many end is on the side that holds the key (`from`), n-m is many on both, 1-1 is one on both.
 * @param {object} model a valid model
 * @returns {string}
 */
export function toMermaidER(model) {
  const eid = idAllocator('', { keep: /[^A-Za-z0-9_]/g, lead: /^[A-Za-z]/ });
  const entities = list(model.entities);
  const relations = list(model.relations);
  const fkFields = new Set(relations.map((r) => `${r.from.entity}\u0000${r.from.field}`));
  const known = new Set(entities.map((e) => e.id));
  const out = ['erDiagram'];
  for (const e of entities) {
    const fields = list(e.fields);
    if (fields.length === 0) {
      out.push(`  ${eid(e.id)}`);
      continue;
    }
    const fid = idAllocator('', { lead: /^[A-Za-z]/ });
    out.push(`  ${eid(e.id)} {`);
    for (const f of fields) {
      const keys = [];
      if (f.pk) keys.push('PK');
      if (f.fk || fkFields.has(`${e.id}\u0000${f.name}`)) keys.push('FK');
      const name = fid(attrName(f.name));
      out.push(`    ${attrType(f.type)} ${name}${keys.length ? ` ${keys.join(', ')}` : ''}`);
    }
    out.push('  }');
  }
  for (const r of relations) {
    if (!known.has(r.from.entity) || !known.has(r.to.entity)) continue;
    const a = eid(r.from.entity);
    const b = eid(r.to.entity);
    const label = quote(r.from.field);
    if (r.cardinality === 'n-m') out.push(`  ${a} }o--o{ ${b} : ${label}`);
    else if (r.cardinality === '1-1') out.push(`  ${a} ||--|| ${b} : ${label}`);
    else out.push(`  ${b} ||--o{ ${a} : ${label}`);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// sequenceDiagram

/**
 * Mermaid sequenceDiagram of one sequence. Messages are solid arrows, steps with a `ret` are dashed
 * replies, alt/else/opt/loop/end become blocks and notes become `Note over`. A stray `end`/`else` and
 * a block left open are repaired so the diagram always parses.
 * @param {object} model a valid model
 * @param {string} sequenceId
 * @returns {string}
 */
export function toMermaidSequence(model, sequenceId) {
  const s = list(model.sequences).find((x) => x.id === sequenceId);
  if (!s) throw new Error(`unknown sequence ${sequenceId}`);
  const pid = idAllocator('p_');
  const out = ['sequenceDiagram'];
  for (const p of list(s.participants)) {
    const label = esc(p.label || p.id) + (p.sub ? `<br/>${esc(p.sub)}` : '');
    out.push(`  participant ${pid(p.id)} as ${label}`);
  }
  const open = [];
  const pad = () => '  '.repeat(open.length + 1);
  const title = (t) => (str(t).trim() === '' ? '' : ` ${esc(t, { br: ' ' })}`);
  for (const st of list(s.steps)) {
    if (st.frag !== undefined) {
      if (st.frag === 'alt' || st.frag === 'opt' || st.frag === 'loop') {
        out.push(`${pad()}${st.frag}${title(st.t)}`);
        open.push(st.frag);
      } else if (st.frag === 'else') {
        if (open[open.length - 1] === 'alt') out.push(`${'  '.repeat(open.length)}else${title(st.t)}`);
      } else if (st.frag === 'end') {
        if (open.length) {
          open.pop();
          out.push(`${pad()}end`);
        }
      }
    } else if (Array.isArray(st.note)) {
      const first = pid(st.note[0]);
      const last = pid(st.note[st.note.length - 1]);
      const over = st.note.length > 1 ? `${first},${last}` : first;
      out.push(`${pad()}Note over ${over}: ${esc(st.t) || '-'}`);
    } else if (Array.isArray(st.m)) {
      const arrow = st.ret !== undefined ? '-->>' : '->>';
      out.push(`${pad()}${pid(st.m[0])}${arrow}${pid(st.m[1])}: ${esc(st.t || st.k) || '-'}`);
    }
  }
  while (open.length) {
    open.pop();
    out.push(`${pad()}end`);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// the file set

/** A file name from a model id: no path separators, no leading dot, unique within one run. */
function fileNamer() {
  const taken = new Set();
  return (raw, suffix) => {
    let stem = str(raw).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '');
    if (stem === '') stem = 'unnamed';
    let name = `${stem}${suffix}`;
    for (let n = 2; taken.has(name); n++) name = `${stem}-${n}${suffix}`;
    taken.add(name);
    return name;
  };
}

/**
 * Every Mermaid file for a model: [{name, text}], in a fixed order.
 * @param {object} model a valid model
 * @param {{view?: string}} [opts] view = only that view's flowchart
 */
export function mermaidFiles(model, { view } = {}) {
  const name = fileNamer();
  const files = [];
  if (view !== undefined) {
    files.push({ name: name(view, '.flowchart.mmd'), text: toMermaidFlowchart(model, view) });
    return files;
  }
  for (const v of list(model.views)) files.push({ name: name(v.id, '.flowchart.mmd'), text: toMermaidFlowchart(model, v.id) });
  if (list(model.views).length === 0) files.push({ name: name('all', '.flowchart.mmd'), text: toMermaidFlowchart(model) });
  if (list(model.entities).length) files.push({ name: 'er.mmd', text: toMermaidER(model) });
  for (const q of list(model.sequences)) files.push({ name: name(q.id, '.sequence.mmd'), text: toMermaidSequence(model, q.id) });
  return files;
}

// ---------------------------------------------------------------------------
// CLI

const USAGE =
  'usage: node scripts/export.mjs <model.json> <mermaid|plantuml|md|svg|png> [--view <id>] [--layout <layout.json>] [--out <dir>]';

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { model: undefined, format: undefined, view: undefined, layout: undefined, out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (['--view', '--layout', '--out'].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (o.model === undefined) o.model = a;
    else if (o.format === undefined) o.format = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (o.help) return o;
  if (o.model === undefined) throw new UsageError('missing <model.json>');
  if (o.format === undefined) throw new UsageError(`missing <format> (${FORMATS.join(', ')})`);
  if (!FORMATS.includes(o.format)) throw new UsageError(`unknown format ${o.format}; use one of ${FORMATS.join(', ')}`);
  if (!IMPLEMENTED.includes(o.format)) throw new UsageError(`format ${o.format} is not yet implemented`);
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
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      console.log(USAGE);
      return 0;
    }
    const model = readJson(opts.model, 'model');
    const v = validate(model);
    if (!v.ok) {
      for (const f of v.findings) console.log(`${f.code}  ${f.pointer || '/'}  ${f.message}`);
      console.log(`FAIL: ${v.findings.length} finding(s); nothing exported`);
      return 1;
    }
    if (opts.view !== undefined && !list(model.views).some((x) => x.id === opts.view)) {
      const known = list(model.views).map((x) => x.id).join(', ') || 'none';
      throw new UsageError(`unknown view ${opts.view} (the model has: ${known})`);
    }
    const files = mermaidFiles(model, { view: opts.view });
    const dir = opts.out ?? join(dirname(opts.model), 'exports');
    try {
      mkdirSync(dir, { recursive: true });
      for (const f of files) writeFileSync(join(dir, f.name), f.text);
    } catch (e) {
      throw new UsageError(`cannot write to ${dir}: ${e.code ?? e.message}`);
    }
    for (const f of files) console.log(join(dir, f.name));
    console.log(`OK: ${files.length} mermaid file(s) written to ${dir}`);
    return 0;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`export: ${e.message}\n${USAGE}`);
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
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
