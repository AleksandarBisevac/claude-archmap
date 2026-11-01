import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (b1..b4) lead every title so the suite prints them first.
// The benchmark document records which comparable plugins the release-1.0.0 benchmark runs against.
// This file parses it; it never contacts the network and has no dependencies.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CANDIDATES = join(ROOT, 'skills', 'architecture-map', 'evals', 'benchmark', 'CANDIDATES.md');

const load = () => {
  assert.ok(existsSync(CANDIDATES), 'CANDIDATES.md is missing');
  return readFileSync(CANDIDATES, 'utf8');
};

// The body of the "## <title>" section, up to the next "## " heading (or the end).
function section(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${title}`.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const bullets = (body) => body.split('\n').filter((l) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(l));

// First markdown table of the body: { header: [...], rows: [[...], ...] }.
function table(body) {
  const lines = body.split('\n').map((l) => l.trim());
  const first = lines.findIndex((l) => l.startsWith('|'));
  if (first === -1) return null;
  const block = [];
  for (let i = first; i < lines.length && lines[i].startsWith('|'); i++) block.push(lines[i]);
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [head, rule, ...rows] = block;
  if (!rule || !/^\|?\s*:?-{3,}/.test(rule)) return null;
  return { header: cells(head), rows: rows.map(cells) };
}

const column = (t, name) => {
  const i = t.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  assert.ok(i !== -1, `column ${name} is missing from [${t.header.join(', ')}]`);
  return t.rows.map((r) => r[i] ?? '');
};

test('b1 CANDIDATES.md has a Selection criteria section with at least three bullets', () => {
  const body = section(load(), 'Selection criteria');
  assert.notEqual(body, null, 'no "## Selection criteria" section');
  assert.ok(bullets(body).length >= 3, `only ${bullets(body).length} bullet(s)`);
});

test('b2 the candidates table has Name, Source, Version, Install, Output and two or more rows', () => {
  const body = section(load(), 'Candidates');
  assert.notEqual(body, null, 'no "## Candidates" section');
  const t = table(body);
  assert.notEqual(t, null, 'no table in the Candidates section');
  for (const h of ['Name', 'Source', 'Version', 'Install', 'Output']) {
    assert.ok(t.header.some((c) => c.toLowerCase() === h.toLowerCase()), `column ${h} missing`);
  }
  assert.ok(t.rows.length >= 2, `only ${t.rows.length} row(s)`);
  for (const [col, cells] of ['Name', 'Version', 'Output'].map((c) => [c, column(t, c)])) {
    cells.forEach((v, i) => assert.ok(v !== '', `row ${i + 1}: empty ${col} cell`));
  }
  const names = column(t, 'Name');
  assert.equal(new Set(names).size, names.length, 'duplicate candidate names');
  column(t, 'Source').forEach((v, i) =>
    assert.match(v, /^<?https:\/\/[^\s<>]+>?$/, `row ${i + 1}: Source is not a URL: ${v}`));
  column(t, 'Install').forEach((v, i) => {
    const code = [...v.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(code.length >= 1, `row ${i + 1}: Install has no inline command`);
    assert.ok(code.some((c) => /\bclaude\b.*(plugin|--plugin-dir)/.test(c)),
      `row ${i + 1}: Install carries no claude plugin command`);
  });
});

test('b3 Considered and rejected has at least one row and each row names one of the selection criteria', () => {
  const text = load();
  const criteria = bullets(section(text, 'Selection criteria') ?? '')
    .map((l) => (l.match(/\*\*([^*]+)\*\*/) ?? [])[1])
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  assert.ok(criteria.length >= 3, 'selection criteria bullets must each start with a bold label');
  const body = section(text, 'Considered and rejected');
  assert.notEqual(body, null, 'no "## Considered and rejected" section');
  const t = table(body);
  assert.notEqual(t, null, 'no table in the rejected section');
  assert.ok(t.rows.length >= 1, 'no rejected row');
  const named = column(t, 'Criterion');
  named.forEach((v, i) =>
    assert.ok(criteria.some((c) => v.toLowerCase().includes(c)),
      `row ${i + 1}: Criterion "${v}" names none of: ${criteria.join(', ')}`));
});

test('b4 the document is public: no machine path, home directory or environment-specific location', () => {
  const text = load();
  for (const re of [/\/Users\/\S/, /\/home\/\S/, /\/private\/\S/, /\/tmp\/\S/, /[A-Za-z]:\\\\?\S/, /~\//, /\.private\b/]) {
    assert.doesNotMatch(text, re, `matches ${re}`);
  }
});

// ---- P12.2: the protocol documents (prompt.md, PROTOCOL.md, rubric.md) ----
const DIR = join(ROOT, 'skills', 'architecture-map', 'evals', 'benchmark');
const DENYLIST = join(ROOT, '.private', 'anonymise-denylist.txt');
const loadDoc = (name) => {
  const file = join(DIR, name);
  assert.ok(existsSync(file), `${name} is missing`);
  return readFileSync(file, 'utf8');
};
const denyTerms = () =>
  readFileSync(DENYLIST, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.toLowerCase());
// Reports term indexes only, never a term.
function denylistHits(text) {
  const low = text.toLowerCase();
  return denyTerms().flatMap((t, i) => (low.includes(t) ? [`term #${i + 1}`] : []));
}
const candidateNames = () =>
  column(table(section(load(), 'Candidates')), 'Name').map((n) => n.replace(/`/g, '').trim());

const REPOS = {
  A: 'a Python API with a React front end and an embedded analytical database',
  B: 'a TypeScript monorepo with a Node API, an ORM and a job queue',
  C: 'a Next.js application with an admin API',
};
const ENV_VARS = ['ARCHMAP_EVAL_REPO_A', 'ARCHMAP_EVAL_REPO_B', 'ARCHMAP_EVAL_REPO_C'];

test('b5 prompt.md names no slash command, no candidate and not this plugin, and carries the placeholder for the repository variable', () => {
  const text = loadDoc('prompt.md');
  assert.doesNotMatch(text, /(^|[\s`(])\/[A-Za-z]/, 'a slash command appears');
  for (const n of candidateNames()) {
    assert.ok(!text.toLowerCase().includes(n.toLowerCase()), `prompt.md names ${n}`);
  }
  // Word boundaries: the required sentence says "architecture-mapping", which is not the skill name.
  assert.doesNotMatch(text, /\barchmap\b/i, 'prompt.md names archmap');
  assert.doesNotMatch(text, /\barchitecture-map\b/i, 'prompt.md names architecture-map');
  assert.ok(candidateNames().length >= 2, 'no candidate names were read');
  assert.match(text, /<ENV_NAME>/, 'the <ENV_NAME> placeholder is missing');
  assert.match(text, /architecture-mapping plugin installed in this session/);
  for (const re of [/component/i, /relation/i, /entit/i, /field/i, /three/i, /sequence/i, /file reference/i, /docs\/architecture/, /summary/i]) {
    assert.match(text, re, `prompt.md lacks ${re}`);
  }
  for (const v of ENV_VARS) assert.doesNotMatch(text, new RegExp(v), 'the prompt is substituted per cell, so it names no variable');
});

