import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The script chain end to end over a temp git copy of the fictional node-api repo, with no LLM: the explorer
// fragments and the synthesizer object are hand-written fixtures (tests/fixtures/e2e/). Nothing from the
// fixture repo is executed; the scripts only read it. Case ids (e1, e2, ...) lead every title.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');
const REPO_SRC = join(ROOT, 'tests/fixtures/repos/node-api');
const E2E = join(ROOT, 'tests/fixtures/e2e');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const run = (script, args, opts = {}) =>
  execFileSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', ...opts });
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }).trim();
const ids = (arr) => arr.map((x) => x.id);

const work = mkdtempSync(join(tmpdir(), 'archmap-e2e-'));
const repo = join(work, 'node-api');
const out = join(work, 'out');
mkdirSync(out);
after(() => rmSync(work, { recursive: true, force: true }));
const P = {
  prescan: join(out, 'prescan.json'),
  model: join(out, 'architecture.model.json'),
  layout: join(out, 'architecture.layout.json'),
  html: join(out, 'archmap.html'),
  issues: join(out, 'issues.json'),
  ledger: join(out, 'usage.jsonl'),
};
const GENERATED_AT = '2026-10-29T00:00:00Z';
const ISSUE_TEXT = 'E2E-SECRET-ISSUE-TEXT-should-never-reach-clean-html';

// a step runs a script, asserts it exits 0 (execFileSync throws otherwise) and records a ledger row
const step = (phase, script, args, label) => {
  const t0 = Date.now();
  const stdout = run(script, args);
  run('usage.mjs', ['add', P.ledger, '--phase', phase, '--label', label ?? script, '--tokens', '0',
    '--duration-ms', String(Date.now() - t0)]);
  return stdout;
};

const state = {};

