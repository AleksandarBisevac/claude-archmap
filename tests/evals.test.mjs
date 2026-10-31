import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (e1, e2, ...) lead every title so the suite prints them first.
// skills/architecture-map/evals/ holds the skill-creator eval set (docs/design.md section 10).
// The repo is public: eval prompts reach the eval repos only through ARCHMAP_EVAL_REPO_A/B/C and
// never carry a path of any machine.
const evalsDir = new URL('../skills/architecture-map/evals/', import.meta.url);
const evalsPath = new URL('evals.json', evalsDir);
const readmePath = new URL('README.md', evalsDir);

const load = () => {
  assert.ok(existsSync(evalsPath), 'skills/architecture-map/evals/evals.json exists');
  return JSON.parse(readFileSync(evalsPath, 'utf8'));
};

// skill-creator reads the checkable statements from `expectations`; `assertions` is accepted as the
// task's own word for them.
const assertionsOf = (e) => e.expectations ?? e.assertions;

const REPO_VAR = /ARCHMAP_EVAL_REPO_([A-Za-z0-9_]*)/g;
// An absolute (/x, C:\), home-relative (~/) or parent-relative (../) path in prose or in a command.
const PATH_LIKE = new RegExp(
  [
    '(^|[\\s"\'`(=:])~[\\/\\\\]', // ~/x
    '[A-Za-z]:[\\\\/]', // C:\\x
    '(^|[\\s"\'`(=:])\\/[A-Za-z.][\\w.-]*\\/', // /abs/x (a slash command such as /archmap:build has no second slash)
    '(^|[\\s"\'`(=:])\\/(tmp|etc|var|opt|usr|mnt|private|home|Users)\\b', // a bare system root
    '\\.\\.[\\/\\\\]', // ../x
  ].join('|'),
);

test('e1 evals.json parses, names the skill and has exactly five evals with ids 1-5, each with prompt, expected_output and >= 3 assertions', () => {
  const doc = load();
  assert.equal(doc.skill_name, 'architecture-map');
  assert.ok(Array.isArray(doc.evals), 'evals is an array');
  assert.deepEqual(doc.evals.map((e) => e.id), [1, 2, 3, 4, 5]);
  for (const e of doc.evals) {
    assert.equal(typeof e.prompt, 'string', `eval ${e.id} prompt is a string`);
    assert.ok(e.prompt.trim().length > 0, `eval ${e.id} prompt is non-empty`);
    assert.equal(typeof e.expected_output, 'string', `eval ${e.id} expected_output is a string`);
    assert.ok(e.expected_output.trim().length > 0, `eval ${e.id} expected_output is non-empty`);
    const a = assertionsOf(e);
    assert.ok(Array.isArray(a) && a.length >= 3, `eval ${e.id} has at least three assertions`);
    for (const s of a) assert.ok(typeof s === 'string' && s.trim().length > 0, `eval ${e.id} assertion is non-empty text`);
  }
});

test('e2 no eval prompt contains an absolute or home-relative path; every repo reference is ARCHMAP_EVAL_REPO_A, _B or _C', () => {
  const doc = load();
  for (const e of doc.evals) {
    assert.doesNotMatch(e.prompt, PATH_LIKE, `eval ${e.id} prompt carries a machine path`);
    const refs = [...e.prompt.matchAll(REPO_VAR)].map((m) => m[1]);
    assert.ok(refs.length >= 1, `eval ${e.id} prompt references an eval repo`);
    for (const r of refs) assert.ok(['A', 'B', 'C'].includes(r), `eval ${e.id} references ARCHMAP_EVAL_REPO_${r}`);
  }
  // The brief's mapping: evals 1-3 run on repo A, 4 on B, 5 on C.
  const repoOf = (e) => new Set([...e.prompt.matchAll(REPO_VAR)].map((m) => m[1]));
  const byId = Object.fromEntries(doc.evals.map((e) => [e.id, repoOf(e)]));
  assert.deepEqual([...byId[1]], ['A']);
  assert.deepEqual([...byId[2]], ['A']);
  assert.deepEqual([...byId[3]], ['A']);
  assert.deepEqual([...byId[4]], ['B']);
  assert.deepEqual([...byId[5]], ['C']);
});

test('e3 no tracked eval file carries an absolute or home path, and .private is referenced only relative to .private', () => {
  const doc = load();
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /\/(Users|home)\/|[A-Za-z]:\\\\/, 'evals.json carries no machine path');
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  assert.doesNotMatch(readme, /\/(Users|home)\//, 'README carries no machine path');
  for (const m of (text + readme).matchAll(/(\S*)\.private\/(\S*)/g)) {
    assert.doesNotMatch(m[1], /[\/~]$/, `.private referenced through a parent path: ${m[0]}`);
  }
});

