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
