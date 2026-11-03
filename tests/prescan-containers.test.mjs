import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (ct1..ct8) lead every title so the suite prints them first.
// The containers stack plug-in of prescan, run on the fictional fleet stack in
// tests/fixtures/repos/containers/ (read as text only - the extractor must never run a Dockerfile or compose file).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'repos', 'containers');
const LIB = join(ROOT, 'scripts', 'lib', 'prescan');
const MODULE = join(LIB, 'containers.mjs');
const { default: plugin, extractContainers, MAX_ITEMS, MAX_NESTED } = await import(pathToFileURL(MODULE).href);

const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });

const fixtureFiles = walk(FIXTURE).sort();
const fixtureRead = (p) => readFileSync(join(FIXTURE, p), 'utf8');
const frag = extractContainers(fixtureFiles, fixtureRead);
const memFrag = (files) => extractContainers(Object.keys(files).sort(), (p) => files[p] ?? null);
const ev = (path, lines) => [{ path, lines }];
const tcp = (host, container) => ({ host, container, protocol: 'tcp' });

test('ct1 compose: one service per entry with image or build context, ports, volumes, depends_on, env key names and line evidence', () => {
  assert.deepEqual(frag.services, [
    {
      name: 'web',
      image: null,
      build: { context: 'web', dockerfile: 'web/Dockerfile' },
      ports: [tcp('8080', '3000')],
      volumes: [],
      dependsOn: ['api'],
      envKeys: ['API_URL', 'FEATURE_FLAGS'],
      evidence: ev('docker-compose.yml', '3-13'),
    },
    {
      name: 'api',
      image: null,
      build: { context: 'api', dockerfile: 'api/Dockerfile' },
      ports: [tcp('8000', '8000'), tcp('8443', '8443')],
      volumes: ['./api/data:/srv/data:ro', 'uploads:/srv/uploads'],
      dependsOn: ['db'],
      envKeys: ['DATABASE_URL', 'DB_PASSWORD', 'LOG_LEVEL', 'SMTP_HOST'],
      evidence: ev('docker-compose.yml', '14-28'),
    },
    {
      name: 'db',
      image: 'postgres:16-alpine',
      build: null,
      ports: [tcp(null, '5432')],
      volumes: ['pgdata:/var/lib/postgresql/data'],
      dependsOn: [],
      envKeys: ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER'],
      evidence: ev('docker-compose.yml', '29-38'),
    },
  ]);
  // The api service names .env.example in env_file: its key names (DB_PASSWORD, LOG_LEVEL, SMTP_HOST) are read from the
  // committed file, and the values it holds never reach the fragment.
  assert.ok(fixtureFiles.includes('.env.example'), 'the fixture carries the env file the api service names');
  assert.deepEqual(frag.services.find((s) => s.name === 'api').envKeys.filter((k) => ['DB_PASSWORD', 'LOG_LEVEL', 'SMTP_HOST'].includes(k)), ['DB_PASSWORD', 'LOG_LEVEL', 'SMTP_HOST']);
  const out = JSON.stringify(frag);
  for (const value of ['placeholder', 'info', 'example.invalid']) assert.ok(!out.includes(value), `env file value ${value} must not be in the fragment`);
});

test('ct2 Dockerfiles: base image, exposed ports and the entrypoint file of the final stage, one item per Dockerfile', () => {
  assert.deepEqual(frag.dockerfiles, [
    {
      base: 'python:3.12-slim',
      stages: 1,
      ports: [{ port: '8000', protocol: 'tcp' }, { port: '8443', protocol: 'tcp' }],
      command: './docker-entrypoint.sh uvicorn app.main:app --host 0.0.0.0',
      entrypoint: 'docker-entrypoint.sh',
      evidence: ev('api/Dockerfile', '1-8'),
    },
    {
      base: 'node:20-alpine',
      stages: 2,
      ports: [{ port: '3000', protocol: 'tcp' }],
      command: 'node server.js',
      entrypoint: 'server.js',
      evidence: ev('web/Dockerfile', '7-12'),
    },
  ]);

  const m = memFrag({
    'svc/Dockerfile':
      '# syntax=docker/dockerfile:1\n' +
      'ARG BASE=alpine:3.20\n' +
      'FROM --platform=linux/amd64 golang:1.22 AS builder\n' +
      'RUN go build -o /out/app ./cmd/app\n' +
      '\n' +
      'FROM ${BASE} AS runtime\n' +
      'expose 8080/udp 9090 \\\n' +
      '  ${EXTRA_PORT}\n' +
      'ENTRYPOINT node --enable-source-maps dist/server.js\n' +
      '\n' +
      'FROM runtime AS final\n' +
      'EXPOSE 5000\n',
    'svc/Dockerfile.dev': 'FROM alpine:3.20\nCMD npm start\n',
    'svc/api.Dockerfile': 'FROM eclipse-temurin:21-jre\nCMD ["java", "-Xmx1g", "-jar", "build/app.jar"]\n',
    'broken/Dockerfile': '# nothing to build\n',
    'svc/Dockerfile.md': 'FROM is a word in a note, not a Dockerfile\n',
  });
  assert.deepEqual(
    m.dockerfiles.map((d) => `${d.evidence[0].path}:${d.evidence[0].lines} base=${d.base} stages=${d.stages} ports=${d.ports.map((p) => `${p.port}/${p.protocol}`).join(',')} command=${d.command} entry=${d.entrypoint}`),
    [
      'svc/Dockerfile:11-12 base=${BASE} stages=3 ports=8080/udp,9090/tcp,${EXTRA_PORT}/tcp,5000/tcp command=node --enable-source-maps dist/server.js entry=dist/server.js',
      'svc/Dockerfile.dev:1-2 base=alpine:3.20 stages=1 ports= command=npm start entry=null',
      'svc/api.Dockerfile:1-2 base=eclipse-temurin:21-jre stages=1 ports= command=java -Xmx1g -jar build/app.jar entry=build/app.jar',
    ],
  );
  assert.equal(m.skipped.dockerfiles, 1, 'a Dockerfile without a FROM is counted, not guessed');
});

