import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync,
  writeFileSync,
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
const NODE_CAP = 40; // CAPS.nodes in scripts/merge.mjs: the merge keeps at most this many nodes of a fragment

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
function step(args, env, cwd) {
  const r = spawnSync(process.execPath, [PIPELINE, ...args], { encoding: 'utf8', env: env ?? process.env, cwd });
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
    const summary = join(work, 'extracts', `${id}.summary.json`);
    const fragment = join(work, 'fragments', `${id}.json`);
    const briefPath = join(work, 'briefs', `${id}.md`);
    assert.ok(existsSync(extract), `extract for ${id}`);
    assert.ok(existsSync(briefPath), `brief for ${id}`);
    const brief = readFileSync(briefPath, 'utf8');
    assert.ok(brief.length <= BRIEF_CAP, `${id}: brief is ${brief.length} characters`);
    assert.ok(existsSync(summary), `summary for ${id}`);
    assert.ok(brief.includes(summary), `${id}: brief names the summary path`);
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
  assert.deepEqual(skipped.json.introspection, [{ type: 'introspection-skipped', kind: 'sqlite', path: 'src/entities/reviews.sqlite', status: 'skipped', reason: 'sqlite3 CLI not found on PATH' }]);
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
  assert.ok(readFileSync(join(w, 'briefs', 'reviewer.md'), 'utf8').includes(join(o, 'architecture.model.json')), 'the reviewer brief carries the model path');
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

test('p14 --usage takes any label without an equals sign: exact id, then unique prefix; any other label is booked under its own name with a warning, never on an area by position', () => {
  const w = join(tmp, 'work-usage');
  assert.equal(planInto(w).status, 0);
  cannedInto(w);
  const odd = '.claude+packages-ui+root/x.y';
  const r = step(['finish', '--work', w, '--usage', 'src=34.5k@62s', '--usage', 'pri=12000', '--usage', `${odd}=8100@9500ms`, '--usage', 'extra/one.two+three=5']);
  assert.equal(r.status, 0, r.stdout);
  const rows = ledgerRows(w).filter((x) => x.phase === 'explorer');
  const byLabel = Object.fromEntries(rows.map((x) => [x.label, x]));
  assert.deepEqual(Object.keys(byLabel).sort(), [odd, 'extra/one.two+three', 'prisma', 'root', 'src'].sort());
  assert.equal(byLabel.src.tokens, 34500, 'an exact id finds its area');
  assert.equal(byLabel.prisma.tokens, 12000, 'a unique prefix finds its area');
  assert.equal(byLabel[odd].tokens, 8100, 'a label matching no area is kept under its own name, not booked on root');
  assert.equal(byLabel[odd].durationMs, 9500);
  assert.equal(byLabel.root.tokens, undefined, 'the area no label names keeps its row without tokens, none booked on it by position');
  assert.equal(byLabel.root.durationMs, undefined);
  assert.equal(byLabel['extra/one.two+three'].tokens, 5, 'recorded under its own label');
  assert.ok(Array.isArray(r.json.warnings), JSON.stringify(r.json));
  for (const label of [odd, 'extra/one.two+three']) assert.ok(r.json.warnings.some((x) => x.includes(label)), `${label}: ${JSON.stringify(r.json.warnings)}`);
  // a stray label before the exact ids: the ids still win their areas, the stray label stays its own row
  const w2 = join(tmp, 'work-usage2');
  assert.equal(planInto(w2).status, 0);
  cannedInto(w2);
  const r2 = step(['finish', '--work', w2, '--usage', 'a.b+c=7', '--usage', 'src=9', '--usage', 'prisma=8']);
  assert.equal(r2.status, 0, r2.stdout);
  const rows2 = Object.fromEntries(ledgerRows(w2).filter((x) => x.phase === 'explorer').map((x) => [x.label, x.tokens]));
  assert.deepEqual(rows2, { 'a.b+c': 7, src: 9, prisma: 8, root: undefined });
  assert.ok(r2.json.warnings.some((x) => x.includes('a.b+c')), JSON.stringify(r2.json.warnings));
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
    assert.equal(total, Math.min(NODE_CAP, Math.max(1, sum)), `${a.id}: the floor is the sum of its parts, at least one, at most the node cap`);
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

// ---------------------------------------------------------------------------------------------
// P10.10: the explorer reads a capped summary; entities, relations and queue edges come from the full extracts.

test('p19 the brief points the explorer at the summary, says entities, relations and queue edges come from the script, and that the explorer lists no tables', () => {
  const w = join(tmp, 'work-summary');
  const r = planInto(w);
  assert.equal(r.status, 0, r.stdout);
  for (const a of r.json.areas) {
    const brief = readFileSync(join(w, 'briefs', `${a.id}.md`), 'utf8');
    assert.ok(brief.includes(join(w, 'extracts', `${a.id}.summary.json`)), `${a.id}: the summary path`);
    assert.ok(!brief.includes(join(w, 'extracts', `${a.id}.json`)), `${a.id}: the full extract is not the explorer's to read`);
    assert.match(brief, /entities, relations and queue edges[^\n]*\b(script|merge\.mjs)\b/i, `${a.id}: who makes them`);
    assert.match(brief, /(do not|never) (list|transcribe)[^\n]*\btables\b/i, `${a.id}: no tables in the fragment`);
    assert.ok(brief.length <= BRIEF_CAP, `${a.id}: ${brief.length} characters`);
  }
});

test('p20 finish on the fixture with fragments that carry no entity produces an entity for every declared table, the declared foreign keys and the queue node, and validate --repo accepts it', () => {
  const w = join(tmp, 'work-gen');
  assert.equal(planInto(w).status, 0);
  mkdirSync(join(w, 'fragments'), { recursive: true });
  for (const f of readdirSync(CANNED)) {
    const fr = readJson(join(CANNED, f));
    writeFileSync(join(w, 'fragments', f), JSON.stringify({ ...fr, entities: [], access: [] }));
  }
  const r = step(['finish', '--work', w]);
  assert.equal(r.status, 0, r.stdout);
  const model = readJson(join(w, 'model.json'));
  const names = model.entities.map((e) => e.name).sort();
  for (const t of ['Customer', 'OrderLine', 'authors', 'books', 'editions', 'orders', 'publishers']) assert.ok(names.includes(t), `${t} in ${names}`);
  const editions = model.entities.find((e) => e.name === 'editions');
  assert.deepEqual(editions.evidence, [{ path: 'src/db/schema.ts', lines: '11-17' }]);
  assert.ok(editions.fields.every((f) => f.provenance === 'declared'));
  const publishers = model.entities.find((e) => e.name === 'publishers');
  assert.ok(model.relations.some((x) => x.from.entity === editions.id && x.from.field === 'publisherId' && x.to.entity === publishers.id), JSON.stringify(model.relations));
  // the explorer's email-queue node is the queue's node (its paths own the producer file); the worker's edge reaches it
  assert.deepEqual(model.nodes.filter((n) => n.kind === 'queue').map((n) => n.id), ['email-queue'], 'the email queue is one node');
  assert.ok(model.edges.some((e) => e.type === 'queue' && e.from === 'email-worker' && e.to === 'email-queue'), JSON.stringify(model.edges.map((e) => e.id)));
  const v = spawnSync(process.execPath, [VALIDATE, join(w, 'model.json'), '--repo', repo], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

/** A repo copy with a python file that opens file databases by path literal, planned and given the canned fragments. */
function dbRepo(name, { present = [], code }) {
  const r = fixtureRepo(name);
  writeFileSync(join(r, 'src/entities/load.py'), code);
  for (const f of present) writeFileSync(join(r, f), 'not a database, only a file of that name\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'db code');
  const w = join(tmp, `work-${name}`);
  assert.equal(step(['plan', r, '--work', w, '--out', join(tmp, `out-${name}`), '--generated-at', GENERATED_AT]).status, 0);
  cannedInto(w);
  return { r, w };
}

/** sh that sets $code to the argument after -c, wherever the flags put it, for a python3 stand-in. */
const PY_CODE_ARG = 'code=; prev=; for a in "$@"; do if [ "$prev" = "-c" ]; then code="$a"; fi; prev="$a"; done\n';

/** A PATH holding git and, when `script` is given, a `duckdb` stand-in running it (and `python3` when `py` is). */
function binWith(name, script, py) {
  const bin = join(tmp, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  const gitPath = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  if (!existsSync(join(bin, 'git'))) symlinkSync(gitPath, join(bin, 'git'));
  if (script) writeFileSync(join(bin, 'duckdb'), script, { mode: 0o755 });
  if (py) writeFileSync(join(bin, 'python3'), py, { mode: 0o755 });
  return bin;
}

test('p21 a file database named in code is introspected when present and a tool exists; otherwise meta.sources carries one introspection-skipped row that names the missing file or the missing tool', () => {
  const code = 'import duckdb\n\nWAREHOUSE = duckdb.connect("src/entities/warehouse.duckdb")\nGHOST = duckdb.connect("src/entities/ghost.duckdb")\n';
  const { r, w } = dbRepo('db-code', { present: ['src/entities/warehouse.duckdb'], code });
  const pre = readJson(join(w, 'prescan.json'));
  assert.deepEqual(pre.extracts.python.stores.map((x) => `${x.kind} ${x.path}`), ['duckdb src/entities/warehouse.duckdb', 'duckdb src/entities/ghost.duckdb']);

  // no duckdb on PATH: the absent file is named as absent, the present one as lacking its tool
  const none = step(['finish', '--work', w], { ...process.env, PATH: binWith('git-only') });
  assert.equal(none.status, 0, none.stdout);
  const rows = (m) => m.meta.sources.filter((x) => x.type === 'introspection-skipped').map((x) => ({ kind: x.kind, path: x.path, reason: x.reason }));
  const got = Object.fromEntries(rows(readJson(join(w, 'model.json'))).map((x) => [x.path, x]));
  assert.deepEqual(Object.keys(got).sort(), ['src/entities/ghost.duckdb', 'src/entities/warehouse.duckdb']);
  assert.equal(got['src/entities/ghost.duckdb'].kind, 'duckdb');
  assert.match(got['src/entities/ghost.duckdb'].reason, /src\/entities\/ghost\.duckdb does not exist/);
  assert.match(got['src/entities/warehouse.duckdb'].reason, /duckdb CLI not found on PATH/);
  const v1 = spawnSync(process.execPath, [VALIDATE, join(w, 'model.json'), '--repo', r], { encoding: 'utf8' });
  assert.equal(v1.status, 0, v1.stdout + v1.stderr);

  // a duckdb stand-in on PATH: the present file is read through a copy, read-only, and its tables become observed entities
  const log = join(tmp, 'duckdb-args.log');
  const stub = '#!/bin/sh\nif [ "$1" = "-version" ]; then echo v0.0.0; exit 0; fi\n' +
    `echo "$@" >> "${log}"\n` +
    "printf 'table\\tevents\\t1\\tid\\tBIGINT\\t0\\t1\\ntable\\tevents\\t2\\tpayload\\tVARCHAR\\t0\\t0\\n'\n";
  const ran = step(['finish', '--work', w], { ...process.env, PATH: binWith('with-duckdb', stub) });
  assert.equal(ran.status, 0, ran.stdout);
  const m2 = readJson(join(w, 'model.json'));
  const events = m2.entities.find((e) => e.name === 'events');
  assert.ok(events, 'the table no fragment declared becomes an entity');
  assert.equal(events.store, 'library-db');
  assert.deepEqual(events.fields.map((f) => [f.name, f.provenance]), [['id', 'observed'], ['payload', 'observed']]);
  const args = readFileSync(log, 'utf8');
  assert.match(args, /-readonly/);
  assert.ok(!args.includes(join(r, 'src/entities/warehouse.duckdb')), 'the original file is never opened, a copy is');
  assert.deepEqual(rows(m2).map((x) => x.path), ['src/entities/ghost.duckdb'], 'only the absent file is still a skip');
  const v2 = spawnSync(process.execPath, [VALIDATE, join(w, 'model.json'), '--repo', r], { encoding: 'utf8' });
  assert.equal(v2.status, 0, v2.stdout + v2.stderr);
});

test('p22 without the duckdb CLI the python duckdb module reads the schema when it is installed, and the skip row names both when it is not', () => {
  const code = 'import duckdb\n\nWAREHOUSE = duckdb.connect("src/entities/warehouse.duckdb")\n';
  const { r, w } = dbRepo('db-module', { present: ['src/entities/warehouse.duckdb'], code });
  // a python3 stand-in: the argument after -c being `import duckdb` is the probe; any other call is the query and
  // prints tab-separated rows (the flags before -c are free, so -I is not tied to a position here)
  const log = join(tmp, 'python-args.log');
  const withModule = `#!/bin/sh\n${PY_CODE_ARG}if [ "$code" = "import duckdb" ]; then exit 0; fi\n` +
    `echo "$@" >> "${log}"\n` +
    "printf 'view\\tlatest\\t1\\tday\\tDATE\\t0\\t1\\n'\n";
  const noModule = `#!/bin/sh\n${PY_CODE_ARG}if [ "$code" = "import duckdb" ]; then echo "ModuleNotFoundError: No module named duckdb" >&2; exit 1; fi\nexit 0\n`;

  const missing = step(['finish', '--work', w], { ...process.env, PATH: binWith('py-no-module', null, noModule) });
  assert.equal(missing.status, 0, missing.stdout);
  const skip = readJson(join(w, 'model.json')).meta.sources.find((x) => x.type === 'introspection-skipped');
  assert.match(skip.reason, /duckdb CLI not found on PATH and the python duckdb module is not installed/);

  const ran = step(['finish', '--work', w], { ...process.env, PATH: binWith('py-module', null, withModule) });
  assert.equal(ran.status, 0, ran.stdout);
  const m = readJson(join(w, 'model.json'));
  const latest = m.entities.find((e) => e.name === 'latest');
  assert.ok(latest, 'the view becomes an entity');
  assert.deepEqual([latest.kind, latest.fields.map((f) => [f.name, f.provenance])], ['view', [['day', 'observed']]]);
  assert.ok(!readFileSync(log, 'utf8').includes(join(r, 'src/entities/warehouse.duckdb')), 'the module opens a copy, never the original');
  assert.ok(!m.meta.sources.some((x) => x.type === 'introspection-skipped'), 'nothing was skipped');
});

// P10.12: the issues flow by script. Real --issues build: render refused a --usage label other than "synthesizer"
// and the same label twice, the reviewer's reply was written to <work>/reviewer.json by the orchestrator, and
// issues.mjs merge, validate --issues and render --mode internal were hand-run in one Bash.
const GIT_HOME_ENV = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
const slugDir = (home) => execFileSync(process.execPath, [join(ROOT, 'scripts/issues.mjs'), 'path', '--project', repo], { encoding: 'utf8', env: GIT_HOME_ENV(home) }).trim();

/** A work dir taken through plan --issues, finish and the canned synth file, ready for render. */
function readyForRender(name, extra = ['--issues']) {
  const w = join(tmp, name);
  assert.equal(planInto(w, extra).status, 0);
  cannedInto(w);
  assert.equal(step(['finish', '--work', w]).status, 0);
  cpSync(SYNTH, join(w, 'synth.json'));
  return w;
}

test('p23 render takes the synthesizer row under any label and a repeated label adds a second row, never exit 2', () => {
  const w = readyForRender('work-labels', []);
  const r = step(['render', '--work', w, '--usage', 'synthesizer-fix=33.2k@25s', '--usage', 'synthesizer=21k@48s', '--usage', 'synthesizer=1k']);
  assert.equal(r.status, 0, r.stdout);
  const rows = ledgerRows(w).filter((x) => x.phase === 'synthesizer');
  assert.deepEqual(rows.map((x) => [x.agent, x.tokens]).sort(), [['archmap-synthesizer', 1000], ['archmap-synthesizer', 21000], ['archmap-synthesizer', 33200]]);
  assert.equal(rows.length, 3, 'one row per pair');
  // a run twice records the same rows once
  const again = step(['render', '--work', w, '--usage', 'synthesizer-fix=33.2k@25s', '--usage', 'synthesizer=21k@48s', '--usage', 'synthesizer=1k']);
  assert.equal(again.status, 0);
  assert.equal(ledgerRows(w).filter((x) => x.phase === 'synthesizer').length, 3);
  // a pair that is not a token count is still a usage error
  assert.equal(step(['render', '--work', w, '--usage', 'synthesizer=lots']).status, 2);
  assert.equal(r.json.ledger.total.tokens >= 55200, true, JSON.stringify(r.json.ledger.total));
});

test('p24 with --issues render writes the reviewer brief (absolute catalogue path, model path, <work>/reviewer.json) and prints the one Agent call, a short pointer to it', () => {
  const w = readyForRender('work-reviewer-brief');
  const o = join(tmp, 'out-work-reviewer-brief');
  assert.equal(readJson(join(w, 'pipeline.json')).issues, true, 'plan carries --issues into pipeline.json');
  const r = step(['render', '--work', w]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.agents.length, 1);
  const call = r.json.agents[0];
  assert.equal(call.subagent_type, 'archmap-reviewer');
  const briefPath = join(w, 'briefs', 'reviewer.md');
  assert.ok(existsSync(briefPath), 'the reviewer brief is written');
  assert.ok(call.prompt.includes(briefPath), 'the prompt points at the brief');
  assert.ok(call.prompt.length < 600, `the prompt is ${call.prompt.length} characters`);
  assert.equal(call.run_in_background, undefined);
  const brief = readFileSync(briefPath, 'utf8');
  const catalogue = join(ROOT, 'skills/architecture-map/references/issues-catalog.md');
  assert.ok(existsSync(catalogue));
  assert.ok(brief.includes(catalogue), 'the absolute path of issues-catalog.md');
  for (const ref of ['model-schema.md', 'relation-taxonomy.md', 'sequences.md']) {
    assert.ok(brief.includes(join(ROOT, 'skills/architecture-map/references', ref)), `absolute path of ${ref}`);
  }
  assert.ok(brief.includes(join(o, 'architecture.model.json')), 'the model path');
  assert.ok(brief.includes(join(w, 'reviewer.json')), 'the reviewer writes its object to <work>/reviewer.json');
  for (const line of ['reviewer: ', 'counts: ', 'tool calls: ']) assert.ok(brief.includes(line), `reply line ${line}`);
  assert.match(brief, /three lines/i);
  assert.match(r.json.next, /pipeline\.mjs issues --work/, r.json.next);
  assert.ok(r.stdout.length < 6000);
  // without --issues there is no brief and no call
  const w2 = readyForRender('work-no-reviewer-brief', []);
  assert.deepEqual(step(['render', '--work', w2]).json.agents, []);
  assert.equal(existsSync(join(w2, 'briefs', 'reviewer.md')), false);
});

/** A reviewer object anchored to a node of the model render wrote, with that node's own evidence. */
function reviewerFile(w, out, extra = {}) {
  const model = readJson(join(out, 'architecture.model.json'));
  const n = model.nodes[0];
  const issue = {
    id: 'zq-pipeline-issue', sev: 'med', category: 'design', title: 'Zq a module with no owner',
    anchor: { node: n.id },
    summary: 'The module has no clear owner in the structure.', impact: 'Changes to it are not reviewed by anyone in particular.',
    fix: 'Name an owner for the module.', detail: 'ZQDETAIL-PIPE internal note.', evidence: [n.evidence[0]], source: 'archmap', ...extra,
  };
  writeFileSync(join(w, 'reviewer.json'), JSON.stringify({ issues: [issue], unreviewed: [] }));
  return { node: n.id, issue };
}

test('p25 the issues step merges <work>/reviewer.json into the overlay outside the repository, validates it, renders the internal HTML there, records the reviewer row once and prints one JSON object', () => {
  const home = join(tmp, 'home-p25');
  mkdirSync(home);
  const env = GIT_HOME_ENV(home);
  const w = readyForRender('work-p25');
  const o = join(tmp, 'out-work-p25');
  assert.equal(step(['render', '--work', w]).status, 0);
  const { issue } = reviewerFile(w, o);
  const before = git(repo, 'status', '--porcelain');
  const r = step(['issues', '--work', w, '--usage', 'reviewer=40k@3m'], env);
  assert.equal(r.status, 0, r.stdout);
  const j = r.json;
  assert.equal(j.step, 'issues');
  assert.equal(j.ok, true);
  const dir = slugDir(home);
  assert.equal(j.files.issues, join(dir, 'issues.json'));
  assert.equal(j.files.html, join(dir, 'archmap.internal.html'));
  for (const f of Object.values(j.files)) {
    assert.ok(existsSync(f), `${f} written`);
    assert.ok(!f.startsWith(repo), `${f} is outside the repository`);
  }
  assert.equal(git(repo, 'status', '--porcelain'), before, 'the repository is untouched');
  assert.deepEqual(readJson(j.files.issues).issues.map((x) => x.id), [issue.id]);
  assert.match(readFileSync(j.files.html, 'utf8'), /zq-pipeline-issue/, 'the internal build carries the issue');
  assert.equal(j.validate.exit, 0);
  assert.match(j.validate.command, /validate\.mjs.*--issues/);
  assert.equal(j.counts.issues, 1);
  assert.ok(j.runs.some((x) => x.script === 'issues.mjs' && x.exit === 0));
  assert.ok(j.runs.some((x) => x.script === 'render.mjs' && x.exit === 0));
  const reviewer = ledgerRows(w).filter((x) => x.phase === 'reviewer');
  assert.deepEqual(reviewer.map((x) => [x.agent, x.model, x.tokens, x.durationMs]), [['archmap-reviewer', 'opus', 40000, 180000]]);
  assert.match(j.report, /reviewer/, 'the printed ledger names the reviewer');
  assert.ok(r.stdout.length < 6000);
  assert.doesNotMatch(r.stdout, /ZQDETAIL-PIPE/, 'no issue content on stdout');
  // a second run replaces, never duplicates: the overlay and the ledger row are the same
  const bytes = readFileSync(j.files.issues, 'utf8');
  assert.equal(step(['issues', '--work', w, '--usage', 'reviewer=40k@3m'], env).status, 0);
  assert.equal(readFileSync(j.files.issues, 'utf8'), bytes);
  assert.equal(ledgerRows(w).filter((x) => x.phase === 'reviewer').length, 1);
  // any label for the reviewer's usage is taken
  assert.equal(step(['issues', '--work', w, '--usage', 'reviewer-2=1k'], env).status, 0);
});

test('p26 the issues step exits 2 naming the path when <work>/reviewer.json is missing, and exits 1 with the findings, writing no overlay, over an issue anchored to nothing', () => {
  const home = join(tmp, 'home-p26');
  mkdirSync(home);
  const env = GIT_HOME_ENV(home);
  const w = readyForRender('work-p26');
  const o = join(tmp, 'out-work-p26');
  assert.equal(step(['render', '--work', w]).status, 0);
  const missing = step(['issues', '--work', w], env);
  assert.equal(missing.status, 2, missing.stdout);
  assert.equal(missing.json.step, 'issues');
  assert.ok(missing.json.error.includes(join(w, 'reviewer.json')), missing.json.error);
  reviewerFile(w, o, { anchor: { node: 'no-such-node' } });
  const bad = step(['issues', '--work', w], env);
  assert.equal(bad.status, 1, bad.stdout);
  assert.ok(bad.json.runs.some((x) => x.script === 'issues.mjs' && x.exit === 1));
  assert.equal(existsSync(join(slugDir(home), 'issues.json')), false, 'no overlay written');
  // a work dir that was not planned with --issues is a usage error, not a silent no-op
  const w2 = readyForRender('work-p26b', []);
  assert.equal(step(['render', '--work', w2]).status, 0);
  writeFileSync(join(w2, 'reviewer.json'), '{"issues":[]}');
  assert.equal(step(['issues', '--work', w2], env).status, 2);
});

// ---------------------------------------------------------------------------------------------
// P10.13: SQL run over a connection is a schema too. The summary states how many tables queries name that nothing
// declares, the brief and the agent say the script makes the tables the summary lists and the explorer adds the
// entities the summary lacks, and finish turns the statements into entities.

test('p27 the summary states the count of tables only queries name; the brief tells the explorer the listed tables are made by script and to add entities for tables, datasets or collections the summary does not list, each with evidence; finish makes declared and inferred entities from the SQL', () => {
  const code =
    'import sqlite3\n\n' +
    'def run(conn):\n' +
    '    conn.executescript("CREATE TABLE IF NOT EXISTS kiosk_visits (id INTEGER PRIMARY KEY, kiosk_id INTEGER, seen_at TEXT)")\n' +
    '    conn.execute("INSERT INTO kiosk_visits (kiosk_id) VALUES (1)")\n' +
    '    rows = conn.execute("SELECT * FROM kiosk_visits v JOIN kiosk_notes n ON n.vid = v.id").fetchall()\n' +
    '    conn.execute("DELETE FROM kiosk_alerts WHERE seen = 1")\n' +
    '    return rows\n';
  const { r, w } = dbRepo('sql-code', { code });
  const sums = readdirSync(join(w, 'extracts')).filter((f) => f.endsWith('.summary.json')).map((f) => readJson(join(w, 'extracts', f)));
  const sum = sums.find((s) => s.counts.sqlTables > 0);
  assert.ok(sum, 'an area lists the statements');
  assert.equal(sum.counts.inferredTables, 2, 'kiosk_notes and kiosk_alerts: queried, declared nowhere');
  assert.match(sum.note, /inferred/i, 'the note says what the count means');
  const full = readJson(join(w, 'extracts', `${sum.area}.json`));
  assert.ok(!('inferredTables' in (full.counts ?? {})), 'the full extract holds rows, not the summary count');
  for (const a of readJson(join(w, 'prescan.json')).areas) {
    const brief = readFileSync(join(w, 'briefs', `${a.id}.md`), 'utf8');
    assert.match(brief, /tables the summary lists[^.]*\bscript\b/i, `${a.id}: the listed tables are the script's`);
    assert.match(brief, /add\s+entities\s+for\s+tables, datasets or collections[^.]*(not list|lacks|does not)/i, `${a.id}: the explorer adds what the summary lacks`);
    assert.match(brief, /evidence/i);
    assert.ok(brief.length <= BRIEF_CAP, `${a.id}: ${brief.length} characters`);
  }

  const none = step(['finish', '--work', w]);
  assert.equal(none.status, 0, none.stdout);
  const model = readJson(join(w, 'model.json'));
  const byName = Object.fromEntries(model.entities.map((e) => [e.name, e]));
  assert.deepEqual(byName.kiosk_visits.fields.map((f) => `${f.name}:${f.provenance}`), ['id:declared', 'kiosk_id:declared', 'seen_at:declared']);
  for (const t of ['kiosk_notes', 'kiosk_alerts']) {
    assert.equal(byName[t].provenance, 'inferred', t);
    assert.deepEqual(byName[t].fields, []);
    assert.equal(byName[t].evidence[0].path, 'src/entities/load.py');
  }
  assert.deepEqual(byName.kiosk_notes.evidence, [{ path: 'src/entities/load.py', lines: '6' }]);
  assert.ok(model.access.some((a) => a.entity === byName.kiosk_alerts.id && a.ops === 'D'), JSON.stringify(model.access));
  const v = spawnSync(process.execPath, [VALIDATE, join(w, 'model.json'), '--repo', r], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test('p28 the explorer brief of an area holding a workspace app names the app and says its app node is made by script; the coverage floor counts middleware modules; both stay under the brief cap', async () => {
  const { coverageFloor, explorerBrief } = await import('../scripts/pipeline.mjs');
  const cov = coverageFloor({ routes: [{ file: 'a.ts' }], middleware: ['src/middleware', 'src/auth.guard.ts'] });
  assert.equal(cov.counts['middleware modules'], 2);
  assert.equal(cov.floor, 3, 'one route group and two middleware modules');
  assert.deepEqual(cov.names['middleware modules'], ['src/middleware', 'src/auth.guard.ts']);
  assert.deepEqual(coverageFloor({ workspaceApps: [{ name: 'x', dir: 'apps/x', manifest: 'apps/x/package.json' }] }).apps, [{ name: 'x', dir: 'apps/x', manifest: 'apps/x/package.json' }]);

  const area = { id: 'apps-hub', title: 'apps/hub', files: 5, stacks: ['node-backend'], globs: ['apps/hub/**'] };
  const base = { area, summary: '/w/extracts/apps-hub.summary.json', fragment: '/w/fragments/apps-hub.json', profile: 'balanced' };
  const plain = explorerBrief({ ...base, coverage: coverageFloor({}) });
  assert.doesNotMatch(plain, /workspace app/i, 'an area with no app has no app line');
  const withApp = explorerBrief({ ...base, coverage: coverageFloor({ workspaceApps: [{ name: '@fict/hub', dir: 'apps/hub', manifest: 'apps/hub/package.json' }], middleware: ['apps/hub/src/middleware'] }) });
  assert.match(withApp, /workspace app[^\n]*@fict\/hub[^\n]*apps\/hub/i);
  assert.match(withApp, /app node[^\n]*(made|written)[^\n]*script|script[^\n]*app node/i);
  assert.match(withApp, /middleware modules=1/);
  assert.match(withApp, /src\/middleware/);

  // through plan: a workspace monorepo with a middleware directory
  const repo = join(tmp, 'mono');
  mkdirSync(join(repo, 'apps/hub/src/middleware'), { recursive: true });
  mkdirSync(join(repo, 'apps/atlas/src'), { recursive: true });
  mkdirSync(join(repo, 'packages/kit/src'), { recursive: true });
  writeFileSync(join(repo, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  writeFileSync(join(repo, 'package.json'), '{"name":"fict-root","private":true}\n');
  writeFileSync(join(repo, 'apps/hub/package.json'), '{"name":"@fict/hub","dependencies":{"express":"4"}}\n');
  writeFileSync(join(repo, 'apps/hub/src/main.ts'), 'export {};\n');
  writeFileSync(join(repo, 'apps/hub/src/middleware/auth.ts'), 'export {};\n');
  writeFileSync(join(repo, 'apps/atlas/package.json'), '{"name":"@fict/atlas"}\n');
  writeFileSync(join(repo, 'apps/atlas/src/main.ts'), 'export {};\n');
  writeFileSync(join(repo, 'packages/kit/package.json'), '{"name":"@fict/kit"}\n');
  writeFileSync(join(repo, 'packages/kit/src/index.ts'), 'export {};\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial');
  const w = join(tmp, 'work-mono');
  const r = step(['plan', repo, '--work', w, '--out', join(tmp, 'out-mono'), '--project', 'mono', '--generated-at', GENERATED_AT]);
  assert.equal(r.status, 0, r.stdout);
  const brief = readFileSync(join(w, 'briefs', 'apps-hub.md'), 'utf8');
  assert.match(brief, /workspace app[^\n]*@fict\/hub[^\n]*apps\/hub/i);
  assert.match(brief, /middleware modules=1/);
  assert.ok(brief.length <= BRIEF_CAP, `${brief.length} characters`);
  const areas = readJson(join(w, 'prescan.json')).areas.map((x) => x.id);
  assert.deepEqual(areas.filter((id) => /^apps-/.test(id)), ['apps-atlas', 'apps-hub'], areas.join());
  const atlas = readFileSync(join(w, 'briefs', 'apps-atlas.md'), 'utf8');
  assert.match(atlas, /workspace app[^\n]*@fict\/atlas/i);
  assert.doesNotMatch(atlas, /@fict\/hub/, 'each brief names its own app');
});

// ---------------------------------------------------------------------------------------------
// P10.15: the trim ladder has a terminal rung, so a brief always fits; the throw is only a last guard.

test('p29 fitExplorerBrief never throws: an area with 30 globs, an extract over the node cap and a 200-character work path fits under BRIEF_CAP, in --update mode with a 200-character previous path too, the note names the last rung, and the contract and the file paths stay intact', async () => {
  const { BRIEF_TRIMS, coverageFloor, explorerBrief, fitExplorerBrief } = await import('../scripts/pipeline.mjs');
  const work = `/${'nested-work-directory/'.repeat(10)}`.slice(0, 200);
  assert.equal(work.length, 200);
  const pad = (i) => String(i).padStart(2, '0');
  const globs = Array.from({ length: 30 }, (_, i) => `packages/widget-${pad(i)}-${'component'.repeat(3)}/**`);
  const extract = {
    entryPoints: Array.from({ length: 37 }, (_, i) => `packages/widget-${pad(i)}-${'component'.repeat(3)}/src/main.ts`),
    routes: Array.from({ length: 12 }, (_, i) => ({ file: `packages/widget-${pad(i)}/src/routes/orders-${pad(i)}.ts` })),
    clients: Array.from({ length: 52 }, (_, i) => ({ client: `tenants-client-${pad(i)}-${'x'.repeat(24)}` })),
    middleware: Array.from({ length: 9 }, (_, i) => `packages/widget-${pad(i)}/src/middleware`),
    modules: Array.from({ length: 14 }, (_, i) => `packages/widget-${pad(i)}/service/orders_${pad(i)}.py`),
    workspaceApps: Array.from({ length: 6 }, (_, i) => ({ name: `@fict/tenant-router-${pad(i)}-${'gateway'.repeat(3)}`, dir: `apps/tenant-router-${pad(i)}-${'gateway'.repeat(3)}`, manifest: 'x' })),
  };
  const coverage = coverageFloor(extract);
  const id = 'apps-tenant-router';
  const area = { id, title: `apps/tenant-router + ${globs.join(', ')}`, files: 1205, stacks: ['node-backend', 'python', 'ts-frontend'], globs };
  const input = {
    area, coverage, profile: 'balanced',
    summary: `${work}/extracts/${id}.summary.json`,
    fragment: `${work}/fragments/${id}.json`,
    stackRef: `${work}/references/stack-node-backend.md`,
  };
  const full = explorerBrief(input);
  assert.ok(full.length > BRIEF_CAP, `the input is over the cap untrimmed (${full.length})`);
  let fit;
  assert.doesNotThrow(() => { fit = fitExplorerBrief(input, id); });
  assert.ok(fit.text.length <= BRIEF_CAP, `${fit.text.length} characters`);
  const rungs = BRIEF_TRIMS.map((t) => t.drop);
  assert.deepEqual(fit.note.dropped, rungs, 'this area needs every rung, in order');
  assert.equal(fit.note.dropped[fit.note.dropped.length - 1], rungs[rungs.length - 1], 'the note names the last rung');
  assert.equal(fit.note.area, id);
  assert.equal(fit.note.after, fit.text.length);
  assert.equal(fit.note.before, full.length);
  const contract = (t) => t.slice(t.indexOf('## Fragment contract'));
  assert.ok(contract(full).length > 1000);
  assert.equal(contract(fit.text), contract(full), 'the contract section is never cut');
  assert.ok(fit.text.includes(input.summary), 'the summary path');
  assert.ok(fit.text.includes(input.fragment), 'the fragment path');
  assert.match(fit.text, new RegExp(`Coverage floor: at least ${coverage.floor} nodes`), 'the floor keeps its count');
  assert.doesNotMatch(fit.text, /Each of these needs its own node/, 'the floor names went with the terminal rungs');

  // P10.16: the same area in --update mode carries the previous-model line (a path as long as the work path): it still fits
  const updating = { ...input, previous: `${work}/model.json` };
  assert.ok(explorerBrief(updating).length > full.length, 'the previous line adds to the brief');
  let upd;
  assert.doesNotThrow(() => { upd = fitExplorerBrief(updating, id); });
  assert.ok(upd.text.length <= BRIEF_CAP, `update mode: ${upd.text.length} characters`);
  assert.ok(upd.text.includes(updating.previous), 'the previous model path is kept');
  assert.equal(contract(upd.text), contract(explorerBrief(updating)), 'the contract section is never cut');
  assert.ok(upd.text.includes(input.summary) && upd.text.includes(input.fragment), 'both file paths stay');
});

// ---------------------------------------------------------------------------------------------
// P10.16: pipeline hardening from the P10 phase review.

test('p30 a repo holding a duckdb.py that writes a marker is scanned with a .duckdb file present: the probe and the query run python3 -I outside the repo, so the marker is never written', () => {
  const marker = join(tmp, 'planted-duckdb-ran.marker');
  const planted = `open(${JSON.stringify(marker)}, "w").write("the scanned repo's duckdb.py ran")\n`;
  const r = fixtureRepo('db-planted');
  writeFileSync(join(r, 'src/entities/load.py'), 'import duckdb\n\nWAREHOUSE = duckdb.connect("src/entities/warehouse.duckdb")\n');
  writeFileSync(join(r, 'src/entities/warehouse.duckdb'), 'not a database, only a file of that name\n');
  writeFileSync(join(r, 'duckdb.py'), planted);
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'planted module');
  const w = join(tmp, 'work-db-planted');
  assert.equal(step(['plan', r, '--work', w, '--out', join(tmp, 'out-db-planted'), '--generated-at', GENERATED_AT], undefined, r).status, 0);
  cannedInto(w);

  // the real interpreter, run from the scanned repo's root as SKILL.md has it, with no duckdb CLI on PATH
  const which = spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
  if (which.status === 0) {
    const py = realpathSync(which.stdout.trim());
    // control: the planted file is what a plain `python3 -c "import duckdb"` from the repo root imports
    spawnSync(py, ['-c', 'import duckdb'], { cwd: r, encoding: 'utf8' });
    assert.ok(existsSync(marker), 'the control run imports the planted duckdb.py, so the check below has teeth');
    rmSync(marker);
    const bin = binWith('real-python');
    if (!existsSync(join(bin, 'python3'))) symlinkSync(py, join(bin, 'python3'));
    const f = step(['finish', '--work', w], { ...process.env, PATH: bin }, r);
    assert.equal(f.status, 0, f.stdout);
    assert.ok(!existsSync(marker), 'finish never imported the duckdb.py of the scanned repo');
  }

  // a stand-in records where and how it ran: every call carries -I before -c, and none runs in the repo
  const log = join(tmp, 'python-isolated.log');
  // shell builtins only: PATH holds git and this stand-in, nothing else
  const stub = `#!/bin/sh\n${PY_CODE_ARG}printf '%s\\n' "$code" | { IFS= read -r first; echo "$(pwd -P)|$1|$first" >> "${log}"; }\n` +
    'if [ "$code" = "import duckdb" ]; then exit 0; fi\n' +
    "printf 'table\\tevents\\t1\\tid\\tBIGINT\\t0\\t1\\n'\n";
  const f2 = step(['finish', '--work', w], { ...process.env, PATH: binWith('py-isolated', null, stub) }, r);
  assert.equal(f2.status, 0, f2.stdout);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split('|'));
  assert.ok(calls.length >= 2, `the probe and the query both ran: ${JSON.stringify(calls)}`);
  assert.ok(calls.some(([, , code]) => code === 'import duckdb'), 'the probe ran');
  const real = realpathSync(r);
  for (const [cwd, first] of calls) {
    assert.equal(first, '-I', `python3 runs in isolated mode: ${JSON.stringify(calls)}`);
    assert.ok(cwd !== real && !cwd.startsWith(`${real}/`), `python3 runs outside the repo, not in ${cwd}`);
  }
  assert.ok(readJson(join(w, 'model.json')).entities.some((e) => e.name === 'events'), 'the query still reads the schema');
  assert.ok(!existsSync(marker));
});

test('p31 coverageFloor clamps the floor to the node cap for an area with more than 40 groups, and the brief says the extract holds more than the cap', async () => {
  const { coverageFloor, explorerBrief } = await import('../scripts/pipeline.mjs');
  const routes = Array.from({ length: 45 }, (_, i) => ({ file: `src/routes/feature-${String(i).padStart(2, '0')}.ts` }));
  const big = coverageFloor({ routes });
  assert.equal(big.floor, NODE_CAP, 'the floor is never above the cap the merge truncates to');
  assert.equal(big.counts['route groups'], 45, 'the parts still count everything the extract holds');
  assert.equal(coverageFloor({ routes: routes.slice(0, 3) }).floor, 3, 'a floor under the cap is the plain sum');
  assert.equal(coverageFloor({ routes: routes.slice(0, NODE_CAP) }).floor, NODE_CAP, 'exactly the cap is not clamped');

  const area = { id: 'src', title: 'src', files: 46, stacks: ['node-backend'], globs: ['src/**'] };
  const base = { area, summary: '/w/extracts/src.summary.json', fragment: '/w/fragments/src.json', profile: 'balanced' };
  const brief = explorerBrief({ ...base, coverage: big });
  assert.match(brief, new RegExp(`Coverage floor: at least ${NODE_CAP} nodes`));
  assert.match(brief, new RegExp(`extract holds 45[^\\n]*more than the ${NODE_CAP}-node cap`, 'i'));
  const atCap = explorerBrief({ ...base, coverage: coverageFloor({ routes: routes.slice(0, NODE_CAP) }) });
  assert.doesNotMatch(atCap, /more than the \d+-node cap/i, 'no cap note when the extract fits');

  // p18-style through plan: 45 router modules in one backend
  const dir = join(tmp, 'more-routers-than-cap');
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'many', dependencies: { express: '^4.0.0' } }));
  writeFileSync(join(dir, 'src', 'app.ts'), "import express from 'express';\nconst app = express();\napp.listen(3000);\n");
  for (let i = 0; i < 45; i++) {
    const name = `feature-${String(i).padStart(2, '0')}-${'long'.repeat(8)}`;
    writeFileSync(join(dir, 'src', 'routes', `${name}.ts`), `import { Router } from 'express';\nconst router = Router();\nrouter.get('/${name}', (req, res) => res.json([]));\nexport default router;\n`);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  const w = join(tmp, 'work-more-routers');
  const r = step(['plan', dir, '--work', w, '--out', join(tmp, 'out-more-routers'), '--generated-at', GENERATED_AT]);
  assert.equal(r.status, 0, r.stdout);
  let over = 0;
  for (const a of r.json.areas) {
    const text = readFileSync(join(w, 'briefs', `${a.id}.md`), 'utf8');
    assert.ok(text.length <= BRIEF_CAP, `${a.id}: ${text.length} characters`);
    const { total, parts } = floorOf(text);
    assert.deepEqual(parts, expectedFloor(readJson(join(w, 'extracts', `${a.id}.json`))), a.id);
    assert.ok(total <= NODE_CAP, `${a.id}: floor ${total} is at most the cap`);
    const sum = Object.values(parts).reduce((x, y) => x + y, 0);
    if (sum > NODE_CAP) {
      over += 1;
      assert.equal(total, NODE_CAP, a.id);
      assert.match(text, new RegExp(`extract holds ${sum}[^\\n]*more than the ${NODE_CAP}-node cap`, 'i'), `${a.id}: the cap note survives the trimming`);
    }
  }
  assert.ok(over >= 1, 'one area holds more groups than the cap');
});

test('p32 plan refuses (exit 2) a pre-existing default work dir that is a symlink or not owned by the current uid, and creates a fresh one with mode 0o700', async () => {
  const { privateDir } = await import('../scripts/pipeline.mjs');
  const envFor = (home) => ({ PATH: process.env.PATH, TMPDIR: home, TEMP: home, TMP: home });
  const planDefault = (home) => step(['plan', repo, '--out', join(tmp, 'out-p32'), '--generated-at', GENERATED_AT], envFor(home));

  const fresh = join(tmp, 'os-tmp-fresh');
  mkdirSync(fresh);
  const a = planDefault(fresh);
  assert.equal(a.status, 0, a.stdout);
  const wd = a.json.work;
  assert.equal(statSync(wd).mode & 0o777, 0o700, 'the work dir is private to the user');
  assert.equal(statSync(join(wd, '..')).mode & 0o777, 0o700, 'so is the archmap directory above it');
  const hash = wd.split('/').pop();

  // the work dir itself is a symlink somebody planted: refused, nothing removed or written through it
  const linked = join(tmp, 'os-tmp-linked');
  mkdirSync(join(linked, 'archmap'), { recursive: true, mode: 0o700 });
  const target = join(tmp, 'planted-target');
  mkdirSync(join(target, 'briefs'), { recursive: true });
  writeFileSync(join(target, 'prescan.json'), 'somebody else\'s file\n');
  symlinkSync(target, join(linked, 'archmap', hash));
  const b = planDefault(linked);
  assert.equal(b.status, 2, b.stdout);
  assert.match(b.json.error ?? b.stdout, /symlink/i);
  assert.equal(readFileSync(join(target, 'prescan.json'), 'utf8'), 'somebody else\'s file\n');
  assert.deepEqual(readdirSync(target).sort(), ['briefs', 'prescan.json']);
  assert.deepEqual(readdirSync(join(target, 'briefs')), []);

  // the archmap directory above it is a symlink: refused as well
  const parent = join(tmp, 'os-tmp-parent');
  mkdirSync(parent);
  const target2 = join(tmp, 'planted-parent');
  mkdirSync(target2);
  symlinkSync(target2, join(parent, 'archmap'));
  const c = planDefault(parent);
  assert.equal(c.status, 2, c.stdout);
  assert.match(c.json.error ?? c.stdout, /symlink/i);
  assert.deepEqual(readdirSync(target2), [], 'nothing was made through the link');

  // not owned by the current uid: one user here, so the check is driven with another uid
  if (typeof process.getuid === 'function') {
    const uid = process.getuid();
    const mine = join(tmp, 'private-mine');
    mkdirSync(mine);
    chmodSync(mine, 0o755);
    assert.match(String(privateDir(mine, uid + 1)), /not owned/i, 'a directory of another uid is refused');
    assert.equal(privateDir(mine, uid), null, 'the user\'s own directory is accepted');
    assert.equal(statSync(mine).mode & 0o777, 0o700, 'and made private');
    const made = join(tmp, 'private-made');
    assert.equal(privateDir(made, uid), null);
    assert.equal(statSync(made).mode & 0o777, 0o700, 'a fresh one is created private');
    const link = join(tmp, 'private-link');
    symlinkSync(mine, link);
    assert.match(String(privateDir(link, uid)), /symlink/i);
  }
});

test('p33 a symlink inside the repo pointing at a database file outside it gets the outside-the-repository skip row (realpath comparison), and the target is never opened', () => {
  const outside = join(tmp, 'outside-warehouse.duckdb');
  writeFileSync(outside, 'a database somewhere else on the machine\n');
  const r = fixtureRepo('db-escape');
  writeFileSync(join(r, 'src/entities/load.py'), 'import duckdb\n\nWAREHOUSE = duckdb.connect("src/entities/warehouse.duckdb")\n');
  symlinkSync(outside, join(r, 'src/entities/warehouse.duckdb'));
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'escaping link');
  const w = join(tmp, 'work-db-escape');
  assert.equal(step(['plan', r, '--work', w, '--out', join(tmp, 'out-db-escape'), '--generated-at', GENERATED_AT]).status, 0);
  cannedInto(w);
  const log = join(tmp, 'duckdb-escape.log');
  const stub = '#!/bin/sh\nif [ "$1" = "-version" ]; then echo v0.0.0; exit 0; fi\n' +
    `echo "$@" >> "${log}"\n` +
    "printf 'table\\tevents\\t1\\tid\\tBIGINT\\t0\\t1\\n'\n";
  const f = step(['finish', '--work', w], { ...process.env, PATH: binWith('duckdb-escape', stub) });
  assert.equal(f.status, 0, f.stdout);
  const m = readJson(join(w, 'model.json'));
  const skip = m.meta.sources.find((x) => x.type === 'introspection-skipped' && x.path === 'src/entities/warehouse.duckdb');
  assert.ok(skip, JSON.stringify(m.meta.sources));
  assert.match(skip.reason, /outside the repository/);
  assert.ok(!existsSync(log), 'the database the link points at is never copied and queried');
  assert.ok(!m.entities.some((e) => e.name === 'events'));
});
