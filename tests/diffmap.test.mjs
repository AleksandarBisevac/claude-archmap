import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffmap } from '../scripts/diffmap.mjs';

// Case ids (d1, d2, ...) lead every title so the suite prints them first.
const CLI = fileURLToPath(new URL('../scripts/diffmap.mjs', import.meta.url));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (dir, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
const put = (dir, rel, text = 'x\n') => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };

// web -> api -> db, queue and cfg stand alone. Sequence login runs web -> api; sequence jobs touches only queue.
const ev = (path) => [{ path, lines: '1-2' }];
const modelFor = (commitSha) => ({
  meta: {
    schemaVersion: '1.0', project: 'demo', commit: commitSha, generatedAt: '2026-01-01T00:00:00Z', profile: 'balanced', sources: [],
    coverage: { api: ['api/**'], web: ['web/**'], data: ['db/**'], queue: ['queue/**'], config: ['config/**'], root: ['*'] },
  },
  zones: [],
  nodes: [
    { id: 'n-web', zone: 'z', kind: 'app', title: 'Web', paths: ['web/**'], level: 1, evidence: ev('web/w.js') },
    { id: 'n-api', zone: 'z', kind: 'service', title: 'API', paths: ['api/**'], level: 1, evidence: ev('api/a.js') },
    { id: 'n-db', zone: 'z', kind: 'store', title: 'DB', paths: ['db/**'], level: 1, evidence: ev('db/schema.sql') },
    { id: 'n-queue', zone: 'z', kind: 'queue', title: 'Queue', paths: ['queue/**'], level: 1, evidence: ev('queue/q.js') },
    { id: 'n-cfg', zone: 'z', kind: 'module', title: 'Cfg', paths: [], level: 2, evidence: ev('config/app.yml') },
  ],
  edges: [
    { id: 'e1', from: 'n-web', to: 'n-api', type: 'api', desc: 'd', evidence: ev('web/w.js'), confidence: 'verified' },
    { id: 'e2', from: 'n-api', to: 'n-db', type: 'sql', desc: 'd', evidence: ev('api/a.js'), confidence: 'verified' },
  ],
  entities: [
    { id: 'en-user', store: 'n-db', name: 'user', kind: 'table', fields: [], evidence: ev('db/schema.sql') },
    { id: 'en-job', store: 'n-queue', name: 'job', kind: 'collection', fields: [{ name: 'id', type: 'int', provenance: 'declared', evidence: ev('queue/job.js') }] },
  ],
  sequences: [
    { id: 'seq-login', title: 'Login', participants: [{ id: 'W', label: 'Web', node: 'n-web' }, { id: 'A', label: 'API', node: 'n-api' }], steps: [{ m: ['W', 'A'], k: 'api', t: 't', d: 'd', r: [] }] },
    { id: 'seq-jobs', title: 'Jobs', participants: [{ id: 'Q', label: 'Queue', node: 'n-queue' }, { id: 'X', label: 'Ext' }], steps: [{ m: ['Q', 'X'], k: 'call', t: 't', d: 'd', r: [] }] },
  ],
});

const MODELS = new Map();

