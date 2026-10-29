import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (u1, u2, ...) lead every title so the suite prints them first.
const CLI = fileURLToPath(new URL('../scripts/usage.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'archmap-usage-'));
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const rows = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const add = (ledger, ...args) => {
  const r = run(['add', ledger, ...args]);
  assert.equal(r.status, 0, r.stderr);
  return r;
};

test('u1 add appends one JSONL row per call, creating the ledger, and records a 0-token script as 0', () => {
  const ledger = join(tmp(), 'ledger.jsonl');
  add(ledger, '--phase', 'prescan', '--tokens', '0', '--duration-ms', '120');
  add(ledger, '--phase', 'explorer', '--label', 'api', '--agent', 'archmap-explorer', '--model', 'sonnet', '--tokens', '5000', '--duration-ms', '42000');
  assert.ok(existsSync(ledger));
  assert.equal(readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length, 2);
  const [a, b] = rows(ledger);
  assert.deepEqual(a, { phase: 'prescan', tokens: 0, durationMs: 120 });
  assert.deepEqual(b, {
    phase: 'explorer', label: 'api', agent: 'archmap-explorer', model: 'sonnet', tokens: 5000, durationMs: 42000,
  });
});

test('u2 print groups rows by phase in pipeline order with token and duration totals', () => {
  const ledger = join(tmp(), 'l.jsonl');
  add(ledger, '--phase', 'reviewer', '--tokens', '900', '--duration-ms', '3000');
  add(ledger, '--phase', 'explorer', '--label', 'api', '--tokens', '1000', '--duration-ms', '2000');
  add(ledger, '--phase', 'explorer', '--label', 'web', '--tokens', '2500', '--duration-ms', '4000');
  add(ledger, '--phase', 'prescan', '--tokens', '0', '--duration-ms', '50');
  const j = JSON.parse(run(['print', ledger, '--json']).stdout);
  assert.deepEqual(j.phases.map((p) => p.phase), ['prescan', 'explorer', 'reviewer']);
  const ex = j.phases.find((p) => p.phase === 'explorer');
  assert.equal(ex.rows, 2);
  assert.equal(ex.tokens, 3500);
  assert.equal(ex.durationMs, 6000);
  assert.deepEqual(j.total, {
    rows: 4, tokens: 4400, durationMs: 9050, unknownTokens: 0, unknownDuration: 0,
  });
  const text = run(['print', ledger]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /explorer\s+2\s+3500\s+6\.0s/);
  assert.match(text.stdout, /total\s+4\s+4400\s+9\.1s/);
});

test('u3 a row without tokens prints unknown and is counted as unknown in the total, never summed as 0', () => {
  const ledger = join(tmp(), 'l.jsonl');
  add(ledger, '--phase', 'explorer', '--label', 'api', '--tokens', '1000', '--duration-ms', '2000');
  add(ledger, '--phase', 'explorer', '--label', 'web', '--duration-ms', '3000');
  add(ledger, '--phase', 'synthesizer');
  const j = JSON.parse(run(['print', ledger, '--json']).stdout);
  const ex = j.phases.find((p) => p.phase === 'explorer');
  assert.equal(ex.tokens, 1000);
  assert.equal(ex.unknownTokens, 1);
  const syn = j.phases.find((p) => p.phase === 'synthesizer');
  assert.equal(syn.tokens, null);
  assert.equal(syn.durationMs, null);
  assert.equal(j.total.tokens, 1000);
  assert.equal(j.total.unknownTokens, 2);
  assert.equal(j.total.unknownDuration, 1);
  const text = run(['print', ledger]).stdout;
  assert.match(text, /synthesizer\s+1\s+unknown\s+unknown/);
  assert.match(text, /explorer\s+2\s+1000 \+ 1 unknown/);
  assert.match(text, /total\s+3\s+1000 \+ 2 unknown/);
  assert.match(text, /2 of 3 rows have unknown tokens/);
  assert.doesNotMatch(text, /synthesizer\s+1\s+0\b/);
});

test('u4 --json output is stable: same ledger, byte-identical output, fixed key order', () => {
  const ledger = join(tmp(), 'l.jsonl');
  add(ledger, '--phase', 'merge', '--tokens', '0', '--duration-ms', '10');
  add(ledger, '--phase', 'layout', '--duration-ms', '20');
  const a = run(['print', ledger, '--json']);
  const b = run(['print', ledger, '--json']);
  assert.equal(a.stdout, b.stdout);
  const j = JSON.parse(a.stdout);
  assert.deepEqual(Object.keys(j), ['phases', 'total']);
  assert.deepEqual(Object.keys(j.phases[0]), ['phase', 'rows', 'tokens', 'durationMs', 'unknownTokens', 'unknownDuration']);
  assert.equal(a.stdout.endsWith('\n'), true);
  assert.equal(run(['print', ledger]).stdout, run(['print', ledger]).stdout);
});

test('u5 print of an empty or missing-phase ledger and an unknown figure never shows 0 for a missing value', () => {
  const dir = tmp();
  const ledger = join(dir, 'l.jsonl');
  writeFileSync(ledger, '');
  const j = JSON.parse(run(['print', ledger, '--json']).stdout);
  assert.deepEqual(j.phases, []);
  assert.deepEqual(j.total, { rows: 0, tokens: null, durationMs: null, unknownTokens: 0, unknownDuration: 0 });
});

test('u6 usage errors and an unreadable ledger exit 2 with a message on stderr', () => {
  const dir = tmp();
  const ledger = join(dir, 'l.jsonl');
  const cases = [
    [],
    ['bogus', ledger],
    ['add', ledger],
    ['add', ledger, '--phase', 'nonsense'],
    ['add', ledger, '--phase', 'explorer', '--tokens', 'abc'],
    ['add', ledger, '--phase', 'explorer', '--tokens', '-3'],
    ['add', ledger, '--phase', 'explorer', '--duration-ms', '1.5'],
    ['add', ledger, '--phase', 'explorer', '--wat', '1'],
    ['add', ledger, '--phase'],
    ['print'],
    ['print', join(dir, 'missing.jsonl')],
  ];
  for (const args of cases) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(' ')} -> ${r.status}`);
    assert.notEqual(r.stderr.trim(), '');
  }
  assert.equal(existsSync(ledger), false, 'a rejected add writes nothing');
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{"phase":"explorer"}\nnot json\n');
  assert.equal(run(['print', bad]).status, 2);
  writeFileSync(bad, '{"phase":"nope"}\n');
  assert.equal(run(['print', bad]).status, 2);
});
