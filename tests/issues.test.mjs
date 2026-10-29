import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../scripts/validate.mjs';

// Case ids (i1, i2, ...) lead every title so the suite prints them first.
const CLI = fileURLToPath(new URL('../scripts/issues.mjs', import.meta.url));
const FIX = (name) => fileURLToPath(new URL(`./fixtures/issues/${name}`, import.meta.url));
const PLAN = FIX('audit-plan.json');
const MODEL = FIX('model.json');
const model = JSON.parse(readFileSync(MODEL, 'utf8'));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const tmp = (prefix = 'archmap-issues-') => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const run = (args, { cwd, env = {} } = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...GIT_ENV, ...env }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const byId = (file) => Object.fromEntries(file.issues.map((i) => [i.id, i]));
/** A throwaway git repo to act as the analysed project. */
function repo(name = 'shop-demo') {
  const base = tmp();
  const dir = join(base, name);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
  writeFileSync(join(dir, 'a.txt'), 'x\n');
  return dir;
}
const issue = (id, anchor, extra = {}) => ({
  id, sev: 'med', category: 'design', title: id, anchor, summary: 's', impact: 'i', fix: 'f',
  evidence: [{ path: 'src/index.js', lines: '1' }], source: 'archmap', ...extra,
});
/**
 * A throwaway project (not a git repo) holding the files the fixture plan names, so the importer can open a file
 * whose audit entry gives no lines and cite a line it actually read. Line numbers below are asserted by i2.
 */
function proj() {
  const dir = tmp();
  const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  put('src/auth/login.js', [
    '// auth entry', 'export function login(req) { // login handler',
    '  return Boolean(req.token); // accepts any token, never compares the supplied value with the stored one', '}', '',
  ].join('\n'));
  put('src/db/query.js', [
    "import { db } from './pool.js';",
    'export const orderQuery = () => db.query(sql); // no timeout: a stalled database hangs the request',
    '', '// reports', '// the report query scans the order table, no index', '',
  ].join('\n'));
  put('src/index.js', [
    "import { serve } from './http.js';", '', 'serve();', 'const cache = new Map(); // module-level cache of per-user state', '',
  ].join('\n'));
  return dir;
}
const write = (dir, name, obj) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(obj)); return p; };

