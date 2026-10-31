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

  const outDir = mkdtempSync(join(tmpdir(), 'archmap-prescan-out-'));
  tmpDirs.push(outDir);
  const outFile = join(outDir, 'prescan.json');
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

// ---------------------------------------------------------------------------------------------
// P10.2: per-area extracts. prescan writes <work>/extracts/<area>.json so the orchestrator never slices JSON.

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const workDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'archmap-work-'));
  tmpDirs.push(d);
  return d;
};
const sliceOf = (repo) => {
  const work = workDir();
  const r = run(repo, '--out', join(work, 'prescan.json'));
  assert.equal(r.status, 0, r.stderr);
  const pre = readJson(join(work, 'prescan.json'));
  return { work, pre, slice: (id) => readJson(join(work, 'extracts', `${id}.json`)) };
};

const LINKED = {
  'api/main.py':
    'from fastapi import FastAPI\nfrom worker.tasks import run\napp = FastAPI()\n\n@app.get("/items/{item_id}")\ndef get_item(item_id):\n    return run(item_id)\n',
  'api/models.py': 'x = 1\n',
  'api/util.py': 'y = 2\n',
  'worker/tasks.py': 'def run(i):\n    return i\n',
  'worker/__init__.py': '',
  'worker/other.py': 'z = 3\n',
  'web/package.json': JSON.stringify({ name: 'web', dependencies: { react: '18.0.0' } }),
  'web/src/api.ts': 'import { base } from "./http";\nexport const getItem = () => fetch("/items/42");\n',
  'web/src/http.ts': 'export const base = "";\n',
  'web/src/App.tsx': 'import { getItem } from "./api";\nexport const App = () => { getItem(); return null; };\n',
};

test('pc8 the import and call edges between areas are listed with source and target file, on both sides', () => {
  const { pre, slice } = sliceOf(makeRepo(LINKED));
  assert.deepEqual(pre.areas.map((a) => a.id).sort(), ['api', 'web', 'worker']);
  for (const a of pre.areas) assert.equal(a.extract, `extracts/${a.id}.json`, 'each area points at its extract file');

  const api = slice('api');
  assert.deepEqual(
    api.links.filter((l) => l.kind === 'import'),
    [{ kind: 'import', dir: 'out', from: 'api/main.py', to: 'worker/tasks.py', other: 'worker' }],
  );
  const worker = slice('worker');
  assert.deepEqual(
    worker.links.filter((l) => l.kind === 'import'),
    [{ kind: 'import', dir: 'in', from: 'api/main.py', to: 'worker/tasks.py', other: 'api' }],
  );

  // the call edge: web fetches a path that an api route serves
  const out = slice('web').links.filter((l) => l.kind === 'http');
  assert.equal(out.length, 1, JSON.stringify(slice('web').links));
  assert.deepEqual([out[0].dir, out[0].other, out[0].via], ['out', 'api', 'GET /items/{item_id}']);
  assert.match(out[0].from, /^web\/src\/api\.ts:2$/);
  assert.match(out[0].to, /^api\/main\.py:5(-\d+)?$/);
  const inn = api.links.filter((l) => l.kind === 'http');
  assert.deepEqual(inn.map((l) => [l.dir, l.other, l.from, l.to]), [['in', 'web', out[0].from, out[0].to]]);

  // edges inside one area are listed too, but as plain "from > to" rows
  assert.deepEqual(slice('web').imports, ['web/src/App.tsx > web/src/api.ts', 'web/src/api.ts > web/src/http.ts']);
});

test('pc9 the explorer agent file plus the area summary is under 12 K characters for every area of every fixture repo; an oversized area keeps every row in its full extract and only the summary is capped', () => {
  const brief = readFileSync(join(ROOT, 'agents', 'archmap-explorer.md'), 'utf8').length;
  for (const name of ['python-api', 'node-api', 'ts-web']) {
    const { pre, slice, work } = sliceOf(join(ROOT, 'tests', 'fixtures', 'repos', name));
    for (const a of pre.areas) {
      const size = readFileSync(join(work, 'extracts', `${a.id}.summary.json`), 'utf8').length;
      assert.ok(brief + size < 12000, `${name}/${a.id}: agent file ${brief} + summary ${size} chars`);
      assert.equal(slice(a.id).area, a.id);
    }
  }

  const wide = { 'big/package.json': JSON.stringify({ name: 'big', dependencies: { express: '4.0.0' } }), 'big/a.js': 'x\n', 'big/b.js': 'x\n' };
  const lines = ["const express = require('express');", 'const app = express();'];
  for (let i = 0; i < 280; i++) lines.push(`app.get('/route-number-${String(i).padStart(3, '0')}/:id', handlerNumber${i});`);
  wide['big/routes.js'] = lines.join('\n') + '\n';
  for (const d of ['one', 'two']) for (let i = 0; i < 3; i++) wide[`${d}/f${i}.py`] = 'x = 1\n';
  const { slice, pre, work } = sliceOf(makeRepo(wide));
  const id = pre.areas.find((a) => a.globs.some((g) => g.startsWith('big/'))).id;
  const s = slice(id);
  assert.equal(s.routes.length, 280, 'the full extract keeps every route');
  assert.ok(!(s.truncated && s.truncated.routes > 0), `nothing is trimmed from the full extract: ${JSON.stringify(s.truncated)}`);
  const sum = readJson(join(work, 'extracts', `${id}.summary.json`));
  assert.ok(JSON.stringify(sum).length + brief < 12000, `summary is ${JSON.stringify(sum).length} chars`);
  assert.equal(sum.counts.routes, 280, 'the summary counts every route');
  assert.ok(sum.routes.length > 0 && sum.routes.length < 280, `the summary carries the first rows only (${sum.routes.length})`);
});

