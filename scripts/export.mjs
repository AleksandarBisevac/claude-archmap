#!/usr/bin/env node
// export.mjs - write the architecture model as diagram-as-code files.
//
//   node scripts/export.mjs <model.json> <format> [--view <id>] [--layout <layout.json>] [--out <path>]
//
// Formats: mermaid | plantuml | md | svg | png.
//
//   mermaid  one flowchart per view (nodes grouped in subgraphs by zone, every edge labelled with its type
//            and label), an erDiagram of the entities (fields with type, PK/FK markers, crow's-foot
//            cardinality) and one sequenceDiagram per sequence (messages, dashed returns, alt/else/opt/loop
//            blocks, notes). --view selects the flowchart of one view; without it every view is written.
//
//   plantuml the same three kinds: a component diagram per view (zones as nested packages, nodes as
//            components, every edge an arrow labelled with its type and label, queue/event edges dashed),
//            er.puml (entity blocks with fields and <<PK>>/<<FK>> markers, crow's-foot relations) and one
//            sequence diagram per sequence (participants, messages, dashed returns, alt/else/opt/loop/end,
//            notes). Files are <view-id>.component.puml, er.puml and <sequence-id>.sequence.puml.
//
//   md       one summary.md (or <view-id>.md with --view): project, commit and generatedAt, zones, nodes per
//            zone (kind, role, facts), an edges table, entities with field tables, relations, a CRUD
//            matrix (nodes x entities from access[]), and each sequence with its summary and an embedded
//            mermaid block. Evidence is path:lines, linked to <repoUrl>/blob/<commit>/<path>#La-Lb when
//            meta.repoUrl is set. Table cells escape pipes and newlines. Ordered by id.
//
//   svg      one standalone <view-id>.svg per view (zone enclosures, node boxes with title and kind, edges
//            drawn along the layout's routed sections with an arrowhead each, coloured and dashed by relation
//            type) and er.svg (entity cards with field rows, PK/FK markers, relation lines with crow's feet).
//            Drawn from the model and its layout file: --layout, else architecture.layout.json beside the
//            model, else computed in memory with layout.mjs and not written. Relation and zone colours are
//            read from assets/viewer/viewer.css (design D10), so they stay in one place. Offline and
//            self-contained: no href, font url, script, foreignObject or url(); text is XML-escaped; system
//            font stack; coordinates rounded to 2 decimals.
//
//   png      each svg above rasterised to <name>.png by a headless Chrome/Chromium: CHROME_PATH, else the
//            platform's known install paths (macOS app bundles, google-chrome/chromium/chromium-browser on
//            PATH, Windows Program Files). The browser is spawned with execFile and an argument array (never
//            a shell), a timeout and a throwaway --user-data-dir under os.tmpdir() removed afterwards; the
//            svg is loaded from a temp file:// path. No browser: one line naming CHROME_PATH, exit 3, nothing
//            written. Browser failure or timeout: exit 2 with the message, no png written.
//
// Exports are ALWAYS clean: no issue id, no step issue ref (steps[].i) and no issue text ever appears in
// any output, because the exporters never read them. Every label taken from the model is escaped for
// Mermaid (quotes, brackets, braces, pipes, semicolons, angle brackets, '#', '%' and newlines become numeric
// entity codes or <br/>), so model text cannot break out of its token or inject a statement. Ids are
// reduced to Mermaid-safe identifiers, collision-free, and never a reserved word. For PlantUML the same
// holds with a different alphabet: line breaks become the two characters \n, and quotes, apostrophes
// (a "/'" would open a comment), '<' (an <img:...> or <$sprite> would load something), '%' (a %getenv()
// call), brackets and braces (links, inline diagrams), '#', ';', '|' and '&' become <U+XXXX> code points,
// so no model text can start a line, a directive or a macro.
//
// The model is validated first (validate.mjs); an invalid model is refused and nothing is written.
// Files go to <model dir>/exports/ (with the model in docs/architecture/ that is docs/architecture/exports/)
// as <view-id>.flowchart.mmd, er.mmd and <sequence-id>.sequence.mmd (PlantUML: .component.puml, er.puml,
// .sequence.puml; SVG: <view-id>.svg, er.svg); --out <dir> overrides the directory.
// --layout is read by svg only (the text formats ignore it).
// Output is deterministic: the same model gives byte-identical files.
// Exit 0 ok, 1 the model is invalid (nothing is written), 2 usage or unreadable input.
// Node >= 18, ESM, zero npm dependencies.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, delimiter, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { validate } from './validate.mjs';

