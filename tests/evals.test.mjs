import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

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