test('e1 prescan, merge, validate --repo, layout and render all exit 0 on the fixture and the clean HTML has no issue text', () => {
  cpSync(REPO_SRC, repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  state.head1 = git(repo, 'rev-parse', 'HEAD');

  // prescan: areas the fragments refer to are really there
  step('prescan', 'prescan.mjs', [repo, '--out', P.prescan]);
  const pre = readJson(P.prescan);
  assert.equal(pre.commit, state.head1);
  assert.ok(ids(pre.areas).includes('src'), 'prescan finds the src area');

  // merge the hand-written explorer fragments plus the synthesizer object
  step('merge', 'merge.mjs', [join(E2E, 'fragments'), '--out', P.model, '--synth', join(E2E, 'synth.json'),
    '--commit', state.head1, '--project', 'node-api', '--profile', 'balanced', '--generated-at', GENERATED_AT]);
  const model = readJson(P.model);
  assert.equal(model.meta.commit, state.head1);
  assert.deepEqual(Object.keys(model.meta.coverage).sort(), ['books', 'express', 'queues']);
  assert.deepEqual(ids(model.nodes), ['books-api', 'email-queue', 'email-worker', 'library-db', 'orders-api']);

  // every evidence {path, lines} exists in the repo at meta.commit
  const v = run('validate.mjs', [P.model, '--repo', repo]);
  assert.match(v, /^OK: no findings$/m);
  assert.match(v, /evidence: checked/);

  step('layout', 'layout.mjs', [P.model, '--out', P.layout]);
  const layout = readJson(P.layout);
  assert.deepEqual(Object.keys(layout.graph.nodes).sort(), ids(model.nodes));

  // an issues overlay exists beside the model; the default (clean) render must not carry any of it
  writeFileSync(P.issues, JSON.stringify({
    schemaVersion: '1.0',
    issues: [{
      id: 'E2E-01', sev: 'low', category: 'design', title: ISSUE_TEXT, anchor: { node: 'books-api' },
      summary: ISSUE_TEXT, impact: ISSUE_TEXT, fix: ISSUE_TEXT, detail: ISSUE_TEXT,
      evidence: [{ path: 'src/books/books.controller.ts', lines: '5-46' }], source: 'archmap',
    }],
  }));
  run('validate.mjs', [P.model, '--issues', P.issues, '--repo', repo]);
  step('render', 'render.mjs', [P.model, '--layout', P.layout, '--issues', P.issues, '--out', P.html]);
  const html = readFileSync(P.html, 'utf8');
  assert.ok(html.includes('books-api'), 'the model is in the page');
  assert.ok(!html.includes(ISSUE_TEXT), 'issue text leaked into the clean HTML');
  assert.ok(!html.includes('E2E-01'), 'issue id leaked into the clean HTML');
  assert.doesNotMatch(html, /id="archmap-issues"/);
  assert.doesNotMatch(html, /id=["']issues-switch["']/);
});

test('e2 the user locks a node with notes and pins it; a scripted commit is mapped by diffmap to exactly its area, nodes and entity', () => {
  // user-authored: locked + notes in the model, pinned (moved) in the layout
  const model = readJson(P.model);
  const books = model.nodes.find((n) => n.id === 'books-api');
  books.locked = true;
  books.notes = 'Owned by the books team; do not reword.';
  writeFileSync(P.model, JSON.stringify(model, null, 2) + '\n');
  const layout = readJson(P.layout);
  state.pin = { ...layout.graph.nodes['books-api'], x: layout.graph.nodes['books-api'].x + 400, y: 777, pinned: true };
  layout.graph.nodes['books-api'] = state.pin;
  writeFileSync(P.layout, JSON.stringify(layout, null, 2) + '\n');
  state.layoutBefore = readJson(P.layout);

  // scripted change: a new route file and a changed entity file
  writeFileSync(join(repo, 'src/books/reviews.controller.ts'), [
    "import { Body, Controller, Get, Post } from '@nestjs/common';",
    '',
    "@Controller('reviews')",
    'export class ReviewsController {',
    '  @Get()',
    '  list() {',
    '    return [];',
    '  }',
    '',
    '  @Post()',
    '  create(@Body() dto: { text: string }) {',
    '    return dto;',
    '  }',
    '}',
    '',
  ].join('\n'));
  const entityPath = join(repo, 'src/entities/book.entity.ts');
  const before = readFileSync(entityPath, 'utf8');
  const after = before.replace('  @Column()\n  title: string;\n',
    '  @Column()\n  title: string;\n\n  @Column({ nullable: true })\n  isbn?: string;\n');
  assert.notEqual(after, before, 'the scripted entity change applied');
  writeFileSync(entityPath, after);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add reviews route, book isbn');
  state.head2 = git(repo, 'rev-parse', 'HEAD');
  assert.notEqual(state.head2, state.head1);

  const report = JSON.parse(run('diffmap.mjs', [P.model, '--repo', repo, '--json']));
  assert.equal(report.base, state.head1);
  assert.equal(report.head, state.head2);
  assert.deepEqual(report.files, ['src/books/reviews.controller.ts', 'src/entities/book.entity.ts']);
  assert.deepEqual(report.areas, ['books']);
  assert.deepEqual(report.nodes, ['books-api', 'library-db']);
  assert.deepEqual(report.dependents, ['orders-api']);
  assert.deepEqual(report.entities, ['books']);
  assert.deepEqual(report.sequences, ['list-books']);
  assert.deepEqual(report.uncovered, []);
});

test('e3 update re-merge keeps locked, notes and pinned; unaffected positions are unchanged; meta.commit is the new HEAD', () => {
  const before = readJson(P.model);
  step('merge', 'merge.mjs', [join(E2E, 'update'), '--out', P.model, '--previous', P.model, '--areas', 'books',
    '--commit', state.head2, '--generated-at', GENERATED_AT], 'books');
  const model = readJson(P.model);
  assert.equal(model.meta.commit, state.head2);
  assert.deepEqual(ids(model.nodes), ['books-api', 'email-queue', 'email-worker', 'library-db', 'orders-api', 'reviews-api']);

  // user-authored fields survive
  const books = model.nodes.find((n) => n.id === 'books-api');
  assert.equal(books.locked, true);
  assert.equal(books.notes, 'Owned by the books team; do not reword.');
  // the changed entity is re-analysed; the other areas' elements are carried over untouched
  assert.ok(model.entities.find((e) => e.id === 'books').fields.some((f) => f.name === 'isbn'));
  for (const id of ['orders-api', 'email-queue', 'email-worker']) {
    assert.deepEqual(model.nodes.find((n) => n.id === id), before.nodes.find((n) => n.id === id), id);
  }
  assert.ok(model.edges.some((e) => e.id === 'orders-calls-books'), 'the cross-area edge of an untouched area is kept');
  assert.deepEqual(model.sequences, before.sequences);

  // evidence of the updated model holds at the new HEAD
  run('validate.mjs', [P.model, '--repo', repo]);

  // seeded layout: pinned and unaffected nodes keep their positions
  step('layout', 'layout.mjs', [P.model, '--layout', P.layout, '--out', P.layout], 'update');
  const layout = readJson(P.layout);
  assert.deepEqual(layout.graph.nodes['books-api'], state.pin, 'pinned node is exactly where the user put it');
  for (const id of ['orders-api', 'email-queue', 'email-worker', 'library-db']) {
    assert.deepEqual(layout.graph.nodes[id], state.layoutBefore.graph.nodes[id], `${id} moved`);
  }
  assert.ok(layout.graph.nodes['reviews-api'], 'the new node is placed');

  step('render', 'render.mjs', [P.model, '--layout', P.layout, '--out', P.html], 'update');
  const html = readFileSync(P.html, 'utf8');
  assert.ok(html.includes('reviews-api'));
  assert.ok(html.includes(state.head2));
});

test('e4 the usage ledger has a row per step and prints per-phase totals', () => {
  const rows = readFileSync(P.ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.phase),
    ['prescan', 'merge', 'layout', 'render', 'merge', 'layout', 'render']);
  const text = run('usage.mjs', ['print', P.ledger]);
  for (const phase of ['prescan', 'merge', 'layout', 'render']) assert.match(text, new RegExp(phase));
  const json = JSON.parse(run('usage.mjs', ['print', P.ledger, '--json']));
  assert.deepEqual(json.phases.map((p) => [p.phase, p.rows]), [['prescan', 1], ['merge', 2], ['layout', 2], ['render', 2]]);
  assert.equal(json.total.rows, 7);
  assert.equal(json.total.tokens, 0);
  assert.equal(json.total.unknownTokens, 0);
  assert.equal(json.total.unknownDuration, 0);
});
