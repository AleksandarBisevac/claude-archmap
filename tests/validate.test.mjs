import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (v1, v2, ...) lead every title so the suite prints them first.
const CLI = fileURLToPath(new URL('../scripts/validate.mjs', import.meta.url));
const { validate } = await import('../scripts/validate.mjs');

const clone = (x) => JSON.parse(JSON.stringify(x));
const ev = (path = 'src/a.txt', lines = '1-2') => ({ path, lines });

function baseModel(commit = 'HEAD') {
  return {
    meta: {
      schemaVersion: '1.0',
      project: 'demo',
      commit,
      generatedAt: '2026-01-01T00:00:00Z',
      profile: 'balanced',
      sources: [],
      coverage: {},
    },
    zones: [
      { id: 'web', kind: 'browser', label: 'Web' },
      { id: 'api', kind: 'service', label: 'API', parent: 'web' },
      { id: 'db', kind: 'data', label: 'DB' },
    ],
    nodes: [
      { id: 'ui', zone: 'web', kind: 'component', title: 'UI', paths: ['src'], level: 1, evidence: [ev()] },
      { id: 'svc', zone: 'api', kind: 'service', title: 'Svc', paths: ['src'], level: 2, evidence: [ev()] },
      { id: 'store', zone: 'db', kind: 'database', title: 'Store', paths: ['db'], level: 1, evidence: [ev()] },
    ],
    edges: [
      { id: 'e1', from: 'ui', to: 'svc', type: 'api', desc: 'calls', evidence: [ev()], confidence: 'verified' },
      { id: 'e2', from: 'svc', to: 'store', type: 'sql', desc: 'reads', evidence: [ev()], confidence: 'inferred' },
    ],
    entities: [
      {
        id: 'users', store: 'store', name: 'users', kind: 'table',
        fields: [{ name: 'id', type: 'int', pk: true, provenance: 'declared' }],
      },
      {
        id: 'orders', store: 'store', name: 'orders', kind: 'table',
        fields: [
          { name: 'id', type: 'int', pk: true, provenance: 'declared' },
          { name: 'user_id', type: 'int', provenance: 'declared', fk: { entity: 'users', field: 'id' } },
        ],
      },
    ],
    relations: [
      {
        from: { entity: 'orders', field: 'user_id' }, to: { entity: 'users', field: 'id' },
        cardinality: '1-n', kind: 'fk', provenance: 'declared',
      },
    ],
    access: [{ node: 'svc', entity: 'orders', ops: 'CRU' }],
    sequences: [
      {
        id: 'seq1', title: 'Order',
        participants: [
          { id: 'pu', label: 'UI', node: 'ui' },
          { id: 'ps', label: 'Svc', node: 'svc' },
        ],
        steps: [
          { m: ['pu', 'ps'], k: 'call', t: 'POST', d: 'create', r: [], i: 'iss1' },
          { frag: 'opt', t: 'maybe' },
          { note: ['ps'], t: 'note', tone: 'info' },
          { m: ['ps', 'pu'], k: 'return', t: '201', d: 'ok', r: [] },
        ],
      },
    ],
    views: [{ id: 'v-all', nodes: ['ui', 'svc'], zones: ['web'] }],
  };
}

function baseIssues() {
  return {
    issues: [
      {
        id: 'iss1', sev: 'high', category: 'security', title: 'T', anchor: { node: 'svc' },
        summary: 's', impact: 'i', fix: 'f', evidence: [ev()], source: 'archmap',
      },
    ],
  };
}

