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

test('pc12 file databases opened by path in js and ts (new duckdb.Database, new Database with a database extension, DuckDBInstance.create) and python reach the area extract as store rows with their path, whether or not the file exists', () => {
  const repo = makeRepo({
    'package.json': '{"name":"x","dependencies":{"express":"4"}}',
    'api/db.ts':
      "import duckdb from 'duckdb';\nimport Database from 'better-sqlite3';\n\n" +
      "export const wh = new duckdb.Database('./data/wh.duckdb');\n" +
      "export const cache = new Database('var/cache.db');\n" +
      "export const mem = new duckdb.Database(':memory:');\n" +
      "export const other = new Database('not-a-database.txt');\n" +
      '// const old = new duckdb.Database("data/old.duckdb");\n',
    'api/etl.py': 'import sqlite3\n\nCONN = sqlite3.connect("var/etl.sqlite")\n',
  });
  const out = JSON.parse(execFileSync(process.execPath, [PRESCAN, repo], { encoding: 'utf8' }));
  const rows = [...out.extracts.generic.stores, ...out.extracts.python.stores].map((s) => `${s.kind} ${s.path} ${s.evidence[0].path}:${s.evidence[0].lines}`);
  assert.deepEqual(rows, [
    'duckdb data/wh.duckdb api/db.ts:4',
    'sqlite var/cache.db api/db.ts:5',
    'sqlite var/etl.sqlite api/etl.py:3',
  ]);
  assert.deepEqual(out.sources, [], 'none of the three files is in the repository');
});

// ---------------------------------------------------------------------------------------------
// P10.13: SQL in string literals is a schema: python strings and js/ts template literals give statement rows in the
// owning area's extract, CREATE TABLE statements give tables with their columns, and the summary counts the tables
// that queries name and nothing declares.

test('pc13 SQL in python strings and js/ts template literals reaches the area extract: sqlTables rows per statement, CREATE TABLE as a table with fields and fk, and the summary counts the tables only queries name', () => {
  const repo = makeRepo({
    'tools/etl.py':
      'def run(conn):\n' +
      '    conn.executescript("""\n' +
      '        CREATE TABLE IF NOT EXISTS depots (id INTEGER PRIMARY KEY, name TEXT);\n' +
      '        CREATE TABLE IF NOT EXISTS pallets (id INTEGER PRIMARY KEY, depot_id INTEGER REFERENCES depots(id));\n' +
      '    """)\n' +
      '    conn.execute("INSERT INTO pallets (depot_id) VALUES (1)")\n' +
      '    conn.execute("SELECT * FROM depots d JOIN forklifts f ON f.depot = d.id")\n',
    'api/package.json': '{"name":"api","dependencies":{"express":"4"}}',
    'api/db.js':
      "const rows = await db.query(`\n  SELECT * FROM forklifts\n  WHERE depot = ${depot}\n`);\n" +
      'await db.query(`INSERT INTO shifts (a) VALUES ($1)`, [1]);\n' +
      'await db.query(`DELETE FROM ${table}`);\n' +
      "// await db.query('SELECT * FROM commented_out');\n" +
      "const note = 'select the best from the rest';\n",
  });
  const { pre, slice, work } = sliceOf(repo);
  const rows = (id) => slice(id).sqlTables;
  const all = pre.areas.flatMap((a) => rows(a.id));
  assert.deepEqual(
    all.slice().sort(),
    [
      'depots ddl tools/etl.py:3', 'depots select tools/etl.py:7', 'forklifts select api/db.js:2', 'forklifts select tools/etl.py:7',
      'pallets ddl tools/etl.py:4', 'pallets insert tools/etl.py:6', 'shifts insert api/db.js:5',
    ].sort(),
  );
  const tables = pre.areas.flatMap((a) => slice(a.id).tables.filter((t) => t.orm === 'sql'));
  const pallets = tables.find((t) => t.name === 'pallets');
  assert.deepEqual(pallets.fields, ['id INTEGER pk', 'depot_id INTEGER fk=depots.id']);
  assert.deepEqual([pallets.file, pallets.line], ['tools/etl.py', 4]);
  const area = pre.areas.find((a) => slice(a.id).sqlTables.some((r) => r.startsWith('pallets')));
  const sum = readJson(join(work, area.summary));
  assert.equal(sum.counts.inferredTables, 2, 'forklifts and shifts: queried, declared nowhere (depots and pallets are declared by CREATE TABLE)');
  assert.equal(sum.counts.sqlTables, slice(area.id).sqlTables.length);
  assert.ok(!('inferredTables' in slice(area.id)), 'the full extract holds rows only');
  assert.match(sum.note, /inferred/i);
});

