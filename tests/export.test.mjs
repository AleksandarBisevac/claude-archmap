import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (x1, x2, ...) lead every title so the suite prints them first.
// Exports are ALWAYS clean: the golden model carries issue refs on sequence steps (steps[].i) and the
// golden issues.json holds the ids, so "never in any output" is observable.
const CLI = fileURLToPath(new URL('../scripts/export.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/golden/', import.meta.url));
const MODEL = join(GOLDEN, 'architecture.model.json');
const model = JSON.parse(readFileSync(MODEL, 'utf8'));
const issues = JSON.parse(readFileSync(join(GOLDEN, 'issues.json'), 'utf8'));

const clone = (x) => JSON.parse(JSON.stringify(x));
const tmp = mkdtempSync(join(tmpdir(), 'archmap-export-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

const { toMermaidFlowchart, toMermaidER, toMermaidSequence, toPlantUmlComponent, toPlantUmlER, toPlantUmlSequence } = await import('../scripts/export.mjs');

let seq = 0;
const fresh = (name) => {
  const d = join(tmp, `${name}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
/** Put a model at <root>/docs/architecture/architecture.model.json, the layout the default output dir assumes. */
function place(m) {
  const root = fresh('proj');
  const dir = join(root, 'docs', 'architecture');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'architecture.model.json');
  writeFileSync(file, JSON.stringify(m, null, 2));
  return { root, dir, file, exports: join(dir, 'exports') };
}
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const readAll = (dir) => files(dir).map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8') }));

// Reading a Mermaid line back: numeric entity codes and <br/> are the only escapes the exporter may use.
const decode = (s) => s.replace(/<br\/>/g, '\n').replace(/#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
// The text with every legitimate escape removed: whatever is left is raw and must be harmless.
const bare = (s) => s.replace(/<br\/>/g, '').replace(/#\d+;/g, '');
const lines = (s) => s.split('\n');

// The viewer's reading of a view (viewer.js buildViews): explicit nodes, else the nodes in the zones (and below), else all.
const zoneById = new Map(model.zones.map((z) => [z.id, z]));
const zoneChain = (id) => {
  const out = [];
  for (let z = zoneById.get(id); z; z = zoneById.get(z.parent)) out.push(z.id);
  return out;
};
function viewNodes(v) {
  if (v.nodes) return model.nodes.filter((n) => v.nodes.includes(n.id));
  if (v.zones) return model.nodes.filter((n) => zoneChain(n.zone).some((z) => v.zones.includes(z)));
  return model.nodes.slice();
}
const viewEdges = (v) => {
  const ids = new Set(viewNodes(v).map((n) => n.id));
  return model.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
};

test('x1 mermaid writes one flowchart per view, er.mmd and one sequence file per sequence into <model dir>/exports', () => {
  const p = place(model);
  const r = run([p.file, 'mermaid']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const expected = [
    ...model.views.map((v) => `${v.id}.flowchart.mmd`),
    'er.mmd',
    ...model.sequences.map((s) => `${s.id}.sequence.mmd`),
  ].sort();
  assert.deepEqual(files(p.exports), expected);
  assert.equal(expected.length, 6 + 1 + 7);
  assert.match(readFileSync(join(p.exports, 'er.mmd'), 'utf8'), /^erDiagram\n/);
  assert.match(readFileSync(join(p.exports, 'place-order.sequence.mmd'), 'utf8'), /^sequenceDiagram\n/);
  assert.match(readFileSync(join(p.exports, 'system-context.flowchart.mmd'), 'utf8'), /^flowchart /);
});

test('x2 the flowchart groups nodes by zone in subgraphs and labels every edge with its type and label', () => {
  for (const v of model.views) {
    const out = toMermaidFlowchart(model, v.id);
    assert.match(out, /^flowchart /);
    // node -> the label of the subgraph that encloses it
    const stack = [];
    const enclosing = new Map();
    for (const line of lines(out)) {
      const t = line.trim();
      if (t.startsWith('subgraph ')) stack.push(decode(t));
      else if (t === 'end') stack.pop();
      else {
        const m = t.match(/^\w+\["(.*)"\]$/);
        if (m) enclosing.set(decode(m[1]), stack[stack.length - 1]);
      }
    }
    assert.equal(stack.length, 0, `${v.id}: every subgraph is closed`);
    for (const n of viewNodes(v)) {
      const sub = enclosing.get(n.title);
      assert.ok(sub, `${v.id}: node ${n.id} is declared`);
      assert.ok(sub.includes(zoneById.get(n.zone).label), `${v.id}: ${n.id} sits in the subgraph of zone ${n.zone}`);
    }
    // edges: type, then ": label" when the model has one; a multiset match
    const got = lines(out)
      .map((l) => l.trim())
      .filter((l) => l.includes('-->'))
      .map((l) => {
        const m = decode(l).match(/^\w+ -->\|"([^"]*)"\| \w+$/);
        assert.ok(m, `${v.id}: edge line has the shape A -->|"label"| B: ${l}`);
        return m[1];
      })
      .sort();
    const want = viewEdges(v)
      .map((e) => (e.label ? `${e.type}: ${e.label}` : e.type))
      .sort();
    assert.deepEqual(got, want, `${v.id}: edge labels`);
  }
  // nested zones nest: zs-api is a child of zs-backend
  const api = toMermaidFlowchart(model, 'api-components');
  const depth = Math.max(0, ...(() => { let d = 0; return lines(api).map((l) => (l.trim().startsWith('subgraph ') ? ++d : l.trim() === 'end' ? --d : d)); })());
  assert.ok(depth >= 1);
  const sys = toMermaidFlowchart(model, 'system-context');
  let d = 0, max = 0;
  for (const l of lines(sys)) { const t = l.trim(); if (t.startsWith('subgraph ')) max = Math.max(max, ++d); else if (t === 'end') d--; }
  assert.ok(max >= 2, 'a child zone is a subgraph inside its parent zone subgraph');
});

test("x3 the erDiagram carries fields with type, PK/FK markers and crow's-foot cardinality", () => {
  const out = toMermaidER(model);
  assert.match(out, /^erDiagram\n/);
  const L = lines(out).map((l) => l.trim());
  assert.equal(L.filter((l) => /^\w+ \{$/.test(l)).length, model.entities.length);
  assert.ok(L.some((l) => /^INTEGER id PK$/.test(l)), 'a primary key is marked PK');
  assert.ok(L.some((l) => /\bcustomer_id\b.*\bFK\b/.test(l)), 'a relation field is marked FK');
  // 1-n puts the many end on the side that holds the key (`from`); n-m is many on both; 1-1 is one on both
  assert.ok(L.some((l) => /^customers \|\|--o\{ orders\b/.test(l)), '1-n: customers one, orders many');
  assert.ok(L.some((l) => /^order_lines \}o--o\{ stock_levels\b/.test(l)), 'n-m');
  assert.ok(L.some((l) => /^parcels \|\|--\|\| shipping_labels\b/.test(l)), '1-1');
  assert.equal(L.filter((l) => /\|\|--|\}o--/.test(l)).length, model.relations.length);
});

test('x4 the sequenceDiagram renders participants, messages, dashed returns, alt/else/end, loop, opt and notes', () => {
  for (const s of model.sequences) {
    const out = toMermaidSequence(model, s.id);
    assert.match(out, /^sequenceDiagram\n/);
    const L = lines(out).map((l) => l.trim());
    const count = (re) => L.filter((l) => re.test(l)).length;
    const frag = (k) => s.steps.filter((st) => st.frag === k).length;
    assert.equal(count(/^participant /), s.participants.length, `${s.id}: participants`);
    assert.equal(count(/^alt\b/), frag('alt'), `${s.id}: alt`);
    assert.equal(count(/^else\b/), frag('else'), `${s.id}: else`);
    assert.equal(count(/^opt\b/), frag('opt'), `${s.id}: opt`);
    assert.equal(count(/^loop\b/), frag('loop'), `${s.id}: loop`);
    assert.equal(count(/^end$/), frag('end'), `${s.id}: end`);
    const msgs = s.steps.filter((st) => st.m);
    assert.equal(count(/^\w+-->>\w+: /), msgs.filter((st) => st.ret !== undefined).length, `${s.id}: dashed returns`);
    assert.equal(count(/^\w+->>\w+: /), msgs.filter((st) => st.ret === undefined).length, `${s.id}: calls`);
    assert.equal(count(/^Note over /), s.steps.filter((st) => st.note).length, `${s.id}: notes`);
  }
  const po = lines(toMermaidSequence(model, 'place-order')).map((l) => l.trim());
  assert.ok(po.some((l) => l.startsWith('alt ') && decode(l).includes('token invalid or expired')));
  assert.ok(po.some((l) => l.startsWith('else ') && decode(l).includes('token valid')));
  assert.ok(po.some((l) => l.startsWith('loop ') && decode(l).includes('each order line')));
  assert.ok(po.some((l) => l.startsWith('opt ')));
  assert.ok(po.some((l) => /^\w+-->>\w+: /.test(l) && decode(l).includes('401 Unauthorized')));
  // a two-participant note spans both; a one-participant note sits over one
  assert.ok(po.some((l) => /^Note over \w+,\w+: /.test(l)));
  assert.ok(lines(toMermaidSequence(model, model.sequences.find((s) => s.steps.some((st) => st.note?.length === 1)).id)).some((l) => /^\s*Note over \w+: /.test(l)));
});

test('x5 no output contains an issue id or a step issue ref', () => {
  const ids = issues.issues.map((i) => i.id);
  const refs = model.sequences.flatMap((s) => s.steps.map((st) => st.i)).filter(Boolean);
  assert.ok(refs.length > 0, 'the golden model has step refs, so this case can fail');
  const p = place(model);
  const r = run([p.file, 'mermaid']);
  assert.equal(r.status, 0, r.stderr);
  for (const { f, text } of readAll(p.exports)) {
    for (const id of new Set([...ids, ...refs])) assert.ok(!text.includes(id), `${f} contains ${id}`);
    assert.ok(!/\bNF-\d+/.test(text), `${f} carries an issue-shaped id`);
  }
  // even a hostile-looking title that is an issue id in the model is the model's text; refs on steps are never read
  const m = clone(model);
  m.sequences[0].steps[0].i = 'ZZ-99';
  assert.ok(!toMermaidSequence(m, m.sequences[0].id).includes('ZZ-99'));
});

const HOSTILE = 'He said "hi" [x] {y} (z) | a; b #c <b>x</b> & more\nline2 %% end';
test('x6 model text is escaped for Mermaid: quotes, brackets, pipes, semicolons and newlines cannot break out', () => {
  const m = clone(model);
  const node = m.nodes[0];
  node.title = `${HOSTILE} a"]\nn_evil["pwned`;
  const edge = m.edges.find((e) => e.from === node.id) ?? m.edges[0];
  edge.label = HOSTILE;
  m.zones[0].label = HOSTILE;
  const seqm = m.sequences[0];
  const msg = seqm.steps.find((s) => s.m);
  msg.t = `${HOSTILE}\nNote over ${seqm.participants[0].id}: injected`;
  seqm.participants[0].label = HOSTILE;
  const ent = m.entities[0];
  ent.fields[1].name = 'we ird"; name';
  ent.fields[1].type = 'VAR CHAR(10)"';

  const outs = [];
  for (const v of m.views) outs.push(toMermaidFlowchart(m, v.id));
  outs.push(toMermaidER(m), toMermaidSequence(m, seqm.id));
  for (const out of outs) {
    assert.ok(!/#(?!\d+;)/.test(out), 'a # that is not an entity code');
    for (const l of lines(out)) {
      assert.ok(!/^\s*n_evil/.test(l), 'label text started a statement of its own');
      assert.ok(!l.includes('%%') || l.trim().startsWith('%%'), 'raw %% would start a comment');
    }
  }
  const flow = outs[m.views.findIndex((v) => viewNodes(v).some((n) => n.id === node.id))];
  const nodeLine = lines(flow).find((l) => /^\s*n_\w+\[/.test(l) && l.includes('He said'));
  assert.ok(nodeLine);
  const nm = nodeLine.match(/^\s*\w+\["([^"]*)"\]$/);
  assert.ok(nm, `the node label stays one quoted token: ${nodeLine}`);
  assert.ok(!/[\[\]|;<>{}]/.test(bare(nm[1])));
  assert.equal(decode(nm[1]), node.title, 'escaping is lossless');
  assert.ok(!lines(flow).some((l) => l.startsWith('line2')), 'a newline did not start a new line');

  const edgeLines = outs.slice(0, m.views.length).flatMap(lines).filter((l) => l.includes('-->') && l.includes('He said'));
  assert.ok(edgeLines.length > 0);
  for (const l of edgeLines) {
    const em = l.match(/^\s*\w+ -->\|"([^"]*)"\| \w+$/);
    assert.ok(em, `edge label stays one quoted token: ${l}`);
    assert.ok(!/[|;<>]/.test(bare(em[1])));
  }

  const sq = outs[outs.length - 1];
  const sl = lines(sq).map((l) => l.trim());
  assert.equal(sl.filter((l) => l.startsWith('Note over ')).length, seqm.steps.filter((s) => s.note).length, 'no injected note');
  const mline = sl.find((l) => /^\w+-?-?>>\w+: /.test(l) && l.includes('He said'));
  assert.ok(mline);
  assert.ok(!/[;<>]/.test(bare(mline.slice(mline.indexOf(': ')))), 'message text has no raw ; < >');
  assert.ok(!/[;"<>]/.test(bare(sl.find((l) => l.startsWith('participant ') && l.includes('He said')))));

  const er = outs[outs.length - 2];
  for (const l of lines(er).map((x) => x.trim())) {
    if (l === '' || /^[^\s{}]+ [^\s{}]+( (PK|FK|PK, FK))?$/.test(l) || /^\w+ \{$/.test(l) || l === '}' || l === 'erDiagram' || /\|\|--|\}o--/.test(l)) continue;
    assert.fail(`ER line is not a plain statement: ${l}`);
  }
  assert.ok(!/we ird|VAR CHAR/.test(er), 'field names and types are reduced to Mermaid-safe words');
});

test('x7 two runs give byte-identical files', () => {
  const a = fresh('a');
  const b = fresh('b');
  const p = place(model);
  assert.equal(run([p.file, 'mermaid', '--out', a]).status, 0);
  assert.equal(run([p.file, 'mermaid', '--out', b]).status, 0);
  assert.deepEqual(files(a), files(b));
  assert.ok(files(a).length > 0);
  for (const f of files(a)) assert.ok(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), `${f} differs between runs`);
  // the pure functions are deterministic too
  assert.equal(toMermaidER(model), toMermaidER(clone(model)));
});

test('x8 --view selects one view; an unknown view exits 2 and writes nothing', () => {
  const p = place(model);
  const ok = run([p.file, 'mermaid', '--view', 'api-components']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(files(p.exports), ['api-components.flowchart.mmd']);
  const q = place(model);
  const bad = run([q.file, 'mermaid', '--view', 'no-such-view']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no-such-view/);
  assert.deepEqual(files(q.exports), []);
});

test('x9 an invalid model is refused: exit 1, nothing written', () => {
  const m = clone(model);
  m.edges[0].to = 'no-such-node';
  const p = place(m);
  const r = run([p.file, 'mermaid']);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.ok(!existsSync(p.exports), 'the default exports dir was not even created');
  const out = fresh('out');
  assert.equal(run([p.file, 'mermaid', '--out', out]).status, 1);
  assert.deepEqual(files(out), []);
});

test('x10 usage errors and formats not yet implemented exit 2 and write nothing', () => {
  const p = place(model);
  for (const fmt of ['md', 'svg', 'png']) {
    const r = run([p.file, fmt]);
    assert.equal(r.status, 2, `${fmt}: ${r.stderr}`);
    assert.match(r.stderr, /not yet implemented/);
  }
  assert.equal(run([p.file, 'docx']).status, 2);
  assert.equal(run([p.file]).status, 2);
  assert.equal(run([]).status, 2);
  assert.equal(run([join(tmp, 'missing.json'), 'mermaid']).status, 2);
  assert.equal(run([p.file, 'mermaid', '--bogus']).status, 2);
  assert.equal(run([p.file, 'mermaid', '--out']).status, 2);
  assert.ok(!existsSync(p.exports));
});

test('x11 --out writes into that directory (created if missing)', () => {
  const p = place(model);
  const out = join(fresh('o'), 'deep', 'er');
  const r = run([p.file, 'mermaid', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(files(out).length, 14);
  assert.ok(!existsSync(p.exports));
});

test('x12 ids are sanitised to Mermaid-safe identifiers without collisions, and file names cannot leave the output dir', () => {
  const m = clone(model);
  const base = m.nodes.find((n) => n.zone === 'zb-web');
  const a = { ...clone(base), id: 'a-b', title: 'Alpha' };
  const b = { ...clone(base), id: 'a_b', title: 'Beta' };
  const c = { ...clone(base), id: 'end', title: 'Gamma' };
  m.nodes.push(a, b, c);
  m.views.push({ id: 'collide', title: 'Collide', nodes: ['a-b', 'a_b', 'end'], zones: ['zb-web'] });
  m.views.push({ id: '../escape me', title: 'Escape' });
  m.views.push({ id: '..-escape-me', title: 'Collides with the sanitised name' });
  const flow = toMermaidFlowchart(m, 'collide');
  const ids = lines(flow).map((l) => l.trim().match(/^(\w+)\["/)).filter(Boolean).map((x) => x[1]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, 'colliding ids stay distinct');
  for (const id of ids) assert.match(id, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.ok(!ids.includes('end'), 'the reserved word end is never an id');

  const p = place(m);
  const out = join(fresh('safe'), 'out');
  const r = run([p.file, 'mermaid', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const names = files(out);
  assert.equal(names.length, 14 + 3);
  for (const f of names) assert.match(f, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `unsafe file name ${f}`);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(files(dirname(out)).filter((f) => f !== 'out'), [], 'nothing written beside the output dir');
});

// ---- PlantUML (P7.2) ----
// Statements are one per line; model text sits after " : " or inside a quoted string. Lines are read back here.
const pumlFiles = (dir) => files(dir).filter((f) => f.endsWith('.puml'));
const ASYNC_TYPES = ['queue', 'event'];
// PlantUML draws <U+XXXX> as that character; reading a line back decodes it.
const decodeU = (s) => s.replace(/<U\+([0-9A-F]{4,6})>/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
const edgeText = (e) => (e.label ? `${e.type}: ${e.label}` : e.type);

test('x13 plantuml writes one component file per view, er.puml and one sequence file per sequence, each @startuml ... @enduml', () => {
  const p = place(model);
  const r = run([p.file, 'plantuml']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const expected = [
    ...model.views.map((v) => `${v.id}.component.puml`),
    'er.puml',
    ...model.sequences.map((s) => `${s.id}.sequence.puml`),
  ].sort();
  assert.deepEqual(files(p.exports), expected);
  assert.equal(expected.length, 6 + 1 + 7);
  for (const { f, text } of readAll(p.exports)) {
    assert.ok(text.startsWith('@startuml\n'), `${f} starts @startuml`);
    assert.ok(text.endsWith('\n@enduml\n'), `${f} ends @enduml`);
    assert.equal(lines(text).filter((l) => l.startsWith('@')).length, 2, `${f}: exactly one start and one end`);
  }
  // --view selects the one component file only
  const q = place(model);
  assert.equal(run([q.file, 'plantuml', '--view', 'api-components']).status, 0);
  assert.deepEqual(files(q.exports), ['api-components.component.puml']);
});

test('x14 the component diagram nests zones as packages, declares nodes as components and draws every edge labelled, async dashed', () => {
  for (const v of model.views) {
    const out = toPlantUmlComponent(model, v.id);
    assert.match(out, /^@startuml\n/);
    assert.match(out, /\n@enduml\n$/);
    const stack = [];
    const enclosing = new Map();
    const alias = new Map();
    for (const line of lines(out)) {
      const t = line.trim();
      let m;
      if ((m = t.match(/^package "(.*)" as \w+ \{$/))) stack.push(decodeU(m[1]));
      else if (t === '}') stack.pop();
      else if ((m = t.match(/^component "(.*)" as (\w+)$/))) { enclosing.set(decodeU(m[1]), stack[stack.length - 1]); alias.set(m[2], decodeU(m[1])); }
    }
    assert.equal(stack.length, 0, `${v.id}: every package is closed`);
    for (const n of viewNodes(v)) {
      const sub = enclosing.get(n.title);
      assert.ok(sub, `${v.id}: node ${n.id} is declared`);
      assert.ok(sub.includes(zoneById.get(n.zone).label), `${v.id}: ${n.id} sits in the package of zone ${n.zone}`);
    }
    assert.equal(new Set(alias.keys()).size, viewNodes(v).length, `${v.id}: one distinct alias per node`);
    // edges: `A --> B : text` or dashed `A ..> B : text`
    const arrows = lines(out).map((l) => l.trim()).filter((l) => /^\w+ (-->|\.\.>) \w+/.test(l));
    const want = viewEdges(v);
    assert.equal(arrows.length, want.length, `${v.id}: one arrow per edge`);
    const got = arrows.map((l) => { const m = l.match(/^(\w+) (-->|\.\.>) (\w+)(?: : (.*))?$/); assert.ok(m, l); return `${m[2]}|${decodeU(m[4] ?? '')}`; }).sort();
    const exp = want.map((e) => `${ASYNC_TYPES.includes(e.type) ? '..>' : '-->'}|${edgeText(e)}`).sort();
    assert.deepEqual(got, exp, `${v.id}: arrows, labels and dashing`);
  }
  assert.ok(toPlantUmlComponent(model, 'system-context').split('\n').filter((l) => l.trim().startsWith('package ')).length >= 2);
  assert.ok(model.views.some((v) => toPlantUmlComponent(model, v.id).includes(' ..> ')), 'a golden view has an async edge');
});

test("x15 the PlantUML ER carries entity blocks with fields, PK/FK markers and crow's-foot relations", () => {
  const out = toPlantUmlER(model);
  assert.match(out, /^@startuml\n/);
  assert.match(out, /\n@enduml\n$/);
  const L = lines(out).map((l) => l.trim());
  assert.equal(L.filter((l) => /^entity "[^"]*" as \w+ \{$/.test(l)).length, model.entities.length);
  assert.equal(L.filter((l) => l === '}').length, model.entities.length);
  assert.ok(L.some((l) => /^id : INTEGER <<PK>>$/.test(l)), 'a primary key is marked PK');
  assert.ok(L.some((l) => /^customer_id : \S+ <<FK>>$/.test(l)), 'a relation field is marked FK');
  assert.ok(L.some((l) => /^customers \|\|--o\{ orders\b/.test(l)), '1-n');
  assert.ok(L.some((l) => /^order_lines \}o--o\{ stock_levels\b/.test(l)), 'n-m');
  assert.ok(L.some((l) => /^parcels \|\|--\|\| shipping_labels\b/.test(l)), '1-1');
  assert.equal(L.filter((l) => /\|\|--|\}o--/.test(l)).length, model.relations.length);
  // inside a block there is one line per field and nothing else
  let inBlock = 0, fields = 0;
  for (const l of L) { if (/ \{$/.test(l)) inBlock = 1; else if (l === '}') inBlock = 0; else if (inBlock) fields++; }
  assert.equal(fields, model.entities.reduce((n, e) => n + e.fields.length, 0));
});

test('x16 the PlantUML sequence renders participants, messages, dashed returns, alt/else/opt/loop/end and notes', () => {
  for (const s of model.sequences) {
    const out = toPlantUmlSequence(model, s.id);
    assert.match(out, /^@startuml\n/);
    assert.match(out, /\n@enduml\n$/);
    const L = lines(out).map((l) => l.trim());
    const count = (re) => L.filter((l) => re.test(l)).length;
    const frag = (k) => s.steps.filter((st) => st.frag === k).length;
    assert.equal(count(/^participant /), s.participants.length, `${s.id}: participants`);
    assert.equal(count(/^alt\b/), frag('alt'), `${s.id}: alt`);
    assert.equal(count(/^else\b/), frag('else'), `${s.id}: else`);
    assert.equal(count(/^opt\b/), frag('opt'), `${s.id}: opt`);
    assert.equal(count(/^loop\b/), frag('loop'), `${s.id}: loop`);
    assert.equal(count(/^end$/), frag('end'), `${s.id}: end`);
    const msgs = s.steps.filter((st) => st.m);
    assert.equal(count(/^\w+ --> \w+ : /), msgs.filter((st) => st.ret !== undefined).length, `${s.id}: dashed returns`);
    assert.equal(count(/^\w+ -> \w+ : /), msgs.filter((st) => st.ret === undefined).length, `${s.id}: calls`);
    assert.equal(count(/^note over /), s.steps.filter((st) => st.note).length, `${s.id}: notes`);
  }
  const po = lines(toPlantUmlSequence(model, 'place-order')).map((l) => l.trim());
  assert.ok(po.some((l) => l.startsWith('alt ') && l.includes('token invalid or expired')));
  assert.ok(po.some((l) => l.startsWith('else ') && l.includes('token valid')));
  assert.ok(po.some((l) => l.startsWith('loop ') && l.includes('each order line')));
  assert.ok(po.some((l) => /^\w+ --> \w+ : /.test(l) && l.includes('401 Unauthorized')));
  assert.ok(po.some((l) => /^note over \w+, \w+ : /.test(l)), 'a two-participant note spans both');
  assert.ok(lines(toPlantUmlSequence(model, model.sequences.find((s) => s.steps.some((st) => st.note?.length === 1)).id)).some((l) => /^\s*note over \w+ : /.test(l)));
});

test('x17 no PlantUML output contains an issue id or a step issue ref, and two runs are byte-identical', () => {
  const ids = issues.issues.map((i) => i.id);
  const refs = model.sequences.flatMap((s) => s.steps.map((st) => st.i)).filter(Boolean);
  assert.ok(refs.length > 0);
  const a = fresh('pa');
  const b = fresh('pb');
  const p = place(model);
  assert.equal(run([p.file, 'plantuml', '--out', a]).status, 0);
  assert.equal(run([p.file, 'plantuml', '--out', b]).status, 0);
  assert.deepEqual(files(a), files(b));
  for (const { f, text } of readAll(a)) {
    for (const id of new Set([...ids, ...refs])) assert.ok(!text.includes(id), `${f} contains ${id}`);
    assert.ok(!/\bNF-\d+/.test(text), `${f} carries an issue-shaped id`);
    assert.ok(readFileSync(join(a, f)).equals(readFileSync(join(b, f))), `${f} differs between runs`);
  }
  assert.equal(toPlantUmlER(model), toPlantUmlER(clone(model)));
  const m = clone(model);
  m.sequences[0].steps[0].i = 'ZZ-99';
  assert.ok(!toPlantUmlSequence(m, m.sequences[0].id).includes('ZZ-99'));
});

const PUML_HOSTILE = 'He said "hi" [x] {y} (z) | a; b #c <b>x</b> <img:http://evil.example/x.png> <$sprite> %getenv("HOME") [[http://evil.example hot]] {{ ditaa }} /\' c \'/ & more\n@enduml\n!include /etc/passwd\n\'comment\n--> evil : x\nparticipant Evil';
test('x18 model text is escaped for PlantUML: newlines, directives, comments, macros, links and embedded images cannot break out', () => {
  const m = clone(model);
  const node = m.nodes[0];
  node.title = PUML_HOSTILE;
  const edge = m.edges.find((e) => e.from === node.id) ?? m.edges[0];
  edge.label = PUML_HOSTILE;
  m.zones[0].label = PUML_HOSTILE;
  const seqm = m.sequences[0];
  const msg = seqm.steps.find((s) => s.m);
  msg.t = `${PUML_HOSTILE}\nnote over ${seqm.participants[0].id} : injected`;
  seqm.participants[0].label = PUML_HOSTILE;
  seqm.steps.find((s) => s.frag === 'alt').t = PUML_HOSTILE;
  const nt = seqm.steps.find((s) => s.note);
  nt.t = PUML_HOSTILE;
  const ent = m.entities[0];
  ent.name = PUML_HOSTILE;
  ent.fields[1].name = 'we ird"; name\n@enduml';
  ent.fields[1].type = 'VAR CHAR(10)"\n!include x';

  const outs = [];
  for (const v of m.views) outs.push(toPlantUmlComponent(m, v.id));
  outs.push(toPlantUmlER(m), toPlantUmlSequence(m, seqm.id));
  for (const out of outs) {
    const L = lines(out);
    assert.equal(L[0], '@startuml');
    assert.equal(L[L.length - 2], '@enduml');
    assert.equal(L.filter((l) => l.trim().startsWith('@')).length, 2, 'only the two bookends start with @');
    for (const l of L) {
      const t = l.trim();
      assert.ok(!t.startsWith('!'), `a preprocessor directive: ${l}`);
      assert.ok(!t.startsWith("'") && !t.startsWith('/'), `a comment: ${l}`);
      assert.ok(!t.startsWith('-->') && !/^evil\b/.test(t), `an injected statement: ${l}`);
      assert.ok(t !== 'participant Evil', 'injected participant');
    }
    assert.ok(!out.includes("/'") && !out.includes("'/"), 'raw block-comment marker');
    assert.ok(!/<img|<\$|%getenv|\[\[|\{\{/i.test(out), 'embedded image, macro, link or inline diagram survived');
    const stripped = out.replace(/<<(PK|FK|PK, FK)>>/g, '').replace(/<U\+[0-9A-Fa-f]+>/g, '');
    assert.ok(!stripped.includes('<'), 'a raw < could open a creole/HTML tag');
  }
  const seqOut = outs[outs.length - 1];
  const sl = lines(seqOut).map((l) => l.trim());
  assert.equal(sl.filter((l) => l.startsWith('note over ')).length, seqm.steps.filter((s) => s.note).length, 'no injected note');
  assert.equal(sl.filter((l) => l.startsWith('participant ')).length, seqm.participants.length, 'no injected participant');
  assert.equal(sl.filter((l) => /^\w+ --?> \w+ : /.test(l)).length, seqm.steps.filter((s) => s.m).length, 'no injected message');
  assert.ok(sl.some((l) => l.includes('He said')), 'the text itself is kept');

  const er = lines(outs[outs.length - 2]).map((l) => l.trim());
  assert.equal(er.filter((l) => / \{$/.test(l)).length, m.entities.length, 'no injected entity block');
  assert.equal(er.filter((l) => l === '}').length, m.entities.length);

  const flow = outs[m.views.findIndex((v) => viewNodes(v).some((n) => n.id === node.id))];
  const nodeLines = lines(flow).filter((l) => /^\s*component "/.test(l) && l.includes('He said'));
  assert.equal(nodeLines.length, 1, 'the hostile title stays on one component line');
  assert.match(nodeLines[0].trim(), /^component "[^"]*" as \w+$/, 'the quoted title has no raw quote');
});

test('x19 PlantUML aliases are safe identifiers without collisions, and file names cannot leave the output dir', () => {
  const m = clone(model);
  const base = m.nodes.find((n) => n.zone === 'zb-web');
  m.nodes.push(
    { ...clone(base), id: 'a-b', title: 'Alpha' },
    { ...clone(base), id: 'a_b', title: 'Beta' },
    { ...clone(base), id: 'end', title: 'Gamma' },
    { ...clone(base), id: 'component', title: 'Delta' },
  );
  m.views.push({ id: 'collide', title: 'Collide', nodes: ['a-b', 'a_b', 'end', 'component'], zones: ['zb-web'] });
  m.views.push({ id: '../escape me', title: 'Escape' });
  m.views.push({ id: '..-escape-me', title: 'Collides with the sanitised name' });
  const out = toPlantUmlComponent(m, 'collide');
  const ids = lines(out).map((l) => l.trim().match(/^component "[^"]*" as (\w+)$/)).filter(Boolean).map((x) => x[1]);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4, 'colliding ids stay distinct');
  for (const id of ids) {
    assert.match(id, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.ok(!['end', 'component', 'package', 'participant', 'entity', 'note'].includes(id), `${id} is a PlantUML keyword`);
  }
  const p = place(m);
  const dir = join(fresh('psafe'), 'out');
  const r = run([p.file, 'plantuml', '--out', dir]);
  assert.equal(r.status, 0, r.stderr);
  const names = files(dir);
  assert.equal(names.length, 14 + 3);
  for (const f of names) assert.match(f, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `unsafe file name ${f}`);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(files(dirname(dir)).filter((f) => f !== 'out'), []);
  assert.equal(pumlFiles(dir).length, names.length, 'only .puml files are written');
});
