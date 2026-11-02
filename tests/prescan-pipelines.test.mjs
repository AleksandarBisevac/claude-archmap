import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (pl1..pl9) lead every title so the suite prints them first.
// The pipelines stack plug-in of prescan, run on the fictional fleet pipelines in
// tests/fixtures/repos/pipelines/ (read as text only - the extractor must never run a workflow or pipeline).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'repos', 'pipelines');
const LIB = join(ROOT, 'scripts', 'lib', 'prescan');
const MODULE = join(LIB, 'pipelines.mjs');
const { default: plugin, extractPipelines, MAX_ITEMS, MAX_NESTED } = await import(pathToFileURL(MODULE).href);

const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });

const fixtureFiles = walk(FIXTURE).sort();
const fixtureRead = (p) => readFileSync(join(FIXTURE, p), 'utf8');
const frag = extractPipelines(fixtureFiles, fixtureRead);
const memFrag = (files) => extractPipelines(Object.keys(files).sort(), (p) => files[p] ?? null);
const ev = (path, lines) => [{ path, lines }];
const GH = '.github/workflows/release.yml';
const AZ = 'azure-pipelines.yml';

test('pl1 one item per workflow and pipeline, with its triggers and line evidence', () => {
  assert.deepEqual(frag.pipelines, [
    { kind: 'github-actions', name: 'Release fleet web', triggers: ['push', 'pull_request', 'workflow_dispatch'], evidence: ev(GH, '1-39') },
    { kind: 'azure-pipelines', name: 'azure-pipelines.yml', triggers: ['trigger', 'pr'], evidence: ev(AZ, '1-36') },
  ]);
});

test('pl2 one item per job or stage with needs and dependsOn, Azure jobs carrying their stage', () => {
  assert.deepEqual(frag.jobs, [
    { pipeline: GH, kind: 'job', id: 'build', stage: null, needs: [], evidence: ev(GH, '9-17') },
    { pipeline: GH, kind: 'job', id: 'test', stage: null, needs: ['build'], evidence: ev(GH, '19-26') },
    { pipeline: GH, kind: 'job', id: 'deploy', stage: null, needs: ['build', 'test'], evidence: ev(GH, '28-39') },
    { pipeline: AZ, kind: 'stage', id: 'Build', stage: null, needs: [], evidence: ev(AZ, '9-19') },
    { pipeline: AZ, kind: 'job', id: 'Package', stage: 'Build', needs: [], evidence: ev(AZ, '11-19') },
    { pipeline: AZ, kind: 'stage', id: 'Deploy', stage: null, needs: ['Build'], evidence: ev(AZ, '21-36') },
    { pipeline: AZ, kind: 'job', id: 'Release', stage: 'Deploy', needs: [], evidence: ev(AZ, '24-36') },
  ]);
});

test('pl3 artefacts uploaded and downloaded, with the step as evidence', () => {
  assert.deepEqual(frag.artifacts, [
    { name: 'dist', direction: 'upload', job: 'build', pipeline: GH, evidence: ev(GH, '14-17') },
    { name: 'dist', direction: 'download', job: 'test', pipeline: GH, evidence: ev(GH, '23-25') },
    { name: 'dist', direction: 'download', job: 'deploy', pipeline: GH, evidence: ev(GH, '33-35') },
    { name: 'drop', direction: 'upload', job: 'Package', pipeline: AZ, evidence: ev(AZ, '16-19') },
    { name: 'drop', direction: 'download', job: 'Release', pipeline: AZ, evidence: ev(AZ, '30-32') },
  ]);
});

test('pl4 an artefact passed from one job to another is an edge with evidence at the upload and the download', () => {
  assert.deepEqual(frag.passes, [
    { name: 'dist', from: 'build', to: 'test', pipeline: GH, evidence: [{ path: GH, lines: '14-17' }, { path: GH, lines: '23-25' }] },
    { name: 'dist', from: 'build', to: 'deploy', pipeline: GH, evidence: [{ path: GH, lines: '14-17' }, { path: GH, lines: '33-35' }] },
    { name: 'drop', from: 'Package', to: 'Release', pipeline: AZ, evidence: [{ path: AZ, lines: '16-19' }, { path: AZ, lines: '30-32' }] },
  ]);
});

test('pl5 deploy targets named as string literals: environments and web app names, at the value line', () => {
  assert.deepEqual(frag.deployTargets, [
    { name: 'production', kind: 'environment', job: 'deploy', pipeline: GH, evidence: ev(GH, '31') },
    { name: 'fleet-web-prod', kind: 'app', job: 'deploy', pipeline: GH, evidence: ev(GH, '38') },
    { name: 'staging', kind: 'environment', job: 'Release', pipeline: AZ, evidence: ev(AZ, '25') },
    { name: 'fleet-api-staging', kind: 'app', job: 'Release', pipeline: AZ, evidence: ev(AZ, '35') },
  ]);
});

