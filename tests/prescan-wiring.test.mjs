import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (pw1..pw4) lead every title so the suite prints them first.
// The real prescan CLI, with its default plug-in loader (scripts/lib/prescan/stacks/*.mjs), run on
// each fixture repo must emit that stack's extract. No `extractors` override anywhere.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRESCAN = join(ROOT, 'scripts', 'prescan.mjs');
const LIB = join(ROOT, 'scripts', 'lib', 'prescan');
const REPOS = join(ROOT, 'tests', 'fixtures', 'repos');

const cli = (repo) => {
  const r = spawnSync(process.execPath, [PRESCAN, join(REPOS, repo)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const total = (frag) =>
  Object.values(frag)
    .filter(Array.isArray)
    .reduce((n, items) => n + items.length, 0);

const CASES = [
  ['pw1', 'python-api', 'python', 'python.mjs'],
  ['pw2', 'ts-web', 'ts-frontend', 'ts-frontend.mjs'],
  ['pw3', 'node-api', 'node-backend', 'node-backend.mjs'],
];

for (const [id, repo, stack, file] of CASES) {
  test(`${id} the CLI on ${repo} emits the ${stack} extract (default loader finds the plug-in)`, () => {
    const out = cli(repo);
    const frag = out.extracts[stack];
    assert.ok(frag, `no extracts.${stack} in ${Object.keys(out.extracts)}`);
    assert.equal(frag.error, undefined);
    assert.ok(total(frag) >= 1, `${stack} fragment has no items`);
    assert.ok(out.stacks.includes(stack), `stacks lists ${stack}: ${out.stacks}`);
  });
}

test('pw4 each stacks/ file is a one-line re-export of the plug-in one directory up, same object', async () => {
  for (const [, , , file] of CASES) {
    const shim = join(LIB, 'stacks', file);
    assert.ok(existsSync(shim), `${file} missing in stacks/`);
    assert.equal(readFileSync(shim, 'utf8').trim(), `export { default } from '../${file}';`);
    const [a, b] = await Promise.all([import(pathToFileURL(shim).href), import(pathToFileURL(join(LIB, file)).href)]);
    assert.equal(a.default, b.default);
  }
});

test('pw5 the python area extract and its summary carry the middleware names and the modules; coverageFloor counts a modules group per module and a middleware modules entry per python middleware name, and the explorer brief names them', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { coverageFloor, explorerBrief, BRIEF_CAP } = await import(pathToFileURL(join(ROOT, 'scripts', 'pipeline.mjs')).href);
  const work = mkdtempSync(join(tmpdir(), 'archmap-pw5-'));
  try {
    const r = spawnSync(process.execPath, [PRESCAN, join(REPOS, 'python-api'), '--out', join(work, 'prescan.json')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const pre = JSON.parse(readFileSync(join(work, 'prescan.json'), 'utf8'));
    const area = pre.areas.find((a) => a.id === 'app');
    const slice = JSON.parse(readFileSync(join(work, area.extract), 'utf8'));
    const sum = JSON.parse(readFileSync(join(work, area.summary), 'utf8'));
    const modules = [
      'app/admin.py', 'app/auth.py', 'app/cache_utils.py', 'app/clients.py', 'app/jobs.py', 'app/models.py',
      'app/reports.py', 'app/schemas.py', 'app/stockroom.py', 'app/tasks.py', 'app/warehouse.py',
    ];
    const middleware = ['app/main.py:CORSMiddleware', 'app/main.py:check_db_ready'];
    assert.deepEqual(slice.modules, modules);
    assert.deepEqual(slice.middleware, middleware, 'the python middleware joins the middleware list as <file>:<name>');
    assert.equal(sum.counts.modules, modules.length);
    assert.equal(sum.counts.middleware, middleware.length);
    assert.deepEqual(sum.modules, modules, 'the summary lists the modules');
    assert.deepEqual(sum.middleware, middleware, 'the summary lists the middleware');
    for (const a of pre.areas.filter((x) => x.id !== 'app')) {
      const other = JSON.parse(readFileSync(join(work, a.extract), 'utf8'));
      assert.ok(!('modules' in other), `${a.id}: only where there is something`);
    }

    const cov = coverageFloor(slice);
    assert.equal(cov.counts.modules, modules.length);
    assert.deepEqual(cov.names.modules, modules);
    assert.equal(cov.counts['middleware modules'], middleware.length);
    assert.deepEqual(cov.names['middleware modules'], middleware);
    assert.equal(cov.floor, Object.values(cov.counts).reduce((x, y) => x + y, 0));
    assert.equal(coverageFloor({}).counts.modules, undefined, 'no modules, no modules group');
    const { joinMiddleware } = await import(pathToFileURL(join(LIB, 'inventory.mjs')).href);
    assert.deepEqual(
      joinMiddleware(['svc/middleware', 'svc/web/middleware.py'], [{ name: 'timing', file: 'svc/web/middleware.py' }, { name: 'gate', file: 'svc/main.py' }]),
      ['svc/main.py:gate', 'svc/middleware', 'svc/web/middleware.py:timing'],
      'a named middleware stands in for the bare entry of its own file; a directory stays',
    );

    const brief = explorerBrief({ area: { ...area, files: 20 }, summary: join(work, area.summary), fragment: join(work, 'fragments', 'app.json'), profile: 'balanced', coverage: cov });
    assert.ok(brief.length <= BRIEF_CAP, `${brief.length} characters`);
    assert.match(brief, new RegExp(`Coverage floor: at least ${cov.floor} nodes \\([^)]*\\bmodules=${modules.length}\\b`));
    assert.match(brief, /middleware modules=2/);
    assert.match(brief, /Each of these needs its own node:[^\n]*\bmodules app\/admin\.py, app\/auth\.py, app\/cache_utils\.py/);
    assert.match(brief, /Each of these needs its own node:[^\n]*check_db_ready/);
    assert.match(brief, /^\d\. [^\n]*one node per[^\n]*listed module/im, 'the Work step asks for one node per listed module');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