test('ct3 env keys are names only: compose environment (map and list), env_file keys; no value reaches the fragment', () => {
  const text = JSON.stringify(frag);
  for (const value of ['maps,alerts', 'http://api:8000', 'placeholder', 'postgres://'])assert.ok(!text.includes(value), `value ${value} must not be in the fragment`);

  const m = memFrag({
    'stack/compose.yml':
      'services:\n  api:\n    image: api\n    env_file: .env\n    environment:\n      - B=value-two\n      - A=value-one\n  job:\n    image: job\n    env_file:\n      - missing.env\n      - .env\n',
    'stack/.env': '# comment\nTOKEN=value-three\nexport REGION=value-four\nBROKEN LINE\nA=again\n',
  });
  assert.deepEqual(m.services.map((s) => [s.name, s.envKeys]), [
    ['api', ['A', 'B', 'REGION', 'TOKEN']],
    ['job', ['A', 'REGION', 'TOKEN']],
  ]);
  const out = JSON.stringify(m);
  for (const value of ['value-one', 'value-two', 'value-three', 'value-four', 'again']) assert.ok(!out.includes(value), `${value} must not be in the fragment`);
});

test('ct4 compose forms: long and flow syntax, depends_on maps, build resolved against the compose file, merges and aliases counted', () => {
  const m = memFrag({
    'deploy/compose.yaml':
      'name: demo\n' +
      'x-common: &common\n' +
      '  restart: always\n' +
      'services:\n' +
      '  app:\n' +
      '    image: demo/app:1.2\n' +
      '    build: ../api\n' +
      '    ports:\n' +
      '      - target: 80\n' +
      '        published: "8081"\n' +
      '        protocol: udp\n' +
      '      - 443:443\n' +
      '      - "9000-9002:9000-9002"\n' +
      '    volumes:\n' +
      '      - type: bind\n' +
      '        source: ./data\n' +
      '        target: /data\n' +
      '    depends_on: [cache, queue]\n' +
      '    environment: {MODE: prod, "DEBUG": "0"}\n' +
      '  cache:\n' +
      '    <<: *common\n' +
      '    image: "redis:7" # inline comment\n' +
      '    build:\n' +
      '      context: .\n' +
      '      dockerfile: docker/Dockerfile.dev\n' +
      '  worker: *common\n' +
      '  queue:\n' +
      '    image: ${QUEUE_IMAGE}\n' +
      '    build: ${QUEUE_CONTEXT}\n',
    'compose.override.yml': 'services:\n  web:\n    image: nginx\n    depends_on:\n      db:\n        condition: service_started\n      cache:\n        condition: service_started\n',
    'notes/compose.yml.txt': 'services:\n  ghost:\n    image: nope\n',
  });
  assert.deepEqual(m.services, [
    {
      name: 'web',
      image: 'nginx',
      build: null,
      ports: [],
      volumes: [],
      dependsOn: ['cache', 'db'],
      envKeys: [],
      evidence: ev('compose.override.yml', '2-8'),
    },
    {
      name: 'app',
      image: 'demo/app:1.2',
      build: { context: 'api', dockerfile: 'api/Dockerfile' },
      ports: [
        { host: '8081', container: '80', protocol: 'udp' },
        tcp('443', '443'),
        tcp('9000-9002', '9000-9002'),
      ],
      volumes: ['./data:/data'],
      dependsOn: ['cache', 'queue'],
      envKeys: ['DEBUG', 'MODE'],
      evidence: ev('deploy/compose.yaml', '5-19'),
    },
    {
      name: 'cache',
      image: 'redis:7',
      build: { context: 'deploy', dockerfile: 'deploy/docker/Dockerfile.dev' },
      ports: [],
      volumes: [],
      dependsOn: [],
      envKeys: [],
      evidence: ev('deploy/compose.yaml', '20-25'),
    },
    {
      name: 'queue',
      image: '${QUEUE_IMAGE}',
      build: { context: '${QUEUE_CONTEXT}', dockerfile: null },
      ports: [],
      volumes: [],
      dependsOn: [],
      envKeys: [],
      evidence: ev('deploy/compose.yaml', '27-29'),
    },
  ]);
  assert.equal(m.skipped.services, 2, 'a merge key and an alias stand for values that are not resolved');
});

