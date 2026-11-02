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

test('pw6 an http link prefers a literal route; a match through a wildcard segment is marked match wildcard with the call path, and a call path of wildcards only links nothing', async () => {
  const { areaExtracts } = await import(pathToFileURL(PRESCAN).href);
  const ev = (path, lines) => [{ path, lines }];
  const route = (url, path, lines) => ({ method: 'GET', url, handler: 'h', evidence: ev(path, lines) });
  const call = (url, path, lines) => ({ method: 'GET', url, client: 'fetch', evidence: ev(path, lines) });
  const out = {
    areas: [
      { id: 'api', title: 'api', globs: ['api/**'], stacks: ['python'], files: 4 },
      { id: 'web', title: 'web', globs: ['web/**'], stacks: ['ts-frontend'], files: 4 },
    ],
    extracts: {
      python: { routes: [route('/{slug}', 'api/pages.py', '40'), route('/orders', 'api/orders.py', '10'), route('/items/{id}', 'api/items.py', '20'), route('/health', 'api/health.py', '30')] },
      'ts-frontend': { apiCalls: [call('/orders', 'web/a.ts', '3'), call('/items/42', 'web/b.ts', '4'), call('${base}', 'web/c.ts', '5'), call('/${id}', 'web/d.ts', '6')] },
    },
  };
  const web = areaExtracts(out).find((x) => x.id === 'web').slice;
  assert.deepEqual(web.links.filter((l) => l.kind === 'http'), [
    { kind: 'http', dir: 'out', from: 'web/a.ts:3', to: 'api/orders.py:10', other: 'api', via: 'GET /orders' },
    { kind: 'http', dir: 'out', from: 'web/b.ts:4', to: 'api/items.py:20', other: 'api', via: 'GET /items/{id}', match: 'wildcard', call: 'GET /items/42' },
  ]);
});

// The platform kinds each slice carries, in the order the slice and summary files print them: after `stores`, before `imports`.
const PLATFORM_KEYS = [
  'images', 'services', 'pipelines', 'jobs', 'artifacts', 'passes', 'deployTargets', 'resources', 'iacModules', 'iacReferences',
  'iacVariables', 'iacOutputs', 'dbtModels', 'dbtSources', 'dbtTests', 'lineage',
];
const COUNT_ONLY = ['passes', 'iacReferences', 'iacVariables', 'iacOutputs', 'dbtTests', 'lineage'];
const PLATFORM_STACKS = ['containers', 'pipelines', 'iac', 'data-platform'];

