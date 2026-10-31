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

// P11.1: eval 2 missed four medium reference issues in every run because the reviewer only opened code to confirm
// what the model already suggested. Each pattern now names the reads it must make, and the loading-state pattern,
// which had no entry, has one.
const targetedReads = (p) => /\*\*Targeted reads?:\*\*[ \t]*(\S[^\n]*)/.exec(p.body)?.[1].trim();

test('i5 the catalogue has a readiness and loading-state pattern in the design category, medium by default, whose targeted read is the client\'s health or readiness call', () => {
  const p = patterns.filter((x) => /loading[- ]state/i.test(x.heading) && /readiness/i.test(x.heading));
  assert.equal(p.length, 1, `one readiness and loading-state pattern, got: ${patterns.map((x) => x.heading).join(' | ')}`);
  assert.match(p[0].body, /\*\*Category:\*\*\s*design\b/);
  assert.match(p[0].body, /\*\*Severity:\*\*\s*med\b/);
  assert.match(p[0].body, /retry/i, 'the pattern covers the missing retry, not only the missing spinner');
  assert.match(targetedReads(p[0]) ?? '', /health|readiness/i, 'the read is the client\'s health or readiness call');
});

test('i6 every pattern names at least one targeted read, and between them they cover exception handlers, process-environment writes, the loop around a bulk pull and the readiness call', () => {
  assert.ok(patterns.length >= 12, `the 11 seeds and the loading-state pattern, got ${patterns.length}`);
  const missing = patterns.filter((p) => !targetedReads(p)).map((p) => p.heading);
  assert.deepEqual(missing, [], 'patterns with no **Targeted reads:** line');
  const all = patterns.map(targetedReads).join('\n');
  assert.match(all, /exception handler|except(ion)? (clause|block)|catch/i, 'the entry point\'s exception handlers');
  assert.match(all, /process\.env|os\.environ|process environment/i, 'writes to the process environment');
  assert.match(all, /loop[^\n]*(bulk|full|every|all)|(bulk|full)[^\n]*loop/i, 'the loop around a bulk pull');
  assert.match(all, /health|readiness/i, 'the client\'s health or readiness call');
  // the reads are made whether or not the model already raised a suspicion
  assert.match(catalog, /targeted reads?[^\n]*(whether or not|even when|not only to confirm|before)/i);
});
