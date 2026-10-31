import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (a1, a2, ...) lead every title so the suite prints them first.
// The three agents are specified in docs/design.md sections 4, 6, 8 and decision D11.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const DESIGN = {
  'archmap-explorer': { model: 'sonnet', effort: 'medium', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'] },
  'archmap-synthesizer': { model: 'sonnet', effort: 'medium', tools: ['Read', 'Grep', 'Glob', 'Write'] },
  'archmap-reviewer': { model: 'opus', effort: 'high', tools: ['Read', 'Grep', 'Glob', 'Write'] },
};

function load(name) {
  const file = join(ROOT, 'agents', `${name}.md`);
  assert.ok(existsSync(file), `agents/${name}.md exists`);
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name} has frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, keys: Object.keys(fm), body: m[2] };
}

const toolList = (fm) => fm.tools.split(',').map((t) => t.trim()).filter(Boolean);

test('a1 each agent frontmatter has exactly the designed name, model, effort and tools', () => {
  for (const [name, want] of Object.entries(DESIGN)) {
    const { fm, keys } = load(name);
    assert.equal(fm.name, name);
    assert.equal(fm.model, want.model, `${name} model`);
    assert.equal(fm.effort, want.effort, `${name} effort`);
    assert.deepEqual(toolList(fm), want.tools, `${name} tools`);
    assert.ok(fm.description && fm.description.length > 40, `${name} has a real description`);
    assert.deepEqual([...keys].sort(), ['description', 'effort', 'model', 'name', 'tools'], `${name} frontmatter keys`);
  }
});

test('a2 no agent lists Edit or Agent; only the explorer, the synthesizer and the reviewer list Write (each for its one file); synthesizer and reviewer have no Bash', () => {
  const writers = ['archmap-explorer', 'archmap-synthesizer', 'archmap-reviewer'];
  for (const name of Object.keys(DESIGN)) {
    const tools = toolList(load(name).fm);
    for (const banned of writers.includes(name) ? ['Edit', 'Agent', 'NotebookEdit'] : ['Edit', 'Write', 'Agent', 'NotebookEdit']) {
      assert.ok(!tools.includes(banned), `${name} must not list ${banned}`);
    }
    if (name !== 'archmap-explorer') assert.ok(!tools.includes('Bash'), `${name} must not list Bash`);
  }
});

