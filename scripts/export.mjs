#!/usr/bin/env node
// export.mjs - write the architecture model as diagram-as-code files.
//
//   node scripts/export.mjs <model.json> <format> [--view <id>] [--layout <layout.json>] [--out <path>]
//
// Formats: mermaid | plantuml | md | svg | png. This build implements mermaid, plantuml and md; the others
// are refused with exit 2 ("not yet implemented") until their tasks land.
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
// .sequence.puml); --out <dir> overrides the directory.
// --layout is accepted for a uniform command line and is not needed by the text formats.
// Output is deterministic: the same model gives byte-identical files.
// Exit 0 ok, 1 the model is invalid (nothing is written), 2 usage or unreadable input.
// Node >= 18, ESM, zero npm dependencies.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';

export const FORMATS = ['mermaid', 'plantuml', 'md', 'svg', 'png'];
const IMPLEMENTED = ['mermaid', 'plantuml', 'md'];

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
// macro call, or mean something to the creole renderer. Each becomes <U+XXXX>, which PlantUML draws as the
// character itself. Line breaks become the two characters \n (a PlantUML line break inside a label), or a
// space where a label must stay on one line. One pass, so an emitted code is never escaped again.
const PUML_UNSAFE = /\r\n|[\n\r\u0085\u2028\u2029]|[\u0000-\u001f\u007f]|["'#&;<>[\]{}|\\%]/g;
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
        edges.map((e) => [cell(e.from), cell(e.to), cell(e.type), cell(e.desc), cell(e.confidence)]),
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
    const files = { plantuml: plantUmlFiles, md: markdownFiles }[opts.format]?.(model, { view: opts.view }) ?? mermaidFiles(model, { view: opts.view });
    const dir = opts.out ?? join(dirname(opts.model), 'exports');
    try {
      mkdirSync(dir, { recursive: true });
      for (const f of files) writeFileSync(join(dir, f.name), f.text);
    } catch (e) {
      throw new UsageError(`cannot write to ${dir}: ${e.code ?? e.message}`);
    }
    for (const f of files) console.log(join(dir, f.name));
    console.log(`OK: ${files.length} ${opts.format} file(s) written to ${dir}`);
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