// ---------------------------------------------------------------------------------------------
// P10.14: workspace apps are listed by script, and the partition never folds two of them into one bucket.

const APP_NAMES = ['atlas', 'billing', 'console', 'gateway', 'hub', 'ledger', 'tenant-router', 'web'];
const monorepo = (workspace = { 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'packages/kits/*'\n" }) => {
  const files = {
    ...workspace,
    'package.json': JSON.stringify({ name: 'fictional-root', private: true }),
    'README.md': '# Fictional workspace\n',
    'packages/db/package.json': JSON.stringify({ name: '@fict/db' }),
    'packages/db/src/schema.ts': 'export {};\n',
    'packages/db/src/client.ts': 'export {};\n',
    'packages/db/src/index.ts': 'export {};\n',
    'packages/kits/forms/package.json': JSON.stringify({ name: '@fict/forms' }),
    'packages/kits/forms/index.ts': 'export {};\n',
    'infra/main.tf': 'x\n',
    'scripts/release.sh': 'x\n',
  };
  for (const n of APP_NAMES) {
    files[`apps/${n}/package.json`] = JSON.stringify({ name: `@fict/${n}`, dependencies: { express: '4.0.0' } });
    files[`apps/${n}/src/main.ts`] = 'export {};\n';
  }
  files['apps/notes/readme.txt'] = 'a directory that is not a workspace member\n';
  return files;
};

test('pc14 prescan lists the workspace apps of a pnpm-workspace.yaml, package.json workspaces or turbo.json as {name, dir, manifest}; the partition keeps every app as its own area or the head of its area and merges leftovers among themselves only', async () => {
  const wantApps = APP_NAMES.map((n) => ({ name: `@fict/${n}`, dir: `apps/${n}`, manifest: `apps/${n}/package.json` }));
  const pnpm = scan(makeRepo(monorepo()));
  assert.deepEqual(pnpm.workspaceApps, wantApps, 'apps/notes has no package.json: not a member');

  const viaJson = scan(makeRepo({
    ...monorepo({}),
    'package.json': JSON.stringify({ name: 'r', workspaces: { packages: ['apps/*', '!apps/web', 'packages/*'] } }),
  }));
  assert.deepEqual(viaJson.workspaceApps.map((a) => a.dir), wantApps.map((a) => a.dir).filter((d) => d !== 'apps/web'), 'a negated member is left out');

  const viaTurbo = scan(makeRepo(monorepo({ 'turbo.json': '{"tasks":{"build":{}}}\n' })));
  assert.deepEqual(viaTurbo.workspaceApps, wantApps, 'turbo.json alone: apps/* and packages/* are the members');

  assert.deepEqual(scan(makeRepo({ 'apps/solo/package.json': '{"name":"solo"}', 'apps/solo/index.js': 'x\n' })).workspaceApps, [], 'no workspace declared, no app listed');

  // the partition: 8 apps, each with 2 files (small), plus other units; the cap is 8 areas
  const out = pnpm;
  const owner = (f) => out.areas.filter((a) => a.globs.map(globRe).some((r) => r.test(f)));
  for (const n of APP_NAMES) {
    const hit = owner(`apps/${n}/src/main.ts`);
    assert.equal(hit.length, 1, `apps/${n}`);
    assert.equal(hit[0].id, `apps-${n}`, `apps/${n} is the head of its area`);
    assert.equal(owner(`apps/${n}/package.json`)[0].id, hit[0].id);
  }
  // P10.15: the cap (8) yields by what the apps need; the leftovers keep at most LEFTOVER_AREAS (3) areas of their own
  assert.ok(out.areas.length <= APP_NAMES.length + 3, `${out.areas.length} areas`);
  assert.ok(out.areas.filter((a) => !APP_NAMES.some((n) => a.id === `apps-${n}`)).length <= 3, out.areas.map((a) => a.id).join());
  for (const n of APP_NAMES) assert.deepEqual(out.areas.find((a) => a.id === `apps-${n}`).globs, [`apps/${n}/**`], `apps/${n} has nothing folded into it`);
  assert.ok(!out.areas.some((a) => a.id.startsWith('misc') && a.globs.some((g) => g.startsWith('apps/') && !g.startsWith('apps/notes'))), 'no misc bucket holds an app');
  const appsIn = (a) => APP_NAMES.filter((n) => a.globs.some((g) => g === `apps/${n}/**`));
  for (const a of out.areas) assert.ok(appsIn(a).length <= 1, `${a.id} holds ${appsIn(a)}`);
  // every file is owned once
  const { partition } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'prescan', 'partition.mjs')).href);
  const paths = Object.keys(monorepo());
  const areas = partition(paths, { containers: ['apps', 'packages', 'packages/kits'], apps: wantApps.map((a) => a.dir) });
  for (const f of paths) assert.equal(areas.filter((a) => a.paths.includes(f)).length, 1, f);
  // with only leftovers over the cap, the leftovers merge together first
  const few = partition(
    ['apps/a/package.json', 'apps/a/x.ts', 'apps/b/package.json', 'apps/b/x.ts', 'one/a.txt', 'two/a.txt', 'three/a.txt'],
    { containers: ['apps'], apps: ['apps/a', 'apps/b'], maxAreas: 3 },
  );
  assert.deepEqual(few.map((a) => a.id), ['apps-a', 'apps-b', 'misc'], 'the three leftovers share one bucket; the apps stay apart');
  // more apps than the cap: the cap yields to the apps, never the other way round
  const many = partition(
    ['apps/a/package.json', 'apps/b/package.json', 'apps/c/package.json', 'lib/x.ts'],
    { containers: ['apps'], apps: ['apps/a', 'apps/b', 'apps/c'], maxAreas: 2 },
  );
  assert.equal(many.length, 3);
  assert.ok(many.find((a) => a.id === 'apps-a' || a.id === 'apps-b' || a.id === 'apps-c').paths.length >= 1);
  assert.equal(many.reduce((n, a) => n + a.paths.length, 0), 4);
});