test('pl6 other forms: scalar and list triggers, long environment form, publish and download shorthands, top-level jobs, templates and non-pipelines counted', () => {
  const m = memFrag({
    '.github/workflows/ci.yaml':
      'on: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/upload-artifact@v4\n        with:\n          name: report\n          path: r.txt\n' +
      '  publish:\n    needs: lint\n    environment:\n      name: npm\n      url: https://example.invalid\n    steps:\n      - uses: actions/download-artifact@v3\n        with:\n          name: report\n      - uses: actions/download-artifact@v4\n        with:\n          pattern: dist-*\n',
    'a/.github/workflows/nightly.yml':
      'name: "Nightly"\non:\n  schedule:\n    - cron: \'0 3 * * *\'\n  workflow_call:\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
    'x/.github/workflows/flow.yml': 'on: [push, pull_request]\njobs:\n  a:\n    steps:\n      - run: x\n',
    'ops/azure-pipelines-ci.yaml':
      'name: $(Date:yyyyMMdd)\ntrigger: none\nschedules:\n  - cron: \'0 0 * * *\'\n    branches:\n      include: [main]\njobs:\n  - job: A\n    steps:\n      - publish: out\n        artifact: bundle\n' +
      '  - job: B\n    dependsOn:\n      - A\n    steps:\n      - download: current\n        artifact: bundle\n      - template: steps/deploy.yml\n',
    'misc/app.pipeline.yml': 'variables:\n  x: 1\n',
    'docs/ci.yml': 'jobs:\n  ghost:\n    steps: []\n',
    '.github/workflows/readme.md': 'jobs:\n  ghost2:\n',
  });
  assert.deepEqual(
    m.pipelines.map((p) => `${p.evidence[0].path}:${p.evidence[0].lines} ${p.kind} ${p.name} [${p.triggers.join(',')}]`),
    [
      '.github/workflows/ci.yaml:1-21 github-actions ci.yaml [push]',
      'a/.github/workflows/nightly.yml:1-10 github-actions Nightly [schedule,workflow_call]',
      'ops/azure-pipelines-ci.yaml:1-18 azure-pipelines azure-pipelines-ci.yaml [schedule]',
      'x/.github/workflows/flow.yml:1-5 github-actions flow.yml [push,pull_request]',
    ],
  );
  assert.deepEqual(
    m.jobs.map((j) => `${j.pipeline}:${j.evidence[0].lines} ${j.kind} ${j.id} needs=${j.needs.join(',')}`),
    [
      '.github/workflows/ci.yaml:3-9 job lint needs=',
      '.github/workflows/ci.yaml:10-21 job publish needs=lint',
      'a/.github/workflows/nightly.yml:7-10 job run needs=',
      'ops/azure-pipelines-ci.yaml:8-11 job A needs=',
      'ops/azure-pipelines-ci.yaml:12-18 job B needs=A',
      'x/.github/workflows/flow.yml:3-5 job a needs=',
    ],
  );
  assert.deepEqual(
    m.artifacts.map((a) => `${a.pipeline}:${a.evidence[0].lines} ${a.direction} ${a.name} in ${a.job}`),
    [
      '.github/workflows/ci.yaml:6-9 upload report in lint',
      '.github/workflows/ci.yaml:16-18 download report in publish',
      '.github/workflows/ci.yaml:19-21 download dist-* in publish',
      'ops/azure-pipelines-ci.yaml:10-11 upload bundle in A',
      'ops/azure-pipelines-ci.yaml:16-17 download bundle in B',
    ],
  );
  assert.deepEqual(m.passes.map((p) => `${p.pipeline} ${p.name} ${p.from}>${p.to}`), [
    '.github/workflows/ci.yaml report lint>publish',
    'ops/azure-pipelines-ci.yaml bundle A>B',
  ]);
  assert.deepEqual(m.deployTargets.map((d) => `${d.pipeline}:${d.evidence[0].lines} ${d.kind} ${d.name}`), ['.github/workflows/ci.yaml:13 environment npm']);
  assert.equal(m.skipped.pipelines, 1, 'a .pipeline.yml with no stages, jobs or steps is counted, not guessed');
  assert.equal(m.skipped.templates, 1, 'a template reference stands for steps that are not resolved');
  assert.equal(m.scanned, 5, 'docs/ci.yml and a markdown file under workflows are not pipeline files');
});

