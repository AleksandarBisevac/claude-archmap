import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
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
  assert.match(flat, /two medium reference issues[^.]*missed in all three runs/i);

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

test('e17 the evals README cost section states the eval 2 turn miss and the three-run recall, carries the eval 3 and 5 rows with the baseline caveat, and gives per-agent shares with the stream lower-bound residual, each row summing to 100', () => {
  checkCostSection(readFileSync(readmePath, 'utf8'));
});

test('e18 the cost-section check fails on a shares row that does not sum to 100, on a missing eval 5 row and on a dropped baseline caveat', () => {
  const readme = readFileSync(readmePath, 'utf8');
  checkCostSection(readme); // the unbroken text passes, so each failure below is the edit's
  const broken = (from, to) => {
    assert.ok(readme.includes(from), `the README carries ${from}`);
    return readme.replace(from, to);
  };
  assert.throws(() => checkCostSection(broken('| 1 | 38.4 | 28.2 | 5.9 | - | 27.4 |', '| 1 | 38.4 | 28.2 | 5.9 | - | 30.4 |')), /shares sum to/);
  assert.throws(() => checkCostSection(broken('| 5 (build) |', '| 6 (build) |')));
  assert.throws(() => checkCostSection(broken('is therefore not a like-for-like comparison', 'is comparable')));
});
