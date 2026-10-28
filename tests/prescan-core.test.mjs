import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (pc1..pc6) lead every title so the suite prints them first.
// prescan.mjs core: inventory, stack detection, area partitioning, generic recipe.
// Fixture repos are built in os.tmpdir() with `git init`; every name in them is fictional.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRESCAN = join(ROOT, 'scripts', 'prescan.mjs');

const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// files: { relPath: string|Buffer }. `untracked` paths are written but never `git add`ed; `force`
// paths are added with -f so they are tracked even though .gitignore matches them.
function makeRepo(files, { untracked = [], force = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-prescan-'));
  tmpDirs.push(dir);
  git(dir, 'init', '-q');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  // `add -A` leaves .gitignore'd paths out; forced ones go in with -f; held ones are un-staged again.
  git(dir, 'add', '-A');
  if (force.length) git(dir, 'add', '-f', '--', ...force);
  if (untracked.length) git(dir, 'rm', '-q', '--cached', '--', ...untracked);
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

const run = (repo, ...extra) => {
  const r = spawnSync(process.execPath, [PRESCAN, repo, ...extra], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const scan = (repo, ...extra) => {
  const r = run(repo, ...extra);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

// "**" crosses "/", "*" does not.
const globRe = (g) =>
  new RegExp(
    '^' +
      g
        .split('**')
        .map((p) => p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
        .join('.*') +
      '$',
  );

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
const MIXED = {
  '.gitignore': 'node_modules/\n.venv/\n*.log\n',
  'README.md': '# Fictional shop\n',
  'docker-compose.yml': 'services:\n  api:\n    build: ./api\n',
  '.github/workflows/ci.yml': 'name: ci\non: push\n',
  'api/pyproject.toml': '[project]\nname = "shop-api"\ndependencies = ["fastapi", "sqlalchemy"]\n',
  'api/Dockerfile': 'FROM python:3.12\n',
  'api/app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
  'api/app/models.py': 'from sqlalchemy import Column\n',
  'api/app/routes.py': 'x = 1\n',
  'api/migrations/0001_init.sql': 'create table t (id int);\n',
  'web/package.json': JSON.stringify({ name: 'shop-web', dependencies: { react: '18.0.0', vite: '5.0.0' } }),
  'web/index.html': '<div id="root"></div>\n',
  'web/src/main.tsx': 'export {};\n',
  'web/src/App.tsx': 'export const App = () => null;\n',
  'web/src/api.ts': 'export const get = () => fetch("/api/items");\n',
  'services/gateway/package.json': JSON.stringify({ name: 'gateway', main: 'src/server.js', dependencies: { express: '4.19.0' } }),
  'services/gateway/src/server.js': 'const express = require("express");\n',
  'services/gateway/src/routes.js': 'module.exports = {};\n',
  'services/gateway/src/util.js': 'module.exports = {};\n',
  'data/shop.sqlite': PNG,
  'data/analytics.duckdb': PNG,
  'assets/logo.png': PNG,
  'node_modules/leftpad/index.js': 'module.exports = 1;\n',
  'web/node_modules/dep/index.js': 'module.exports = 1;\n',
  'api/.venv/lib/site.py': 'x = 1\n',
  'debug.log': 'noise\n',
  'tools/notes.txt': 'untracked but not ignored\n',
};
// web/node_modules is tracked on purpose: a tracked vendored file must still be skipped.
const MIXED_OPTS = { untracked: ['tools/notes.txt'], force: ['web/node_modules/dep/index.js'] };
// What the inventory must keep: text files that are not vendored, ignored, binary or DB files.
const MIXED_SOURCES = Object.keys(MIXED).filter(
  (f) => !/(^|\/)(node_modules|\.venv)\//.test(f) && !/\.(png|sqlite|duckdb|log)$/.test(f),
);

test('pc1 lists files via git ls-files, honouring .gitignore, vendored dirs and binaries', () => {
  const repo = makeRepo(MIXED, MIXED_OPTS);
  const out = scan(repo);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.commit, git(repo, 'rev-parse', 'HEAD').trim());
  const total = out.areas.reduce((n, a) => n + a.files, 0);
  assert.equal(total, MIXED_SOURCES.length, 'every kept source file is counted in exactly one area');
  const outText = JSON.stringify(out);
  assert.ok(!outText.includes('node_modules'), 'vendored dirs are skipped');
  assert.ok(!outText.includes('debug.log'), 'gitignored files are not inventoried');
});

test('pc2 detects stacks from pyproject/requirements and package.json deps', () => {
  const repo = makeRepo(MIXED, MIXED_OPTS);
  assert.deepEqual(scan(repo).stacks, ['node-backend', 'python', 'ts-frontend']);

  const pyOnly = makeRepo({ 'requirements.txt': 'flask\n', 'app.py': 'x = 1\n' });
  assert.deepEqual(scan(pyOnly).stacks, ['python']);

  const nodeOnly = makeRepo({
    'package.json': JSON.stringify({ dependencies: { fastify: '4.0.0' } }),
    'index.js': 'x\n',
  });
  assert.deepEqual(scan(nodeOnly).stacks, ['node-backend']);

  const none = makeRepo({ 'main.go': 'package main\n' });
  assert.deepEqual(scan(none).stacks, []);
});

test('pc3 partitions into at most 8 areas with disjoint globs covering every source file', () => {
  const repo = makeRepo(MIXED, MIXED_OPTS);
  const { areas } = scan(repo);
  assert.ok(areas.length >= 3 && areas.length <= 8, `got ${areas.length} areas`);
  const ids = areas.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'area ids are unique');
  for (const a of areas) {
    assert.ok(a.title && Array.isArray(a.globs) && a.globs.length > 0 && Array.isArray(a.stacks));
  }
  const res = areas.map((a) => ({ a, res: a.globs.map(globRe) }));
  for (const f of MIXED_SOURCES) {
    const hit = res.filter((x) => x.res.some((r) => r.test(f))).map((x) => x.a.id);
    assert.equal(hit.length, 1, `${f} matched by ${JSON.stringify(hit)}`);
  }
  const owner = (f) => res.find((x) => x.res.some((r) => r.test(f))).a;
  assert.deepEqual(owner('api/app/main.py').stacks, ['python']);
  assert.deepEqual(owner('web/src/App.tsx').stacks, ['ts-frontend']);
  assert.deepEqual(owner('services/gateway/src/server.js').stacks, ['node-backend']);
  assert.notEqual(owner('api/app/main.py').id, owner('web/src/App.tsx').id, 'backend and frontend are separate areas');
});

test('pc4 caps a wide repo at 8 areas and splits monorepo workspaces', () => {
  const wide = {};
  for (let i = 0; i < 14; i++) for (let j = 0; j < 4; j++) wide[`mod${String(i).padStart(2, '0')}/f${j}.py`] = `x = ${j}\n`;
  wide['top.py'] = 'x = 1\n';
  const repo = makeRepo(wide);
  const { areas } = scan(repo);
  assert.ok(areas.length <= 8, `got ${areas.length}`);
  const res = areas.map((a) => a.globs.map(globRe));
  for (const f of Object.keys(wide)) {
    assert.equal(res.filter((rs) => rs.some((r) => r.test(f))).length, 1, f);
  }

  const mono = {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'packages/alpha/package.json': JSON.stringify({ name: 'alpha', dependencies: { express: '4.0.0' } }),
    'packages/alpha/index.js': 'a\n',
    'packages/alpha/lib.js': 'a\n',
    'packages/beta/package.json': JSON.stringify({ name: 'beta', dependencies: { react: '18.0.0' } }),
    'packages/beta/index.jsx': 'b\n',
    'packages/beta/lib.js': 'b\n',
  };
  const m = scan(makeRepo(mono));
  const globs = m.areas.flatMap((a) => a.globs);
  assert.ok(globs.some((g) => g.startsWith('packages/alpha')), JSON.stringify(globs));
  assert.ok(globs.some((g) => g.startsWith('packages/beta')), JSON.stringify(globs));
  assert.ok(!m.areas.some((a) => a.globs.some((g) => g.startsWith('packages/alpha')) && a.globs.some((g) => g.startsWith('packages/beta'))));
});

test('pc5 lists sqlite and duckdb files in sources without reading them, plus generic hints', () => {
  const repo = makeRepo(MIXED, MIXED_OPTS);
  const out = scan(repo);
  assert.deepEqual(out.sources, [
    { kind: 'duckdb', path: 'data/analytics.duckdb', status: 'found' },
    { kind: 'sqlite', path: 'data/shop.sqlite', status: 'found' },
  ]);
  const g = out.extracts.generic;
  assert.ok(g.entryPoints.includes('api/app/main.py'), JSON.stringify(g.entryPoints));
  assert.ok(g.entryPoints.includes('services/gateway/src/server.js'));
  assert.deepEqual(g.topLevelDirs, ['.github', 'api', 'services', 'tools', 'web']);
  assert.ok(g.containers.includes('docker-compose.yml') && g.containers.includes('api/Dockerfile'));
  assert.deepEqual(g.ci, ['.github/workflows/ci.yml']);
});

test('pc6 output is byte-identical across runs, honours --out and --scope, and plugs in extractors', () => {
  const repo = makeRepo(MIXED, MIXED_OPTS);
  const a = run(repo);
  const b = run(repo);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  assert.ok(a.stdout.endsWith('\n'));

  const outFile = join(repo, '..', `${repo.split('/').pop()}-out.json`);
  tmpDirs.push(outFile);
  const c = run(repo, '--out', outFile);
  assert.equal(c.status, 0);
  assert.equal(readFileSync(outFile, 'utf8'), a.stdout);

  const scoped = scan(repo, '--scope', 'web');
  assert.ok(scoped.areas.every((x) => x.globs.every((g) => g.startsWith('web/'))), JSON.stringify(scoped.areas));
  assert.deepEqual(scoped.stacks, ['ts-frontend']);

  assert.equal(run(join(tmpdir(), 'archmap-no-such-dir-xyz')).status, 2);
});

test('pc7 prescan() runs plug-in extractors (detect/extract) and files their fragment under extracts', async () => {
  const { prescan } = await import(pathToFileURL(PRESCAN).href);
  const repo = makeRepo({ 'a/x.txt': 'hello\n', 'a/y.txt': 'yo\n', 'a/z.txt': 'z\n' });
  const seen = [];
  const plugin = {
    id: 'fake',
    detect: (inv) => inv.files.includes('a/x.txt'),
    extract: (files, read) => {
      seen.push(files.length);
      return { greeting: read('a/x.txt').trim() };
    },
  };
  const off = { id: 'never', detect: () => false, extract: () => assert.fail('must not run') };
  const out = await prescan(repo, { extractors: [plugin, off] });
  assert.deepEqual(out.extracts.fake, { greeting: 'hello' });
  assert.ok(out.stacks.includes('fake') && !out.stacks.includes('never'));
  assert.deepEqual(seen, [3]);
});