test('e4 README names the three env vars and the workspace directory outside the repo', () => {
  assert.ok(existsSync(readmePath), 'skills/architecture-map/evals/README.md exists');
  const readme = readFileSync(readmePath, 'utf8');
  for (const v of ['ARCHMAP_EVAL_REPO_A', 'ARCHMAP_EVAL_REPO_B', 'ARCHMAP_EVAL_REPO_C']) {
    assert.ok(readme.includes(v), `README names ${v}`);
  }
  assert.match(readme, /\.claude\/archmap\/evals\//, 'README names the workspace directory under the home .claude');
  assert.match(readme, /generate_review\.py/, 'README names the owner review viewer');
  assert.match(readme, /without-skill|without_skill/, 'README covers the without-skill baseline');
});

test('e5 the path detector flags machine paths and lets slash commands, env vars and repo-relative paths through', () => {
  for (const bad of ['read /Users/x/repo', 'cd ~/code', 'open ../other', 'in /tmp/work', 'see C:\\repo', 'at (/srv/app/x)']) {
    assert.match(bad, PATH_LIKE, bad);
  }
  for (const good of ['Run /archmap:build on $ARCHMAP_EVAL_REPO_A', 'write docs/architecture/architecture.model.json', 'the .claude/archmap/evals folder']) {
    assert.doesNotMatch(good, PATH_LIKE, good);
  }
});

// e6-e13: skills/architecture-map/evals/score-recall.mjs on a synthetic, non-client ground truth
// (tests/fixtures/evals/). Reference issues G1-G4 count (high+med), G5 is low and never counts.
//   G1 matches I-1 on category plus anchor; G2 matches I-2 on category plus keyword (anchor differs);
//   G3 matches I-3 on category plus keyword; G4 stays a miss (I-4 has the keyword but the wrong category).
const SCORER = fileURLToPath(new URL('../skills/architecture-map/evals/score-recall.mjs', import.meta.url));
const FIXDIR = (n) => fileURLToPath(new URL(`./fixtures/evals/${n}`, import.meta.url));
const GT = FIXDIR('ground-truth.json');
const ISSUES = FIXDIR('issues.json');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-evals-')));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
let nTmp = 0;
const put = (obj, raw) => {
  const p = join(scratch, `f${++nTmp}.json`);
  writeFileSync(p, raw ?? JSON.stringify(obj));
  return p;
};
const score = (...args) => {
  const r = spawnSync(process.execPath, [SCORER, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const fixtureIssues = () => JSON.parse(readFileSync(ISSUES, 'utf8')).issues;
const issuesFile = (list) => put({ issues: list });
const ref = (id, sev, category, anchor, keywords) => ({ id, sev, category, anchor, keywords });
const prod = (id, category, anchorNode, text) => ({
  id, sev: 'high', category, title: id, anchor: { node: anchorNode }, summary: text, impact: '', fix: '',
  evidence: [{ path: 'x.js', lines: '1' }], source: 'archmap',
});

test('e6 on the synthetic fixtures recall is 3 of 4 high+med reference issues (0.75) and the run exits 0', () => {
  const r = score(ISSUES, GT, '--json');
  assert.equal(r.status, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.counted, 4);
  assert.equal(j.recalled, 3);
  assert.equal(j.recall, 0.75);
  assert.equal(j.threshold, 0.6);
  assert.equal(j.pass, true);
});

test('e7 matched pairs and misses are listed: G1<-I-1 (anchor), G2<-I-2 and G3<-I-3 (keyword), G4 missed (category differs)', () => {
  const j = JSON.parse(score(ISSUES, GT, '--json').out);
  assert.deepEqual(j.matched.map((m) => [m.reference, m.produced]), [['G1', 'I-1'], ['G2', 'I-2'], ['G3', 'I-3']]);
  assert.deepEqual(j.misses.map((m) => m.id), ['G4']);
  const text = score(ISSUES, GT);
  assert.equal(text.status, 0);
  assert.match(text.out, /recall\s+0\.75/i);
  assert.match(text.out, /3\s*\/\s*4/);
  assert.match(text.out, /G1\b.*I-1/);
  assert.match(text.out, /G3\b.*I-3/);
  assert.match(text.out, /miss/i);
  assert.match(text.out, /G4\b/);
  assert.doesNotMatch(text.out, /G5/, 'a low-severity reference issue is neither matched nor missed');
});

test('e8 low-severity reference issues do not count: dropping or hitting G5 leaves counted and recall unchanged', () => {
  const gt = JSON.parse(readFileSync(GT, 'utf8'));
  const without = JSON.parse(score(ISSUES, put(gt.filter((g) => g.sev !== 'low')), '--json').out);
  const withLow = JSON.parse(score(ISSUES, GT, '--json').out);
  assert.equal(withLow.counted, without.counted);
  assert.equal(withLow.recall, without.recall);
  assert.ok(!withLow.matched.some((m) => m.reference === 'G5'));
  // All low only: nothing to score, so no recall exists and that is bad input.
  assert.equal(score(ISSUES, put([ref('L', 'low', 'docs', 'n-gateway', ['readme'])])).status, 2);
});

test('e9 an extra produced issue that matches nothing does not raise recall', () => {
  const base = JSON.parse(score(ISSUES, GT, '--json').out);
  const noisy = [...fixtureIssues(), ...['a', 'b', 'c', 'd'].map((k) => prod(`N-${k}`, 'design', `n-${k}`, `unrelated ${k}`))];
  const j = JSON.parse(score(issuesFile(noisy), GT, '--json').out);
  assert.equal(j.recall, base.recall);
  assert.equal(j.recalled, base.recalled);
  // Fewer produced issues can only lower it: only I-1 left.
  const lone = JSON.parse(score(issuesFile([fixtureIssues()[0]]), GT, '--json').out);
  assert.equal(lone.recalled, 1);
  assert.equal(lone.recall, 0.25);
});

test('e10 the threshold is 60 percent: 3 of 5 exits 0, 2 of 4 exits 1, 0 of 4 exits 1', () => {
  const five = put(['A', 'B', 'C', 'D', 'E'].map((k) => ref(k, 'high', 'security', `anchor-${k}`, [`kw-${k}`])));
  const hit = (ks) => issuesFile(ks.map((k) => prod(`P-${k}`, 'security', `anchor-${k}`, 'x')));
  const exactly = score(hit(['A', 'B', 'C']), five, '--json');
  assert.equal(exactly.status, 0);
  assert.equal(JSON.parse(exactly.out).recall, 0.6);
  const four = put(['A', 'B', 'C', 'D'].map((k) => ref(k, 'med', 'security', `anchor-${k}`, [`kw-${k}`])));
  const half = score(hit(['A', 'B']), four, '--json');
  assert.equal(half.status, 1);
  assert.equal(JSON.parse(half.out).pass, false);
  assert.equal(score(issuesFile([]), four).status, 1);
});

test('e11 a match needs the category: right anchor or keyword with the wrong category is a miss; keywords match case-insensitively', () => {
  const gt = put([ref('G', 'high', 'security', 'n-x', ['Token Leak'])]);
  assert.equal(score(issuesFile([prod('P', 'data', 'n-x', 'token leak')]), gt).status, 1);
  const hit = score(issuesFile([prod('P', 'security', 'n-other', 'a TOKEN LEAK in logs')]), gt, '--json');
  assert.equal(hit.status, 0);
  assert.deepEqual(JSON.parse(hit.out).matched.map((m) => [m.reference, m.produced]), [['G', 'P']]);
});

test('e12 one produced issue answers one reference issue: the second reference needs its own produced issue', () => {
  const gt = put([ref('G1', 'high', 'security', 'n-x', ['leak']), ref('G2', 'high', 'security', 'n-x', ['leak'])]);
  const one = JSON.parse(score(issuesFile([prod('P1', 'security', 'n-x', 'leak')]), gt, '--json').out);
  assert.equal(one.recalled, 1);
  const two = JSON.parse(score(issuesFile([prod('P1', 'security', 'n-x', 'leak'), prod('P2', 'security', 'n-x', 'leak')]), gt, '--json').out);
  assert.equal(two.recalled, 2);
});

test('e13 usage errors and unreadable or malformed input exit 2 and print nothing on stdout', () => {
  const bad = [
    [],
    [ISSUES],
    [ISSUES, GT, '--nope'],
    [ISSUES, GT, GT],
    [ISSUES, join(scratch, 'does-not-exist.json')],
    [join(scratch, 'does-not-exist.json'), GT],
    [put(null, '{not json'), GT],
    [ISSUES, put(null, '{broken')],
    [ISSUES, put({ not: 'a list' })],
    [ISSUES, put([{ id: 'G', sev: 'high', category: 'security', anchor: 'n-x' }])], // no keywords
    [ISSUES, put([{ id: 'G', sev: 'urgent', category: 'security', anchor: 'n-x', keywords: ['k'] }])],
    [ISSUES, put([])],
    [put({ issues: 'nope' }), GT],
  ];
  for (const args of bad) {
    const r = score(...args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args.map((a) => a.replace(scratch, '<tmp>')))} exited ${r.status}`);
    assert.equal(r.out, '');
    assert.ok(r.err.length > 0, 'a reason goes to stderr');
  }
});

test('e14 output is byte-identical across runs, in text and in --json, and the header documents the match rule', () => {
  for (const flags of [[], ['--json']]) {
    const a = score(ISSUES, GT, ...flags);
    const b = score(ISSUES, GT, ...flags);
    assert.equal(a.out, b.out);
    assert.equal(a.status, b.status);
  }
  const head = readFileSync(SCORER, 'utf8').split('\n').slice(0, 40).join('\n');
  assert.match(head, /category/i);
  assert.match(head, /anchor/i);
  assert.match(head, /keyword/i);
  assert.match(head, /0\.6|60/);
});

// P8.6: the trigger eval set for skill-creator's run_loop, and the description it tunes.
const triggerPath = new URL('trigger-evals.json', evalsDir);
// A trigger query may name an HTTP route (/api/export); what it may not carry is a machine path.
const MACHINE_PATH = new RegExp(
  [
    '(^|[\\s"\'`(=:])~[\\/\\\\]', // ~/x
    '[A-Za-z]:[\\\\/]', // C:\\x
    '(^|[\\s"\'`(=:])\\/(tmp|etc|var|opt|usr|mnt|private|home|Users)\\b', // a bare system root
    '\\.\\.[\\/\\\\]', // ../x
  ].join('|'),
);
const skillMdPath = new URL('../skills/architecture-map/SKILL.md', import.meta.url);

test('e15 trigger-evals.json is a list of {query, should_trigger} with >= 16 entries, >= 40 percent of each side, no duplicate queries and no machine path', () => {
  assert.ok(existsSync(triggerPath), 'skills/architecture-map/evals/trigger-evals.json exists');
  const set = JSON.parse(readFileSync(triggerPath, 'utf8'));
  assert.ok(Array.isArray(set), 'a JSON array');
  assert.ok(set.length >= 16, `at least 16 entries (got ${set.length})`);
  for (const item of set) {
    assert.deepEqual(Object.keys(item).sort(), ['query', 'should_trigger'], `entry keys: ${JSON.stringify(item)}`);
    assert.equal(typeof item.query, 'string');
    assert.ok(item.query.trim().length >= 15, `a realistic query: ${item.query}`);
    assert.equal(typeof item.should_trigger, 'boolean');
    assert.doesNotMatch(item.query, MACHINE_PATH, `no machine path in: ${item.query}`);
  }
  const yes = set.filter((i) => i.should_trigger).length;
  const no = set.length - yes;
  assert.ok(yes >= set.length * 0.4, `at least 40 percent should trigger (${yes}/${set.length})`);
  assert.ok(no >= set.length * 0.4, `at least 40 percent should not trigger (${no}/${set.length})`);
  const norm = set.map((i) => i.query.trim().toLowerCase());
  assert.equal(new Set(norm).size, norm.length, 'no duplicate queries');
});

test('e16 SKILL.md frontmatter description is one line under 1024 characters and names the skill', () => {
  const text = readFileSync(skillMdPath, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'SKILL.md starts with a frontmatter block');
  const desc = fm[1].match(/^description:\s*(.*)$/m);
  assert.ok(desc, 'frontmatter has a description');
  assert.ok(desc[1].length > 0 && desc[1].length < 1024, `description length ${desc[1].length} is under 1024`);
  assert.match(fm[1], /^name:\s*architecture-map\s*$/m);
});

// P10.19 (P10-R14, P10-R15), P8.10: the cost section says where a turn count missed the 12-turn target and why, records
// eval 2 over its three runs, gives evals 3 and 5 their rows with the baseline caveat, and its shares say what they are
// shares of: the result-event total per run, with the output the per-agent stream under-counts (its lower bound) named as
// the residual, for every eval in the shares table. The checks read a README text, so e18 can feed them a broken one.
const checkCostSection = (readme) => {
  const start = readme.indexOf('## Cost of a build');
  assert.ok(start >= 0, 'the cost section exists');
  const rest = readme.slice(start + 3);
  const cost = rest.slice(0, rest.indexOf('\n## ') < 0 ? rest.length : rest.indexOf('\n## '));
  const flat = cost.replace(/\s+/g, ' ');
  const rows = (re) => cost.split('\n').filter((l) => re.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

  // the turn table: every row over 12 turns is named under the table with the reason
  const head = rows(/^\| Eval \| Iteration 1/)[0];
  assert.ok(head, 'the cost table header');
  const turnsAt = head.indexOf('Orchestrator turns');
  const baselineAt = head.indexOf('Baseline, no skill');
  const resultAt = head.indexOf('Result');
  const evalRows = rows(/^\| \d \(/);
  assert.deepEqual(evalRows.map((r) => r[0].split(' ')[0]), ['1', '2', '3', '4', '5']);
  const byEval = Object.fromEntries(evalRows.map((r) => [r[0].split(' ')[0], r]));
  const over = evalRows.filter((r) => Number(r[turnsAt]) > 12).map((r) => r[0].split(' ')[0]);
  assert.deepEqual(over, ['2', '3', '5'], 'eval 2 (first run), eval 3 (two flows) and eval 5 (13 turns) are the rows over 12 turns');
  assert.match(flat, /exceeded the 12-turn target with 17 turns/, 'the miss is stated');
  assert.match(flat, /exceeded the 12-turn target[^.]*\b(because|:)[^.]*(overlay|ledger)/i, 'and why');
  assert.match(flat, /Eval 3 is an update[^.]*two flows[^.]*12-turn target[^.]*does not apply/i, 'eval 3 is over 12 turns for a stated reason');
  assert.match(flat, /eval 5 took 13 turns, one over the target/i, 'eval 5 is over by one and says so');

  // eval 2: the first run is the row, the reruns and the recall over three runs are stated
  assert.match(flat, /first run/i, 'the eval 2 row says it shows the first run');
  assert.match(flat, /reruns[^.]*took 11 and 13 orchestrator turns/i, 'the reruns turn counts');
  assert.match(byEval[2][resultAt], /0\.67, 0\.53, 0\.53 \(mean 0\.58\)/, 'recall over three runs and its mean in the result cell');
  assert.match(flat, /four medium reference issues, one each in performance, security, reliability and design, (were )?missed in all three runs/i, 'the four issues missed in all three runs, by category');
  assert.doesNotMatch(flat, /two medium reference issues/i, 'the two-issue sentence is gone');

  // P11.4: every eval 2 figure names the run it comes from (first run, rerun 1, rerun 2, then the three P11.2 runs on the P11.1 reviewer)
  assert.match(flat, /recall cell[^.]*first run, rerun 1 and rerun 2/i, 'the eval 2 row says which run each recall value is');
  const runHead = rows(/^\| Run \| Reviewer/)[0];
  assert.ok(runHead, 'the eval 2 per-run table header');
  const runCol = (name) => {
    const at = runHead.findIndex((c) => c.startsWith(name));
    assert.ok(at >= 0, `a per-run column ${name}`);
    return at;
  };
  const runRows = rows(/^\| (first run|rerun [12]|P11\.2 run [123]) \|/);
  assert.deepEqual(runRows.map((r) => r[0]), ['first run', 'rerun 1', 'rerun 2', 'P11.2 run 1', 'P11.2 run 2', 'P11.2 run 3'], 'the six eval 2 runs, each in its own row');
  for (const r of runRows) assert.match(r[runCol('Evidence')], /^`evidence\/iteration-2\/2-with-skill-\d\.json`$/, `${r[0]} names its evidence file`);
  const recallOf = (r) => r[runCol('Recall')];
  const missedOf = (r) => r[runCol('Missed')];
  assert.deepEqual(runRows.slice(0, 3).map(recallOf), ['0.67', '0.53', '0.53'], 'the recall of the first run and the two reruns');
  assert.match(byEval[2][resultAt], /0\.67, 0\.53, 0\.53/, 'and the result cell has the same values in the same order');
  for (const r of runRows.slice(0, 3)) for (const c of ['performance', 'security', 'reliability', 'design']) assert.match(missedOf(r), new RegExp(c), `${r[0]} misses a ${c} issue`);
  assert.deepEqual(runRows.slice(3).map(recallOf), ['0.93', '0.93', '0.93'], 'the recall of the three P11.2 runs');
  assert.deepEqual(runRows.slice(3).map(missedOf).map((c) => c.replace(/ \(.*$/, '')), ['reliability', 'reliability', 'security'], 'the one remaining miss of each P11.2 run, by category');
  assert.match(flat, /all three P11\.2 runs reach a recall of 0\.93[^.]*above the 0\.60 threshold/i, 'the P11.2 result');
  assert.match(flat, /none of the four[^.]*missed in all three[^.]*is missed in every P11\.2 run/i, 'no systematic miss remains');
  assert.doesNotMatch(flat, /the mean fall below the 60 percent threshold/i, 'the below-threshold statement is replaced by the P11.2 result');

  // P11.4: the self-build row, the one run whose whole output is public
  const selfHead = rows(/^\| Build \| Evidence/)[0];
  assert.ok(selfHead, 'the self-build table header');
  const selfRows = rows(/^\| self-build /);
  assert.equal(selfRows.length, 1, 'one self-build row');
  assert.match(selfRows[0][0], /balanced/);
  assert.match(selfRows[0][0], /no issues/);
  for (const [name, value] of [['Nodes', '63'], ['Edges', '28'], ['Entities', '16'], ['Sequences', '4'], ['Views', '5']]) {
    assert.equal(selfRows[0][selfHead.findIndex((c) => c.startsWith(name))], value, `self-build ${name}`);
  }
  for (const name of ['Cost', 'Orchestrator turns', 'Orchestrator max context', 'Opus', 'Sonnet']) assert.ok(selfHead.some((c) => c.startsWith(name)), `a self-build column ${name}`);
  assert.match(flat, /the one run whose whole output is public/i, 'the self-build row says why it is there');

  // evals 3 and 5: their rows carry a baseline that scored 0 and the sentence that says the cost column is not like for like
  assert.match(byEval[3][baselineAt], /^1\.00 USD$/);
  assert.match(byEval[3][resultAt], /8\/8[^|]*baseline 0\/8/);
  assert.match(byEval[5][baselineAt], /^2\.96 USD$/);
  assert.match(byEval[5][resultAt], /7\/7[^|]*baseline 0\/7/);
  assert.match(flat, /baselines of evals 3 and 5 score 0 because[^.]*archmap-shaped[^.]*not a like-for-like comparison/i);

  // the shares: a table per eval, labelled, the residual named, every row summing to 100
  assert.match(flat, /shares of the result-event total/i);
  assert.match(flat, /per-agent[^.]*stream[^.]*lower bound/i, 'the per-agent stream is named as a lower bound');
  const shareHead = rows(/^\| Eval \| Explorers/)[0];
  assert.ok(shareHead, 'the shares table header');
  assert.match(shareHead.at(-1), /not attributed/i, 'the residual column');
  const shares = rows(/^\| \d \| [\d.]+ /);
  assert.deepEqual(shares.map((r) => r[0]), ['1', '2', '4'], 'shares for evals 1, 2 and 4');
  for (const r of shares) {
    const sum = r.slice(1).map((c) => (c === '-' ? 0 : Number(c))).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) < 0.15, `eval ${r[0]} shares sum to ${sum}`);
  }
};

test('e17 the evals README cost section states the eval 2 turn miss, the three-run recall with the four issues missed in all three runs by category and the source run of each eval 2 figure, the P11.2 result, the self-build row, carries the eval 3 and 5 rows with the baseline caveat, and gives per-agent shares with the stream lower-bound residual, each row summing to 100', () => {
  checkCostSection(readFileSync(readmePath, 'utf8'));
});

test('e18 the cost-section check fails on a shares row that does not sum to 100, on a missing eval 5 row, on a dropped baseline caveat, on the two-issue sentence, on a renamed run row, on a changed P11.2 recall and on a self-build row that is not the balanced build without issues and on a dropped self-build reason', () => {
  const readme = readFileSync(readmePath, 'utf8');
  checkCostSection(readme); // the unbroken text passes, so each failure below is the edit's
  const broken = (from, to) => {
    assert.ok(readme.includes(from), `the README carries ${from}`);
    return readme.replace(from, to);
  };
  assert.throws(() => checkCostSection(broken('| 1 | 38.4 | 28.2 | 5.9 | - | 27.4 |', '| 1 | 38.4 | 28.2 | 5.9 | - | 30.4 |')), /shares sum to/);
  assert.throws(() => checkCostSection(broken('| 5 (build) |', '| 6 (build) |')));
  assert.throws(() => checkCostSection(broken('is therefore not a like-for-like comparison', 'is comparable')));
  // P11.4: the four-issue sentence, a run row, the P11.2 result and the self-build row
  assert.throws(() => checkCostSection(broken('Four medium reference issues, one each in performance, security, reliability', 'Two medium reference issues, one each in performance, security')), /four issues missed/);
  assert.throws(() => checkCostSection(broken('| rerun 2 | P8 |', '| rerun 3 | P8 |')), /six eval 2 runs|each in its own row/);
  assert.throws(() => checkCostSection(broken('| P11.2 run 3 | P11.1 | `evidence/iteration-2/2-with-skill-6.json` | 14 | 2.61 USD | 69.4 K | 0.93 | security |', '| P11.2 run 3 | P11.1 | `evidence/iteration-2/2-with-skill-6.json` | 14 | 2.61 USD | 69.4 K | 0.53 | security |')), /recall of the three P11\.2 runs/);
  assert.throws(() => checkCostSection(broken('| self-build (balanced, no issues) |', '| self-build (max) |')));
  assert.throws(() => checkCostSection(broken('It is the one run whose whole output is public', 'It is a run')), /says why/);
});

// P11.3: every cost, turn and context figure of the cost section is the figure of a tracked profile. The evidence files
// are `node scripts/cost-profile.mjs <stream.jsonl> --json --basename`, one per run, under evidence/<iteration>/
// <eval>-<configuration>-<run>.json; the "How each number was produced" table names the files of each row and column.
// The check reads a README text and an evidence reader, so e20 can feed it a tampered README or a tampered profile.
const evidenceDir = new URL('evidence/', evalsDir);
const readEvidence = (rel) => JSON.parse(readFileSync(new URL(rel.replace(/^evidence\//, ''), evidenceDir), 'utf8'));
const evidenceFiles = () => readdirSync(evidenceDir, { recursive: true }).filter((f) => f.endsWith('.json')).map((f) => `evidence/${f.split(/[\\/]/).join('/')}`).sort();
const orchestratorOf = (j) => j.byAgent.find((a) => a.agent === 'orchestrator');
const usd2 = (j) => `${(Math.round(j.total.costUsd * 100) / 100).toFixed(2)} USD`;

const checkCostEvidence = (readme, read = readEvidence, onDisk = evidenceFiles) => {
  const start = readme.indexOf('## Cost of a build');
  assert.ok(start >= 0, 'the cost section exists');
  const rest = readme.slice(start + 3);
  const cost = rest.slice(0, rest.indexOf('\n## ') < 0 ? rest.length : rest.indexOf('\n## '));
  const flat = cost.replace(/\s+/g, ' ');
  const rows = (re) => cost.split('\n').filter((l) => re.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const cache = new Map();
  const get = (rel) => {
    if (!cache.has(rel)) cache.set(rel, read(rel));
    return cache.get(rel);
  };

  assert.match(cost, /### How each number was produced/, 'the cost section has the "How each number was produced" subsection');
  const how = cost.slice(cost.indexOf('### How each number was produced'));
  assert.match(how, /node scripts\/cost-profile\.mjs <stream\.jsonl> --json --basename/, 'the command is named');
  assert.match(how, /last `?result`? event/i, "the per-model figure is the last result event's");
  assert.match(how, /lower bound/i, "the per-agent output is the stream's lower bound");

  // the evidence table: the files of each row, by column
  const evHead = rows(/^\| Eval \| Evidence/)[0];
  assert.ok(evHead, 'the evidence table header');
  const costHead = rows(/^\| Eval \| Iteration 1/)[0];
  assert.ok(costHead, 'the cost table header');
  const col = (head, name) => {
    const at = head.findIndex((c) => c.startsWith(name));
    assert.ok(at >= 0, `a column ${name}`);
    return at;
  };
  const evRows = rows(/^\| \d \| .*evidence\//);
  const costRows = rows(/^\| \d \(/);
  assert.deepEqual(evRows.map((r) => r[0]), ['1', '2', '3', '4', '5'], 'evidence rows for evals 1 to 5');
  assert.deepEqual(costRows.map((r) => r[0].split(' ')[0]), ['1', '2', '3', '4', '5']);
  const FILE = /^evidence\/iteration-(\d)\/(\d|self)-(with|without)-skill-(\d)\.json$/;
  const filesOf = (cell) => [...cell.matchAll(/`([^`]+\.json)`/g)].map((m) => m[1]);
  const named = new Set();
  const figures = {};
  for (const ev of evRows) {
    const e = ev[0];
    const cr = costRows.find((r) => r[0].split(' ')[0] === e);
    figures[e] = {};
    for (const [evName, costName, iteration, config] of [['Evidence, iteration 1', 'Iteration 1, with skill', '1', 'with'], ['Evidence, iteration 2', 'Iteration 2, with skill', '2', 'with'], ['Evidence, baseline', 'Baseline, no skill', null, 'without']]) {
      const files = filesOf(ev[col(evHead, evName)]);
      assert.ok(files.length >= 1, `eval ${e}, ${costName}: an evidence file is named`);
      for (const f of files) {
        const m = f.match(FILE);
        assert.ok(m, `${f} is named evidence/<iteration>/<eval>-<configuration>-<run>.json`);
        assert.equal(m[2], e, `${f} belongs to eval ${e}`);
        assert.equal(m[3], config, `${f} is a ${config}-skill run`);
        if (iteration) assert.equal(m[1], iteration, `${f} is an iteration ${iteration} run`);
        named.add(f);
      }
      const j = get(files[0]);
      assert.equal(cr[col(costHead, costName)], usd2(j), `eval ${e}, ${costName}: the cell is total.costUsd of ${files[0]} rounded to two decimals (${j.total.costUsd})`);
      figures[e][costName] = { files, j };
      if (costName === 'Iteration 2, with skill') {
        assert.equal(Number(cr[col(costHead, 'Orchestrator turns')]), orchestratorOf(j).turns, `eval ${e}: the turn count is the orchestrator row of ${files[0]}`);
      }
    }
    // the baseline runs of the other iteration are tracked too, though the cost table does not use them
    for (const f of filesOf(ev[col(evHead, 'Evidence, other baseline')])) {
      const m = f.match(FILE);
      assert.ok(m && m[2] === e && m[3] === 'without', `${f} is a without-skill run of eval ${e}`);
      named.add(f);
    }
  }
  // P11.4: the eval 2 per-run table, cell by cell against the file each row names; the three first runs are the files of the
  // iteration 2 column, in order, and the P11.2 runs follow them
  const runHead = rows(/^\| Run \| Reviewer/)[0];
  assert.ok(runHead, 'the eval 2 per-run table header');
  const runAt = (name) => col(runHead, name);
  const runRows = rows(/^\| (first run|rerun [12]|P11\.2 run [123]) \|/);
  assert.equal(runRows.length, 6, 'six eval 2 runs');
  const eval2Files = figures[2]['Iteration 2, with skill'].files;
  runRows.forEach((r, i) => {
    const [f] = filesOf(r[runAt('Evidence')]);
    assert.equal(f, `evidence/iteration-2/2-with-skill-${i + 1}.json`, `${r[0]} is run ${i + 1} of eval 2`);
    if (i < 3) assert.equal(f, eval2Files[i], `${r[0]} is the file the iteration 2 column names in position ${i + 1}`);
    named.add(f);
    const j = get(f);
    assert.equal(Number(r[runAt('Orchestrator turns')]), orchestratorOf(j).turns, `${r[0]}: the turn count is the orchestrator row of ${f}`);
    assert.equal(r[runAt('Cost')], usd2(j), `${r[0]}: the cost is total.costUsd of ${f}`);
    assert.equal(r[runAt('Max context')], `${(orchestratorOf(j).maxContext / 1000).toFixed(1)} K`, `${r[0]}: the max context is the orchestrator maxContext of ${f}`);
  });

  // P11.4: the self-build row against its profile
  const selfHead = rows(/^\| Build \| Evidence/)[0];
  const selfRow = rows(/^\| self-build /)[0];
  assert.ok(selfHead && selfRow, 'the self-build table');
  const selfAt = (name) => col(selfHead, name);
  const [selfFile] = filesOf(selfRow[selfAt('Evidence')]);
  assert.equal(selfFile, 'evidence/iteration-2/self-with-skill-1.json', 'the self-build row names its profile');
  const sj = get(selfFile);
  assert.equal(selfRow[selfAt('Cost')], usd2(sj), `self-build: the cost is total.costUsd of ${selfFile}`);
  assert.equal(Number(selfRow[selfAt('Orchestrator turns')]), orchestratorOf(sj).turns, `self-build: the turn count is the orchestrator row of ${selfFile}`);
  assert.equal(selfRow[selfAt('Orchestrator max context')], `${(orchestratorOf(sj).maxContext / 1000).toFixed(1)} K`, `self-build: the max context is the orchestrator maxContext of ${selfFile}`);
  for (const [name, key] of [['Opus', 'opus'], ['Sonnet', 'sonnet']]) {
    const m = sj.byModel.find((x) => x.model.includes(key));
    assert.equal(selfRow[selfAt(name)], `${m.turns} turns, ${(Math.round(m.costUsd * 100) / 100).toFixed(2)} USD`, `self-build: the ${name} model figure is the byModel row of ${selfFile}`);
  }

  assert.deepEqual([...named].sort(), onDisk().filter((f) => !f.includes('/self-')).sort(), 'the table names every evidence file of the evals, and each exists');
  const self = onDisk().filter((f) => f.includes('/self-'));
  assert.ok(self.length >= 1, 'the self-build profile is tracked');
  for (const f of self) assert.ok(how.includes(f), `${f} is named in the subsection`);
  for (const f of [...named, ...self]) {
    const j = get(f);
    assert.equal(j.rates.date, how.match(/rate table dated (\d{4}-\d{2}-\d{2})/)?.[1], `${f}: the rate table date the README states`);
    for (const r of j.reconciliation.files) assert.doesNotMatch(r.file, /[\\/]/, `${f}: transcripts are recorded by base name`);
  }

  // the eval 2 reruns sentence: turns, cost and the largest context of the two reruns, against the first run
  const rerun = flat.match(/reruns[^.]*took (\d+) and (\d+) orchestrator turns[^.]*, ([\d.]+) and ([\d.]+) USD, and a context of at most ([\d.]+) K tokens, against (\d+) turns and ([\d.]+) USD/i);
  assert.ok(rerun, 'the reruns sentence: turns, cost, context, against the first run');
  const eval2 = figures[2]['Iteration 2, with skill'].files;
  assert.equal(eval2.length, 3, 'eval 2 names the first run and the two reruns');
  const [first, ...reruns] = eval2.map((f) => get(f));
  assert.deepEqual(reruns.map((j) => orchestratorOf(j).turns), [Number(rerun[1]), Number(rerun[2])], 'the reruns turn counts');
  assert.deepEqual(reruns.map(usd2), [`${rerun[3]} USD`, `${rerun[4]} USD`], 'the reruns costs');
  assert.equal((Math.max(...reruns.map((j) => orchestratorOf(j).maxContext)) / 1000).toFixed(1), rerun[5], 'the reruns largest context, in K tokens');
  assert.equal(orchestratorOf(first).turns, Number(rerun[6]), 'the first run turns');
  assert.equal(usd2(first), `${rerun[7]} USD`, 'the first run cost');

  // the stated maximum context over the evals it names
  const ctx = flat.match(/orchestrator's context never exceeds (\d+) K tokens in evals ([\d, and]+)/i);
  assert.ok(ctx, 'the maximum context sentence');
  const covered = ctx[2].match(/\d/g);
  assert.deepEqual(covered, ['1', '2', '4'], 'it covers evals 1, 2 and 4');
  const largest = Math.max(...covered.flatMap((e) => figures[e]['Iteration 2, with skill'].files.map((f) => orchestratorOf(get(f)).maxContext)));
  assert.equal(String(Math.round(largest / 1000)), ctx[1], `the largest orchestrator max ctx of those runs is ${largest}`);
};

test('e19 every cost, turn and context figure of the evals README cost section equals the figure in the tracked evidence profile it names', () => {
  checkCostEvidence(readFileSync(readmePath, 'utf8'));
});

test('e20 the cost-evidence check fails on a tampered cost cell, turn count, reruns figure, context figure, evidence file name or evidence profile', () => {
  const readme = readFileSync(readmePath, 'utf8');
  checkCostEvidence(readme); // the unbroken text passes, so each failure below is the edit's
  // the README wraps its prose, so a phrase matches across a line break
  const broken = (from, to) => {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
    assert.match(readme, re, `the README carries ${from}`);
    return readme.replace(re, to);
  };
  const cell = readme.match(/\| 1 \(build\) \| ([\d.]+) USD \| ([\d.]+) USD \| ([\d.]+) USD \| (\d+) \|/);
  assert.ok(cell, 'the eval 1 row');
  const [row, it1, it2, base, turns] = cell;
  assert.throws(() => checkCostEvidence(broken(row, row.replace(`${it1} USD`, '13.84 USD'))), /cell is total\.costUsd/, 'iteration 1 cost');
  assert.throws(() => checkCostEvidence(broken(row, row.replace(`| ${it2} USD`, '| 1.17 USD'))), /cell is total\.costUsd/, 'iteration 2 cost');
  assert.throws(() => checkCostEvidence(broken(row, row.replace(`${base} USD`, '1.56 USD'))), /cell is total\.costUsd/, 'baseline cost');
  assert.throws(() => checkCostEvidence(broken(row, row.replace(`| ${turns} |`, `| ${Number(turns) + 1} |`))), /turn count/, 'turns');
  assert.throws(() => checkCostEvidence(broken('2.05 and 1.80 USD', '2.05 and 1.90 USD')), /reruns costs/);
  assert.throws(() => checkCostEvidence(broken('took 11 and 13 orchestrator turns', 'took 11 and 12 orchestrator turns')), /reruns turn counts/);
  assert.throws(() => checkCostEvidence(broken('at most 69.6 K tokens', 'at most 60.0 K tokens')), /largest context/);
  assert.throws(() => checkCostEvidence(broken('never exceeds 72 K tokens', 'never exceeds 70 K tokens')), /largest orchestrator max ctx/);
  assert.throws(() => checkCostEvidence(broken('`evidence/iteration-1/1-with-skill-1.json`', '`evidence/iteration-1/2-with-skill-1.json`')), /belongs to eval 1/);
  const runRow = readme.match(/\| P11\.2 run 2 \| [^\n]*\n/)[0];
  const selfRow = readme.match(/\| self-build [^\n]*\n/)[0];
  assert.throws(() => checkCostEvidence(broken(runRow, runRow.replace(/\d\.\d\d USD/, '9.99 USD'))), /the cost is total\.costUsd/, 'a P11.2 run cost');
  assert.throws(() => checkCostEvidence(broken(runRow, runRow.replace(/\| 13 \|/, '| 12 |'))), /turn count/, 'a P11.2 run turns');
  assert.throws(() => checkCostEvidence(broken(runRow, runRow.replace('2-with-skill-5', '2-with-skill-6'))), /is run 5 of eval 2/, 'a P11.2 run file');
  assert.throws(() => checkCostEvidence(broken(selfRow, selfRow.replace(/\d\.\d\d USD/, '9.99 USD'))), /self-build: the cost/, 'the self-build cost');
  assert.throws(() => checkCostEvidence(broken(selfRow, selfRow.replace(/\| 12 \|/, '| 13 |'))), /self-build: the turn count/, 'the self-build turns');
  assert.throws(() => checkCostEvidence(broken(selfRow, selfRow.replace(/\| 51 turns/, '| 50 turns'))), /Sonnet model figure/, 'the self-build Sonnet turns');
  // a profile that drifted from its transcript: the same README against a profile with one more orchestrator turn or one more dollar
  const bump = (mutate) => (rel) => {
    const j = JSON.parse(JSON.stringify(readEvidence(rel)));
    if (rel === 'evidence/iteration-2/1-with-skill-1.json') mutate(j);
    return j;
  };
  assert.throws(() => checkCostEvidence(readme, bump((j) => { j.total.costUsd += 1; })), /cell is total\.costUsd/);
  assert.throws(() => checkCostEvidence(readme, bump((j) => { orchestratorOf(j).turns += 1; })), /turn count/);
  assert.throws(() => checkCostEvidence(readme, bump((j) => { j.reconciliation.files[0].file = '/home/x/stream.jsonl'; })), /base name/);
  // an evidence file the table does not name
  assert.throws(() => checkCostEvidence(readme, readEvidence, () => [...evidenceFiles(), 'evidence/iteration-2/9-with-skill-1.json']), /names every evidence file/);
});