test('b6 PROTOCOL.md has the six sections, the Metrics section names every metric and the three variables are documented', () => {
  const text = loadDoc('PROTOCOL.md');
  for (const s of ['Repositories', 'Configurations', 'Metrics', 'Expectations', 'Limits', 'Evidence']) {
    const body = section(text, s);
    assert.notEqual(body, null, `no "## ${s}" section`);
    assert.ok(body.trim().length > 40, `section ${s} is empty`);
  }
  const metrics = section(text, 'Metrics').toLowerCase();
  for (const m of ['cost', 'duration', 'turns', 'context', 'pass rate', 'recall', 'rubric']) {
    assert.ok(metrics.includes(m), `Metrics does not name ${m}`);
  }
  for (const v of ENV_VARS) assert.ok(text.includes(v), `PROTOCOL.md does not name ${v}`);
  assert.ok(text.includes('<ENV_NAME>'), 'PROTOCOL.md does not document the placeholder');
  assert.match(text, /not graded/i);
});

test('b7 the repositories are described only by the three generic descriptions and no denylist term appears (skipped when the list is absent)', (t) => {
  const text = loadDoc('PROTOCOL.md');
  const body = section(text, 'Repositories');
  assert.notEqual(body, null, 'no "## Repositories" section');
  const rows = bullets(body);
  assert.equal(rows.length, 3, `expected three repository bullets, saw ${rows.length}`);
  ['A', 'B', 'C'].forEach((letter, i) => {
    assert.ok(rows[i].includes(`(${letter})`), `bullet ${i + 1} is not repository ${letter}`);
    assert.ok(rows[i].includes(REPOS[letter]), `repository ${letter} is not the generic description`);
  });
  if (!existsSync(DENYLIST)) {
    t.skip('denylist not checked: .private/anonymise-denylist.txt is absent');
    return;
  }
  for (const f of ['prompt.md', 'PROTOCOL.md', 'rubric.md']) {
    assert.deepEqual(denylistHits(loadDoc(f)), [], `${f} carries a denylist term`);
  }
});

test('b8 rubric.md has four axes, each with five levels numbered 1 to 5', () => {
  const text = loadDoc('rubric.md');
  const axes = text.split(/\r?\n/).filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, ''));
  assert.equal(axes.length, 4, `expected four axes, saw ${axes.length}`);
  for (const [i, re] of [/coverage/i, /correctness/i, /usefulness/i, /readability/i].entries()) {
    assert.match(axes[i], re, `axis ${i + 1} is "${axes[i]}"`);
  }
  for (const a of axes) {
    const lv = bullets(section(text, a));
    assert.equal(lv.length, 5, `${a}: ${lv.length} level(s)`);
    lv.forEach((l, i) => assert.match(l, new RegExp(`^\\s*${5 - i}\\.\\s+\\S`), `${a}: level line ${i + 1} should start "${5 - i}."`));
  }
});

test('b9 the protocol documents are public: no machine path, home directory or drive path', () => {
  for (const f of ['prompt.md', 'PROTOCOL.md', 'rubric.md']) {
    const text = loadDoc(f);
    for (const re of [/\/Users\/\S/, /\/home\/\S/, /\/private\/\S/, /\/tmp\/\S/, /[A-Za-z]:\\\\?\S/, /~\//]) {
      assert.doesNotMatch(text, re, `${f} matches ${re}`);
    }
  }
});