const codes = (res) => res.findings.map((f) => f.code);
const find = (res, code, pointer) =>
  res.findings.find((f) => f.code === code && (pointer === undefined || f.pointer === pointer));

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const work = mkdtempSync(join(tmpdir(), 'archmap-validate-'));
test.after(() => rmSync(work, { recursive: true, force: true }));
const writeJson = (name, obj) => {
  const p = join(work, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

// A throwaway repo: src/a.txt has 3 lines at the commit; src/later.txt is added afterwards.
const repo = join(work, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'src/a.txt'), 'one\ntwo\nthree\n');
git('add', '.');
git('commit', '-q', '-m', 'first');
const sha = git('rev-parse', 'HEAD');
writeFileSync(join(repo, 'src/later.txt'), 'x\n');
git('add', '.');
git('commit', '-q', '-m', 'second');

// ---- schema and happy path -------------------------------------------------

test('v1 accepts a minimal valid model, and a valid model with an issues file', () => {
  const minimal = {
    meta: baseModel().meta,
    zones: [{ id: 'z', kind: 'service', label: 'Z' }],
    nodes: [{ id: 'n', zone: 'z', kind: 'k', title: 'N', paths: [], level: 1, evidence: [ev()] }],
    edges: [],
  };
  const r1 = validate(minimal);
  assert.deepEqual(r1.findings, []);
  assert.equal(r1.ok, true);
  const r2 = validate(baseModel(), { issues: baseIssues() });
  assert.deepEqual(r2.findings, []);
  assert.equal(r2.ok, true);
});

test('v2 reports schema violations with a JSON pointer: missing evidence, bad lines, ops outside CRUD', () => {
  const m = baseModel();
  delete m.nodes[0].evidence;
  m.edges[0].evidence = [];
  m.edges[1].evidence = [{ path: 'src/a.txt', lines: 'abc' }];
  m.access[0].ops = 'CRX';
  const res = validate(m);
  assert.equal(res.ok, false);
  assert.ok(find(res, 'schema', '/nodes/0/evidence'), 'missing evidence on a node');
  assert.ok(find(res, 'schema', '/edges/0/evidence'), 'empty evidence array on an edge');
  assert.ok(find(res, 'schema', '/edges/1/evidence/0/lines'), 'non-numeric lines');
  assert.ok(find(res, 'schema', '/access/0/ops'), 'ops outside CRUD');
});

test('v3 reports malformed lines ranges the pattern cannot see (zero, reversed)', () => {
  const m = baseModel();
  m.nodes[0].evidence = [ev('src/a.txt', '0')];
  m.nodes[1].evidence = [ev('src/a.txt', '5-3')];
  const res = validate(m);
  assert.ok(find(res, 'evidence-lines-malformed', '/nodes/0/evidence/0/lines'));
  assert.ok(find(res, 'evidence-lines-malformed', '/nodes/1/evidence/0/lines'));
});

test('v4 rejects a duplicate id inside a collection', () => {
  const m = baseModel();
  m.nodes[1].id = 'ui';
  const res = validate(m);
  assert.ok(find(res, 'duplicate-id', '/nodes/1/id'));
});

// ---- referential integrity -------------------------------------------------

test('v5 rejects dangling zone, parent, edge and view ids', () => {
  const m = baseModel();
  m.nodes[0].zone = 'nope';
  m.zones[1].parent = 'ghost';
  m.edges[0].from = 'x1';
  m.edges[1].to = 'x2';
  m.views[0].nodes = ['ui', 'x3'];
  m.views[0].zones = ['x4'];
  const res = validate(m);
  for (const p of ['/nodes/0/zone', '/zones/1/parent', '/edges/0/from', '/edges/1/to', '/views/0/nodes/1', '/views/0/zones/0']) {
    assert.ok(find(res, 'dangling-ref', p), `dangling at ${p}`);
  }
});

test('v6 rejects dangling entity store, fk, relation and access ids', () => {
  const m = baseModel();
  m.entities[0].store = 'nostore';
  m.entities[1].fields[1].fk = { entity: 'users', field: 'missing_col' };
  m.relations[0].to = { entity: 'ghost', field: 'id' };
  m.access[0].node = 'nonode';
  m.access.push({ node: 'svc', entity: 'noent', ops: 'R' });
  const res = validate(m);
  for (const p of [
    '/entities/0/store',
    '/entities/1/fields/1/fk/field',
    '/relations/0/to/entity',
    '/access/0/node',
    '/access/1/entity',
  ]) {
    assert.ok(find(res, 'dangling-ref', p), `dangling at ${p}`);
  }
});

test('v7 rejects dangling sequence participant node, step participants and note ids', () => {
  const m = baseModel();
  m.sequences[0].participants[0].node = 'nonode';
  m.sequences[0].steps[0].m = ['pu', 'pghost'];
  m.sequences[0].steps[2].note = ['pnote'];
  const res = validate(m);
  assert.ok(find(res, 'dangling-ref', '/sequences/0/participants/0/node'));
  assert.ok(find(res, 'dangling-ref', '/sequences/0/steps/0/m/1'));
  assert.ok(find(res, 'dangling-ref', '/sequences/0/steps/2/note/0'));
});

test('v8 checks step issue ids only when an issues file is given', () => {
  const m = baseModel();
  const without = validate(m);
  assert.deepEqual(without.findings, [], 'step i = iss1 is not checked without --issues');
  const withIssues = baseIssues();
  withIssues.issues[0].id = 'other';
  const res = validate(m, { issues: withIssues });
  assert.ok(find(res, 'dangling-ref', '/sequences/0/steps/0/i'));
});

test('v9 rejects dangling issue anchors of every kind, including seqId:stepIndex', () => {
  const issues = baseIssues();
  const mk = (id, anchor) => ({ ...clone(issues.issues[0]), id, anchor });
  issues.issues = [
    mk('a', { node: 'ghost' }),
    mk('b', { edge: 'ghost' }),
    mk('c', { entity: 'ghost' }),
    mk('d', { step: 'seq1:99' }),
    mk('e', { step: 'noseq:0' }),
    mk('f', { step: 'garbage' }),
    mk('ok1', { node: 'svc' }),
    mk('ok2', { step: 'seq1:0' }),
  ];
  const m = baseModel();
  m.sequences[0].steps[0].i = 'ok1';
  const res = validate(m, { issues });
  for (let i = 0; i < 6; i++) {
    assert.ok(find(res, 'dangling-ref', `/issues/${i}/anchor`), `dangling anchor ${i}`);
  }
  assert.ok(!res.findings.some((f) => f.pointer.startsWith('/issues/6') || f.pointer.startsWith('/issues/7')));
});

test('v10 reports schema errors in the issues file under the issues pointer', () => {
  const issues = baseIssues();
  issues.issues[0].sev = 'critical';
  const res = validate(baseModel(), { issues });
  assert.ok(find(res, 'schema', '/issues/0/sev'));
});

test('v11 tolerates unknown keys in data', () => {
  const m = baseModel();
  m.extra = 1;
  m.nodes[0].futureField = { a: 1 };
  const res = validate(m);
  assert.deepEqual(res.findings, []);
});

// ---- evidence at meta.commit ----------------------------------------------

test('v12 without a repo the evidence check is skipped and says so', () => {
  const res = validate(baseModel());
  assert.equal(res.evidence, 'skipped');
  const file = writeJson('m-skip.json', baseModel());
  const out = run([file]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /evidence[^\n]*skipped/i);
  const js = JSON.parse(run([file, '--json']).stdout);
  assert.equal(js.evidence, 'skipped');
});

test('v13 with a repo, accepts evidence that exists at meta.commit', () => {
  const m = baseModel(sha);
  const res = validate(m, { repo });
  assert.equal(res.evidence, 'checked');
  assert.deepEqual(res.findings, []);
});

test('v14 with a repo, reports a path absent at meta.commit even if present at HEAD', () => {
  const m = baseModel(sha);
  m.nodes[0].evidence = [ev('src/later.txt', '1')];
  m.nodes[1].evidence = [ev('src/never.txt', '1')];
  const res = validate(m, { repo });
  assert.ok(find(res, 'evidence-path-missing', '/nodes/0/evidence/0/path'));
  assert.ok(find(res, 'evidence-path-missing', '/nodes/1/evidence/0/path'));
});

test('v15 with a repo, reports a line range past the end of the file at that commit', () => {
  const m = baseModel(sha);
  m.nodes[0].evidence = [ev('src/a.txt', '3')]; // last line: fine
  m.nodes[1].evidence = [ev('src/a.txt', '2-4')];
  m.edges[0].evidence = [ev('src/a.txt', '9')];
  const res = validate(m, { repo });
  assert.ok(!res.findings.some((f) => f.pointer.startsWith('/nodes/0')));
  assert.ok(find(res, 'evidence-lines-out-of-range', '/nodes/1/evidence/0/lines'));
  assert.ok(find(res, 'evidence-lines-out-of-range', '/edges/0/evidence/0/lines'));
});

test('v16 with a repo, checks evidence on entities, fields, access and issues too', () => {
  const m = baseModel(sha);
  m.entities[0].evidence = [ev('src/gone.txt', '1')];
  m.entities[1].fields[0].evidence = [ev('src/a.txt', '50')];
  m.access[0].evidence = [ev('src/gone2.txt', '1')];
  const issues = baseIssues();
  issues.issues[0].evidence = [ev('src/gone3.txt', '1')];
  const res = validate(m, { repo, issues });
  assert.ok(find(res, 'evidence-path-missing', '/entities/0/evidence/0/path'));
  assert.ok(find(res, 'evidence-lines-out-of-range', '/entities/1/fields/0/evidence/0/lines'));
  assert.ok(find(res, 'evidence-path-missing', '/access/0/evidence/0/path'));
  assert.ok(find(res, 'evidence-path-missing', '/issues/0/evidence/0/path'));
});

test('v17 with a repo, an unknown meta.commit is one finding, not one per evidence', () => {
  const m = baseModel('0123456789abcdef0123456789abcdef01234567');
  const res = validate(m, { repo });
  assert.equal(codes(res).filter((c) => c === 'commit-missing').length, 1);
  assert.ok(find(res, 'commit-missing', '/meta/commit'));
  assert.ok(!codes(res).includes('evidence-path-missing'));
});

// ---- CLI and exit codes ----------------------------------------------------

test('v18 exit 0 for a valid model, in human and --json form', () => {
  const file = writeJson('m-ok.json', baseModel());
  const human = run([file]);
  assert.equal(human.status, 0, human.stderr);
  const js = run([file, '--json']);
  assert.equal(js.status, 0, js.stderr);
  const parsed = JSON.parse(js.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.findings, []);
});

test('v19 exit 1 with findings listed with pointer and code, human and --json', () => {
  const m = baseModel();
  m.nodes[0].zone = 'nope';
  const file = writeJson('m-bad.json', m);
  const human = run([file]);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /dangling-ref/);
  assert.match(human.stdout, /\/nodes\/0\/zone/);
  const js = run([file, '--json']);
  assert.equal(js.status, 1);
  const parsed = JSON.parse(js.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.findings.some((f) => f.code === 'dangling-ref' && f.pointer === '/nodes/0/zone'));
});