test('a3 each body names its input and output contract and the references it reads', () => {
  const refDir = join(ROOT, 'skills/architecture-map/references');
  const reads = {
    'archmap-explorer': ['model-schema.md', 'relation-taxonomy.md', 'discovery-generic.md'],
    'archmap-synthesizer': ['model-schema.md', 'relation-taxonomy.md', 'sequences.md'],
    'archmap-reviewer': ['model-schema.md', 'issues-catalog.md'],
  };
  for (const name of Object.keys(DESIGN)) {
    const { body } = load(name);
    assert.match(body, /^#+\s*Input\b/im, `${name} has an Input section`);
    assert.match(body, /^#+\s*Output\b/im, `${name} has an Output section`);
    assert.match(body, /^#+\s*References\b/im, `${name} has a References section`);
    for (const ref of reads[name]) {
      assert.ok(existsSync(join(refDir, ref)), `${ref} exists`);
      assert.ok(body.includes(ref), `${name} names ${ref}`);
    }
  }
  assert.match(load('archmap-explorer').body, /stack-(python|ts|node)/, 'explorer names the stack references');
  assert.match(load('archmap-explorer').body, /fragment/i);
  assert.match(load('archmap-explorer').body, /read-only|never execut/i);
  assert.match(load('archmap-synthesizer').body, /3-7|3 to 7/);
  assert.match(load('archmap-reviewer').body, /\bdetail\b[^.\n]*internal/i);
});

test('a4 explorer and model-schema state that a subtree coverage glob is dir/** and a bare directory matches only itself', () => {
  const docs = {
    'agents/archmap-explorer.md': readFileSync(join(ROOT, 'agents/archmap-explorer.md'), 'utf8'),
    'references/model-schema.md': readFileSync(join(ROOT, 'skills/architecture-map/references/model-schema.md'), 'utf8'),
  };
  for (const [name, text] of Object.entries(docs)) {
    const line = text.split('\n').find((l) => /bare director/i.test(l) && /literal/i.test(l) && /\/\*\*/.test(l));
    assert.ok(line, `${name} has a line naming dir/** and that a bare directory matches only its literal path`);
  }
});

test('a5 the explorer states its tool-call budget, writes the fragment to the path in its brief and replies with three lines only', () => {
  const { fm, body } = load('archmap-explorer');
  assert.ok(toolList(fm).includes('Write'), 'Write is in the explorer tools');
  assert.equal(fm.effort, 'medium');
  assert.match(body, /budget[^\n]*\b\d+ tool calls\b|\b\d+ tool calls\b[^\n]*budget/i, 'a numeric tool-call budget is stated');
  assert.match(body, /fragment path|path (named|given) in (the|your) (brief|prompt)/i, 'the fragment goes to the path the brief names');
  assert.match(body, /Write[^\n]*(only|one)[^\n]*(path|file)|(only|one)[^\n]*(path|file)[^\n]*Write/i, 'Write is limited to that one path');
  assert.match(body, /exactly three lines/i);
  for (const key of ['fragment:', 'counts:', 'tool calls:']) assert.ok(body.includes(key), `reply line ${key} is specified`);
  assert.match(body, /never (contains?|includes?|returns?)[^\n]*(fragment|JSON)|no JSON|not (the )?(fragment|JSON)/i, 'the reply never carries the fragment');
  assert.doesNotMatch(body, /re-requested|re-ask/i, 'no re-ask path');
  assert.match(body, /extract/i, 'the explorer starts from the extract file');
});

test('a6 the synthesizer reads the digest, states a read budget, writes only sequences, views, notes and conflicts to its synth path and adds no nodes, edges, entities or access rows', () => {
  const { fm, body } = load('archmap-synthesizer');
  assert.ok(toolList(fm).includes('Write'), 'Write is in the synthesizer tools');
  assert.match(body, /digest\.json/, 'its input is the digest');
  assert.doesNotMatch(body, /read(s)? the (merged )?model and (the )?fragments/i, 'it no longer loops over the model and fragments');
  assert.match(body, /(at most|no more than) \d+ (targeted )?(source )?reads/i, 'a numeric read budget is stated');
  assert.match(body, /synth path|path (named|given) in (the|your) (brief|prompt)/i, 'the result goes to the path the brief names');
  assert.match(body, /Write[^\n]*(only|one)[^\n]*(path|file)|(only|one)[^\n]*(path|file)[^\n]*Write/i, 'Write is limited to that one path');
  assert.match(body, /exactly three lines/i);
  for (const key of ['synth:', 'counts:', 'tool calls:']) assert.ok(body.includes(key), `reply line ${key} is specified`);
  // the output object has exactly the four keys
  const block = /```json\n([\s\S]*?)\n```/.exec(body);
  assert.ok(block, 'an output example in a json block');
  assert.deepEqual(Object.keys(JSON.parse(block[1])).sort(), ['conflicts', 'notes', 'sequences', 'views']);
  for (const kind of ['nodes', 'edges', 'entities', 'access']) {
    assert.match(body, new RegExp(`(never|not|no|may not)[^\\n.]*\\b${kind}\\b`, 'i'), `forbids adding ${kind}`);
  }
  assert.match(body, /draft/i, 'it confirms the pre-drafted sequences');
  assert.match(body, /3-7|3 to 7/);
});

test('a7 the explorer runs at medium effort, states the coverage floor rule and the minimum of 6 tool calls, and keeps Write for the fragment path only', () => {
  const { fm, body } = load('archmap-explorer');
  assert.equal(fm.effort, 'medium');
  assert.match(body, /coverage floor/i, 'the coverage floor is named');
  assert.match(body, /(fewer|less) nodes than (the|its) (coverage )?floor[^\n]*incomplete|under (the|its) (coverage )?floor[^\n]*incomplete/i, 'a fragment under the floor is incomplete');
  assert.match(body, /at least 6\b[^\n]*tool calls|tool calls[^\n]*at least 6\b/i, 'at least 6 tool calls');
  assert.match(body, /at most 20\b|\b20 tool calls/i, 'at most 20 tool calls');
  assert.match(body, /one node per[^\n]*(feature director|router|handler)/i, 'one node per feature directory or router module');
  assert.match(body, /Write[^\n]*(only|one)[^\n]*(path|file)|(only|one)[^\n]*(path|file)[^\n]*Write/i, 'Write is limited to the fragment path');
  assert.doesNotMatch(body, /transcribe (it|the extract)\b|do not re-derive the rest/i, 'it no longer tells the explorer to stop at the extract');
});

test('a8 the explorer reads the summary, not the full extract, and never transcribes tables: entities, relations and queue edges are made by merge.mjs', () => {
  const { fm, body } = load('archmap-explorer');
  assert.match(body, /extracts\/<area>\.summary\.json/, 'the summary path is named');
  assert.match(body, /(not|never)[^\n.]*\bfull extract\b/i, 'it does not read the full extract');
  assert.match(body, /(never|do not|don't) transcribe[^\n.]*\btables\b/i, 'tables are not transcribed');
  assert.match(body, /entities, relations and queue edges[^\n.]*\b(script|merge\.mjs)\b/i, 'who makes them is said');
  assert.match(fm.description, /summary/i, 'the description says the explorer starts from the summary');
});

// P10.12: the reviewer writes its file like the other agents, and a step merge cannot place is never re-asked.
test('a9 the reviewer has Write for the path in its brief only, writes its object there and replies with exactly three lines; the brief render prints names the catalogue by absolute path', () => {
  const { fm, body } = load('archmap-reviewer');
  assert.ok(toolList(fm).includes('Write'), 'Write is in the reviewer tools');
  for (const banned of ['Edit', 'Agent', 'Bash', 'NotebookEdit']) assert.ok(!toolList(fm).includes(banned), `no ${banned}`);
  assert.match(body, /path (named|given) in (the|your) (brief|prompt)|reviewer path|<work>\/reviewer\.json/i, 'the result goes to the path the brief names');
  assert.match(body, /Write[^\n]*(only|one)[^\n]*(path|file)|(only|one)[^\n]*(path|file)[^\n]*Write/i, 'Write is limited to that one path');
  assert.match(body, /exactly three lines/i);
  for (const key of ['reviewer:', 'counts:', 'tool calls:']) assert.ok(body.includes(key), `reply line ${key} is specified`);
  assert.match(body, /never (contains?|includes?|returns?)[^\n]*(issues|JSON)|no JSON|not (the )?(issues|JSON)/i, 'the reply never carries the object');
  assert.doesNotMatch(body, /You have no write tools|the caller writes it/i, 'the old return-the-JSON contract is gone');
  assert.doesNotMatch(body, /re-requested|re-ask/i, 'no re-ask path');
  assert.match(body, /absolute path|path (named|given) in (the|your) (brief|prompt)/i, 'references are read by the paths the brief gives');
  const block = /```json\n([\s\S]*?)\n```/.exec(body);
  assert.ok(block, 'an output example in a json block');
  assert.deepEqual(Object.keys(JSON.parse(block[1])).sort(), ['import', 'issues', 'unreviewed']);
});

test('a10 the synthesizer says a step merge cannot place is dropped and recorded, never re-asked', () => {
  const { body } = load('archmap-synthesizer');
  assert.match(body, /step[^\n.]*(merge|script)[^\n.]*(cannot|can't|can not) place[^\n.]*(dropped|drops)|(dropped|drops)[^\n.]*step[^\n.]*(merge|script)[^\n.]*(cannot|can't|can not) place/i, 'a step merge cannot place is dropped');
  assert.match(body, /never (re-?asked|asked again|sent back)|not (re-?asked|asked again|sent back)|is never asked again/i, 'never asked again');
  assert.match(body, /step grammar|sequences\.md/i);
});

// P10.13: the script makes the tables the summary lists, but a table, dataset or collection it lacks is the explorer's to add.
test('a10 the explorer adds the entities the summary lacks, each with evidence, and never re-lists the ones the summary shows', () => {
  const { body } = load('archmap-explorer');
  assert.match(body, /add (an )?entit(y|ies)[^\n.]*(summary|prescan)[^\n.]*(lacks|does not list|doesn't list|missing)/i, 'it adds entities the summary lacks');
  assert.match(body, /\b(tables|datasets|collections)\b[^\n]*\b(tables|datasets|collections)\b/i, 'tables, datasets or collections');
  assert.match(body, /evidence/i);
  assert.match(body, /(never|do not|don't) (re-list|list again|transcribe)[^\n.]*(summary|shows|lists)/i, 'the listed ones are not re-listed');
  assert.match(body, /entities, relations and queue edges[^\n.]*\b(script|merge\.mjs)\b/i, 'the script still makes the rest');
});