async function prescanTo(repo) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const work = mkdtempSync(join(tmpdir(), 'archmap-pw7-'));
  const r = spawnSync(process.execPath, [PRESCAN, join(REPOS, repo), '--out', join(work, 'prescan.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const pre = JSON.parse(readFileSync(join(work, 'prescan.json'), 'utf8'));
  const read = (p) => JSON.parse(readFileSync(join(work, p), 'utf8'));
  return {
    work,
    pre,
    slices: pre.areas.map((a) => ({ area: a, slice: read(a.extract), sum: read(a.summary), text: readFileSync(join(work, a.extract), 'utf8'), sumText: readFileSync(join(work, a.summary), 'utf8') })),
  };
}
const sumKind = (run, key) => run.slices.reduce((n, s) => n + (s.slice[key]?.length ?? 0), 0);
const orderOk = (keys) => {
  // the platform keys appear in PLATFORM_KEYS order, all after `stores` (when present) and before `imports`
  const at = keys.filter((k) => PLATFORM_KEYS.includes(k));
  assert.deepEqual(at, PLATFORM_KEYS.filter((k) => at.includes(k)), `platform keys out of order: ${keys}`);
  for (const k of at) {
    assert.ok(keys.indexOf(k) < keys.indexOf('imports'), `${k} before imports`);
    if (keys.includes('stores')) assert.ok(keys.indexOf(k) > keys.indexOf('stores'), `${k} after stores`);
  }
};

test('pw7 each platform fixture is detected as its stack, its slices and summaries carry the new kinds in the documented order, and a repository without them is unchanged', async () => {
  const { rmSync } = await import('node:fs');
  const want = {
    containers: { stack: 'containers', kinds: { images: 2, services: 3 } },
    pipelines: { stack: 'pipelines', kinds: { pipelines: 2, jobs: 7, artifacts: 5, passes: 3, deployTargets: 4 } },
    iac: { stack: 'iac', kinds: { resources: 7, iacModules: 2, iacReferences: 13, iacVariables: 9, iacOutputs: 6 } },
    'data-platform': { stack: 'data-platform', kinds: { dbtModels: 4, dbtSources: 2, dbtTests: 3, lineage: 5 } },
  };
  for (const [repo, { stack, kinds }] of Object.entries(want)) {
    const run = await prescanTo(repo);
    try {
      assert.ok(run.pre.stacks.includes(stack), `${repo}: stacks lists ${stack}: ${run.pre.stacks}`);
      assert.ok(run.pre.extracts[stack] && !run.pre.extracts[stack].error, `${repo}: extracts.${stack}`);
      for (const { area, slice, sum, text, sumText } of run.slices) {
        orderOk(Object.keys(slice));
        orderOk(Object.keys(sum));
        assert.equal(JSON.stringify(JSON.parse(text)), JSON.stringify(slice));
        for (const k of PLATFORM_KEYS) {
          if (slice[k]) assert.ok(slice[k].every((row) => typeof row.file === 'string' && Number.isInteger(row.line) && typeof row.lines === 'string'), `${repo}/${area.id}: ${k} rows cite file, line and lines`);
        }
        // the summary counts every kind; the rows of a count-only kind never print, the others do (under the budget)
        for (const k of PLATFORM_KEYS.filter((x) => slice[x]?.length)) {
          assert.equal(sum.counts[k], slice[k].length, `${repo}/${area.id}: counts.${k}`);
          assert.equal(sum[k] !== undefined, !COUNT_ONLY.includes(k), `${repo}/${area.id}: summary rows of ${k}`);
        }
        assert.ok(sumText.length <= 4200, `${repo}/${area.id}: summary ${sumText.length} characters`);
        // P13.12: an area's stacks are the code stacks plus the platform stacks found inside it (pw8 pins the rule)
        assert.ok(area.stacks.every((s) => PLATFORM_STACKS.includes(s) ? s === stack : true), `${repo}/${area.id}: only this fixture's platform stack: ${area.stacks}`);
      }
      for (const [k, n] of Object.entries(kinds)) assert.equal(sumKind(run, k), n, `${repo}: ${k} rows over the areas`);
      for (const other of PLATFORM_STACKS.filter((s) => s !== stack)) assert.ok(!run.pre.stacks.includes(other), `${repo}: no ${other}`);
    } finally {
      rmSync(run.work, { recursive: true, force: true });
    }
  }
  for (const repo of ['python-api', 'ts-web', 'node-api']) {
    const run = await prescanTo(repo);
    try {
      for (const s of PLATFORM_STACKS) assert.ok(!run.pre.stacks.includes(s), `${repo}: no ${s}`);
      for (const { area, slice, sum } of run.slices) {
        assert.ok(!area.stacks.some((s) => PLATFORM_STACKS.includes(s)), `${repo}/${area.id}: area stacks unchanged`);
        for (const k of PLATFORM_KEYS) {
          assert.ok(!(k in slice) && !(k in sum) && !(k in sum.counts), `${repo}/${area.id}: no ${k}`);
        }
      }
    } finally {
      rmSync(run.work, { recursive: true, force: true });
    }
  }
});

// pw8: an area's stacks are the union of the code stacks and the platform stacks whose plug-in fires on files inside
// the area's globs (code first, then platform in a fixed order), so a platform-only area is briefed with its reference.
test('pw8 an area of only Terraform, compose, workflow or dbt files carries that platform stack, a code area with an added Dockerfile carries both, and an area with none keeps its code stacks only', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const globRe = (g) =>
    new RegExp('^' + g.split('**').map((p) => p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
  const work = mkdtempSync(join(tmpdir(), 'archmap-pw8-'));
  try {
    const put = (rel, body) => {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), body);
    };
    const copy = (from, to) => cpSync(join(REPOS, from), join(work, to), { recursive: true });
    cpSync(join(REPOS, 'python-api'), join(work, 'api'), { recursive: true });
    cpSync(join(REPOS, 'ts-web'), join(work, 'web'), { recursive: true });
    put('web/Dockerfile', 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n');
    copy('iac/terraform', 'infra/terraform');
    copy('containers/docker-compose.yml', 'deploy/docker-compose.yml');
    copy('pipelines/.github', '.github');
    copy('data-platform', 'analytics');
    // enough files in each platform directory that the partition keeps it as its own area
    for (const n of ['a', 'b', 'c']) {
      copy('containers/docker-compose.yml', `deploy/docker-compose.${n}.yml`);
      copy('pipelines/.github/workflows/release.yml', `.github/workflows/${n}.yml`);
    }
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: work, encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    const r = spawnSync(process.execPath, [PRESCAN, work], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const owners = (f) => out.areas.filter((a) => a.globs.some((g) => globRe(g).test(f)));
    const own = (f) => {
      const hit = owners(f);
      assert.equal(hit.length, 1, `${f} owned by ${JSON.stringify(hit.map((a) => a.id))}`);
      return hit[0];
    };
    assert.deepEqual(own('infra/terraform/main.tf').stacks, ['iac'], 'terraform only');
    assert.deepEqual(own('deploy/docker-compose.yml').stacks, ['containers'], 'compose only');
    assert.deepEqual(own('.github/workflows/release.yml').stacks, ['pipelines'], 'workflow only');
    assert.deepEqual(own('analytics/dbt_project.yml').stacks, ['data-platform'], 'dbt only');
    assert.deepEqual(own('web/Dockerfile').stacks, ['ts-frontend', 'containers'], 'a code area with a Dockerfile: code stacks first, then the platform stack');
    assert.deepEqual(own('api/app/main.py').stacks, ['python'], 'an area with no platform files keeps its code stacks only');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