test('i1 import-audit maps bugs, structured findings and legacy strings to source audit issues with audit-<id> ids and track', () => {
  const dir = proj();
  const out = join(dir, 'issues.json');
  const r = run(['import-audit', PLAN, '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  const file = readJson(out);
  const ids = file.issues.map((i) => i.id).sort();
  assert.deepEqual(ids, [
    'audit-BUG-1', 'audit-BUG-5', 'audit-P1-R1', 'audit-P1-R2', 'audit-P1-R6', 'audit-P2-0', 'audit-P2-1',
  ]);
  for (const i of file.issues) {
    assert.equal(i.source, 'audit');
    assert.equal(i.track, i.id.slice('audit-'.length));
  }
  const m = byId(file);
  assert.equal(m['audit-BUG-1'].sev, 'high'); // high stays high
  assert.equal(m['audit-BUG-5'].sev, 'med'); // medium becomes med
  assert.equal(m['audit-P1-R1'].sev, 'med');
  assert.equal(m['audit-P2-0'].sev, 'high'); // leading [high] tag on a legacy string
  assert.equal(m['audit-P2-1'].sev, 'med'); // [med] tag, tag before path
  assert.equal(m['audit-P1-R6'].sev, 'low');
  assert.equal(m['audit-P1-R6'].category, 'docs');
  assert.equal(m['audit-BUG-1'].category, 'security');
  // the result is a valid overlay for the model
  assert.deepEqual(validate(model, { issues: file }).findings, []);
});

test('i2 import-audit anchors each issue by file to the owning node and carries path and lines as evidence', () => {
  const dir = proj();
  const out = join(dir, 'issues.json');
  assert.equal(run(['import-audit', PLAN, '--model', MODEL, '--out', out], { cwd: dir }).status, 0);
  const m = byId(readJson(out));
  assert.deepEqual(m['audit-BUG-1'].anchor, { node: 'n-auth' }); // most specific glob wins over src/**
  assert.deepEqual(m['audit-BUG-5'].anchor, { node: 'n-db' });
  assert.deepEqual(m['audit-P1-R1'].anchor, { node: 'n-db' });
  assert.deepEqual(m['audit-P1-R2'].anchor, { node: 'n-shop' });
  assert.deepEqual(m['audit-P1-R6'].anchor, { node: 'n-docs' });
  assert.deepEqual(m['audit-P2-0'].anchor, { node: 'n-auth' });
  assert.deepEqual(m['audit-P1-R1'].evidence, [{ path: 'src/db/query.js', lines: '40-52' }]);
  assert.deepEqual(m['audit-P2-0'].evidence, [{ path: 'src/auth/login.js', lines: '30-41' }]);
  // a path without lines is opened and a line actually found is cited, never a guessed one
  assert.deepEqual(m['audit-P1-R2'].evidence, [{ path: 'src/index.js', lines: '4' }]);
  assert.deepEqual(m['audit-BUG-1'].evidence, [{ path: 'src/auth/login.js', lines: '3' }]);
  assert.deepEqual(m['audit-BUG-5'].evidence, [{ path: 'src/db/query.js', lines: '2' }]);
  assert.deepEqual(m['audit-P2-1'].evidence, [{ path: 'src/db/query.js', lines: '5' }]);
  assert.equal(m['audit-P1-R2'].fix, 'Move the state into a shared store.'); // resolution becomes the fix
});

test('i3 import-audit skips fixed, unanchored and line-level entries and prints the four counts', () => {
  const dir = proj();
  const out = join(dir, 'issues.json');
  const r = run(['import-audit', PLAN, '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /imported[: =]+7\b/);
  assert.match(r.out, /skipped-fixed[: =]+3\b/);
  assert.match(r.out, /skipped-unanchored[: =]+4\b/);
  assert.match(r.out, /skipped-line-level[: =]+1\b/);
  assert.match(r.out, /skipped-no-lines[: =]+0\b/);
  const ids = readJson(out).issues.map((i) => i.id);
  for (const gone of ['audit-BUG-2', 'audit-BUG-3', 'audit-BUG-4', 'audit-P1-R3', 'audit-P1-R4', 'audit-P1-R5', 'audit-P2-2', 'audit-P2-3']) {
    assert.ok(!ids.includes(gone), `${gone} must not be imported`);
  }
});

test('i4 re-importing is idempotent, keeps other sources, and drops an audit issue whose source closed', () => {
  const dir = proj();
  const out = join(dir, 'issues.json');
  assert.equal(run(['import-audit', PLAN, '--model', MODEL, '--out', out], { cwd: dir }).status, 0);
  const first = readFileSync(out, 'utf8');
  // an archmap-source issue in the existing overlay survives, and a stale audit one is dropped
  const existing = readJson(out);
  existing.issues.push(issue('no-auth-shop', { node: 'n-shop' }));
  existing.issues.push(issue('audit-BUG-GONE', { node: 'n-shop' }, { source: 'audit', track: 'BUG-GONE' }));
  const ex = write(dir, 'existing.json', existing);
  const out2 = join(dir, 'issues2.json');
  assert.equal(run(['import-audit', PLAN, '--model', MODEL, '--existing', ex, '--out', out2], { cwd: dir }).status, 0);
  const second = readJson(out2);
  const ids = second.issues.map((i) => i.id);
  assert.ok(ids.includes('no-auth-shop'));
  assert.ok(!ids.includes('audit-BUG-GONE'));
  assert.equal(ids.filter((id) => id === 'audit-BUG-1').length, 1);
  // run it again over its own output: byte-identical
  const out3 = join(dir, 'issues3.json');
  assert.equal(run(['import-audit', PLAN, '--model', MODEL, '--existing', out2, '--out', out3], { cwd: dir }).status, 0);
  assert.equal(readFileSync(out3, 'utf8'), readFileSync(out2, 'utf8'));
  // and over an import-only overlay it adds nothing
  const out4 = join(dir, 'issues4.json');
  assert.equal(run(['import-audit', PLAN, '--model', MODEL, '--existing', out, '--out', out4], { cwd: dir }).status, 0);
  assert.equal(readFileSync(out4, 'utf8'), first);
});

test('i5 merge replaces only the issues on the listed anchors; ids stay stable; output is sorted', () => {
  const dir = tmp();
  const existing = write(dir, 'existing.json', { schemaVersion: '1.0', issues: [
    issue('keep-db', { node: 'n-db' }, { sev: 'low' }),
    issue('old-auth', { node: 'n-auth' }),
    issue('keep-edge', { edge: 'e-shop-db' }, { sev: 'high' }),
  ] });
  const incoming = write(dir, 'incoming.json', { issues: [
    issue('new-auth', { node: 'n-auth' }, { sev: 'high' }),
    issue('ignored-db', { node: 'n-db' }), // not on a listed anchor: not taken
  ] });
  const out = join(dir, 'merged.json');
  const r = run(['merge', '--existing', existing, '--incoming', incoming, '--anchors', 'n-auth', '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  const merged = readJson(out);
  assert.deepEqual(merged.issues.map((i) => i.id), ['keep-edge', 'new-auth', 'keep-db']); // high by id, then low
  assert.equal(merged.issues.find((i) => i.id === 'keep-db').summary, 's'); // untouched
  // same inputs, same bytes
  const out2 = join(dir, 'merged2.json');
  assert.equal(run(['merge', '--existing', existing, '--incoming', incoming, '--anchors', 'n-auth', '--model', MODEL, '--out', out2], { cwd: dir }).status, 0);
  assert.equal(readFileSync(out2, 'utf8'), readFileSync(out, 'utf8'));
  // without --anchors the incoming file replaces everything
  const out3 = join(dir, 'merged3.json');
  assert.equal(run(['merge', '--existing', existing, '--incoming', incoming, '--model', MODEL, '--out', out3], { cwd: dir }).status, 0);
  assert.deepEqual(readJson(out3).issues.map((i) => i.id).sort(), ['ignored-db', 'new-auth']);
});

test('i6 path prints <home>/.claude/archmap/<repo-slug>/ with the slug rule from SKILL.md', () => {
  const home = tmp('archmap-home-');
  const dir = repo('My Shop_Demo.v2');
  const r = run(['path', '--project', dir], { cwd: tmp(), env: { HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim(), `${home}/.claude/archmap/my-shop-demo-v2/`);
  const r2 = run(['path'], { cwd: dir, env: { HOME: home, USERPROFILE: home } }); // default project = cwd
  assert.equal(r2.out.trim(), `${home}/.claude/archmap/my-shop-demo-v2/`);
  assert.equal(existsSync(join(home, '.claude')), false, 'path only prints');
});

test('i7 an --out inside the analysed repo working tree is refused with exit 2 and nothing written', () => {
  const dir = repo();
  mkdirSync(join(dir, 'docs'));
  for (const rel of ['issues.json', 'docs/architecture/issues.json', '.git/issues.json']) {
    const before = readdirSync(dir).sort();
    const out = join(dir, rel);
    const r = run(['import-audit', PLAN, '--model', MODEL, '--out', out, '--project', dir], { cwd: dir });
    assert.equal(r.status, 2, `${rel}: ${r.err}`);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(dir, 'docs/architecture')), false, 'no directory is created either');
    assert.deepEqual(readdirSync(dir).sort(), before);
  }
  // merge refuses the same way, with a relative --out
  const ex = write(tmp(), 'e.json', { issues: [] });
  const r = run(['merge', '--existing', ex, '--incoming', ex, '--model', MODEL, '--out', 'rel.json'], { cwd: dir });
  assert.equal(r.status, 2, r.err);
  assert.equal(existsSync(join(dir, 'rel.json')), false);
  // outside the repo is fine, and the directory is created
  const home = tmp('archmap-home-');
  const ok = join(home, '.claude', 'archmap', 'shop-demo', 'issues.json');
  assert.equal(run(['import-audit', PLAN, '--model', MODEL, '--out', ok, '--project', dir], { cwd: dir }).status, 0);
  assert.ok(existsSync(ok));
});

test('i8 an issue anchored to an id missing from the model is refused with exit 1 and nothing written', () => {
  const dir = tmp();
  const existing = write(dir, 'existing.json', { issues: [] });
  const incoming = write(dir, 'incoming.json', { issues: [issue('ghost', { node: 'n-ghost' })] });
  const out = join(dir, 'merged.json');
  const r = run(['merge', '--existing', existing, '--incoming', incoming, '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /n-ghost/);
  assert.equal(existsSync(out), false);
  // an already-dangling kept issue is refused too
  const bad = write(dir, 'bad.json', { issues: [issue('ghost2', { entity: 'en-nope' })] });
  const r2 = run(['merge', '--existing', bad, '--incoming', existing, '--anchors', 'n-auth', '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r2.status, 1, r2.err);
  assert.equal(existsSync(out), false);
});

test('i9 usage errors exit 2: unknown subcommand, missing plan, unreadable input', () => {
  const dir = tmp();
  assert.equal(run([], { cwd: dir }).status, 2);
  assert.equal(run(['frobnicate'], { cwd: dir }).status, 2);
  assert.equal(run(['import-audit', '--model', MODEL], { cwd: dir }).status, 2);
  assert.equal(run(['import-audit', join(dir, 'nope.json'), '--model', MODEL], { cwd: dir }).status, 2);
});

test('i10 an entry naming a file but no lines, with no readable line to cite, is skipped and counted as skipped-no-lines', () => {
  // cwd holds none of the plan's files, so nothing can be read for the four entries that give a path only
  const dir = tmp();
  const out = join(dir, 'issues.json');
  const r = run(['import-audit', PLAN, '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /imported[: =]+3\b/);
  assert.match(r.out, /skipped-no-lines[: =]+4\b/);
  const file = readJson(out);
  assert.deepEqual(file.issues.map((i) => i.id).sort(), ['audit-P1-R1', 'audit-P1-R6', 'audit-P2-0']);
  for (const i of file.issues) for (const e of i.evidence) assert.notEqual(e.lines, '1', `${i.id} cites an invented line`);
});

test('i11 no imported issue carries a line the importer did not read: a file with nothing relevant is skipped, not pinned to line 1', () => {
  const dir = proj();
  // overwrite the named files with content unrelated to the audit text
  for (const rel of ['src/auth/login.js', 'src/db/query.js', 'src/index.js']) writeFileSync(join(dir, rel), 'const a = 1;\nconst b = 2;\n');
  const out = join(dir, 'issues.json');
  const r = run(['import-audit', PLAN, '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /skipped-no-lines[: =]+4\b/);
  for (const gone of ['audit-BUG-1', 'audit-BUG-5', 'audit-P1-R2', 'audit-P2-1']) {
    assert.ok(!readJson(out).issues.some((i) => i.id === gone), `${gone} must be skipped`);
  }
  // a path that climbs out of the project is never opened
  const plan = write(dir, 'plan.json', { bugs: [{ id: 'B-X', status: 'open', severity: 'low', title: 'orders', description: 'orders query', files: ['src/db/../../outside.js'] }] });
  writeFileSync(join(dirname(dir), 'outside.js'), '// orders query orders query\n');
  const out2 = join(dir, 'issues2.json');
  const r2 = run(['import-audit', plan, '--model', MODEL, '--out', out2], { cwd: dir });
  assert.equal(r2.status, 0, r2.err);
  assert.ok(!readJson(out2).issues.some((i) => i.id === 'audit-B-X'));
});

const planOf = (dir, entries) => write(dir, 'plan-x.json', { bugs: entries.map((e) => ({ status: 'open', severity: 'low', ...e })) });

test('i12 a symlink inside the project that points outside it is never opened: the entry is skipped as skipped-no-lines', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = proj();
  const outsideDir = tmp();
  const target = join(outsideDir, 'secret.js');
  writeFileSync(target, '// scheduler orders queue retries timeout: the order query hangs the request\n');
  symlinkSync(target, join(dir, 'src', 'link.js'));
  const plan = planOf(dir, [{ id: 'B-LINK', title: 'Scheduler orders queue', description: 'scheduler orders queue retries timeout', files: ['src/link.js'] }]);
  const out = join(dir, 'issues-link.json');
  const r = run(['import-audit', plan, '--model', MODEL, '--out', out, '--project', dir], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /skipped-no-lines[: =]+1\b/);
  assert.ok(!readJson(out).issues.some((i) => i.id === 'audit-B-LINK'), 'a symlinked outside file must not be read or cited');
  // a symlink whose target stays inside the project is still read
  writeFileSync(join(dir, 'src', 'real.js'), '// header\n// scheduler orders queue retries timeout here\n');
  symlinkSync(join(dir, 'src', 'real.js'), join(dir, 'src', 'inner.js'));
  const plan2 = planOf(dir, [{ id: 'B-INNER', title: 'Scheduler orders queue', description: 'scheduler orders queue retries timeout', files: ['src/inner.js'] }]);
  const out2 = join(dir, 'issues-inner.json');
  assert.equal(run(['import-audit', plan2, '--model', MODEL, '--out', out2, '--project', dir], { cwd: dir }).status, 0);
  assert.deepEqual(readJson(out2).issues.find((i) => i.id === 'audit-B-INNER')?.evidence, [{ path: 'src/inner.js', lines: '2' }]);
});

test('i13 findLine needs whole-word matches: substrings do not count, 3 distinct words are required (2 when the entry has fewer than 4 words)', () => {
  const dir = proj();
  writeFileSync(join(dir, 'src', 'weak.js'), [
    '// reorder requested databases', // substrings only of: order, request, database
    '// orders queue handled here', // 2 whole words of a 5-word entry
    '// scheduler orders queue', // 3 whole words
    '',
  ].join('\n'));
  const out = join(dir, 'issues-weak.json');
  const plan = planOf(dir, [
    { id: 'B-SUB', title: 'Order request database', description: 'order request database', files: ['src/weak.js'] },
    { id: 'B-TWO', title: 'Orders queue scheduler retries timeout', description: 'orders queue scheduler retries timeout', files: ['src/weak.js'] },
  ]);
  const r = run(['import-audit', plan, '--model', MODEL, '--out', out, '--project', dir], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  const m = byId(readJson(out));
  assert.ok(!m['audit-B-SUB'], 'substring-only matches must not be cited');
  assert.deepEqual(m['audit-B-TWO']?.evidence, [{ path: 'src/weak.js', lines: '3' }]); // line 2 has only two of five words
  // a short entry (3 words) is satisfied by 2 whole words
  writeFileSync(join(dir, 'src', 'short.js'), '// x\n// order request handled\n');
  const plan2 = planOf(dir, [{ id: 'B-SHORT', title: 'Order request database', description: 'order request database', files: ['src/short.js'] }]);
  const out2 = join(dir, 'issues-short.json');
  assert.equal(run(['import-audit', plan2, '--model', MODEL, '--out', out2, '--project', dir], { cwd: dir }).status, 0);
  assert.deepEqual(readJson(out2).issues.find((i) => i.id === 'audit-B-SHORT')?.evidence, [{ path: 'src/short.js', lines: '2' }]);
});

test('i14 a first build has no overlay yet: merge without --existing and import-audit with a missing --existing file both treat it as empty', () => {
  const dir = proj();
  const incoming = write(dir, 'incoming.json', { issues: [issue('new-auth', { node: 'n-auth' }, { sev: 'high' })] });
  const out = join(dir, 'merged.json');
  const r = run(['merge', '--incoming', incoming, '--anchors', 'n-auth', '--model', MODEL, '--out', out], { cwd: dir });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(readJson(out).issues.map((i) => i.id), ['new-auth']);
  const out2 = join(dir, 'merged2.json');
  const r2 = run(['merge', '--existing', join(dir, 'absent.json'), '--incoming', incoming, '--model', MODEL, '--out', out2], { cwd: dir });
  assert.equal(r2.status, 0, r2.err);
  assert.deepEqual(readJson(out2).issues.map((i) => i.id), ['new-auth']);
  const out3 = join(dir, 'imported.json');
  const r3 = run(['import-audit', PLAN, '--model', MODEL, '--existing', join(dir, 'absent.json'), '--out', out3], { cwd: dir });
  assert.equal(r3.status, 0, r3.err);
  assert.equal(readJson(out3).issues.length, 7);
});