test('v20 CLI honours --issues and --repo', () => {
  const m = baseModel(sha);
  m.nodes[0].evidence = [ev('src/never.txt', '1')];
  const file = writeJson('m-repo.json', m);
  const iss = baseIssues();
  iss.issues[0].anchor = { node: 'ghost' };
  const issFile = writeJson('iss.json', iss);
  const out = run([file, '--issues', issFile, '--repo', repo, '--json']);
  assert.equal(out.status, 1);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.evidence, 'checked');
  const cs = parsed.findings.map((f) => f.code);
  assert.ok(cs.includes('evidence-path-missing'));
  assert.ok(cs.includes('dangling-ref'));
});

test('v21 exit 2 on usage errors and unreadable input', () => {
  assert.equal(run([]).status, 2, 'no arguments');
  assert.equal(run([join(work, 'does-not-exist.json')]).status, 2, 'missing file');
  assert.equal(run([writeJson('broken.json', '{not json')]).status, 2, 'invalid JSON');
  const ok = writeJson('m-ok2.json', baseModel());
  assert.equal(run([ok, '--bogus']).status, 2, 'unknown flag');
  assert.equal(run([ok, '--issues']).status, 2, '--issues without a value');
  assert.equal(run([ok, '--issues', join(work, 'nope.json')]).status, 2, 'unreadable issues file');
  assert.equal(run([ok, '--repo', join(work, 'not-a-dir')]).status, 2, 'repo is not a directory');
});

test('v22 rejects a dangling sequence participant zone and accepts a resolving one', () => {
  const ok = baseModel();
  ok.sequences[0].participants[0].zone = 'web';
  const okRes = validate(ok);
  assert.deepEqual(okRes.findings, []);
  assert.equal(okRes.ok, true);

  const m = baseModel();
  m.sequences[0].participants[0].zone = 'nozone';
  m.sequences[0].participants[1].zone = 'api';
  const res = validate(m);
  assert.equal(res.ok, false);
  assert.ok(find(res, 'dangling-ref', '/sequences/0/participants/0/zone'));
  assert.equal(find(res, 'dangling-ref', '/sequences/0/participants/1/zone'), undefined);
});
