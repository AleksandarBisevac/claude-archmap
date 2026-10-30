import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (a1, a2, ...) lead every title so the suite prints them first.
// The three agents are specified in docs/design.md sections 4, 6, 8 and decision D11.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const DESIGN = {
  'archmap-explorer': { model: 'sonnet', effort: 'low', tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'] },
  'archmap-synthesizer': { model: 'opus', effort: 'high', tools: ['Read', 'Grep', 'Glob'] },
  'archmap-reviewer': { model: 'opus', effort: 'high', tools: ['Read', 'Grep', 'Glob'] },
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

test('a2 no agent lists Edit or Agent; only the explorer lists Write (for its one fragment file); synthesizer and reviewer have no Bash', () => {
  for (const name of Object.keys(DESIGN)) {
    const tools = toolList(load(name).fm);
    for (const banned of name === 'archmap-explorer' ? ['Edit', 'Agent', 'NotebookEdit'] : ['Edit', 'Write', 'Agent', 'NotebookEdit']) {
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
  assert.equal(fm.effort, 'low');
  assert.match(body, /budget[^\n]*\b\d+ tool calls\b|\b\d+ tool calls\b[^\n]*budget/i, 'a numeric tool-call budget is stated');
  assert.match(body, /fragment path|path (named|given) in (the|your) (brief|prompt)/i, 'the fragment goes to the path the brief names');
  assert.match(body, /Write[^\n]*(only|one)[^\n]*(path|file)|(only|one)[^\n]*(path|file)[^\n]*Write/i, 'Write is limited to that one path');
  assert.match(body, /exactly three lines/i);
  for (const key of ['fragment:', 'counts:', 'tool calls:']) assert.ok(body.includes(key), `reply line ${key} is specified`);
  assert.match(body, /never (contains?|includes?|returns?)[^\n]*(fragment|JSON)|no JSON|not (the )?(fragment|JSON)/i, 'the reply never carries the fragment');
  assert.doesNotMatch(body, /re-requested|re-ask/i, 'no re-ask path');
  assert.match(body, /extract/i, 'the explorer starts from the extract file');
});