test('pc15 the full extract of an area holding a workspace app lists it under workspaceApps, and a middleware, guards or interceptors file or directory under middleware; two runs are byte-identical', () => {
  const repo = makeRepo({
    ...monorepo(),
    'apps/hub/src/middleware/auth.ts': 'export {};\n',
    'apps/hub/src/middleware/log.ts': 'export {};\n',
    'apps/hub/src/users/users.guard.ts': 'export {};\n',
    'apps/hub/src/audit.interceptor.ts': 'export {};\n',
    'apps/hub/src/middleware.test.ts': 'export {};\n',
    'apps/web/src/guards/session.ts': 'export {};\n',
  });
  const { pre, slice, work } = sliceOf(repo);
  const hub = slice('apps-hub');
  assert.deepEqual(hub.workspaceApps, [{ name: '@fict/hub', dir: 'apps/hub', manifest: 'apps/hub/package.json' }]);
  assert.deepEqual(hub.middleware, ['apps/hub/src/audit.interceptor.ts', 'apps/hub/src/middleware', 'apps/hub/src/users/users.guard.ts']);
  assert.deepEqual(slice('apps-web').middleware, ['apps/web/src/guards']);
  assert.ok(!('middleware' in slice('apps-ledger')), 'only where there is something');
  assert.deepEqual(slice('apps-ledger').workspaceApps.map((x) => x.dir), ['apps/ledger'], 'an area lists the apps it owns');
  const sum = readJson(join(work, pre.areas.find((a) => a.id === 'apps-hub').summary));
  assert.equal(sum.counts.workspaceApps, 1);
  assert.equal(sum.counts.middleware, 3);
  const a = run(repo);
  const b = run(repo);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
});