test('ct5 every item carries {path, lines} evidence inside the file, output sorted and deterministic', () => {
  for (const kind of ['services', 'dockerfiles']) {
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
  assert.deepEqual(Object.keys(frag), ['dockerfiles', 'scanned', 'services', 'skipped', 'truncated']);
  assert.equal(frag.scanned, 3, 'two Dockerfiles and one compose file were read; .env.example is read for key names through env_file but yields no item of its own');
  assert.deepEqual(frag.skipped, { dockerfiles: 0, services: 0 });
  assert.deepEqual(frag.truncated, { dockerfiles: 0, services: 0 });
  const again = extractContainers(fixtureFiles.slice().reverse(), fixtureRead);
  assert.equal(JSON.stringify(again), JSON.stringify(frag), 'input order does not change the output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(frag)), 'no timestamps');
});

test('ct6 caps: items past MAX_ITEMS per kind are counted in truncated; ports past MAX_NESTED per service are dropped', () => {
  const docker = {};
  for (let i = 0; i < MAX_ITEMS + 3; i++) docker[`d/Dockerfile.${String(i).padStart(6, '0')}`] = 'FROM alpine:3.20\n';
  const d = memFrag(docker);
  assert.equal(d.dockerfiles.length, MAX_ITEMS);
  assert.equal(d.truncated.dockerfiles, 3);
  assert.equal(d.dockerfiles[0].evidence[0].path, 'd/Dockerfile.000000', 'the first rows in sort order are the ones kept');

  let services = 'services:\n';
  for (let i = 0; i < MAX_ITEMS + 2; i++) services += `  s${String(i).padStart(6, '0')}:\n    image: busybox\n`;
  const s = memFrag({ 'compose.yml': services });
  assert.equal(s.services.length, MAX_ITEMS);
  assert.equal(s.truncated.services, 2);

  let ports = 'services:\n  big:\n    image: busybox\n    ports:\n';
  for (let i = 0; i < MAX_NESTED + 5; i++) ports += `      - "${10000 + i}"\n`;
  const p = memFrag({ 'compose.yml': ports });
  assert.equal(p.services[0].ports.length, MAX_NESTED);
  assert.ok(JSON.stringify(frag).length < 200 * 1024, 'fragment stays small');
});

test('ct7 the plug-in detects Dockerfiles and compose files by name only, and names the stack containers', () => {
  assert.equal(plugin.id, 'containers');
  const det = (...files) => plugin.detect({ files });
  assert.equal(det('web/Dockerfile'), true);
  assert.equal(det('Dockerfile.dev'), true);
  assert.equal(det('api.Dockerfile'), true);
  assert.equal(det('docker-compose.yml'), true);
  assert.equal(det('deploy/docker-compose.prod.yaml'), true);
  assert.equal(det('compose.yaml'), true);
  assert.equal(det('app/main.py', 'package.json', 'docs/compose-notes.md', 'compose.yml.txt'), false);
  assert.equal(det(), false);
  assert.equal(typeof plugin.extract, 'function');
});

test('ct8 nothing is executed or imported from the scanned repo; the plug-in runs inside prescan and behind the stacks/ re-export', async () => {
  const src = readFileSync(MODULE, 'utf8');
  assert.ok(!/child_process|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|node:vm|node:worker_threads/.test(src), 'containers.mjs has no way to run code');

  const shim = join(LIB, 'stacks', 'containers.mjs');
  assert.equal(readFileSync(shim, 'utf8').trim(), "export { default } from '../containers.mjs';");
  const viaShim = await import(pathToFileURL(shim).href);
  assert.equal(viaShim.default, plugin, 'the re-export is the same object');

  const dir = mkdtempSync(join(tmpdir(), 'archmap-ctfix-'));
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
    assert.ok(out.stacks.includes('containers'));
    assert.equal(JSON.stringify(out.extracts.containers), JSON.stringify(frag));
    const real = await prescan(dir);
    assert.equal(JSON.stringify(real.extracts.containers), JSON.stringify(frag), 'the default loader finds the plug-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