test('pl7 every item carries {path, lines} evidence inside the file, output sorted and deterministic', () => {
  for (const kind of ['pipelines', 'jobs', 'artifacts', 'passes', 'deployTargets']) {
    assert.ok(frag[kind].length > 0, `${kind} found something in the fixture`);
    for (const item of frag[kind]) {
      assert.ok(Array.isArray(item.evidence) && item.evidence.length >= 1, `${kind} item has evidence`);
      for (const { path, lines } of item.evidence) {
        assert.match(lines, /^[0-9]+(-[0-9]+)?$/);
        assert.ok(fixtureFiles.includes(path), `evidence path ${path} is a fixture file`);
        const [a, b = a] = lines.split('-').map(Number);
        const total = fixtureRead(path).split('\n').length;
        assert.ok(a >= 1 && a <= b && b <= total, `${path}:${lines} is inside the file`);
      }
    }
    const keys = frag[kind].map((i) => [i.evidence[0].path, Number(i.evidence[0].lines.split('-')[0])]);
    const sorted = keys.slice().sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    assert.deepEqual(keys, sorted, `${kind} is ordered by path then line`);
  }
  assert.deepEqual(Object.keys(frag), ['artifacts', 'deployTargets', 'jobs', 'passes', 'pipelines', 'scanned', 'skipped', 'truncated']);
  assert.equal(frag.scanned, 2, 'one workflow and one Azure pipeline were read');
  assert.deepEqual(frag.skipped, { pipelines: 0, templates: 0 });
  assert.deepEqual(frag.truncated, { artifacts: 0, deployTargets: 0, jobs: 0, passes: 0, pipelines: 0 });
  const again = extractPipelines(fixtureFiles.slice().reverse(), fixtureRead);
  assert.equal(JSON.stringify(again), JSON.stringify(frag), 'input order does not change the output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(frag)), 'no timestamps');
});

test('pl8 caps: items past MAX_ITEMS per kind are counted in truncated; needs past MAX_NESTED are dropped', () => {
  const files = {};
  for (let i = 0; i < MAX_ITEMS + 2; i++) files[`.github/workflows/w${String(i).padStart(6, '0')}.yml`] = 'on: push\njobs:\n  a:\n    steps:\n      - run: x\n';
  const p = memFrag(files);
  assert.equal(p.pipelines.length, MAX_ITEMS);
  assert.equal(p.truncated.pipelines, 2);
  assert.equal(p.pipelines[0].evidence[0].path, '.github/workflows/w000000.yml', 'the first rows in sort order are the ones kept');

  let jobs = 'on: push\njobs:\n';
  for (let i = 0; i < MAX_ITEMS + 3; i++) jobs += `  j${String(i).padStart(6, '0')}:\n    steps:\n      - run: x\n`;
  const j = memFrag({ '.github/workflows/big.yml': jobs });
  assert.equal(j.jobs.length, MAX_ITEMS);
  assert.equal(j.truncated.jobs, 3);

  let needs = 'on: push\njobs:\n  last:\n    needs:\n';
  for (let i = 0; i < MAX_NESTED + 5; i++) needs += `      - n${i}\n`;
  needs += '    steps:\n      - run: x\n';
  const n = memFrag({ '.github/workflows/needs.yml': needs });
  assert.equal(n.jobs[0].needs.length, MAX_NESTED);
  assert.ok(JSON.stringify(frag).length < 200 * 1024, 'fragment stays small');
});

test('pl9 the plug-in detects workflows and pipelines by name only, and names the stack pipelines', () => {
  assert.equal(plugin.id, 'pipelines');
  const det = (...files) => plugin.detect({ files });
  assert.equal(det('.github/workflows/ci.yml'), true);
  assert.equal(det('.github/workflows/ci.yaml'), true);
  assert.equal(det('azure-pipelines.yml'), true);
  assert.equal(det('build/azure-pipelines-ci.yaml'), true);
  assert.equal(det('deploy.pipeline.yml'), true);
  assert.equal(det('app/main.py', 'package.json', 'docs/ci.yml', '.github/workflows/readme.md', '.github/dependabot.yml', 'azure-pipelines.yml.txt'), false);
  assert.equal(det(), false);
  assert.equal(typeof plugin.extract, 'function');
});

test('pl10 nothing is executed or imported from the scanned repo; the plug-in runs inside prescan and behind the stacks/ re-export', async () => {
  const src = readFileSync(MODULE, 'utf8');
  assert.ok(!/child_process|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|node:vm|node:worker_threads/.test(src), 'pipelines.mjs has no way to run code');

  const shim = join(LIB, 'stacks', 'pipelines.mjs');
  assert.equal(readFileSync(shim, 'utf8').trim(), "export { default } from '../pipelines.mjs';");
  const viaShim = await import(pathToFileURL(shim).href);
  assert.equal(viaShim.default, plugin, 'the re-export is the same object');

  const dir = mkdtempSync(join(tmpdir(), 'archmap-plfix-'));
  try {
    for (const f of fixtureFiles) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), fixtureRead(f));
    }
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
    const { prescan } = await import(pathToFileURL(join(ROOT, 'scripts', 'prescan.mjs')).href);
    const out = await prescan(dir, { extractors: [plugin] });
    assert.ok(out.stacks.includes('pipelines'));
    assert.equal(JSON.stringify(out.extracts.pipelines), JSON.stringify(frag));
    const real = await prescan(dir);
    assert.equal(JSON.stringify(real.extracts.pipelines), JSON.stringify(frag), 'the default loader finds the plug-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
