import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (c1, c2, ...) lead every title so the suite prints them first.
const CLI = fileURLToPath(new URL('../scripts/cost-profile.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/cost/stream-sample.jsonl', import.meta.url));
const expected = JSON.parse(readFileSync(new URL('./fixtures/cost/expected.json', import.meta.url), 'utf8'));
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const profile = (...files) => {
  const r = run([...files, '--json']);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const events = () => readFileSync(SAMPLE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const CLASSES = ['input', 'output', 'cacheRead', 'cacheWrite'];

test('c1 per-model totals equal the LAST result event modelUsage (cumulative), not the sum of result events', () => {
  const results = events().filter((e) => e.type === 'result');
  assert.equal(results.length, 2, 'the fixture has two result events with cumulative modelUsage');
  const last = results.at(-1).modelUsage;
  const j = profile(SAMPLE);
  for (const [model, u] of Object.entries(last)) {
    const row = j.byModel.find((r) => r.model === model);
    assert.ok(row, `row for ${model}`);
    assert.equal(row.input, u.inputTokens);
    assert.equal(row.output, u.outputTokens);
    assert.equal(row.cacheRead, u.cacheReadInputTokens);
    assert.equal(row.cacheWrite, u.cacheCreationInputTokens);
  }
  assert.equal(j.byModel.length, Object.keys(last).length);
  assert.deepEqual(j.reconciliation, { files: [{ file: SAMPLE, resultEvents: 2, matchesModelUsage: true }], matchesModelUsage: true });
});

test('c2 the fixture is built so summing unique assistant message usage equals the last result modelUsage', () => {
  const byId = new Map();
  for (const e of events()) if (e.type === 'assistant') byId.set(e.message.id, e.message);
  const sum = {};
  for (const m of byId.values()) {
    const s = (sum[m.model] ??= { i: 0, o: 0, r: 0, w: 0 });
    s.i += m.usage.input_tokens; s.o += m.usage.output_tokens;
    s.r += m.usage.cache_read_input_tokens; s.w += m.usage.cache_creation_input_tokens;
  }
  const last = events().filter((e) => e.type === 'result').at(-1).modelUsage;
  assert.deepEqual(Object.keys(sum).sort(), Object.keys(last).sort());
  for (const [model, u] of Object.entries(last)) {
    assert.deepEqual(sum[model], { i: u.inputTokens, o: u.outputTokens, r: u.cacheReadInputTokens, w: u.cacheCreationInputTokens });
  }
});

test('c3 byModel, byAgent and total match tests/fixtures/cost/expected.json', () => {
  const j = profile(SAMPLE);
  assert.deepEqual(j.byModel, expected.byModel);
  assert.deepEqual(j.byAgent, expected.byAgent);
  assert.deepEqual(j.total, expected.total);
});

test('c4 rows exist for the orchestrator and for each subagent_type present, orchestrator first', () => {
  const j = profile(SAMPLE);
  assert.deepEqual(j.byAgent.map((r) => r.agent), ['orchestrator', 'archmap-explorer', 'archmap-reviewer', 'archmap-synthesizer']);
});

test('c5 turn counts count unique assistant message ids; median and max context per agent are cache read + cache write + input of a turn', () => {
  const j = profile(SAMPLE);
  const by = Object.fromEntries(j.byAgent.map((r) => [r.agent, r]));
  assert.equal(by.orchestrator.turns, 4);
  assert.equal(by['archmap-explorer'].turns, 5, 'the repeated msg_f1 event is one turn');
  assert.equal(by.orchestrator.medianContext, 8555, 'median of an even count is the mean of the middle two');
  assert.equal(by['archmap-explorer'].medianContext, 5080);
  assert.equal(by['archmap-explorer'].maxContext, 8100);
  assert.equal(by['archmap-synthesizer'].maxContext, 12200);
  assert.equal(j.total.turns, j.byAgent.reduce((n, r) => n + r.turns, 0));
});

test('c6 every agent row and model row sums to the total in each token class', () => {
  const j = profile(SAMPLE);
  for (const rows of [j.byModel, j.byAgent]) {
    for (const c of CLASSES) assert.equal(rows.reduce((n, r) => n + r[c], 0), j.total[c], c);
  }
});

test('c7 --json validates: fixed top-level keys, the rate table with its date, integers for tokens, a number cost per row', () => {
  const r = run([SAMPLE, '--json']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.endsWith('\n'), true);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(j), ['rates', 'byModel', 'byAgent', 'total', 'reconciliation']);
  assert.equal(j.rates.date, '2026-10-30');
  assert.deepEqual(j.rates.perMillion['claude-opus-5-5'], { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(j.rates.perMillion['claude-fable-5-1'], { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
  assert.deepEqual(j.rates.perMillion['claude-sonnet-5-5'], { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  assert.deepEqual(j.rates.perMillion['claude-haiku-5-5'], { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  for (const row of [...j.byModel, ...j.byAgent, j.total]) {
    for (const c of CLASSES) assert.ok(Number.isInteger(row[c]) && row[c] >= 0, c);
    assert.equal(typeof row.costUsd, 'number');
  }
  assert.equal(run([SAMPLE, '--json']).stdout, r.stdout, 'deterministic output');
});

test('c8 the text table lists every agent and model, the cost column, and states the rate table date', () => {
  const r = run([SAMPLE]);
  assert.equal(r.status, 0, r.stderr);
  for (const name of ['orchestrator', 'archmap-explorer', 'archmap-synthesizer', 'archmap-reviewer', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    assert.ok(r.stdout.includes(name), name);
  }
  assert.match(r.stdout, /list prices.*2026-10-30/i);
  assert.match(r.stdout, /0\.3964/);
  assert.match(r.stdout, /total/);
});

test('c9 a model with no rate is reported unpriced, never costed as 0; a transcript without result events reconciles to null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-cost-'));
  const f = join(dir, 'session.jsonl');
  const line = { type: 'assistant', message: { id: 'm1', model: 'mystery-model-9', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  writeFileSync(f, `${JSON.stringify(line)}\n\n`);
  const j = profile(f);
  assert.equal(j.byModel[0].costUsd, null);
  assert.equal(j.total.costUsd, null);
  assert.deepEqual(j.byAgent.map((r) => r.agent), ['orchestrator']);
  assert.equal(j.reconciliation.matchesModelUsage, null);
  assert.match(run([f]).stdout, /unpriced/i);
});

test('c10 two transcripts are added together', () => {
  const j = profile(SAMPLE, SAMPLE);
  assert.equal(j.total.output, expected.total.output * 2);
  assert.equal(j.reconciliation.files.length, 2);
});

test('c11 an unreadable file, malformed JSON and no arguments exit 2 with a message on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-cost-'));
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, 'not json\n');
  for (const args of [[join(dir, 'missing.jsonl')], [bad], [], [SAMPLE, '--wat']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.notEqual(r.stderr.trim(), '');
    assert.equal(r.stdout, '');
  }
});

test('c12 the fixture is synthetic: no path, user name or repository name in it', () => {
  const text = readFileSync(SAMPLE, 'utf8') + readFileSync(new URL('./fixtures/cost/expected.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /\/Users\/|\/home\/|C:\\|github\.com|@/);
});