export const FORMATS = ['mermaid', 'plantuml', 'md', 'svg', 'png'];

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
function idAllocator(prefix, { keep = /[^A-Za-z0-9_]/g, lead = /^[A-Za-z_]/, reserved } = {}) {
  const byRaw = new Map();
  const taken = new Set();
  return (raw) => {
    const key = str(raw);
    if (byRaw.has(key)) return byRaw.get(key);
    let base = key.replace(keep, '_');
    if (prefix) base = prefix + base;
    else if (!lead.test(base) || (reserved && reserved.has(base.toLowerCase()))) base = `x_${base}`;
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
// PlantUML

// Characters that could end a token, open a comment, a link, an inline diagram, an embedded image or a
// macro call, or mean something to the creole renderer. `@` and `!` start a bookend or a preprocessor
// directive (`@enduml`, `!include`), and a field name is the first token of its line. Each becomes <U+XXXX>, which PlantUML draws as the
// character itself. Line breaks become the two characters \n (a PlantUML line break inside a label), or a
// space where a label must stay on one line. One pass, so an emitted code is never escaped again.
const PUML_UNSAFE = /\r\n|[\n\r\u0085\u2028\u2029]|[\u0000-\u001f\u007f]|["'#&;<>[\]{}|\\%@!]/g;
function pesc(s, { br = '\\n' } = {}) {
  return str(s).replace(PUML_UNSAFE, (c) => {
    if (/^(\r\n|[\n\r\u0085\u2028\u2029])$/.test(c)) return br;
    if (c.charCodeAt(0) < 32 || c === '\u007f') return ' ';
    return `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}
const pquote = (s) => `"${pesc(s)}"`;
// Words a bare alias must never be, whatever the model calls its ids.
const PUML_RESERVED = new Set(
  ['actor', 'alt', 'as', 'autonumber', 'boundary', 'box', 'break', 'class', 'component', 'control', 'critical', 'database', 'entity', 'else', 'end', 'enduml', 'group', 'hide', 'interface', 'left', 'loop', 'newpage', 'node', 'note', 'of', 'opt', 'over', 'package', 'par', 'participant', 'queue', 'ref', 'right', 'rectangle', 'return', 'skinparam', 'startuml', 'title', 'top', 'bottom', 'together', 'usecase'],
);
const ASYNC_EDGE_TYPES = new Set(['queue', 'event']);

/**
 * PlantUML component diagram of one view (every node and zone when viewId is omitted): zones are nested
 * packages, nodes components, edges arrows labelled `type: label`, queue and event edges dashed.
 * @param {object} model a valid model
 * @param {string} [viewId]
 * @returns {string}
 */
export function toPlantUmlComponent(model, viewId) {
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
  const out = ['@startuml'];
  const nodeLine = (n, pad) => `${pad}component ${pquote(n.title || n.id)} as ${nid(n.id)}`;
  const emitted = new Set();
  const emit = (z, pad) => {
    if (emitted.has(z.id)) return;
    emitted.add(z.id);
    out.push(`${pad}package ${pquote(z.label || z.id)} as ${zid(z.id)} {`);
    for (const n of byZone.get(z.id) ?? []) out.push(nodeLine(n, `${pad}  `));
    for (const c of children.get(z.id) ?? []) emit(c, `${pad}  `);
    out.push(`${pad}}`);
  };
  for (const z of roots) emit(z, '');
  for (const n of loose) out.push(nodeLine(n, ''));
  for (const e of scope.edges) {
    const label = e.label ? `${str(e.type)}: ${e.label}` : str(e.type);
    const arrow = ASYNC_EDGE_TYPES.has(e.type) ? '..>' : '-->';
    out.push(`${nid(e.from)} ${arrow} ${nid(e.to)} : ${pesc(label, { br: ' ' }) || '-'}`);
  }
  out.push('@enduml');
  return `${out.join('\n')}\n`;
}

/**
 * PlantUML entity-relationship diagram. Cardinality is read as in toMermaidER: for 1-n the many end is on
 * the side that holds the key (`from`), n-m is many on both, 1-1 is one on both.
 * @param {object} model a valid model
 * @returns {string}
 */
export function toPlantUmlER(model) {
  const eid = idAllocator('', { lead: /^[A-Za-z]/, reserved: PUML_RESERVED });
  const entities = list(model.entities);
  const relations = list(model.relations);
  const fkFields = new Set(relations.map((r) => `${r.from.entity}\u0000${r.from.field}`));
  const known = new Set(entities.map((e) => e.id));
  const out = ['@startuml'];
  for (const e of entities) {
    out.push(`entity ${pquote(e.name || e.id)} as ${eid(e.id)} {`);
    for (const f of list(e.fields)) {
      const keys = [];
      if (f.pk) keys.push('PK');
      if (f.fk || fkFields.has(`${e.id}\u0000${f.name}`)) keys.push('FK');
      const type = pesc(f.type, { br: ' ' }).trim() || 'unknown';
      out.push(`  ${pesc(f.name, { br: ' ' }).trim() || '-'} : ${type}${keys.length ? ` <<${keys.join(', ')}>>` : ''}`);
    }
    out.push('}');
  }
  for (const r of relations) {
    if (!known.has(r.from.entity) || !known.has(r.to.entity)) continue;
    const a = eid(r.from.entity);
    const b = eid(r.to.entity);
    const label = pesc(r.from.field, { br: ' ' }) || '-';
    if (r.cardinality === 'n-m') out.push(`${a} }o--o{ ${b} : ${label}`);
    else if (r.cardinality === '1-1') out.push(`${a} ||--|| ${b} : ${label}`);
    else out.push(`${b} ||--o{ ${a} : ${label}`);
  }
  out.push('@enduml');
  return `${out.join('\n')}\n`;
}

/**
 * PlantUML sequence diagram of one sequence. Messages are solid arrows, steps with a `ret` dashed replies,
 * alt/else/opt/loop/end blocks, notes `note over`. A stray `end`/`else` and a block left open are repaired
 * so the diagram always parses.
 * @param {object} model a valid model
 * @param {string} sequenceId
 * @returns {string}
 */
export function toPlantUmlSequence(model, sequenceId) {
  const s = list(model.sequences).find((x) => x.id === sequenceId);
  if (!s) throw new Error(`unknown sequence ${sequenceId}`);
  const pid = idAllocator('p_');
  const out = ['@startuml'];
  for (const p of list(s.participants)) {
    const label = pesc(p.label || p.id) + (p.sub ? `\\n${pesc(p.sub)}` : '');
    out.push(`participant "${label}" as ${pid(p.id)}`);
  }
  const open = [];
  const pad = () => '  '.repeat(open.length);
  const title = (t) => (str(t).trim() === '' ? '' : ` ${pesc(t, { br: ' ' })}`);
  for (const st of list(s.steps)) {
    if (st.frag !== undefined) {
      if (st.frag === 'alt' || st.frag === 'opt' || st.frag === 'loop') {
        out.push(`${pad()}${st.frag}${title(st.t)}`);
        open.push(st.frag);
      } else if (st.frag === 'else') {
        if (open[open.length - 1] === 'alt') out.push(`${'  '.repeat(open.length - 1)}else${title(st.t)}`);
      } else if (st.frag === 'end') {
        if (open.length) {
          open.pop();
          out.push(`${pad()}end`);
        }
      }
    } else if (Array.isArray(st.note)) {
      const first = pid(st.note[0]);
      const last = pid(st.note[st.note.length - 1]);
      const over = st.note.length > 1 ? `${first}, ${last}` : first;
      out.push(`${pad()}note over ${over} : ${pesc(st.t) || '-'}`);
    } else if (Array.isArray(st.m)) {
      const arrow = st.ret !== undefined ? '-->' : '->';
      out.push(`${pad()}${pid(st.m[0])} ${arrow} ${pid(st.m[1])} : ${pesc(st.t || st.k) || '-'}`);
    }
  }
  while (open.length) {
    open.pop();
    out.push(`${pad()}end`);
  }
  out.push('@enduml');
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

/**
 * Every PlantUML file for a model: [{name, text}], in a fixed order.
 * @param {object} model a valid model
 * @param {{view?: string}} [opts] view = only that view's component diagram
 */
export function plantUmlFiles(model, { view } = {}) {
  const name = fileNamer();
  const files = [];
  if (view !== undefined) {
    files.push({ name: name(view, '.component.puml'), text: toPlantUmlComponent(model, view) });
    return files;
  }
  for (const v of list(model.views)) files.push({ name: name(v.id, '.component.puml'), text: toPlantUmlComponent(model, v.id) });
  if (list(model.views).length === 0) files.push({ name: name('all', '.component.puml'), text: toPlantUmlComponent(model) });
  if (list(model.entities).length) files.push({ name: 'er.puml', text: toPlantUmlER(model) });
  for (const q of list(model.sequences)) files.push({ name: name(q.id, '.sequence.puml'), text: toPlantUmlSequence(model, q.id) });
  return files;
}

// ---------------------------------------------------------------------------
// Markdown summary

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortedById = (xs) => list(xs).slice().sort(byId);

/** Text for a table cell: no raw HTML, escaped pipes and backslashes, line breaks as <br>. */
function cell(s) {
  return str(s)
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|[\n\r\u0085\u2028\u2029]/g, '<br>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}
/** Text for a line of prose or a list item: no raw HTML, line breaks folded to a space. */
const prose = (s) =>
  str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\r\n|[\n\r\u0085\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
const mdRow = (cs) => `| ${cs.join(' | ')} |`;
const mdTable = (head, rows) => [mdRow(head), mdRow(head.map(() => '---')), ...rows.map(mdRow)];

/** One evidence reference as `path:lines`, linked to the commit on the repo host when meta.repoUrl is set. */
function evidenceRef(meta, path, lines) {
  const label = lines === undefined || lines === '' ? str(path) : `${path}:${lines}`;
  const text = label.replace(/[[\]\\]/g, (c) => `\\${c}`);
  const repo = str(meta && meta.repoUrl).replace(/\/+$/, '');
  if (!repo || !meta.commit) return `\`${label.replace(/`/g, "'")}\``;
  const m = /^(\d+)(?:-(\d+))?$/.exec(str(lines).trim());
  const anchor = m ? `#L${m[1]}${m[2] ? `-L${m[2]}` : ''}` : '';
  const file = str(path).split('/').map(encodeURIComponent).join('/');
  return `[${text}](${repo}/blob/${encodeURIComponent(str(meta.commit))}/${file}${anchor})`;
}
const evidenceList = (meta, ev) => list(ev).map((e) => evidenceRef(meta, e.path, e.lines)).join(', ');
/** Step references are "path:lines" strings; the lines part follows the last colon. */
function stepRef(meta, r) {
  const s = str(r);
  const i = s.lastIndexOf(':');
  return i > 0 && /^\d+(-\d+)?$/.test(s.slice(i + 1)) ? evidenceRef(meta, s.slice(0, i), s.slice(i + 1)) : evidenceRef(meta, s);
}

const OPS = 'CRUD';
const mergeOps = (a, b) => [...new Set(str(a) + str(b))].sort((x, y) => OPS.indexOf(x) - OPS.indexOf(y)).join('');

/**
 * A Markdown summary of the model for a wiki or a PR: meta, zones, nodes per zone, an edges table,
 * entities with field tables, relations, a CRUD matrix, and sequences with embedded Mermaid. Ordered by
 * id, so the same model gives the same text. Issue data is never part of it.
 * @param {object} model a valid model
 * @param {string} [viewId] limit zones, nodes, edges and the CRUD matrix to that view
 * @returns {string}
 */
export function toMarkdown(model, viewId) {
  let view;
  if (viewId !== undefined) {
    view = list(model.views).find((v) => v.id === viewId);
    if (!view) throw new Error(`unknown view ${viewId}`);
  }
  const meta = model.meta || {};
  const scope = viewScope(model, view);
  const nodes = sortedById(scope.nodes);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const out = [];
  const title = view ? `${prose(meta.project)} - ${prose(view.title || view.id)}` : `${prose(meta.project)} - architecture summary`;
  out.push(`# ${title}`, '');
  out.push(`- Project: ${prose(meta.project)}`);
  if (meta.commit) out.push(`- Commit: \`${prose(meta.commit)}\``);
  if (meta.generatedAt) out.push(`- Generated at: ${prose(meta.generatedAt)}`);
  if (view) out.push(`- View: \`${prose(view.id)}\``);
  out.push('');

  out.push('## Zones', '');
  const zones = sortedById(scope.zones);
  if (zones.length === 0) out.push('None.');
  else out.push(...mdTable(['Zone', 'Kind', 'Label', 'Parent'], zones.map((z) => [cell(z.id), cell(z.kind), cell(z.label), cell(z.parent)])));
  out.push('');

  out.push('## Nodes', '');
  if (nodes.length === 0) out.push('None.', '');
  for (const z of zones) {
    const inZone = nodes.filter((n) => n.zone === z.id);
    if (inZone.length === 0) continue;
    out.push(`### ${prose(z.label || z.id)} (\`${prose(z.id)}\`)`, '');
    for (const n of inZone) {
      out.push(`- **${prose(n.id)}** - ${prose(n.title)} (${prose(n.kind)})`);
      if (n.role) out.push(`  - Role: ${prose(n.role)}`);
      for (const f of list(n.facts)) out.push(`  - ${prose(f)}`);
      if (list(n.evidence).length) out.push(`  - Evidence: ${evidenceList(meta, n.evidence)}`);
    }
    out.push('');
  }

  out.push('## Edges', '');
  const edges = sortedById(scope.edges);
  if (edges.length === 0) out.push('None.');
  else
    out.push(
      ...mdTable(
        ['From', 'To', 'Type', 'Label', 'Confidence'],
        edges.map((e) => [cell(e.from), cell(e.to), cell(e.type), cell(e.label), cell(e.confidence)]),
      ),
    );
  out.push('');

  out.push('## Entities', '');
  const entities = sortedById(model.entities);
  const fkFields = new Set(list(model.relations).map((r) => `${r.from.entity}\u0000${r.from.field}`));
  if (entities.length === 0) out.push('None.', '');
  for (const e of entities) {
    out.push(`### ${prose(e.name || e.id)} (\`${prose(e.id)}\`)`, '');
    out.push(`${prose(e.kind)}${e.store ? ` in \`${prose(e.store)}\`` : ''}`, '');
    out.push(
      ...mdTable(
        ['Name', 'Type', 'Key', 'Nullable'],
        list(e.fields).map((f) => {
          const keys = [];
          if (f.pk) keys.push('PK');
          if (f.fk || fkFields.has(`${e.id}\u0000${f.name}`)) keys.push('FK');
          return [cell(f.name), cell(f.type), keys.join(', '), f.nullable ? 'yes' : 'no'];
        }),
      ),
    );
    out.push('');
    if (list(e.evidence).length) out.push(`Evidence: ${evidenceList(meta, e.evidence)}`, '');
  }

  out.push('## Relations', '');
  const rels = list(model.relations)
    .slice()
    .sort((a, b) => {
      const k = (r) => [r.from.entity, r.from.field, r.to.entity, r.to.field].join('\u0000');
      return k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0;
    });
  if (rels.length === 0) out.push('None.');
  else
    out.push(
      ...mdTable(
        ['From', 'To', 'Cardinality', 'Kind'],
        rels.map((r) => [cell(`${r.from.entity}.${r.from.field}`), cell(`${r.to.entity}.${r.to.field}`), cell(r.cardinality), cell(r.kind)]),
      ),
    );
  out.push('');

  out.push('## CRUD matrix', '');
  const access = list(model.access).filter((a) => nodeIds.has(a.node));
  const rowIds = [...new Set(access.map((a) => a.node))].sort();
  const colIds = [...new Set(access.map((a) => a.entity))].sort();
  if (access.length === 0) out.push('None.');
  else {
    const ops = new Map();
    for (const a of access) {
      const k = `${a.node}\u0000${a.entity}`;
      ops.set(k, mergeOps(ops.get(k), a.ops));
    }
    out.push(...mdTable(['Node', ...colIds.map(cell)], rowIds.map((n) => [cell(n), ...colIds.map((e) => ops.get(`${n}\u0000${e}`) || '')])));
    const refs = [];
    for (const a of access.slice().sort((x, y) => (`${x.node}\u0000${x.entity}` < `${y.node}\u0000${y.entity}` ? -1 : 1))) {
      if (list(a.evidence).length) refs.push(`- \`${prose(a.node)}\` x \`${prose(a.entity)}\` (${prose(a.ops)}): ${evidenceList(meta, a.evidence)}`);
    }
    if (refs.length) out.push('', 'Evidence:', '', ...refs);
  }
  out.push('');

  out.push('## Sequences', '');
  const seqs = sortedById(model.sequences);
  if (seqs.length === 0) out.push('None.', '');
  for (const s of seqs) {
    out.push(`### ${prose(s.title || s.id)} (\`${prose(s.id)}\`)`, '');
    if (s.summary) out.push(prose(s.summary), '');
    out.push('```mermaid', toMermaidSequence(model, s.id).trimEnd(), '```', '');
    const seen = new Set();
    const refs = [];
    for (const st of list(s.steps)) {
      for (const r of list(st.r)) {
        if (seen.has(r)) continue;
        seen.add(r);
        refs.push(stepRef(meta, r));
      }
    }
    if (refs.length) out.push(`Evidence: ${refs.join(', ')}`, '');
  }
  while (out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

/** The Markdown file for a model: summary.md, or <view-id>.md when one view is asked for. */
export function markdownFiles(model, { view } = {}) {
  if (view !== undefined) return [{ name: fileNamer()(view, '.md'), text: toMarkdown(model, view) }];
  return [{ name: 'summary.md', text: toMarkdown(model) }];
}

// ---------------------------------------------------------------------------
// SVG

// Colours are the viewer's: the first :root block of assets/viewer/viewer.css (the light theme) is the one table
// of fixed relation / zone colours (design D10), read here so they stay in one place. The dash pattern and
// stroke width of each relation type mirror viewer.js REL (that table lives in a browser script and cannot be
// imported; keep the two in step).
const REL_STYLE = {
  api: { dash: null, w: 2 },
  static: { dash: '2 4', w: 1.7 },
  auth: { dash: '7 4', w: 2 },
  pull: { dash: null, w: 3.2 },
  sql: { dash: null, w: 2 },
  cache: { dash: null, w: 2 },
  persist: { dash: '1.5 3.5', w: 2.2 },
  call: { dash: null, w: 1.3 },
  link: { dash: '8 3 2 3', w: 1.6 },
  deploy: { dash: '10 5', w: 2 },
  event: { dash: '4 2 1 2', w: 1.8 },
  queue: { dash: '6 3', w: 2.4 },
};
const SVG_FONT = 'system-ui,-apple-system,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif';
const SVG_MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,Liberation Mono,monospace';

let paletteCache;
function viewerPalette() {
  if (paletteCache) return paletteCache;
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'viewer', 'viewer.css');
  let css;
  try {
    css = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the viewer palette ${file}: ${e.code ?? e.message}`);
  }
  const start = css.indexOf(':root{');
  const block = start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  const p = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\b/g)) p[m[1]] = m[2];
  for (const k of ['surface', 'surface-2', 'fg', 'muted', 'line-2', 'rel-call']) {
    if (!p[k]) throw new Error(`the viewer palette ${file} lacks --${k}`);
  }
  paletteCache = p;
  return p;
}

/** Text for an XML text node or a double-quoted attribute: the five entities, no control characters. */
function xesc(s) {
  return str(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[\t\n\r\u0085\u2028\u2029]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
/** Shorten text that would overflow a box of the given width at roughly `per` pixels per character. */
function fit(s, width, per) {
  const t = str(s);
  const max = Math.max(3, Math.floor(width / per));
  const chars = Array.from(t);
  return chars.length <= max ? t : `${chars.slice(0, max - 1).join('')}…`;
}
const rnd = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const hasBox = (b) => b && finite(b.x) && finite(b.y) && finite(b.w) && finite(b.h);

/** The routed points of an edge or relation: its sections' start, bend and end points, repeats dropped. */
function sectionPoints(entry) {
  const pts = [];
  for (const sec of list(entry && entry.sections)) {
    for (const q of [sec && sec.startPoint, ...list(sec && sec.bendPoints), sec && sec.endPoint]) {
      if (!q || !finite(q.x) || !finite(q.y)) continue;
      const last = pts[pts.length - 1];
      if (!last || last[0] !== q.x || last[1] !== q.y) pts.push([q.x, q.y]);
    }
  }
  return pts;
}
/** A polyline with rounded corners. */
function roundedPath(pts, rad) {
  let d = `M${rnd(pts[0][0])},${rnd(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0) || 1;
    const d2 = Math.hypot(x2 - x1, y2 - y1) || 1;
    const r = Math.min(rad, d1 / 2, d2 / 2);
    d += ` L${rnd(x1 + ((x0 - x1) / d1) * r)},${rnd(y1 + ((y0 - y1) / d1) * r)} Q${rnd(x1)},${rnd(y1)} ${rnd(x1 + ((x2 - x1) / d2) * r)},${rnd(y1 + ((y2 - y1) / d2) * r)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${rnd(last[0])},${rnd(last[1])}`;
}
/** A filled triangle whose tip is p, arriving from q. */
function arrowHead(p, q) {
  const dx = p[0] - q[0];
  const dy = p[1] - q[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = p[0] - ux * 10;
  const by = p[1] - uy * 10;
  return `M${rnd(p[0])},${rnd(p[1])} L${rnd(bx - uy * 4.5)},${rnd(by + ux * 4.5)} L${rnd(bx + uy * 4.5)},${rnd(by - ux * 4.5)} Z`;
}
/** Crow's foot (many) or bar (one) at p, for a line arriving from q (the viewer's glyphs). */
function crowFoot(p, q, many) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  if (many) {
    const bx = p[0] + ux * 12;
    const by = p[1] + uy * 12;
    return `M${rnd(bx + nx * 6)},${rnd(by + ny * 6)} L${rnd(p[0])},${rnd(p[1])} L${rnd(bx - nx * 6)},${rnd(by - ny * 6)}`;
  }
  const bx = p[0] + ux * 10;
  const by = p[1] + uy * 10;
  return `M${rnd(bx + nx * 6)},${rnd(by + ny * 6)} L${rnd(bx - nx * 6)},${rnd(by - ny * 6)}`;
}

/** Boxes for items the layout has no position for: a row below everything that has one. */
function parkMissing(items, placed, size) {
  const out = new Map(placed);
  let bottom = 0;
  for (const b of placed.values()) bottom = Math.max(bottom, b.y + b.h);
  let x = 0;
  const y = placed.size ? bottom + 40 : 0;
  for (const it of items) {
    if (out.has(it.id)) continue;
    const { w, h } = size(it);
    out.set(it.id, { x, y, w, h });
    x += w + 24;
  }
  return out;
}

function svgDocument(bounds, body, desc) {
  const pad = 24;
  const x = rnd(bounds.x0 - pad);
  const y = rnd(bounds.y0 - pad);
  const w = rnd(bounds.x1 - bounds.x0 + 2 * pad);
  const h = rnd(bounds.y1 - bounds.y0 + 2 * pad);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" role="img" font-family="${SVG_FONT}" font-size="12">`,
    `<title>${xesc(desc)}</title>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#FFFFFF"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}
function boundsOf() {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}
function grow(b, x, y) {
  b.x0 = Math.min(b.x0, x);
  b.y0 = Math.min(b.y0, y);
  b.x1 = Math.max(b.x1, x);
  b.y1 = Math.max(b.y1, y);
}
function settle(b) {
  if (!Number.isFinite(b.x0)) return { x0: 0, y0: 0, x1: 400, y1: 120 };
  return b;
}

/**
 * Standalone SVG of one view (every node and zone when viewId is omitted), drawn from the model and the
 * layout file's `graph` block (absolute coordinates). Nodes or zones the layout lacks are parked below the rest.
 * @param {object} model a valid model
 * @param {object} layout an architecture.layout.json content
 * @param {string} [viewId]
 * @returns {string}
 */
export function toSvgGraph(model, layout, viewId) {
  let view;
  if (viewId !== undefined) {
    view = list(model.views).find((v) => v.id === viewId);
    if (!view) throw new Error(`unknown view ${viewId}`);
  }
  const pal = viewerPalette();
  const scope = viewScope(model, view);
  const lg = (layout && layout.graph) || {};
  const placedNodes = new Map();
  for (const n of scope.nodes) if (hasBox(lg.nodes && lg.nodes[n.id])) placedNodes.set(n.id, lg.nodes[n.id]);
  const nodeBox = parkMissing(scope.nodes, placedNodes, () => ({ w: 160, h: 56 }));
  const zoneBox = new Map();
  for (const z of scope.zones) if (hasBox(lg.zones && lg.zones[z.id])) zoneBox.set(z.id, lg.zones[z.id]);

  const zones = new Map(list(model.zones).map((z) => [z.id, z]));
  const depth = (z) => zoneChain(zones, z.id).length;
  const drawnZones = scope.zones
    .filter((z) => zoneBox.has(z.id))
    .sort((a, b) => depth(a) - depth(b) || byId(a, b));
  const b = boundsOf();
  const body = [];
  for (const z of drawnZones) {
    const r = zoneBox.get(z.id);
    const col = pal[`zone-${z.kind}`] ?? pal['line-2'];
    grow(b, r.x, r.y);
    grow(b, r.x + r.w, r.y + r.h);
    body.push(
      `<g class="zone" data-zone="${xesc(z.id)}"><rect x="${rnd(r.x)}" y="${rnd(r.y)}" width="${rnd(r.w)}" height="${rnd(r.h)}" rx="8" fill="${col}" fill-opacity="0.07" stroke="${col}" stroke-opacity="0.6" stroke-width="1.2"/>` +
        `<text x="${rnd(r.x + 12)}" y="${rnd(r.y + 22)}" font-size="12" font-weight="600" fill="${col}">${xesc(fit(z.label ?? z.id,r.w - 24, 7.4))}</text></g>`,
    );
  }
  const nodes = scope.nodes.slice().sort(byId);
  for (const n of nodes) {
    const r = nodeBox.get(n.id);
    grow(b, r.x, r.y);
    grow(b, r.x + r.w, r.y + r.h);
    const col = pal[`zone-${(zones.get(n.zone) || {}).kind}`] ?? pal['line-2'];
    body.push(
      `<g class="node"><rect data-node="${xesc(n.id)}" x="${rnd(r.x)}" y="${rnd(r.y)}" width="${rnd(r.w)}" height="${rnd(r.h)}" rx="6" fill="${pal.surface}" stroke="${col}" stroke-width="1.4"/>` +
        `<text x="${rnd(r.x + 12)}" y="${rnd(r.y + 24)}" font-size="13" font-weight="600" fill="${pal.fg}">${xesc(fit(n.title ?? n.id, r.w - 24, 7.6))}</text>` +
        `<text x="${rnd(r.x + 12)}" y="${rnd(r.y + 42)}" font-size="11" fill="${pal.muted}">${xesc(fit(n.kind ?? '', r.w - 24, 6.4))}</text></g>`,
    );
  }
  const edges = scope.edges.slice().sort(byId);
  for (const e of edges) {
    const type = REL_STYLE[e.type] ? e.type : 'call';
    const st = REL_STYLE[type];
    const col = pal[`rel-${type}`];
    let pts = sectionPoints(lg.edges && lg.edges[e.id]);
    if (pts.length < 2) {
      const a = nodeBox.get(e.from);
      const c = nodeBox.get(e.to);
      pts = [
        [a.x + a.w / 2, a.y + a.h / 2],
        [c.x + c.w / 2, c.y + c.h / 2],
      ];
    }
    for (const q of pts) grow(b, q[0], q[1]);
    const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : '';
    body.push(
      `<g class="edge"><path data-edge="${xesc(e.id)}" d="${roundedPath(pts, 8)}" fill="none" stroke="${col}" stroke-width="${st.w}"${dash} stroke-linejoin="round"/>` +
        `<path data-arrow="${xesc(e.id)}" d="${arrowHead(pts[pts.length - 1], pts[pts.length - 2])}" fill="${col}" stroke="none"/></g>`,
    );
  }
  return svgDocument(settle(b), body, `${str(model.meta && model.meta.project) || 'Architecture'} - ${str(view && (view.title ?? view.id)) || 'all components'}`);
}

/**
 * Standalone SVG of the entity-relationship diagram, drawn from the model and the layout file's `er` block:
 * entity cards with a field row each (PK / FK markers, type) and the relation lines with crow's-foot ends.
 * @param {object} model a valid model
 * @param {object} layout an architecture.layout.json content
 * @returns {string}
 */
export function toSvgER(model, layout) {
  const pal = viewerPalette();
  const le = (layout && layout.er) || {};
  const entities = list(model.entities).slice().sort(byId);
  const placed = new Map();
  for (const e of entities) if (hasBox(le.entities && le.entities[e.id])) placed.set(e.id, le.entities[e.id]);
  const box = parkMissing(entities, placed, (e) => ({ w: 210, h: 36 + 22 * list(e.fields).length }));
  const rels = list(model.relations);
  const outgoing = new Set(rels.map((r) => `${r.from.entity}\u0000${r.from.field}`));
  const b = boundsOf();
  const body = [];
  const rows = new Map(); // entity id -> field name -> [x, y] of the row's edge
  for (const e of entities) {
    const r = box.get(e.id);
    const fields = list(e.fields);
    grow(b, r.x, r.y);
    grow(b, r.x + r.w, r.y + Math.max(r.h, 30 + 22 * fields.length));
    const port = (le.entities && le.entities[e.id] && le.entities[e.id].ports) || {};
    const rowAt = new Map();
    const g = [
      `<g class="entity"><rect data-entity="${xesc(e.id)}" x="${rnd(r.x)}" y="${rnd(r.y)}" width="${rnd(r.w)}" height="${rnd(r.h)}" rx="6" fill="${pal.surface}" stroke="${pal['line-2']}" stroke-width="1.2"/>`,
      `<path d="M${rnd(r.x)},${rnd(r.y + 30)} L${rnd(r.x)},${rnd(r.y + 6)} Q${rnd(r.x)},${rnd(r.y)} ${rnd(r.x + 6)},${rnd(r.y)} L${rnd(r.x + r.w - 6)},${rnd(r.y)} Q${rnd(r.x + r.w)},${rnd(r.y)} ${rnd(r.x + r.w)},${rnd(r.y + 6)} L${rnd(r.x + r.w)},${rnd(r.y + 30)} Z" fill="${pal['surface-2']}" stroke="none"/>`,
      `<text x="${rnd(r.x + 10)}" y="${rnd(r.y + 20)}" font-size="13" font-weight="600" fill="${pal.fg}">${xesc(fit(e.name ?? e.id, r.w - 20, 7.6))}</text>`,
    ];
    fields.forEach((f, i) => {
      const y = r.y + 30 + 22 * i;
      const p = port[f.name];
      rowAt.set(f.name, finite(p && p.x) && finite(p && p.y) ? [r.x + p.x, r.y + p.y] : [r.x + r.w, y + 11]);
      const fk = !!f.fk || outgoing.has(`${e.id}\u0000${f.name}`);
      if (i > 0) g.push(`<path d="M${rnd(r.x)},${rnd(y)} L${rnd(r.x + r.w)},${rnd(y)}" fill="none" stroke="${pal['surface-2']}" stroke-width="1"/>`);
      let tx = r.x + 10;
      if (f.pk) {
        g.push(`<text x="${rnd(tx)}" y="${rnd(y + 15)}" font-size="9" font-weight="700" fill="${pal['rel-deploy']}">PK</text>`);
        tx += 20;
      }
      if (fk) {
        g.push(`<text x="${rnd(r.x + 10 + (f.pk ? 20 : 0))}" y="${rnd(y + 15)}" font-size="9" font-weight="700" fill="${pal['rel-sql']}">FK</text>`);
        tx += 20;
      }
      const room = r.w - (tx - r.x) - 10;
      g.push(`<text x="${rnd(tx)}" y="${rnd(y + 15)}" font-size="11.5" font-family="${SVG_MONO}" fill="${pal.fg}">${xesc(fit(f.name, room * 0.6, 7))}</text>`);
      if (f.type) g.push(`<text x="${rnd(r.x + r.w - 10)}" y="${rnd(y + 15)}" font-size="10.5" text-anchor="end" fill="${pal.muted}">${xesc(fit(f.type, room * 0.38, 6.2))}</text>`);
    });
    g.push('</g>');
    rows.set(e.id, rowAt);
    body.push(g.join(''));
  }
  const used = new Map();
  for (const rel of rels) {
    const base = `${rel.from.entity}.${rel.from.field}->${rel.to.entity}.${rel.to.field}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;
    const a = box.get(rel.from.entity);
    const c = box.get(rel.to.entity);
    if (!a || !c) continue;
    let pts = sectionPoints(le.relations && le.relations[key]);
    if (pts.length < 2) {
      const pa = (rows.get(rel.from.entity) || new Map()).get(rel.from.field) || [a.x + a.w, a.y + a.h / 2];
      const pc = (rows.get(rel.to.entity) || new Map()).get(rel.to.field) || [c.x, c.y + c.h / 2];
      pts = [pa, pc];
    }
    for (const q of pts) grow(b, q[0], q[1]);
    const manyFrom = rel.cardinality === '1-n' || rel.cardinality === 'n-m';
    const manyTo = rel.cardinality === 'n-m';
    const foot = `${crowFoot(pts[0], pts[1], manyFrom)} ${crowFoot(pts[pts.length - 1], pts[pts.length - 2], manyTo)}`;
    const col = pal['rel-sql'];
    const dash = rel.provenance === 'inferred' ? ' stroke-dasharray="4 3"' : '';
    body.push(
      `<g class="relation"><path data-relation="${xesc(key)}" d="${roundedPath(pts, 8)}" fill="none" stroke="${col}" stroke-width="1.5"${dash}/>` +
        `<path class="foot" d="${foot}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></g>`,
    );
  }
  return svgDocument(settle(b), body, `${str(model.meta && model.meta.project) || 'Architecture'} - entities`);
}

/**
 * Every SVG file for a model: [{name, text}], in a fixed order.
 * @param {object} model a valid model
 * @param {object} layout an architecture.layout.json content
 * @param {{view?: string}} [opts] view = only that view's SVG
 */
export function svgFiles(model, layout, { view } = {}) {
  const name = fileNamer();
  if (view !== undefined) return [{ name: name(view, '.svg'), text: toSvgGraph(model, layout, view) }];
  const files = [];
  for (const v of list(model.views)) files.push({ name: name(v.id, '.svg'), text: toSvgGraph(model, layout, v.id) });
  if (list(model.views).length === 0) files.push({ name: name('all', '.svg'), text: toSvgGraph(model, layout) });
  if (list(model.entities).length) files.push({ name: 'er.svg', text: toSvgER(model, layout) });
  return files;
}

// ---------------------------------------------------------------------------
// png: rasterise the svg files with a headless Chrome/Chromium

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The Chrome/Chromium executable to rasterise with, or null. CHROME_PATH wins when it exists; otherwise
 * the platform's known install paths (a CHROME_PATH that points nowhere does not hide a real install).
 * @param {{env?: object, platform?: string, exists?: (p: string) => boolean}} [opts] injected for tests
 * @returns {string|null}
 */
export function findChromium({ env = process.env, platform = process.platform, exists = isFile } = {}) {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) return env.CHROME_PATH;
  const candidates = [];
  if (platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    for (const base of ['/Applications', env.HOME ? posix.join(env.HOME, 'Applications') : '']) {
      if (base) for (const a of apps) candidates.push(posix.join(base, a));
    }
  } else if (platform === 'win32') {
    const roots = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(win32.join(r, 'Chromium', 'Application', 'chrome.exe'));
      candidates.push(win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else {
    for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
      for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) candidates.push(posix.join(dir, n));
    }
  }
  return candidates.find((c) => exists(c)) ?? null;
}

/** The argument array (never a shell line) for one screenshot. */
export function chromiumArgs({ userDataDir, width, height, screenshot, url }) {
  return [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    `--user-data-dir=${userDataDir}`,
    `--screenshot=${screenshot}`,
    `--window-size=${width},${height}`,
    url,
  ];
}

const CHROME_TIMEOUT_MS = 30000;

/** Window size from the svg root's width/height (svgDocument writes both), rounded up; a sane default otherwise. */
function svgSize(text) {
  const root = /<svg\b[^>]*>/.exec(text)?.[0] ?? '';
  const dim = (n) => {
    const m = new RegExp(`\\s${n}="([0-9.]+)"`).exec(root);
    return m ? Math.max(1, Math.ceil(Number(m[1]))) : 0;
  };
  return { width: dim('width') || 800, height: dim('height') || 600 };
}

class BrowserError extends Error {}
class NoBrowserError extends Error {}

/** Rasterise [{name: 'x.svg', text}] into a fresh temp dir; returns {dir, pngs: [{name: 'x.png', path}]}. The caller removes dir. */
async function rasterise(chrome, svgs) {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-png-'));
  const pngs = [];
  try {
    for (const f of svgs) {
      const base = f.name.replace(/\.svg$/, '');
      const svgPath = join(dir, f.name);
      const pngPath = join(dir, `${base}.png`);
      writeFileSync(svgPath, f.text);
      const userDataDir = mkdtempSync(join(tmpdir(), 'archmap-chrome-'));
      const args = chromiumArgs({ userDataDir, ...svgSize(f.text), screenshot: pngPath, url: pathToFileURL(svgPath).href });
      try {
        await new Promise((resolve, reject) => {
          execFile(chrome, args, { timeout: CHROME_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1 << 20 }, (err, _out, errOut) => {
            if (!err) return resolve();
            const why = err.killed ? `timed out after ${CHROME_TIMEOUT_MS / 1000}s` : String(errOut || err.message).trim().split('\n').pop();
            reject(new BrowserError(`${chrome} failed on ${f.name}: ${why}`));
          });
        });
      } finally {
        rmSync(userDataDir, { recursive: true, force: true });
      }
      if (!isFile(pngPath)) throw new BrowserError(`${chrome} produced no image for ${f.name}`);
      pngs.push({ name: `${base}.png`, path: pngPath });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { dir, pngs };
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

/** The layout svg draws from: --layout, else architecture.layout.json beside the model, else computed in memory (never written). */
async function layoutFor(opts, model) {
  if (opts.layout !== undefined) return readJson(opts.layout, 'layout');
  const beside = join(dirname(opts.model), 'architecture.layout.json');
  if (existsSync(beside)) return readJson(beside, 'layout');
  const { layoutModel } = await import('./layout.mjs');
  try {
    return await layoutModel(model);
  } catch (e) {
    throw new UsageError(`cannot lay out the model: ${e.message}`);
  }
}

async function main(argv) {
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
    let files;
    let tmpPngs;
    const chrome = opts.format === 'png' ? findChromium() : null;
    if (opts.format === 'png' && !chrome) throw new NoBrowserError('export: png needs headless Chrome/Chromium and none was found; set CHROME_PATH to its executable');
    if (opts.format === 'svg' || opts.format === 'png') {
      files = svgFiles(model, await layoutFor(opts, model), { view: opts.view });
      if (chrome) {
        tmpPngs = await rasterise(chrome, files);
        files = tmpPngs.pngs;
      }
    } else {
      files = { plantuml: plantUmlFiles, md: markdownFiles }[opts.format]?.(model, { view: opts.view }) ?? mermaidFiles(model, { view: opts.view });
    }
    const dir = opts.out ?? join(dirname(opts.model), 'exports');
    try {
      mkdirSync(dir, { recursive: true });
      for (const f of files) {
        if (f.path) copyFileSync(f.path, join(dir, f.name));
        else writeFileSync(join(dir, f.name), f.text);
      }
    } catch (e) {
      throw new UsageError(`cannot write to ${dir}: ${e.code ?? e.message}`);
    } finally {
      if (tmpPngs) rmSync(tmpPngs.dir, { recursive: true, force: true });
    }
    for (const f of files) console.log(join(dir, f.name));
    console.log(`OK: ${files.length} ${opts.format} file(s) written to ${dir}`);
    return 0;
  } catch (e) {
    if (e instanceof NoBrowserError) {
      console.error(e.message);
      return 3;
    }
    if (e instanceof BrowserError) {
      console.error(`export: ${e.message}`);
      return 2;
    }
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
if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