test('pc10 a merged leftover bucket is named misc (misc-2, misc-3 for more) and its title lists its member directories, never an id joined with plus signs', () => {
  const files = {};
  for (let i = 0; i < 14; i++) for (let j = 0; j < 4; j++) files[`mod${String(i).padStart(2, '0')}/f${j}.py`] = `x = ${j}\n`;
  files['top.py'] = 'x = 1\n';
  const { areas } = scan(makeRepo(files));
  const ids = areas.map((a) => a.id);
  assert.ok(!ids.some((i) => i.includes('+')), ids.join(','));
  assert.equal(new Set(ids).size, ids.length);
  const miscs = areas.filter((a) => /^misc(-\d+)?$/.test(a.id));
  assert.ok(miscs.length >= 1, ids.join(','));
  assert.equal(miscs[0].id, 'misc');
  assert.ok(miscs.length >= 2, `further buckets are misc-2, misc-3: ${ids.join(',')}`);
  for (const [i, a] of miscs.entries()) {
    assert.equal(a.id, i === 0 ? 'misc' : `misc-${i + 1}`, 'misc, misc-2, misc-3 in order');
    const dirs = a.globs.map((g) => g.split('/')[0]).filter((d) => /^mod\d+$/.test(d));
    assert.ok(dirs.length >= 1, `${a.id} holds ${dirs.length} directories`);
    for (const d of dirs) assert.ok(a.title.includes(d), `${a.id}: title ${a.title} lists ${d}`);
  }
});

// ---------------------------------------------------------------------------------------------
// P10.10: prescan writes the full extract for the script and a capped summary for the explorer.

test('pc11 prescan writes extracts/<area>.json in full and extracts/<area>.summary.json with counts per kind, the first rows and the note that entities, relations and queue edges are made by script', () => {
  const brief = readFileSync(join(ROOT, 'agents', 'archmap-explorer.md'), 'utf8').length;
  for (const name of ['python-api', 'node-api', 'ts-web']) {
    const { pre, work } = sliceOf(join(ROOT, 'tests', 'fixtures', 'repos', name));
    for (const a of pre.areas) {
      assert.equal(a.extract, `extracts/${a.id}.json`);
      assert.equal(a.summary, `extracts/${a.id}.summary.json`, `${name}/${a.id}: the area points at its summary`);
      const full = readJson(join(work, a.extract));
      const text = readFileSync(join(work, a.summary), 'utf8');
      assert.ok(text.length + brief < 12000, `${name}/${a.id}: ${text.length} chars`);
      const sum = JSON.parse(text);
      assert.equal(sum.area, a.id);
      assert.equal(sum.extract, a.extract, 'the summary names the full extract it summarises');
      assert.match(sum.note, /entities, relations and queue edges[^.]*\bscript\b/i, `${name}/${a.id}: ${sum.note}`);
      const kinds = Object.keys(full).filter((k) => Array.isArray(full[k]) && k !== 'globs' && k !== 'stacks');
      assert.ok(kinds.length >= 3, JSON.stringify(kinds));
      for (const k of kinds) {
        assert.equal(sum.counts[k], full[k].length, `${name}/${a.id}: counts.${k}`);
        if (Array.isArray(sum[k])) {
          assert.ok(sum[k].length <= full[k].length, `${name}/${a.id}: ${k} rows`);
          assert.deepEqual(sum[k], full[k].slice(0, sum[k].length), `${name}/${a.id}: the summary's ${k} are the first rows`);
        }
      }
    }
  }
  // the node fixture's src area: the counts say how much there is although the summary shows less
  const { pre, work } = sliceOf(join(ROOT, 'tests', 'fixtures', 'repos', 'node-api'));
  const src = pre.areas.find((a) => a.id === 'src');
  const sum = readJson(join(work, src.summary));
  assert.ok(sum.counts.routes >= 20 && sum.counts.tables >= 4 && sum.counts.queues >= 1, JSON.stringify(sum.counts));
  // byte-identical across runs
  const again = sliceOf(join(ROOT, 'tests', 'fixtures', 'repos', 'node-api'));
  assert.equal(readFileSync(join(again.work, src.summary), 'utf8'), readFileSync(join(work, src.summary), 'utf8'));
  assert.equal(readFileSync(join(again.work, src.extract), 'utf8'), readFileSync(join(work, src.extract), 'utf8'));
});