// ---------------------------------------------------------------------------------------------
// P10.15: leftovers keep areas of their own; they are never glued to one app to hold the cap.

test('pc16 partition with 8 workspace apps and 20 leftover units over maxAreas 8 keeps every app its own area and at least LEFTOVER_AREAS leftover areas; a leftover is folded into an app only when it is the single one left and smaller than SMALL; every path is owned once; two runs are byte-identical', async () => {
  const { partition, LEFTOVER_AREAS, SMALL } = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'prescan', 'partition.mjs')).href);
  assert.equal(LEFTOVER_AREAS, 3);
  assert.equal(SMALL, 3);
  const apps = APP_NAMES.map((n) => `apps/${n}`);
  const paths = [];
  for (const d of apps) paths.push(`${d}/package.json`, `${d}/src/main.ts`);
  // 20 leftover units, none small, so the small-leftover merge leaves them alone and the cap loop has to act
  for (let i = 0; i < 20; i++) {
    const dir = i < 12 ? `packages/widgets-${String(i).padStart(2, '0')}` : `tools-${String(i).padStart(2, '0')}`;
    for (let k = 0; k <= i % 4 + SMALL; k++) paths.push(`${dir}/src/f${k}.ts`);
  }
  const opts = { containers: ['apps', 'packages'], apps, maxAreas: 8 };
  const areas = partition(paths, opts);
  const appArea = (d) => areas.filter((a) => a.globs.includes(`${d}/**`));
  for (const d of apps) {
    const hit = appArea(d);
    assert.equal(hit.length, 1, d);
    assert.deepEqual(hit[0].globs, [`${d}/**`], `${d} is an area of its own, nothing folded into it`);
  }
  const leftovers = areas.filter((a) => !apps.some((d) => a.globs.includes(`${d}/**`)));
  assert.equal(leftovers.length, LEFTOVER_AREAS, `leftover areas: ${leftovers.map((a) => a.id)}`);
  assert.equal(areas.length, apps.length + LEFTOVER_AREAS, 'the cap yields by what the apps need');
  for (const f of paths) assert.equal(areas.filter((a) => a.paths.includes(f)).length, 1, f);
  assert.equal(JSON.stringify(partition(paths, opts)), JSON.stringify(areas), 'two runs are byte-identical');
  assert.equal(JSON.stringify(partition([...paths].reverse(), opts)), JSON.stringify(areas), 'input order does not matter');

  // the fold: the single leftover left over the cap, smaller than SMALL, joins the smallest app's area
  const three = ['apps/a/package.json', 'apps/b/package.json', 'apps/b/x.ts', 'apps/c/package.json', 'apps/c/x.ts'];
  const folded = partition([...three, 'lib/x.ts'], { containers: ['apps'], apps: ['apps/a', 'apps/b', 'apps/c'], maxAreas: 2 });
  assert.deepEqual(folded.map((a) => a.id), ['apps-a', 'apps-b', 'apps-c']);
  assert.deepEqual(folded[0].globs, ['apps/a/**', 'lib/**'], 'folded into the smallest app');
  // not smaller than SMALL: it keeps its own area
  const big = Array.from({ length: SMALL }, (_, i) => `lib/x${i}.ts`);
  const kept = partition([...three, ...big], { containers: ['apps'], apps: ['apps/a', 'apps/b', 'apps/c'], maxAreas: 2 });
  assert.deepEqual(kept.map((a) => a.id), ['apps-a', 'apps-b', 'apps-c', 'lib']);
  // two leftovers over the cap, fewer than LEFTOVER_AREAS: neither merged nor folded
  const two = partition([...three, ...big, 'docs/a.md', 'docs/b.md', 'docs/c.md'], { containers: ['apps'], apps: ['apps/a', 'apps/b', 'apps/c'], maxAreas: 2 });
  assert.deepEqual(two.map((a) => a.id), ['apps-a', 'apps-b', 'apps-c', 'docs', 'lib']);
  for (const a of two.filter((x) => x.id.startsWith('apps-'))) assert.equal(a.globs.length, 1, `${a.id} holds only its app`);
});