/** A repo with one base commit; returns { dir, base, model }. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-diffmap-'));
  git(dir, 'init', '-q');
  for (const f of ['api/a.js', 'web/w.js', 'db/schema.sql', 'queue/q.js', 'queue/job.js', 'config/app.yml', 'README.md']) put(dir, f);
  const base = commit(dir, 'base');
  const model = modelFor(base);
  // The model lives outside the repo so committing the repo never picks it up.
  const mdir = mkdtempSync(join(tmpdir(), 'archmap-diffmap-model-'));
  put(mdir, 'model.json', JSON.stringify(model));
  MODELS.set(dir, join(mdir, 'model.json'));
  return { dir, base, model };
}
const cli = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, MODELS.get(dir), '--repo', dir, '--json', ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null };
};

test('d1 a changed file maps to its area and owning node; one-edge neighbours in both directions are dependents', () => {
  const { dir, base } = repo();
  put(dir, 'api/a.js', 'changed\n');
  const head = commit(dir, 'edit api');
  const r = cli(dir);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.json.base, base);
  assert.equal(r.json.head, head);
  assert.deepEqual(r.json.files, ['api/a.js']);
  assert.deepEqual(r.json.areas, ['api']);
  assert.deepEqual(r.json.nodes, ['n-api']);
  assert.deepEqual(r.json.dependents, ['n-db', 'n-web']);
  assert.deepEqual(r.json.uncovered, []);
  rmSync(dir, { recursive: true, force: true });
});

test('d2 an entity whose evidence file changed is listed, including field-level evidence', () => {
  const { dir } = repo();
  put(dir, 'db/schema.sql', 'changed\n');
  put(dir, 'queue/job.js', 'changed\n');
  commit(dir, 'edit schema');
  const r = cli(dir);
  assert.deepEqual(r.json.entities, ['en-job', 'en-user']);
  assert.deepEqual(r.json.nodes, ['n-db', 'n-queue']);
  assert.deepEqual(r.json.dependents, ['n-api']);
  rmSync(dir, { recursive: true, force: true });
});

test('d3 a node is also found by an evidence path when no paths glob owns the file', () => {
  const { dir } = repo();
  put(dir, 'config/app.yml', 'changed\n');
  commit(dir, 'edit cfg');
  const r = cli(dir);
  assert.deepEqual(r.json.areas, ['config']);
  assert.deepEqual(r.json.nodes, ['n-cfg']);
  assert.deepEqual(r.json.dependents, []);
  rmSync(dir, { recursive: true, force: true });
});

test('d4 a sequence is listed when a participant node or a step endpoint touches an affected node', () => {
  const { dir } = repo();
  put(dir, 'web/w.js', 'changed\n');
  commit(dir, 'edit web');
  assert.deepEqual(cli(dir).json.sequences, ['seq-login']);
  put(dir, 'queue/q.js', 'changed\n');
  commit(dir, 'edit queue');
  assert.deepEqual(cli(dir).json.sequences, ['seq-jobs', 'seq-login']);
  rmSync(dir, { recursive: true, force: true });
});

test('d5 a new file outside every glob is uncovered, whether committed or untracked; a covered new file is not', () => {
  const { dir } = repo();
  put(dir, 'misc/new.txt');
  commit(dir, 'add misc');
  put(dir, 'tools/untracked.sh');
  put(dir, 'api/fresh.js');
  const r = cli(dir);
  assert.deepEqual(r.json.uncovered, ['misc/new.txt', 'tools/untracked.sh']);
  assert.deepEqual(r.json.files, ['api/fresh.js', 'misc/new.txt', 'tools/untracked.sh']);
  assert.deepEqual(r.json.areas, ['api']);
  assert.deepEqual(r.json.nodes, ['n-api']);
  rmSync(dir, { recursive: true, force: true });
});

test('d6 gitignored files are not reported; a deleted file maps to its node but is never uncovered', () => {
  const { dir } = repo();
  put(dir, '.gitignore', 'ignored/\n');
  put(dir, 'ignored/x.txt');
  git(dir, 'rm', '-q', 'web/w.js');
  commit(dir, 'drop web');
  const r = cli(dir);
  assert.ok(!r.json.files.includes('ignored/x.txt'));
  assert.ok(r.json.files.includes('web/w.js'));
  assert.deepEqual(r.json.nodes, ['n-web']);
  assert.deepEqual(r.json.uncovered, []);
  rmSync(dir, { recursive: true, force: true });
});

test('d7 a rename counts as delete plus add: both paths are listed and the new path can be uncovered', () => {
  const { dir } = repo();
  mkdirSync(join(dir, 'misc'), { recursive: true });
  git(dir, 'mv', 'api/a.js', 'misc/a.js');
  commit(dir, 'move');
  const r = cli(dir);
  assert.deepEqual(r.json.files, ['api/a.js', 'misc/a.js']);
  assert.deepEqual(r.json.nodes, ['n-api']);
  assert.deepEqual(r.json.uncovered, ['misc/a.js']);
  rmSync(dir, { recursive: true, force: true });
});

test('d8 behind counts the commits between the base and HEAD, and --since overrides meta.commit', () => {
  const { dir, base } = repo();
  put(dir, 'api/a.js', '1\n'); const c1 = commit(dir, 'one');
  put(dir, 'web/w.js', '2\n'); commit(dir, 'two');
  put(dir, 'queue/q.js', '3\n'); commit(dir, 'three');
  const r = cli(dir);
  assert.equal(r.json.behind, 3);
  assert.equal(r.json.base, base);
  const s = cli(dir, '--since', c1);
  assert.equal(s.json.behind, 2);
  assert.equal(s.json.base, c1);
  assert.deepEqual(s.json.files, ['queue/q.js', 'web/w.js']);
  rmSync(dir, { recursive: true, force: true });
});

test('d9 nothing changed gives empty lists and exit 0, in JSON and in the human summary', () => {
  const { dir, base } = repo();
  const r = cli(dir);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.json, { base, head: base, behind: 0, files: [], areas: [], nodes: [], dependents: [], entities: [], sequences: [], uncovered: [] });
  const h = spawnSync(process.execPath, [CLI, MODELS.get(dir), '--repo', dir], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /nothing affected/i);
  rmSync(dir, { recursive: true, force: true });
});

test('d10 human output is a short summary naming counts and the commits behind', () => {
  const { dir } = repo();
  put(dir, 'api/a.js', 'changed\n');
  commit(dir, 'edit');
  const h = spawnSync(process.execPath, [CLI, MODELS.get(dir), '--repo', dir], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /1 commit behind/);
  assert.match(h.stdout, /n-api/);
  assert.ok(h.stdout.split('\n').length < 20);
  rmSync(dir, { recursive: true, force: true });
});

test('d11 usage errors, an unknown base commit and a non-git directory all exit 2', () => {
  const { dir } = repo();
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.equal(run(MODELS.get(dir), '--bogus').status, 2);
  assert.equal(run(join(dir, 'missing.json'), '--repo', dir).status, 2);
  assert.equal(run(MODELS.get(dir), '--repo', dir, '--since', 'deadbeef00000000000000000000000000000000').status, 2);
  const plain = mkdtempSync(join(tmpdir(), 'archmap-nogit-'));
  put(plain, 'model.json', JSON.stringify(modelFor('abc')));
  const r = run(join(plain, 'model.json'), '--repo', plain);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /git/i);
  rmSync(dir, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

test('d12 the pure diffmap(model, changes) sorts and dedupes, and output is deterministic', () => {
  const { model } = repo();
  const changes = { base: 'b', head: 'h', behind: 2, files: [{ status: 'M', path: 'web/w.js' }, { status: 'M', path: 'api/a.js' }, { status: 'A', path: 'zzz/new.txt' }, { status: 'A', path: 'aaa/new.txt' }, { status: 'M', path: 'api/a.js' }] };
  const a = diffmap(model, changes);
  assert.deepEqual(a, diffmap(model, changes));
  assert.deepEqual(a, {
    base: 'b', head: 'h', behind: 2,
    files: ['aaa/new.txt', 'api/a.js', 'web/w.js', 'zzz/new.txt'],
    areas: ['api', 'web'], nodes: ['n-api', 'n-web'], dependents: ['n-db'], entities: [], sequences: ['seq-login'],
    uncovered: ['aaa/new.txt', 'zzz/new.txt'],
  });
});
