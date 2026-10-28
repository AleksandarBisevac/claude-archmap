import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (i1, i2, ...) lead every title so the suite prints them first.
// issues-catalog.md generalises the docs/design.md section 11 seeds for the archmap-reviewer agent (D4).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DENYLIST = join(ROOT, '.private', 'anonymise-denylist.txt');
const catalog = readFileSync(join(ROOT, 'skills/architecture-map/references/issues-catalog.md'), 'utf8');
const schema = JSON.parse(readFileSync(join(ROOT, 'schema/archmap-issues.schema.json'), 'utf8'));
const issueProps = schema.$defs.issue.properties;

const tokenRe = (name) =>
  new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i');

// A pattern is a "### " heading and everything up to the next heading.
const patterns = catalog
  .split(/^(?=### )/m)
  .filter((s) => s.startsWith('### '))
  .map((s) => ({ heading: s.split('\n')[0], body: s }));

test('i1 every category and severity enum value of the issues schema is used in the catalogue', () => {
  const missing = [...issueProps.category.enum, ...issueProps.sev.enum].filter((v) => !tokenRe(v).test(catalog));
  assert.deepEqual(missing, []);
  // Each category is actually the category of at least one pattern, each severity the default of one.
  for (const c of issueProps.category.enum) {
    assert.ok(patterns.some((p) => new RegExp(`\\*\\*Category:\\*\\*\\s*${c}\\b`).test(p.body)), `category ${c} has a pattern`);
  }
  for (const s of issueProps.sev.enum) {
    assert.ok(patterns.some((p) => new RegExp(`\\*\\*Severity:\\*\\*\\s*${s}\\b`).test(p.body)), `severity ${s} is a default`);
  }
});

test('i2 every pattern names an anchor kind (node|edge|entity|step), a category and a default severity', () => {
  assert.ok(patterns.length >= 11, `at least the 11 seeds are generalised, got ${patterns.length}`);
  const bad = [];
  for (const p of patterns) {
    const a = /\*\*Anchor:\*\*\s*`?(node|edge|entity|step)\b/.exec(p.body);
    const c = /\*\*Category:\*\*\s*(security|data|reliability|performance|design|docs)\b/.exec(p.body);
    const s = /\*\*Severity:\*\*\s*(high|med|low)\b/.exec(p.body);
    if (!a || !c || !s) bad.push(p.heading);
  }
  assert.deepEqual(bad, []);
});

test('i3 the catalogue states the calibration rule and the audit import shapes', () => {
  assert.match(catalog, /\bdetail\b[^.\n]*internal/i);
  assert.match(catalog, /summary/i);
  assert.match(catalog, /impact/i);
  assert.match(catalog, /shared build/i);
  assert.match(catalog, /bugs\[\]/);
  assert.match(catalog, /phases\[\]\.review\.findings\[\]/);
  assert.match(catalog, /legacy string/i);
  assert.match(catalog, /source[^.\n]*audit/i);
  assert.match(catalog, /architecture-level/i);
  assert.match(catalog, /line-level/i);
});

test('i4 the catalogue carries no absolute home paths and no denylist term (index only; skipped visibly when the list is absent)', (t) => {
  assert.doesNotMatch(catalog, /\/Users\/|\/home\/[a-z]|[A-Z]:\\Users\\/);
  if (!existsSync(DENYLIST)) {
    t.skip('denylist not checked: .private/anonymise-denylist.txt is absent');
    return;
  }
  const terms = readFileSync(DENYLIST, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
  const lower = catalog.toLowerCase();
  const hits = terms.flatMap((term, i) => (lower.includes(term) ? [`term #${i + 1}`] : []));
  assert.deepEqual(hits, []);
});
