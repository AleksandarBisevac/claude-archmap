import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/pipeline.mjs, the build driver: plan, finish and render over a temp git copy of the fictional node-api
// repo, with canned explorer fragments (tests/fixtures/e2e/pipeline/fragments/) and the canned synthesizer object
// (tests/fixtures/e2e/synth.json) standing in for the agents. Nothing from the fixture repo is executed.
// Case ids (p1, p2, ...) lead every title so the suite prints them first.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PIPELINE = join(ROOT, 'scripts/pipeline.mjs');
const USAGE = join(ROOT, 'scripts/usage.mjs');
const VALIDATE = join(ROOT, 'scripts/validate.mjs');
const REPO_SRC = join(ROOT, 'tests/fixtures/repos/node-api');
const CANNED = join(ROOT, 'tests/fixtures/e2e/pipeline/fragments');
const SYNTH = join(ROOT, 'tests/fixtures/e2e/synth.json');
const GENERATED_AT = '2026-10-29T00:00:00Z';
const BRIEF_CAP = 4000;

const tmp = mkdtempSync(join(tmpdir(), 'archmap-pipeline-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=p', '-c', 'user.email=p@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' }).trim();

function fixtureRepo(name) {
  const repo = join(tmp, name);
  cpSync(REPO_SRC, repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

/** Run one driver step; stdout must be exactly one JSON object on one line, whatever the exit code. */
function step(args, env) {
  const r = spawnSync(process.execPath, [PIPELINE, ...args], { encoding: 'utf8', env: env ?? process.env });
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 1, `one JSON line on stdout, got:\n${r.stdout}\n${r.stderr}`);
  const json = JSON.parse(lines[0]);
  assert.equal(json.exit, r.status, 'the printed exit equals the process exit code');
  return { status: r.status, json, stdout: r.stdout };
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ledgerRows = (work) => readFileSync(join(work, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const cannedInto = (work) => cpSync(CANNED, join(work, 'fragments'), { recursive: true });

/** Every file under `dir`, relative path -> bytes, for the byte-identical check. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

const repo = fixtureRepo('node-api');
const work = join(tmp, 'work');
const out = join(tmp, 'out');
const planArgs = [repo, '--work', work, '--out', out, '--project', 'node-api', '--generated-at', GENERATED_AT];
const usagePairs = ['--usage', 'src=34.5k@62s', '--usage', 'prisma=12000', '--usage', 'root=8100@9500ms'];
const state = {};

test('p1 plan writes prescan, one extract and one brief per area (under the cap, with the fragment path and the caps) and prints the Agent calls as JSON', () => {
  const r = step(['plan', ...planArgs]);
  assert.equal(r.status, 0, r.stdout);
  const j = r.json;
  state.plan = r;
  assert.equal(j.step, 'plan');
  assert.equal(j.ok, true);
  assert.equal(j.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.ok(existsSync(join(work, 'prescan.json')), 'prescan.json written');
  const areas = readJson(join(work, 'prescan.json')).areas.map((a) => a.id);
  assert.deepEqual(j.areas.map((a) => a.id), areas, 'the partition is the prescan areas');
  assert.ok(areas.length >= 2 && areas.length <= 8, `${areas.length} areas`);
  assert.ok(existsSync(join(work, 'fragments')), 'the fragments directory is created');
  assert.equal(j.agents.length, areas.length, 'one Agent call per area');
  for (const [i, id] of areas.entries()) {
    const extract = join(work, 'extracts', `${id}.json`);
    const fragment = join(work, 'fragments', `${id}.json`);
    const briefPath = join(work, 'briefs', `${id}.md`);
    assert.ok(existsSync(extract), `extract for ${id}`);
    assert.ok(existsSync(briefPath), `brief for ${id}`);
    const brief = readFileSync(briefPath, 'utf8');
    assert.ok(brief.length <= BRIEF_CAP, `${id}: brief is ${brief.length} characters`);
    assert.ok(brief.includes(extract), `${id}: brief names the extract path`);
    assert.ok(brief.includes(fragment), `${id}: brief names the fragment path`);
    for (const cap of ['40 nodes', '80 edges', '60 entities', '80 access rows', '20 tool calls']) {
      assert.ok(brief.includes(cap), `${id}: brief carries the cap ${cap}`);
    }
    for (const line of ['fragment: ', 'counts: ', 'tool calls: ']) assert.ok(brief.includes(line), `${id}: reply line ${line}`);
    assert.match(brief, /evidence/i, `${id}: the evidence rule`);
    assert.doesNotMatch(brief, /references\/model-schema\.md/, `${id}: the contract is in the brief, not behind a reference`);
    const call = j.agents[i];
    assert.equal(call.subagent_type, 'archmap-explorer');
    assert.ok(call.prompt.includes(briefPath), `${id}: the prompt points at the brief`);
    assert.ok(call.prompt.length < 400, `${id}: the prompt is a pointer, not the brief`);
    assert.ok(call.description && call.description.length <= 60, `${id}: a short description`);
    assert.equal(call.model, undefined, 'balanced needs no model override');
    assert.equal(call.run_in_background, undefined, 'never a background dispatch');
  }
  assert.ok(r.stdout.length < 6000, `plan prints ${r.stdout.length} characters`);
  assert.doesNotMatch(r.stdout, /"routes"|"tables"/, 'no extract content on stdout');
});

test('p2 the profile sets the model override on every Agent call: max is opus, economy haiku', () => {
  const w = join(tmp, 'work-profile');
  const max = step(['plan', repo, '--work', w, '--out', join(tmp, 'out-profile'), '--profile', 'max', '--generated-at', GENERATED_AT]);
  assert.equal(max.status, 0);
  assert.deepEqual([...new Set(max.json.agents.map((a) => a.model))], ['opus']);
  const eco = step(['plan', repo, '--work', w, '--out', join(tmp, 'out-profile'), '--profile', 'economy', '--generated-at', GENERATED_AT]);
  assert.deepEqual([...new Set(eco.json.agents.map((a) => a.model))], ['haiku']);
  const bad = step(['plan', repo, '--work', w, '--profile', 'cheap']);
  assert.equal(bad.status, 2);
  assert.equal(bad.json.step, 'plan');
});

test('p3 finish with canned fragments and --usage pairs writes a valid model, the digest, the synthesizer brief and the explorer ledger rows', () => {
  cannedInto(work);
  const r = step(['finish', '--work', work, ...usagePairs]);
  assert.equal(r.status, 0, r.stdout);
  const j = r.json;
  state.finish = r;
  assert.equal(j.step, 'finish');
  assert.equal(j.ok, true);
  const model = join(work, 'model.json');
  assert.ok(existsSync(model), 'the merged model is in the work dir');
  const v = spawnSync(process.execPath, [VALIDATE, model, '--repo', repo], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /evidence: checked/);
  assert.deepEqual(j.runs.map((x) => [x.script, x.exit]).filter(([s]) => s === 'validate.mjs'), [['validate.mjs', 0]], 'validate --repo ran and passed');
  assert.ok(j.runs.some((x) => x.script === 'merge.mjs' && x.exit === 0), 'merge ran');
  const digest = join(work, 'digest.json');
  assert.ok(existsSync(digest) && readFileSync(digest, 'utf8').length < 30000, 'digest under 30 K');
  assert.deepEqual(j.counts.nodes > 0 && j.counts.edges > 0, true);
  // the synthesizer brief and its one Agent call
  const briefPath = join(work, 'briefs', 'synthesizer.md');
  const brief = readFileSync(briefPath, 'utf8');
  assert.ok(brief.includes(digest), 'the synthesizer brief names the digest');
  assert.ok(brief.includes(join(work, 'synth.json')), 'the synthesizer brief names the synth path');
  assert.ok(brief.length <= BRIEF_CAP, `synthesizer brief is ${brief.length} characters`);
  for (const line of ['synth: ', 'counts: ', 'tool calls: ']) assert.ok(brief.includes(line), `reply line ${line}`);
  assert.match(brief, /3-7/);
  assert.equal(j.agents.length, 1);
  assert.equal(j.agents[0].subagent_type, 'archmap-synthesizer');
  assert.ok(j.agents[0].prompt.includes(briefPath) && j.agents[0].prompt.length < 400);
  // the ledger: plan's prescan row, one explorer row per --usage pair, the script rows
  const rows = ledgerRows(work);
  const explorers = rows.filter((x) => x.phase === 'explorer');
  assert.deepEqual(explorers.map((x) => [x.label, x.tokens, x.durationMs]),
    [['prisma', 12000, undefined], ['root', 8100, 9500], ['src', 34500, 62000]]);
  for (const x of explorers) {
    assert.equal(x.agent, 'archmap-explorer');
    assert.equal(x.model, 'sonnet');
  }
  assert.deepEqual(rows.filter((x) => x.phase !== 'explorer').map((x) => [x.phase, x.tokens]),
    [['prescan', 0], ['merge', 0], ['validate', 0]]);
  // the orchestrator never sees a fragment or the model
  assert.ok(r.stdout.length < 4000, `finish prints ${r.stdout.length} characters`);
  assert.doesNotMatch(r.stdout, /Books controller reads|"evidence"/, 'no fragment or model content on stdout');
});

test('p4 render with a canned synth file writes the model, the layout and a self-contained HTML, the remaining ledger rows and the report skeleton', () => {
  cpSync(SYNTH, join(work, 'synth.json'));
  const r = step(['render', '--work', work, '--usage', 'synthesizer=21.2k@48s']);
  assert.equal(r.status, 0, r.stdout);
  const j = r.json;
  state.render = r;
  assert.equal(j.step, 'render');
  const files = ['architecture.model.json', 'architecture.layout.json', 'archmap.html'].map((f) => join(out, f));
  for (const f of files) assert.ok(existsSync(f), `${f} written`);
  assert.deepEqual(j.files, { model: files[0], layout: files[1], html: files[2] });
  const model = readJson(files[0]);
  assert.deepEqual(model.sequences.map((s) => s.id), ['list-books'], 'the synthesizer sequences are merged');
  assert.equal(model.meta.generatedAt, GENERATED_AT);
  assert.equal(model.meta.profile, 'balanced');
  assert.equal(j.validate.exit, 0);
  assert.match(j.validate.command, /validate\.mjs.*--repo/);
  assert.equal(j.counts.sequences, 1);
  const html = readFileSync(files[2], 'utf8');
  assert.doesNotMatch(html, /\b(?:src|srcset|href)\s*=\s*['"]?\s*(?:https?:)?\/\//i, 'no remote src or href');
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external script');
  for (const x of ['merge.mjs', 'validate.mjs', 'layout.mjs', 'render.mjs']) {
    assert.ok(j.runs.some((run) => run.script === x && run.exit === 0), `${x} ran and exited 0`);
  }
  const rows = ledgerRows(work);
  const synth = rows.filter((x) => x.phase === 'synthesizer');
  assert.deepEqual(synth.map((x) => [x.agent, x.model, x.tokens, x.durationMs]), [['archmap-synthesizer', 'sonnet', 21200, 48000]]);
  for (const phase of ['layout', 'render']) assert.ok(rows.some((x) => x.phase === phase && x.tokens === 0), `${phase} row`);
  // the printed ledger is the one usage.mjs prints, with the total
  const printed = JSON.parse(execFileSync(process.execPath, [USAGE, 'print', join(work, 'usage.jsonl'), '--json'], { encoding: 'utf8' }));
  assert.deepEqual(j.ledger.total, printed.total);
  assert.equal(j.ledger.total.tokens, 12000 + 8100 + 34500 + 21200);
  // the table usage.mjs prints, once, inside the report skeleton
  const table = execFileSync(process.execPath, [USAGE, 'print', join(work, 'usage.jsonl')], { encoding: 'utf8' });
  assert.ok(j.report.includes(table.trimEnd()), 'the report carries the printed ledger table');
  assert.match(j.report, /orchestrator's own context is not counted/);
  // the report skeleton carries what the final report owes
  for (const part of ['architecture.model.json', 'validate.mjs', 'exit 0', 'nodes', 'sequences', 'balanced', 'cost-profile.mjs']) {
    assert.ok(j.report.includes(part), `report skeleton names ${part}`);
  }
  assert.deepEqual(j.agents, [], 'no reviewer without --issues');
  assert.ok(r.stdout.length < 6000, `render prints ${r.stdout.length} characters`);
  assert.doesNotMatch(r.stdout, /"evidence"|"participants"/, 'no model content on stdout');
});

test('p5 a second run of plan, finish and render with the same inputs is byte-identical', () => {
  const first = { work: snapshot(work), out: snapshot(out), stdout: [state.plan.stdout, state.finish.stdout, state.render.stdout] };
  rmSync(out, { recursive: true, force: true });
  // a fresh plan starts a fresh build: the fragments, synth file and later ledger rows of the last one are gone
  const plan = step(['plan', ...planArgs]);
  assert.deepEqual(readdirSync(join(work, 'fragments')), [], 'plan empties the fragments directory');
  assert.ok(!existsSync(join(work, 'synth.json')), 'plan removes a stale synth file');
  assert.deepEqual(ledgerRows(work).map((x) => x.phase), ['prescan'], 'plan keeps only its own ledger row');
  cannedInto(work);
  const finish = step(['finish', '--work', work, ...usagePairs]);
  cpSync(SYNTH, join(work, 'synth.json'));
  const again = [plan, finish, step(['render', '--work', work, '--usage', 'synthesizer=21.2k@48s'])];
  assert.deepEqual(again.map((x) => x.status), [0, 0, 0]);
  assert.deepEqual(again.map((x) => x.stdout), first.stdout, 'the printed JSON is identical');
  assert.deepEqual(snapshot(work), first.work, 'every work file is identical (ledger included)');
  assert.deepEqual(snapshot(out), first.out, 'model, layout and HTML are identical');
});

test('p6 a missing work dir or fragment exits 2 with the step named; --allow-missing merges without it and names the area', () => {
  const nowhere = join(tmp, 'no-such-work');
  for (const s of ['finish', 'render']) {
    const r = step([s, '--work', nowhere]);
    assert.equal(r.status, 2);
    assert.equal(r.json.step, s);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /no-such-work/);
  }
  const w = join(tmp, 'work-missing');
  assert.equal(step(['plan', repo, '--work', w, '--out', join(tmp, 'out-missing'), '--generated-at', GENERATED_AT]).status, 0);
  cannedInto(w);
  rmSync(join(w, 'fragments', 'root.json'));
  const r = step(['finish', '--work', w]);
  assert.equal(r.status, 2);
  assert.equal(r.json.step, 'finish');
  assert.ok(r.json.error.includes(join(w, 'fragments', 'root.json')), r.json.error);
  assert.deepEqual(r.json.missing, ['root']);
  assert.ok(!existsSync(join(w, 'model.json')), 'nothing merged');
  const ok = step(['finish', '--work', w, '--allow-missing']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.deepEqual(ok.json.notMapped, ['root']);
  // render before a synth file exists names the file it wants
  const noSynth = step(['render', '--work', w]);
  assert.equal(noSynth.status, 2);
  assert.equal(noSynth.json.step, 'render');
  assert.ok(noSynth.json.error.includes(join(w, 'synth.json')));
});

test('p7 usage errors exit 2 with the step named: no repo, an unknown step, a malformed token count', () => {
  assert.equal(step(['plan', '--work', join(tmp, 'w7')]).status, 2);
  const unknown = step(['deploy', '--work', work]);
  assert.equal(unknown.status, 2);
  for (const bad of ['src=lots']) {
    const r = step(['finish', '--work', work, '--usage', bad]);
    assert.equal(r.status, 2, bad);
    assert.equal(r.json.step, 'finish');
    assert.match(r.json.error, /--usage/);
  }
});

test('p8 introspection: a listed database file without its CLI is recorded as skipped; with sqlite3 present its new tables become observed entities', () => {
  const r8 = fixtureRepo('node-api-db');
  const db = join(r8, 'src/entities/reviews.sqlite');
  // a sqlite file is listed by prescan and owned by the store node whose paths cover src/entities/**
  const sqlite = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  if (sqlite.status === 0) {
    execFileSync('sqlite3', [db, 'CREATE TABLE reviews (id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL, body TEXT); CREATE TABLE books (id TEXT PRIMARY KEY);']);
  } else writeFileSync(db, 'SQLite format 3\0');
  git(r8, 'add', '-A');
  git(r8, 'commit', '-q', '-m', 'db');
  const w = join(tmp, 'work-db');
  assert.equal(step(['plan', r8, '--work', w, '--out', join(tmp, 'out-db'), '--generated-at', GENERATED_AT]).status, 0);
  cannedInto(w);
  // a PATH holding git and nothing else: no database CLI is present
  const bin = join(tmp, 'bin-git-only');
  mkdirSync(bin, { recursive: true });
  const gitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  if (!existsSync(join(bin, 'git'))) symlinkSync(gitPath, join(bin, 'git'));
  const skipped = step(['finish', '--work', w], { ...process.env, PATH: bin });
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.deepEqual(skipped.json.introspection, [{ kind: 'sqlite', path: 'src/entities/reviews.sqlite', status: 'skipped', reason: 'sqlite3 CLI not found on PATH' }]);
  const m1 = readJson(join(w, 'model.json'));
  assert.ok(m1.meta.sources.some((s) => s.path === 'src/entities/reviews.sqlite' && s.status === 'skipped'), 'the skip is in meta.sources');
  if (sqlite.status !== 0) return; // the observed half needs the sqlite3 CLI
  const ran = step(['finish', '--work', w]);
  assert.equal(ran.status, 0, ran.stdout);
  assert.equal(ran.json.introspection[0].status, 'ok');
  const m2 = readJson(join(w, 'model.json'));
  const reviews = m2.entities.find((e) => e.name === 'reviews');
  assert.ok(reviews, 'the table no fragment declared becomes an entity');
  assert.equal(reviews.store, 'library-db');
  assert.deepEqual(reviews.fields.map((f) => [f.name, f.provenance]), [['id', 'observed'], ['book_id', 'observed'], ['body', 'observed']]);
  assert.ok(reviews.fields[0].pk);
  assert.equal(m2.entities.filter((e) => e.name === 'books').length, 1, 'a declared table is not duplicated');
  const v = spawnSync(process.execPath, [VALIDATE, join(w, 'model.json'), '--repo', r8], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout);
});

test('p9 update: plan --update maps the commit onto the affected areas only, and finish and render merge with --areas', () => {
  // a built model in `out` from p4/p5; add a route file to src and commit
  writeFileSync(join(repo, 'src/books/reviews.controller.ts'), "import { Controller, Get } from '@nestjs/common';\n\n@Controller('reviews')\nexport class ReviewsController {\n  @Get()\n  list() {\n    return [];\n  }\n}\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'reviews');
  const w = join(tmp, 'work-update');
  const r = step(['plan', repo, '--work', w, '--out', out, '--update', '--generated-at', GENERATED_AT]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.mode, 'update');
  assert.deepEqual(r.json.areas.map((a) => a.id), ['src']);
  assert.ok(r.json.runs.some((x) => x.script === 'diffmap.mjs' && x.exit === 0), 'diffmap ran');
  const brief = readFileSync(join(w, 'briefs', 'src.md'), 'utf8');
  assert.ok(brief.includes(join(out, 'architecture.model.json')), 'the brief names the previous model so ids stay stable');
  cpSync(join(CANNED, 'src.json'), join(w, 'fragments', 'src.json'));
  const f = step(['finish', '--work', w, '--usage', 'src=9k']);
  assert.equal(f.status, 0, f.stdout);
  assert.ok(f.json.runs.find((x) => x.script === 'merge.mjs').args.includes('--areas'), 'merge runs with --areas');
  cpSync(SYNTH, join(w, 'synth.json'));
  const rr = step(['render', '--work', w]);
  assert.equal(rr.status, 0, rr.stdout);
  const model = readJson(join(out, 'architecture.model.json'));
  assert.equal(model.meta.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.ok(model.nodes.some((n) => n.id === 'orders-db'), 'the unaffected prisma area is carried over');
  // nothing changed since: plan --update lists no agent and render re-renders only
  const w2 = join(tmp, 'work-noop');
  const noop = step(['plan', repo, '--work', w2, '--out', out, '--update', '--generated-at', GENERATED_AT]);
  assert.equal(noop.status, 0);
  assert.deepEqual(noop.json.agents, []);
  assert.match(noop.json.next, /render/);
  const re = step(['render', '--work', w2]);
  assert.equal(re.status, 0, re.stdout);
});

test('p10 with --issues render prints the reviewer call, and ledger --usage records the reviewer row once however often it runs', () => {
  const w = join(tmp, 'work-issues');
  const o = join(tmp, 'out-issues');
  assert.equal(step(['plan', repo, '--work', w, '--out', o, '--issues', '--generated-at', GENERATED_AT]).status, 0);
  cannedInto(w);
  assert.equal(step(['finish', '--work', w]).status, 0);
  cpSync(SYNTH, join(w, 'synth.json'));
  const r = step(['render', '--work', w]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.agents.length, 1);
  assert.equal(r.json.agents[0].subagent_type, 'archmap-reviewer');
  assert.ok(r.json.agents[0].prompt.includes(join(o, 'architecture.model.json')), 'the reviewer gets the model path');
  for (let i = 0; i < 2; i++) {
    const l = step(['ledger', '--work', w, '--usage', 'reviewer=40k@3m']);
    assert.equal(l.status, 0, l.stdout);
    assert.ok(l.json.report.includes('reviewer'), 'the ledger table names the reviewer');
  }
  const reviewer = ledgerRows(w).filter((x) => x.phase === 'reviewer');
  assert.deepEqual(reviewer.map((x) => [x.agent, x.model, x.tokens, x.durationMs]), [['archmap-reviewer', 'opus', 40000, 180000]]);
  assert.equal(step(['ledger', '--work', w, '--usage', 'synthesizer=1']).status, 2, 'ledger takes the reviewer label only');
});

test('p11 what the orchestrator holds for a build stays small: SKILL.md, the command and the three steps\' JSON with the replies are under 48 K characters', () => {
  const skill = readFileSync(join(ROOT, 'skills/architecture-map/SKILL.md'), 'utf8');
  const command = readFileSync(join(ROOT, 'commands/build.md'), 'utf8');
  const replies = state.plan.json.areas.map((a) => `fragment: ${join(work, 'fragments', `${a.id}.json`)}\ncounts: nodes=40 edges=80 entities=60 access=80\ntool calls: 20\n`).join('')
    + `synth: ${join(work, 'synth.json')}\ncounts: 7 sequences, 6 views\ntool calls: 20\n`;
  const steps = [state.plan.stdout, state.finish.stdout, state.render.stdout];
  for (const s of steps) assert.ok(s.length < 8000, `a step prints ${s.length} characters`);
  const total = skill.length + command.length + replies.length + steps.reduce((n, s) => n + s.length, 0);
  assert.ok(total < 48000, `the orchestrator holds ${total} characters of skill, command and driver output`);
});

test('p12 plan never clears a directory it did not make, and a plan that stopped half-way is not finished on', () => {
  const foreign = join(tmp, 'foreign');
  mkdirSync(join(foreign, 'fragments'), { recursive: true });
  writeFileSync(join(foreign, 'fragments', 'keep.json'), '{}');
  const r = step(['plan', repo, '--work', foreign, '--generated-at', GENERATED_AT]);
  assert.equal(r.status, 2);
  assert.match(r.json.error, /no pipeline\.json/);
  assert.ok(existsSync(join(foreign, 'fragments', 'keep.json')), 'nothing was removed');
  // a plan that fails after clearing (an unreadable scope) leaves a marker finish refuses
  const w = join(tmp, 'work-half');
  const bad = step(['plan', repo, '--work', w, '--scope', '../outside', '--generated-at', GENERATED_AT]);
  assert.equal(bad.status, 2);
  assert.equal(bad.json.runs[0].script, 'prescan.mjs');
  const f = step(['finish', '--work', w]);
  assert.equal(f.status, 2);
  assert.match(f.json.error, /plan did not complete/);
  // inside the repo and not ignored by git: refused before anything runs
  const inRepo = step(['plan', repo, '--work', join(repo, '.archmap-work'), '--generated-at', GENERATED_AT]);
  assert.equal(inRepo.status, 2);
  assert.match(inRepo.json.error, /inside the repo/);
  assert.deepEqual(inRepo.json.runs, []);
});

// ---------------------------------------------------------------------------------------------
// P10.6: what a real monorepo build tripped on: area ids as references, odd --usage labels, a brief over its cap,
// a work dir the subagents could not write to.

const planInto = (w, extra = [], env) =>
  step(['plan', repo, '--work', w, '--out', join(tmp, `out-${w.split('/').pop()}`), '--project', 'node-api', '--generated-at', GENERATED_AT, ...extra], env);

test('p13 the explorer brief says to name another area as area:<id>, and finish resolves such an edge into a valid model', () => {
  const w = join(tmp, 'work-ref');
  const r = planInto(w);
  assert.equal(r.status, 0, r.stdout);
  const brief = readFileSync(join(w, 'briefs', 'src.md'), 'utf8');
  assert.match(brief, /area:<id>/);
  assert.match(brief, /merge resolves/i);
  cannedInto(w);
  const fp = join(w, 'fragments', 'src.json');
  const frag = readJson(fp);
  frag.edges.push({
    id: 'orders-reads-prisma', from: 'orders-api', to: 'area:prisma', type: 'sql', desc: 'by area id',
    evidence: [{ path: 'src/books/books.controller.ts', lines: '3-4' }], confidence: 'inferred',
  });
  frag.edges.push({
    id: 'orders-reads-ghost', from: 'orders-api', to: 'area:ghost', type: 'call', desc: 'nothing there',
    evidence: [{ path: 'src/books/books.controller.ts', lines: '5-6' }], confidence: 'inferred',
  });
  writeFileSync(fp, JSON.stringify(frag));
  const f = step(['finish', '--work', w]);
  assert.equal(f.status, 0, f.stdout);
  const model = readJson(join(w, 'model.json'));
  const e = model.edges.find((x) => x.id === 'orders-reads-prisma');
  assert.equal(e.to, 'orders-db');
  assert.equal(model.edges.some((x) => x.id === 'orders-reads-ghost'), false);
  assert.ok(model.meta.sources.some((x) => x.type === 'dropped-ref' && x.target === 'area:ghost'));
});

test('p14 --usage takes any label without an equals sign: exact id, then unique prefix, then position; an unmatched label is kept under its own name with a warning', () => {
  const w = join(tmp, 'work-usage');
  assert.equal(planInto(w).status, 0);
  cannedInto(w);
  const odd = '.claude+packages-ui+root/x.y';
  const r = step(['finish', '--work', w, '--usage', 'src=34.5k@62s', '--usage', 'pri=12000', '--usage', `${odd}=8100@9500ms`, '--usage', 'extra/one.two+three=5']);
  assert.equal(r.status, 0, r.stdout);
  const rows = ledgerRows(w).filter((x) => x.phase === 'explorer');
  const byLabel = Object.fromEntries(rows.map((x) => [x.label, x]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['extra/one.two+three', 'prisma', 'root', 'src']);
  assert.equal(byLabel.src.tokens, 34500);
  assert.equal(byLabel.prisma.tokens, 12000, 'a unique prefix finds its area');
  assert.equal(byLabel.root.tokens, 8100, 'the label left over takes the area that still lacks a row');
  assert.equal(byLabel.root.durationMs, 9500);
  assert.equal(byLabel['extra/one.two+three'].tokens, 5, 'no area left: recorded under its own label');
  assert.ok(Array.isArray(r.json.warnings) && r.json.warnings.length >= 1, JSON.stringify(r.json));
  assert.ok(r.json.warnings.some((x) => x.includes('extra/one.two+three')), JSON.stringify(r.json.warnings));
  // an exact id given after a stray label still wins the area
  const w2 = join(tmp, 'work-usage2');
  assert.equal(planInto(w2).status, 0);
  cannedInto(w2);
  const r2 = step(['finish', '--work', w2, '--usage', 'a.b+c=7', '--usage', 'src=9', '--usage', 'prisma=8']);
  assert.equal(r2.status, 0, r2.stdout);
  const rows2 = Object.fromEntries(ledgerRows(w2).filter((x) => x.phase === 'explorer').map((x) => [x.label, x.tokens]));
  assert.deepEqual(rows2, { src: 9, prisma: 8, root: 7 });
});

/** Three ordinary directories and a dozen one-file directories with long names: the small ones merge into misc. */
function wideRepo(name, tiny = 12, len = 60) {
  const dir = join(tmp, name);
  const put = (d, f) => {
    mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, d, f), 'x = 1\n');
  };
  for (const d of ['core', 'web', 'api']) for (let j = 0; j < 4; j++) put(d, `f${j}.py`);
  for (let i = 0; i < tiny; i++) put(`module-${String(i).padStart(2, '0')}-${'x'.repeat(len)}`, 'only.py');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

test('p15 a merged leftover area is named misc, lists its directories in the boundary globs, and a brief over its cap is trimmed and noted, never a refusal', () => {
  const wr = wideRepo('wide-repo');
  const w = join(tmp, 'work-wide');
  const r = step(['plan', wr, '--work', w, '--out', join(tmp, 'out-wide'), '--generated-at', GENERATED_AT]);
  assert.equal(r.status, 0, r.stdout);
  const ids = r.json.areas.map((a) => a.id);
  assert.ok(ids.some((i) => /^misc(-\d+)?$/.test(i)), ids.join(','));
  assert.ok(!ids.some((i) => i.includes('+')), ids.join(','));
  const misc = readJson(join(w, 'prescan.json')).areas.find((a) => a.id === 'misc');
  assert.ok(misc && misc.globs.length >= 2, 'misc holds several directories');
  for (const id of ids) {
    const brief = readFileSync(join(w, 'briefs', `${id}.md`), 'utf8');
    assert.ok(brief.length <= BRIEF_CAP, `${id}: ${brief.length} characters`);
  }
  const miscBrief = readFileSync(join(w, 'briefs', 'misc.md'), 'utf8');
  assert.ok(miscBrief.includes(misc.globs[0]), 'a member directory shows in the boundary globs');
  assert.ok(Array.isArray(r.json.trimmed) && r.json.trimmed.some((t) => t.area === 'misc'), `a note says misc was trimmed: ${JSON.stringify(r.json.trimmed)}`);
});

test('p16 plan without --work uses a directory under the OS temp dir named from the repo path hash and prints it; a --work it did not make is accepted when empty or holding only its own files', () => {
  const home = join(tmp, 'os-tmp');
  mkdirSync(home);
  const env = { PATH: process.env.PATH, TMPDIR: home, TEMP: home, TMP: home };
  const a = step(['plan', repo, '--out', join(tmp, 'out-default'), '--generated-at', GENERATED_AT], env);
  assert.equal(a.status, 0, a.stdout);
  const wd = a.json.work;
  assert.equal(typeof wd, 'string');
  assert.equal(join(wd, '..', '..'), home, wd);
  assert.match(wd.split('/').pop(), /^[0-9a-f]{8,16}$/);
  assert.equal(wd.split('/').slice(-2)[0], 'archmap');
  assert.ok(existsSync(join(wd, 'prescan.json')));
  assert.match(a.json.workNote, /subagents? must be able to write/i);
  const again = step(['plan', repo, '--out', join(tmp, 'out-default'), '--generated-at', GENERATED_AT], env);
  assert.equal(again.json.work, wd, 'the same repo path gives the same directory');
  const other = step(['plan', fixtureRepo('node-api-other'), '--out', join(tmp, 'out-default2'), '--generated-at', GENERATED_AT], env);
  assert.notEqual(other.json.work, wd, 'another repo path gives another directory');
  // a directory somebody else made: empty is fine, one with only an empty fragments/ is fine
  const empty = join(tmp, 'made-by-hand');
  mkdirSync(empty);
  assert.equal(planInto(empty).status, 0);
  const own = join(tmp, 'made-by-hand-2');
  mkdirSync(join(own, 'fragments'), { recursive: true });
  assert.equal(planInto(own).status, 0);
  // but one holding somebody's files is still refused
  const foreign = join(tmp, 'made-by-hand-3');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'notes.txt'), 'mine');
  const bad = planInto(foreign);
  assert.equal(bad.status, 2);
  assert.ok(existsSync(join(foreign, 'notes.txt')));
});

// ---------------------------------------------------------------------------------------------
// P10.7: the explorer is held to a coverage floor computed from its extract, not left to transcribe it.

/** What the floor counts, recomputed here from the extract file alone. */
function expectedFloor(extract) {
  const dirOf = (p) => p.split('/').slice(0, -1).join('/');
  const distinct = (xs) => new Set(xs).size;
  return {
    'entry-point groups': distinct((extract.entryPoints || []).map((p) => dirOf(typeof p === 'string' ? p : p.file))),
    'route groups': distinct((extract.routes || []).map((r) => r.file)),
    stores: distinct((extract.tables || []).map((t) => t.file)),
    queues: (extract.queues || []).length,
    jobs: (extract.jobs || []).length,
    'external clients': (extract.clients || []).length,
  };
}

function floorOf(brief) {
  const line = brief.split('\n').find((l) => /Coverage floor/.test(l));
  assert.ok(line, 'the brief has a Coverage floor line');
  const total = /Coverage floor:\s*at least (\d+) nodes?/.exec(line);
  assert.ok(total, `the floor line states a number of nodes: ${line}`);
  const parts = {};
  for (const m of line.matchAll(/(entry-point groups|route groups|stores|queues|jobs|external clients)=(\d+)/g)) parts[m[1]] = Number(m[2]);
  return { total: Number(total[1]), parts, line };
}

test('p17 the brief carries a coverage floor computed from the extract, says a fragment under it is incomplete, asks for 6 to 20 tool calls beyond the extract, and stays under its cap', () => {
  const w = join(tmp, 'work-floor');
  const r = planInto(w);
  assert.equal(r.status, 0, r.stdout);
  for (const a of r.json.areas) {
    const brief = readFileSync(join(w, 'briefs', `${a.id}.md`), 'utf8');
    const extract = readJson(join(w, 'extracts', `${a.id}.json`));
    const { total, parts, line } = floorOf(brief);
    const want = expectedFloor(extract);
    assert.deepEqual(parts, want, `${a.id}: the floor's parts are counted from the extract`);
    const sum = Object.values(want).reduce((x, y) => x + y, 0);
    assert.equal(total, Math.max(1, sum), `${a.id}: the floor is the sum of its parts, at least one`);
    assert.match(brief, /fewer nodes than (the|this) (coverage )?floor[^\n]*incomplete|under (the|this) (coverage )?floor[^\n]*incomplete/i, `${a.id}: a fragment under the floor is incomplete`);
    assert.match(brief, /at least 6\b[^\n]*\bat most 20\b[^\n]*tool calls|at least 6 and at most 20 tool calls/i, `${a.id}: 6 to 20 tool calls`);
    assert.match(brief, /Grep[^\n]*(line-range|line range)[^\n]*Read|(line-range|line range)[^\n]*Read[^\n]*Grep/i, `${a.id}: Grep, then a line-range Read`);
    assert.ok(brief.length <= BRIEF_CAP, `${a.id}: ${brief.length} characters`);
    assert.ok(line.length < 700, `${a.id}: the floor line is compact (${line.length})`);
  }
  // the area with routes, tables, a queue and clients has a floor of more than one
  const src = floorOf(readFileSync(join(w, 'briefs', 'src.md'), 'utf8'));
  assert.ok(src.total >= 4, `src floor is ${src.total}`);
  assert.ok(src.parts['route groups'] >= 1 && src.parts.queues >= 1 && src.parts['external clients'] >= 1, JSON.stringify(src.parts));
});

test('p18 a backend with many router modules gets a floor that counts them, and the floor line survives the trimming under the cap', () => {
  const dir = join(tmp, 'many-routers');
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'many', dependencies: { express: '^4.0.0' } }));
  writeFileSync(join(dir, 'src', 'app.ts'), "import express from 'express';\nconst app = express();\napp.listen(3000);\n");
  for (let i = 0; i < 30; i++) {
    const name = `feature-${String(i).padStart(2, '0')}-${'long'.repeat(8)}`;
    writeFileSync(join(dir, 'src', 'routes', `${name}.ts`), `import { Router } from 'express';\nconst router = Router();\nrouter.get('/${name}', (req, res) => res.json([]));\nexport default router;\n`);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  const w = join(tmp, 'work-many');
  const r = step(['plan', dir, '--work', w, '--out', join(tmp, 'out-many'), '--generated-at', GENERATED_AT]);
  assert.equal(r.status, 0, r.stdout);
  let seen = 0;
  for (const a of r.json.areas) {
    const brief = readFileSync(join(w, 'briefs', `${a.id}.md`), 'utf8');
    const extract = readJson(join(w, 'extracts', `${a.id}.json`));
    assert.ok(brief.length <= BRIEF_CAP, `${a.id}: ${brief.length} characters`);
    const { total, parts } = floorOf(brief);
    assert.deepEqual(parts, expectedFloor(extract), a.id);
    assert.ok(total >= 1);
    seen += parts['route groups'];
  }
  assert.ok(seen >= 30, `the 30 router modules are counted as route groups, saw ${seen}`);
});
