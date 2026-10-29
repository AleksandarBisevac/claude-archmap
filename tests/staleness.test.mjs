import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (s1, s2, ...) lead every title so the suite prints them first.
const CLI = fileURLToPath(new URL('../scripts/staleness.mjs', import.meta.url));
const HOOKS = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));
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
const MODEL_REL = 'docs/architecture/architecture.model.json';
const ev = (path) => [{ path, lines: '1-2' }];
const modelFor = (sha) => ({
  meta: { schemaVersion: '1.0', project: 'demo', commit: sha, generatedAt: '2026-01-01T00:00:00Z', profile: 'balanced', sources: [], coverage: { api: ['api/**'], db: ['db/**'] } },
  zones: [],
  nodes: [
    { id: 'n-api', zone: 'z', kind: 'service', title: 'API', paths: ['api/**'], level: 1, evidence: ev('api/a.js') },
    { id: 'n-db', zone: 'z', kind: 'store', title: 'DB', paths: ['db/**'], level: 1, evidence: ev('db/schema.sql') },
  ],
  edges: [],
  entities: [{ id: 'en-user', store: 'n-db', name: 'user', kind: 'table', fields: [], evidence: ev('db/schema.sql') }],
  sequences: [],
});

/** A repo with a base commit and a model (left untracked) built at that commit. */
function repo({ model = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-stale-'));
  git(dir, 'init', '-q');
  for (const f of ['api/a.js', 'db/schema.sql', 'README.md']) put(dir, f);
  const base = commit(dir, 'base');
  if (model) put(dir, MODEL_REL, JSON.stringify(modelFor(base)));
  return { dir, base };
}
/** Two commits on top of the model's commit: one touches api (a node), one touches db (a node and an entity). */
function staleRepo() {
  const r = repo();
  put(r.dir, 'api/a.js', 'changed\n');
  commit(r.dir, 'edit api');
  put(r.dir, 'db/schema.sql', 'changed\n');
  commit(r.dir, 'edit db');
  return r;
}

const run = (args, { cwd, env = {}, input } = {}) => {
  const e = { ...GIT_ENV, ...env };
  if (!('CLAUDE_PROJECT_DIR' in env)) delete e.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: e, input, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const hook = (dir) => run([], { cwd: tmpdir(), env: { CLAUDE_PROJECT_DIR: dir } });
const LINE = /^Architecture map is 2 commits behind \(2 nodes, 1 entity affected\) \S+ run \/archmap:update\n$/;

test('s1 hook mode prints nothing and exits 0 when the project has no model', () => {
  const { dir } = repo({ model: false });
  const r = hook(dir);
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
});

test('s2 hook mode prints nothing and exits 0 for a fresh model', () => {
  const { dir } = repo();
  const r = hook(dir);
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
});

test('s3 hook mode prints exactly one line with the commits behind and the affected node/entity counts for a stale model', () => {
  const { dir } = staleRepo();
  const r = hook(dir);
  assert.equal(r.status, 0);
  assert.match(r.out, LINE);
  assert.equal(r.out.trimEnd().split('\n').length, 1);
});

test('s4 hook mode resolves the project from the stdin cwd, then process.cwd(), when CLAUDE_PROJECT_DIR is unset', () => {
  const { dir } = staleRepo();
  const viaStdin = run([], { cwd: tmpdir(), input: JSON.stringify({ cwd: dir, hook_event_name: 'SessionStart' }) });
  assert.equal(viaStdin.status, 0);
  assert.match(viaStdin.out, LINE);
  const viaCwd = run([], { cwd: dir, input: '' });
  assert.equal(viaCwd.status, 0);
  assert.match(viaCwd.out, LINE);
});

test('s5 hook mode prints nothing and exits 0 on a corrupt model, an unknown commit, a non-git dir and bad stdin', () => {
  const corrupt = repo();
  put(corrupt.dir, MODEL_REL, '{ not json');
  const unknown = repo();
  put(unknown.dir, MODEL_REL, JSON.stringify(modelFor('0'.repeat(40))));
  const nonGit = mkdtempSync(join(tmpdir(), 'archmap-stale-nogit-'));
  put(nonGit, MODEL_REL, JSON.stringify(modelFor('a'.repeat(40))));
  for (const d of [corrupt.dir, unknown.dir, nonGit]) {
    const r = hook(d);
    assert.equal(r.status, 0, d);
    assert.equal(r.out, '', d);
    assert.equal(r.err, '', d);
  }
  const bad = run([], { cwd: nonGit, input: '}{ garbage' });
  assert.equal(bad.status, 0);
  assert.equal(bad.out, '');
});

test('s6 hook mode gives up silently with exit 0 when git hangs past the timeout', () => {
  const { dir } = staleRepo();
  const bin = mkdtempSync(join(tmpdir(), 'archmap-stale-bin-'));
  put(bin, 'git', '#!/bin/sh\nsleep 20\n');
  chmodSync(join(bin, 'git'), 0o755);
  const t0 = Date.now();
  const r = run([], { cwd: tmpdir(), env: { CLAUDE_PROJECT_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ARCHMAP_STALENESS_TIMEOUT_MS: '400' } });
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  assert.ok(Date.now() - t0 < 10000, 'returned before the hanging git finished');
});

test('s7 check mode exits 0 and says the map is current for a fresh model', () => {
  const { dir } = repo();
  const r = run(['--check', '--project', dir]);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, 'Architecture map is current\n');
});

test('s8 check mode exits 1 and prints the stale line; --json reports the numbers', () => {
  const { dir } = staleRepo();
  const r = run(['--check', '--project', dir]);
  assert.equal(r.status, 1, r.err);
  assert.match(r.out, LINE);
  const j = run(['--check', '--project', dir, '--json']);
  assert.equal(j.status, 1);
  const o = JSON.parse(j.out);
  assert.equal(o.stale, true);
  assert.equal(o.behind, 2);
  assert.equal(o.nodes, 2);
  assert.equal(o.entities, 1);
  const fresh = JSON.parse(run(['--check', '--project', repo().dir, '--json']).out);
  assert.equal(fresh.stale, false);
});

test('s9 check mode exits 2 on no model, a non-git dir, a corrupt model, an unknown option', () => {
  const none = repo({ model: false });
  const nonGit = mkdtempSync(join(tmpdir(), 'archmap-stale-nogit-'));
  put(nonGit, MODEL_REL, JSON.stringify(modelFor('a'.repeat(40))));
  const corrupt = repo();
  put(corrupt.dir, MODEL_REL, '{ not json');
  for (const args of [['--check', '--project', none.dir], ['--check', '--project', nonGit], ['--check', '--project', corrupt.dir], ['--check', '--bogus'], ['--check', '--project']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
  }
});

test('s10 hooks/hooks.json holds one SessionStart command hook running scripts/staleness.mjs through ${CLAUDE_PLUGIN_ROOT}', () => {
  const cfg = JSON.parse(readFileSync(HOOKS, 'utf8'));
  assert.deepEqual(Object.keys(cfg.hooks), ['SessionStart']);
  const groups = cfg.hooks.SessionStart;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hooks.length, 1);
  const h = groups[0].hooks[0];
  assert.equal(h.type, 'command');
  assert.equal(h.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/staleness.mjs"');
});

/** NODE_OPTIONS that preload a module making process.stdout.write throw: an unexpected, non-usage failure. */
function crashingStdout() {
  const d = mkdtempSync(join(tmpdir(), 'archmap-stale-crash-'));
  put(d, 'crash.cjs', "process.stdout.write = () => { throw new Error('boom-unexpected'); };\n");
  return `--require ${join(d, 'crash.cjs')}`;
}

test('s11 check mode exits 2 and prints the error when an unexpected exception is thrown, while hook mode stays silent with exit 0', () => {
  const { dir } = staleRepo();
  const NODE_OPTIONS = crashingStdout();
  const c = run(['--check', '--project', dir], { env: { NODE_OPTIONS } });
  assert.equal(c.status, 2, `check mode must report an error, not 0: ${c.err}`);
  assert.match(c.err, /boom-unexpected/);
  const h = run([], { cwd: tmpdir(), env: { CLAUDE_PROJECT_DIR: dir, NODE_OPTIONS } });
  assert.equal(h.status, 0);
  assert.equal(h.out, '');
});
