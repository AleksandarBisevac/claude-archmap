import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (nb1..nb8) lead every title so the suite prints them first.
// The node-backend stack plug-in of prescan, run on the fictional Inkwell Books fixture in
// tests/fixtures/repos/node-api/ (read as text only - the extractor must never import it).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'repos', 'node-api');
const NB_MODULE = join(ROOT, 'scripts', 'lib', 'prescan', 'node-backend.mjs');
const { default: nodeExtractor, extractNodeBackend } = await import(pathToFileURL(NB_MODULE).href);

const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });

const fixtureFiles = walk(FIXTURE).sort();
const fixtureRead = (p) => readFileSync(join(FIXTURE, p), 'utf8');
const frag = extractNodeBackend(fixtureFiles, fixtureRead);
const memFrag = (files) => extractNodeBackend(Object.keys(files).sort(), (p) => files[p] ?? null);

const KINDS = ['entities', 'openapi', 'queues', 'routes'];
const pick = (items, keys) => items.map((i) => Object.fromEntries(keys.map((k) => [k, i[k]])));
const ev = (i) => `${i.evidence[0].path}:${i.evidence[0].lines}`;
const routeRows = (f) => f.routes.map((r) => `${r.framework} ${r.method} ${r.url} ${r.handler} ${ev(r)}`);

test('nb1 routes: NestJS controllers, Express and Hono routers with method, full path and line evidence', () => {
  assert.deepEqual(routeRows(frag), [
    'nestjs GET /api/v1/books list src/books/books.controller.ts:7-8',
    'nestjs GET /api/v1/books/:id findOne src/books/books.controller.ts:12-13',
    'nestjs POST /api/v1/books create src/books/books.controller.ts:17-18',
    'nestjs PUT /api/v1/books/:id update src/books/books.controller.ts:22-23',
    'nestjs DELETE /api/v1/books/:id remove src/books/books.controller.ts:27-28',
    'nestjs GET /api/v1/books/featured highlights src/books/books.controller.ts:32-33',
    'nestjs GET /api/v1/books/bestsellers highlights src/books/books.controller.ts:32-33',
    'nestjs ANY /api/v1/books/ping ping src/books/books.controller.ts:37-38',
    'express GET /health null src/express/app.ts:7',
    'express GET /orders listOrders src/express/orders.router.ts:7',
    'express GET /orders/:orderId getOrder src/express/orders.router.ts:8',
    'express POST /orders null src/express/orders.router.ts:9-11',
    'express DELETE /orders/:orderId cancelOrder src/express/orders.router.ts:12',
    'hono GET /authors null src/hono/app.ts:6',
    'hono GET /authors/:id null src/hono/app.ts:7',
    'hono POST /authors createAuthor src/hono/app.ts:8',
    'hono GET /health null src/hono/app.ts:11',
    'hono ANY /ping null src/hono/app.ts:12',
    'hono GET /search null src/hono/app.ts:13',
    'hono POST /search null src/hono/app.ts:13',
    'hono GET /reviews null src/hono/reviews.ts:7',
    'hono POST /reviews/:bookId addReview src/hono/reviews.ts:8',
    'hono DELETE /reviews/:bookId/:reviewId null src/hono/reviews.ts:9',
  ]);
});

test('nb2 entities: Prisma, TypeORM and Drizzle with fields, PK, FK and relations', () => {
  const byName = Object.fromEntries(frag.entities.map((e) => [`${e.orm}:${e.name}`, e]));
  assert.deepEqual(Object.keys(byName).sort(), [
    'drizzle:editions', 'drizzle:publishers',
    'prisma:Customer', 'prisma:Order', 'prisma:OrderLine',
    'typeorm:Author', 'typeorm:Book',
  ]);
  const F = ['name', 'type', 'pk', 'fk'];
  const R = ['field', 'kind', 'target', 'via'];

  // Prisma: the table is @@map or the model name; relation fields are relations, not columns.
  assert.equal(byName['prisma:Customer'].table, 'Customer');
  assert.deepEqual(pick(byName['prisma:Customer'].fields, F), [
    { name: 'id', type: 'Int', pk: true, fk: null },
    { name: 'email', type: 'String', pk: false, fk: null },
  ]);
  assert.deepEqual(pick(byName['prisma:Customer'].relations, R), [{ field: 'orders', kind: 'many', target: 'Order', via: null }]);
  assert.equal(byName['prisma:Order'].table, 'orders');
  assert.deepEqual(pick(byName['prisma:Order'].fields, F), [
    { name: 'id', type: 'Int', pk: true, fk: null },
    { name: 'placedAt', type: 'DateTime', pk: false, fk: null },
    { name: 'format', type: 'Format?', pk: false, fk: null },
    { name: 'customerId', type: 'Int', pk: false, fk: 'Customer.id' },
  ]);
  assert.deepEqual(pick(byName['prisma:Order'].relations, R), [
    { field: 'customer', kind: 'one', target: 'Customer', via: 'customerId' },
    { field: 'lines', kind: 'many', target: 'OrderLine', via: null },
  ]);
  assert.deepEqual(pick(byName['prisma:OrderLine'].fields, F), [
    { name: 'orderId', type: 'Int', pk: true, fk: 'Order.id' },
    { name: 'sku', type: 'String', pk: true, fk: null },
    { name: 'qty', type: 'Int', pk: false, fk: null },
  ]);

  // TypeORM
  assert.equal(byName['typeorm:Author'].table, 'authors');
  assert.deepEqual(pick(byName['typeorm:Author'].fields, F), [
    { name: 'id', type: 'number', pk: true, fk: null },
    { name: 'name', type: 'string', pk: false, fk: null },
  ]);
  assert.deepEqual(pick(byName['typeorm:Author'].relations, R), [{ field: 'books', kind: 'many', target: 'Book', via: null }]);
  assert.equal(byName['typeorm:Book'].table, 'books');
  assert.deepEqual(pick(byName['typeorm:Book'].fields, F), [
    { name: 'id', type: 'string', pk: true, fk: null },
    { name: 'title', type: 'string', pk: false, fk: null },
    { name: 'subtitle', type: 'string', pk: false, fk: null },
    { name: 'authorId', type: 'number', pk: false, fk: 'Author' },
  ]);
  assert.deepEqual(pick(byName['typeorm:Book'].relations, R), [{ field: 'author', kind: 'one', target: 'Author', via: 'author_id' }]);

  // Drizzle
  assert.equal(byName['drizzle:publishers'].table, 'publishers');
  assert.deepEqual(pick(byName['drizzle:publishers'].fields, F), [
    { name: 'id', type: 'serial', pk: true, fk: null },
    { name: 'name', type: 'varchar', pk: false, fk: null },
  ]);
  assert.deepEqual(pick(byName['drizzle:publishers'].relations, R), [{ field: 'editions', kind: 'many', target: 'editions', via: null }]);
  assert.deepEqual(pick(byName['drizzle:editions'].fields, F), [
    { name: 'id', type: 'serial', pk: true, fk: null },
    { name: 'isbn', type: 'text', pk: false, fk: null },
    { name: 'publisherId', type: 'integer', pk: false, fk: 'publishers.id' },
  ]);
  assert.deepEqual(pick(byName['drizzle:editions'].relations, R), [{ field: 'publisher', kind: 'one', target: 'publishers', via: 'publisherId' }]);

  assert.deepEqual(frag.entities.map(ev), [
    'prisma/schema.prisma:15-19', 'prisma/schema.prisma:21-30', 'prisma/schema.prisma:32-39',
    'src/db/schema.ts:6-9', 'src/db/schema.ts:11-17',
    'src/entities/author.entity.ts:4-14', 'src/entities/book.entity.ts:4-21',
  ]);
});

test('nb3 openapi: documents with title, version, servers, operations and schemas', () => {
  assert.equal(frag.openapi.length, 1);
  const d = frag.openapi[0];
  assert.deepEqual(pick([d], ['title', 'version', 'specVersion', 'servers', 'schemas']), [
    { title: 'Inkwell Books API', version: '1.2.0', specVersion: '3.0.3', servers: ['https://api.inkwell.example.invalid/v1'], schemas: ['Author', 'Book'] },
  ]);
  assert.deepEqual(d.operations.map((o) => `${o.method} ${o.url} ${o.operationId} ${ev(o)}`), [
    'GET /books listBooks openapi.yaml:9-11',
    'POST /books createBook openapi.yaml:12-14',
    'GET /books/{bookId} getBook openapi.yaml:19-20',
    'DELETE /books/{bookId} null openapi.yaml:21-22',
  ]);
  assert.equal(ev(d), 'openapi.yaml:1-28');

  const json = memFrag({ 'docs/swagger.json': JSON.stringify({ swagger: '2.0', info: { title: 'Old', version: '0.1' }, paths: { '/x': { get: { operationId: 'getX' }, parameters: [] } } }, null, 2) });
  assert.equal(json.openapi.length, 1);
  assert.deepEqual(pick(json.openapi[0].operations, ['method', 'url', 'operationId']), [{ method: 'GET', url: '/x', operationId: 'getX' }]);
  assert.equal(json.openapi[0].specVersion, '2.0');
});

test('nb4 queues: BullMQ queues with producers and workers, names resolved through imported constants', () => {
  assert.equal(frag.queues.length, 1);
  const q = frag.queues[0];
  assert.equal(q.name, 'email');
  assert.equal(ev(q), 'src/queues/email.queue.ts:6');
  assert.deepEqual(q.producers.map((p) => `${p.job} ${ev(p)}`), [
    'welcome src/queues/email.producer.ts:4',
    'receipt src/queues/email.producer.ts:8',
  ]);
  assert.deepEqual(q.workers.map((w) => `${w.handler} ${w.concurrency} ${ev(w)}`), ['deliver 5 src/queues/email.worker.ts:8']);
});

test('nb5 every item carries {path, lines} evidence inside the file, output sorted and deterministic', () => {
  const nested = (item) => [...(item.operations ?? []), ...(item.producers ?? []), ...(item.workers ?? [])];
  for (const kind of KINDS) {
    assert.ok(frag[kind].length > 0, `${kind} found something in the fixture`);
    for (const item of frag[kind]) {
      for (const it of [item, ...nested(item)]) {
        assert.ok(Array.isArray(it.evidence) && it.evidence.length >= 1, `${kind} item has evidence`);
        for (const { path, lines } of it.evidence) {
          assert.match(lines, /^[0-9]+(-[0-9]+)?$/);
          assert.ok(fixtureFiles.includes(path), `evidence path ${path} is a fixture file`);
          const [a, b = a] = lines.split('-').map(Number);
          const total = fixtureRead(path).split('\n').length;
          assert.ok(a >= 1 && a <= b && b <= total, `${path}:${lines} is inside the file`);
        }
      }
    }
    const keys = frag[kind].map((i) => [i.evidence[0].path, Number(i.evidence[0].lines.split('-')[0])]);
    const sorted = keys.slice().sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    assert.deepEqual(keys, sorted, `${kind} is ordered by path then line`);
  }
  const again = extractNodeBackend(fixtureFiles.slice().reverse(), fixtureRead);
  assert.equal(JSON.stringify(again), JSON.stringify(frag), 'input order does not change the output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(frag)), 'no timestamps');
  assert.deepEqual(Object.keys(frag), Object.keys(frag).slice().sort(), 'fragment keys are sorted');
});

test('nb6 unknown patterns are skipped and counted, never guessed; a large file keeps every route', () => {
  // Fixture tally: @Get(CONST), get(CONST), express .route(path) chain, a template path in Hono,
  // a pgTable whose name is not a literal, a queue.add whose job name is a variable.
  assert.deepEqual(frag.skipped, { clients: 0, entities: 1, envKeys: 0, openapi: 0, queues: 1, routes: 4, sqlTables: 0 });
  assert.deepEqual(frag.truncated, { clients: 0, entities: 0, envKeys: 0, openapi: 0, queues: 0, routes: 0, sqlTables: 0 });

  const odd = memFrag({
    'svc/odd.ts':
      "import express from 'express';\nimport { Queue, Worker } from 'bullmq';\nimport { pgTable, serial } from 'drizzle-orm/pg-core';\n" +
      "const app = express();\nconst other = makeApp();\n" +
      "app.get(PATHS[0], h);\nother.get('/x', h);\napp.get('title');\n" +
      "new Queue(name());\nnew Worker(NAME, fn);\n" +
      "export const t = pgTable(compute(), { id: serial('id') });\n",
    'docs/swagger-notes.json': '{"hello": 1}',
    'docs/openapi-broken.yaml': 'just: text\n',
  });
  // P10.14: a Worker named by an identifier is a queue row named for the identifier; a call as the name is still skipped
  assert.deepEqual(odd.skipped, { clients: 0, entities: 1, envKeys: 0, openapi: 2, queues: 1, routes: 1, sqlTables: 0 });
  for (const k of KINDS.filter((x) => x !== 'queues')) assert.deepEqual(odd[k], [], `${k}: nothing is guessed from unknown shapes`);
  assert.deepEqual(odd.queues.map((q) => `${q.name} ${ev(q)}`), ['NAME svc/odd.ts:10'], 'the identifier text names the queue');

  const lines = ["import express from 'express';", 'const app = express();'];
  for (let i = 0; i < 400; i++) lines.push(`app.get('/r${String(i).padStart(3, '0')}', h);`);
  const big = memFrag({ 'm/routes.ts': lines.join('\n') + '\n' });
  // P10.10: the extract is the full record (the explorer gets a capped summary instead), so 400 routes are 400 rows.
  assert.equal(big.routes.length, 400, `every route is kept (${big.routes.length})`);
  assert.equal(big.truncated.routes, 0);
  assert.equal(big.routes[0].url, '/r000', 'rows stay in sort order');
  assert.ok(JSON.stringify(big).length < 200 * 1024, 'fragment stays small');
});

test('nb7 mounts, prefixes and controllers resolve only from literals; nothing is applied on a guess', () => {
  // A router mounted twice answers under both prefixes; a default-imported router mounts with no prefix.
  const mounts = memFrag({
    'a/main.ts': "import express from 'express';\nimport api from './api';\nimport v2 from './v2';\nconst app = express();\napp.use('/v1', api);\napp.use('/v2', api);\napp.use(v2);\n",
    'a/api.ts': "import { Router } from 'express';\nconst r = Router();\nr.get('/ping', p);\nexport default r;\n",
    'a/v2.ts': "import { Router } from 'express';\nconst router = Router();\nrouter.get('/pong', q);\nexport default router;\n",
  });
  assert.deepEqual(routeRows(mounts), [
    'express GET /v1/ping p a/api.ts:3',
    'express GET /v2/ping p a/api.ts:3',
    'express GET /pong q a/v2.ts:3',
  ]);

  // An unmounted router keeps the path it declares.
  assert.deepEqual(routeRows(memFrag({ 'b/r.ts': "import { Router } from 'express';\nexport const r = Router();\nr.get('/solo', h);\n" })), ['express GET /solo h b/r.ts:3']);

  const ctl =
    "import { Controller, Get, Post } from '@nestjs/common';\n@Controller({ path: 'x', version: '1' })\nexport class X {\n  @Get('a')\n  a() {}\n}\n" +
    '@Controller()\nexport class Y {\n  @Post()\n  b() {}\n}\nexport class Z {\n  @Get(\'nope\')\n  c() {}\n}\n';
  assert.deepEqual(routeRows(memFrag({ 'n/x.controller.ts': ctl })), [
    'nestjs GET /x/a a n/x.controller.ts:4-5',
    'nestjs POST / b n/x.controller.ts:9-10',
  ]);
  // One literal global prefix is applied; two different ones are not (never guessed).
  const one = memFrag({ 'n/x.controller.ts': ctl, 'n/main.ts': "app.setGlobalPrefix('api');\n" });
  assert.equal(one.routes[0].url, '/api/x/a');
  const two = memFrag({ 'n/x.controller.ts': ctl, 'n/main1.ts': "app.setGlobalPrefix('a');\n", 'n/main2.ts': "app.setGlobalPrefix('b');\n" });
  assert.equal(two.routes[0].url, '/x/a');
});

test('nb8 nothing is executed or imported from the scanned repo; the plug-in runs inside prescan', () => {
  const canary = join(FIXTURE, 'src', 'EXECUTED.txt');
  assert.ok(!existsSync(canary), 'canary absent before');
  extractNodeBackend(fixtureFiles, fixtureRead);
  assert.ok(!existsSync(canary), 'the import-time canary in src/sidefx.ts was never run');

  const src = readFileSync(NB_MODULE, 'utf8');
  assert.ok(!/child_process|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|node:vm|node:worker_threads/.test(src), 'node-backend.mjs has no way to run code');

  assert.equal(nodeExtractor.id, 'node-backend');
  const pkg = JSON.stringify({ dependencies: { express: '^4' } });
  const read = (p) => (p === 'package.json' ? pkg : null);
  assert.equal(nodeExtractor.detect({ files: ['package.json', 'src/a.ts'], read }), true);
  assert.equal(nodeExtractor.detect({ files: ['app/main.py'], read }), false);
  assert.equal(nodeExtractor.detect({ files: ['package.json'], read: () => JSON.stringify({ dependencies: { react: '^18' } }) }), false);

  const dir = mkdtempSync(join(tmpdir(), 'archmap-nbfix-'));
  try {
    for (const f of fixtureFiles) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), fixtureRead(f));
    }
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
    return import(pathToFileURL(join(ROOT, 'scripts', 'prescan.mjs')).href).then(async ({ prescan }) => {
      const out = await prescan(dir, { extractors: [nodeExtractor] });
      assert.deepEqual(out.stacks, ['node-backend']);
      assert.equal(JSON.stringify(out.extracts['node-backend']), JSON.stringify(frag));
      assert.ok(!existsSync(join(dir, 'src', 'EXECUTED.txt')));
      rmSync(dir, { recursive: true, force: true });
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});

// ---------------------------------------------------------------------------------------------
// P10.2: what the explorer used to rediscover with Grep now arrives in the extract.

test('nb9 env keys and SDK clients are extracted with file and line, never with values; queue producers and workers stay paired', () => {
  assert.deepEqual(
    frag.envKeys.map((k) => `${k.name} ${ev(k)}`),
    [
      'DATABASE_URL src/config.ts:4',
      'QUEUE_PREFIX src/config.ts:5',
      'REDIS_URL src/config.ts:7',
      'OBJECT_STORE_URL src/config.ts:8',
      'LEGACY_SLUG src/hono/app.ts:14',
    ],
  );
  const clients = frag.clients.map((c) => `${c.client} ${c.kind} ${c.target} ${ev(c)}`);
  for (const want of ['Redis sdk env:REDIS_URL src/config.ts:7', 'S3Client sdk env:OBJECT_STORE_URL src/config.ts:8']) {
    assert.ok(clients.includes(want), `${want} in ${JSON.stringify(clients)}`);
  }
  assert.ok(!clients.some((c) => /^(Queue|Worker) /.test(c)), 'queues are reported under queues, not as clients');
  assert.ok(!JSON.stringify(frag.envKeys).includes("'q'"), 'defaults are not kept');
  assert.equal(frag.queues[0].producers.length, 2);
  assert.equal(frag.queues[0].workers.length, 1);
});

test('nb10 prescan writes one extracts/<area>.json per area with routes, tables, env keys and queues in the area that owns them', () => {
  const work = mkdtempSync(join(tmpdir(), 'archmap-nbwork-'));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'prescan.mjs'), FIXTURE, '--out', join(work, 'prescan.json')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const pre = JSON.parse(readFileSync(join(work, 'prescan.json'), 'utf8'));
    assert.deepEqual(readdirSync(join(work, 'extracts')).sort(), pre.areas.flatMap((a) => [`${a.id}.json`, `${a.id}.summary.json`]).sort());
    const slice = (id) => JSON.parse(readFileSync(join(work, 'extracts', `${id}.json`), 'utf8'));

    const src = slice('src');
    assert.deepEqual(src.routes[0], { method: 'GET', path: '/api/v1/books', handler: 'list', file: 'src/books/books.controller.ts', line: 7 });
    assert.equal(src.routes.length, 23);
    assert.deepEqual(src.envKeys.find((k) => k.name === 'REDIS_URL'), { name: 'REDIS_URL', at: ['src/config.ts:7'] });
    const email = src.queues.find((q) => q.name === 'email');
    assert.deepEqual(email.producers.map((p) => `${p.job} ${p.file}:${p.line}`), ['welcome src/queues/email.producer.ts:4', 'receipt src/queues/email.producer.ts:8']);
    assert.deepEqual(email.consumers, [{ handler: 'deliver', file: 'src/queues/email.worker.ts', line: 8 }]);
    assert.ok(src.tables.some((t) => t.orm === 'typeorm') && !src.tables.some((t) => t.orm === 'prisma'), 'prisma models belong to the prisma area');
    assert.ok(src.imports.includes('src/books/books.service.ts > src/config.ts'), JSON.stringify(src.imports));
    assert.ok(src.imports.includes('src/books/books.service.ts > src/queues/email.producer.ts'));

    const prisma = slice('prisma');
    const order = prisma.tables.find((t) => t.name === 'Order');
    assert.deepEqual([order.table, order.orm, order.file, order.line], ['orders', 'prisma', 'prisma/schema.prisma', 21]);
    assert.ok(order.fields.includes('customerId Int fk=Customer.id'), JSON.stringify(order.fields));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// P10.10: the per-area extract is the full record a script builds the model's entities, relations and queues
// from. It is never trimmed to a budget, the Hono parser follows generics and composition, and the node
// scanners run on any area that holds .ts or .js files whatever its stack label.

const prescanInto = (repo) => {
  const work = mkdtempSync(join(tmpdir(), 'archmap-nbfull-'));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'prescan.mjs'), repo, '--out', join(work, 'prescan.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const pre = JSON.parse(readFileSync(join(work, 'prescan.json'), 'utf8'));
  const full = Object.fromEntries(pre.areas.map((a) => [a.id, JSON.parse(readFileSync(join(work, 'extracts', `${a.id}.json`), 'utf8'))]));
  return { work, pre, full };
};
const gitRepo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-nbrepo-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
  g('init', '-q');
  g('add', '-A');
  g('commit', '-q', '-m', 'fixture');
  return dir;
};
const noneTruncated = (x, kinds = ['tables', 'routes', 'queues']) =>
  kinds.every((k) => !(x.truncated && Number(x.truncated[k]) > 0));

test('nb11 the full extract lists every Drizzle table with fields and references, every Hono route of a generic sub-app mounted with a prefix, and every BullMQ queue, with nothing truncated', () => {
  const { work, full } = prescanInto(FIXTURE);
  try {
    const all = Object.values(full);
    // every table, route and queue the scanner found is in exactly one area's full extract
    assert.equal(all.reduce((n, s) => n + (s.tables ?? []).length, 0), frag.entities.length, 'every table is in an extract');
    assert.equal(all.reduce((n, s) => n + (s.routes ?? []).length, 0), frag.routes.length, 'every route is in an extract');
    assert.equal(all.reduce((n, s) => n + (s.queues ?? []).length, 0), frag.queues.length, 'every queue is in an extract');
    for (const s of all) assert.ok(noneTruncated(s), `${s.area}: nothing truncated in ${JSON.stringify(s.truncated)}`);

    const src = full.src;
    const editions = src.tables.find((t) => t.name === 'editions');
    assert.deepEqual([editions.orm, editions.table, editions.file, editions.line, editions.lines], ['drizzle', 'editions', 'src/db/schema.ts', 11, '11-17']);
    assert.deepEqual(editions.fields, ['id serial pk', 'isbn text', 'publisherId integer fk=publishers.id']);
    assert.deepEqual(src.tables.find((t) => t.name === 'publishers').fields, ['id serial pk', 'name varchar']);

    const rows = src.routes.filter((r) => r.file.startsWith('src/hono/')).map((r) => `${r.method} ${r.path} ${r.file}:${r.line}`);
    for (const want of ['GET /reviews src/hono/reviews.ts:7', 'POST /reviews/:bookId src/hono/reviews.ts:8', 'DELETE /reviews/:bookId/:reviewId src/hono/reviews.ts:9']) {
      assert.ok(rows.includes(want), `${want} in ${JSON.stringify(rows)}`);
    }
    const email = src.queues.find((q) => q.name === 'email');
    assert.deepEqual([email.file, email.line], ['src/queues/email.queue.ts', 6], 'the queue carries its declaration');
    assert.equal(email.producers.length, 2);
    assert.equal(email.consumers.length, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('nb12 Hono sub-apps declared with generics, in the same file or imported, take the prefix they are mounted under', () => {
  const rows = routeRows(memFrag({
    'h/index.ts':
      "import { Hono } from 'hono';\nimport books from './books';\ntype Env = { Bindings: { DB: string } };\n" +
      'const app = new Hono<Env>();\nconst r = new Hono<{ Bindings: { DB: string }; Variables: { id: string } }>();\n' +
      "r.get('/list', (c) => c.json([]));\napp.route('/admin', r);\napp.route('/books', books);\napp.get('/up', (c) => c.text('ok'));\nexport default app;\n",
    'h/books.ts': "import { Hono } from 'hono';\nconst books = new Hono<Env>();\nbooks.get('/:id', getBook);\nbooks.put('/:id', (c) => c.json({}));\nexport default books;\n",
  }));
  assert.deepEqual(rows, [
    'hono GET /books/:id getBook h/books.ts:3',
    'hono PUT /books/:id null h/books.ts:4',
    'hono GET /admin/list null h/index.ts:6',
    'hono GET /up null h/index.ts:9',
  ]);
  // route composition: a sub-app built as one chain of .get/.post calls, then mounted
  const chained = routeRows(memFrag({
    'c/app.ts':
      "import { Hono } from 'hono';\nimport { notes } from './notes';\nconst app = new Hono<Env>();\napp.route('/notes', notes);\n" +
      "app.get('/a', (c) => c.text('a')).post('/b', postB);\nexport default app;\n",
    'c/notes.ts':
      "import { Hono } from 'hono';\nexport const notes = new Hono<Env>()\n  .get('/', (c) => c.json([]))\n  .post('/', createNote)\n  .delete('/:id', (c) => c.body(null, 204));\n",
  }));
  assert.deepEqual(chained, [
    'hono GET /a null c/app.ts:5',
    'hono POST /b postB c/app.ts:5',
    'hono GET /notes null c/notes.ts:3',
    'hono POST /notes createNote c/notes.ts:4',
    'hono DELETE /notes/:id null c/notes.ts:5',
  ]);
});

test('nb13 an area labelled ts-frontend that holds .ts files still gets its queues, tables and routes extracted', () => {
  const repo = gitRepo({
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'packages/console/package.json': JSON.stringify({ name: 'console', dependencies: { react: '^18.0.0' } }),
    'packages/console/src/App.tsx': 'export const App = () => null;\n',
    'packages/console/src/jobs.ts':
      "import { Queue, Worker } from 'bullmq';\nexport const mail = new Queue('mail');\nexport async function send(to) {\n  await mail.add('notice', { to });\n}\n" +
      "export const mailWorker = new Worker('mail', async (job) => job.data);\n",
    'packages/console/src/db.ts':
      "import { pgTable, serial, text } from 'drizzle-orm/pg-core';\nexport const notes = pgTable('notes', {\n  id: serial('id').primaryKey(),\n  body: text('body'),\n});\n",
    'packages/console/src/api.ts':
      "import { Hono } from 'hono';\ntype Env = {};\nconst api = new Hono<Env>();\napi.get('/notes', (c) => c.json([]));\nexport default api;\n",
    'packages/site/package.json': JSON.stringify({ name: 'site', dependencies: { react: '^18.0.0' } }),
    'packages/site/src/main.tsx': 'export {};\n',
    'packages/site/src/Page.tsx': 'export const Page = () => null;\n',
  });
  const { work, pre, full } = prescanInto(repo);
  try {
    const area = pre.areas.find((a) => a.globs.some((g) => g.startsWith('packages/console')));
    assert.ok(area, JSON.stringify(pre.areas));
    assert.deepEqual(area.stacks, ['ts-frontend'], 'the label stays what the package.json says');
    const s = full[area.id];
    const mail = (s.queues ?? []).find((q) => q.name === 'mail');
    assert.ok(mail, JSON.stringify(s.queues));
    assert.deepEqual(mail.producers.map((p) => `${p.job} ${p.file}:${p.line}`), ['notice packages/console/src/jobs.ts:4']);
    assert.deepEqual(mail.consumers.map((c) => `${c.file}:${c.line}`), ['packages/console/src/jobs.ts:6']);
    assert.deepEqual((s.tables ?? []).map((t) => `${t.orm} ${t.table} ${t.file}:${t.lines}`), ['drizzle notes packages/console/src/db.ts:2-5']);
    assert.deepEqual((s.routes ?? []).map((r) => `${r.method} ${r.path}`), ['GET /notes']);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('nb14 new Queue(NAME_CONST), new Queue(QUEUES.x), new Worker(name, ...) and new FlowProducer(...) yield queue rows: the literal, else the resolved constant, else the identifier text; a Worker with no resolvable name is named after its file', () => {
  const f = memFrag({
    'src/names.ts':
      "export const QUEUE_NAMES = {\n  maintenance: 'maintenance',\n  reports: \"reports\",\n} as const;\n" +
      "export enum Lane { Slow = 'slow-lane' }\nexport const MAIL = 'mail-out';\n",
    'src/queues.ts':
      "import { Queue, Worker, FlowProducer } from 'bullmq';\nimport { QUEUE_NAMES, MAIL, Lane } from './names';\n" +
      "export const maint = new Queue(QUEUE_NAMES.maintenance, { connection });\n" +
      "export const mail = new Queue(MAIL);\n" +
      "export const lit = new Queue('emails', {});\n" +
      "export const flow = new FlowProducer({ connection });\n" +
      "const LOCAL = 'sweeps';\n" +
      "new Worker(LOCAL, handler);\n" +
      "new Queue(EXTERNAL_NAME);\n" +
      "new Queue(config.queues.audit);\n" +
      "new Worker(Lane.Slow, slowHandler);\n" +
      "new Queue(name());\n",
    'src/worker.ts':
      "import { Worker } from 'bullmq';\nimport { QUEUE_NAMES } from './names';\n" +
      "export function start(name: string) {\n  return new Worker(name, async (job) => job.data, { concurrency: 2 });\n}\n" +
      "new Worker(QUEUE_NAMES.reports, reportHandler);\n",
  });
  const rows = f.queues.map((q) => `${q.name} ${ev(q)}`).sort();
  assert.deepEqual(rows, [
    'EXTERNAL_NAME src/queues.ts:9',
    'config.queues.audit src/queues.ts:10',
    'emails src/queues.ts:5',
    'flow:src/queues src/queues.ts:6',
    'mail-out src/queues.ts:4',
    'maintenance src/queues.ts:3',
    'reports src/worker.ts:6',
    'slow-lane src/queues.ts:11',
    'src/worker src/worker.ts:4',
    'sweeps src/queues.ts:8',
  ].sort());
  const by = Object.fromEntries(f.queues.map((q) => [q.name, q]));
  assert.deepEqual(by['src/worker'].workers.map((w) => `${w.concurrency} ${ev(w)}`), ['2 src/worker.ts:4']);
  assert.deepEqual(by.reports.workers.map((w) => `${w.handler} ${ev(w)}`), ['reportHandler src/worker.ts:6']);
  assert.equal(f.skipped.queues, 1, 'only the call new Queue(name()) is skipped');
  assert.equal(memFrag({ 'src/a.ts': "new Worker('x', fn);\n" }).queues[0].name, 'x', 'a literal is still the name');
  // the producer pairing of a literal-named queue still holds
  const paired = memFrag({
    'src/q.ts': "const jobs = new Queue('jobs');\njobs.add('run', {});\nnew Worker('jobs', h);\nnew Worker(jobsName, h);\n",
  });
  const jobs = paired.queues.find((q) => q.name === 'jobs');
  assert.equal(jobs.producers.length, 1);
  assert.equal(jobs.workers.length, 1);
});

test('nb15 new Queue(param) with an unresolved lowercase identifier (a parameter, an unresolved import) is skipped and counted, never named after its file; new Worker(param, ...) still is', () => {
  const f = memFrag({
    'src/factory.ts':
      "import { Queue, Worker } from 'bullmq';\n" +
      "export function makeQueue(name: string) {\n  return new Queue(name, { connection });\n}\n" +
      "export function makeOther(queueName: string) {\n  return new Queue(queueName);\n}\n" +
      "export function startWorker(name: string) {\n  return new Worker(name, handler);\n}\n",
    'src/imported.ts':
      "import { Queue } from 'bullmq';\nimport { jobsName } from 'shared-config';\n" +
      'export const jobs = new Queue(jobsName);\n',
  });
  assert.deepEqual(f.queues.map((q) => `${q.name} ${ev(q)}`), ['src/factory src/factory.ts:9'], 'only the Worker takes its file name');
  assert.deepEqual(f.queues[0].workers.map((w) => `${w.handler} ${ev(w)}`), ['handler src/factory.ts:9']);
  assert.equal(f.skipped.queues, 3, 'new Queue(name), new Queue(queueName) and new Queue(jobsName) are counted, never guessed');
});

// P13.6: Knex migrations are a static schema source too (the database file is not in the checkout): a createTable
// is a table row with the fields its callback declares, an alterTable of a table a migration created adds its columns.
test('nb16 Knex migrations: createTable (chained or not) gives a knex table with fields, PK and FK from references/inTable/foreign; a later alterTable adds its columns; a table another ORM declares is not repeated', () => {
  const f = memFrag({
    'db/migrations/20240101_init.js':
      'exports.up = function (knex) {\n' +
      '  return knex.schema\n' +
      "    .createTable('users', (t) => {\n" +
      "      t.increments('id');\n" +
      "      t.string('email', 120).notNullable();\n" +
      "      t.integer('team_id').unsigned().references('id').inTable('teams');\n" +
      '    })\n' +
      "    .createTable('teams', function (table) {\n" +
      "      table.uuid('id').primary();\n" +
      "      table.text('name');\n" +
      "      table.integer('owner_id').references('users.id');\n" +
      '      table.timestamps(true, true);\n' +
      '    });\n' +
      '};\n' +
      "exports.down = function (knex) { return knex.schema.dropTable('teams').dropTable('users'); };\n",
    'db/migrations/20240201_seen.js':
      'export async function up(knex) {\n' +
      "  await knex.schema.alterTable('users', (t) => {\n" +
      "    t.timestamp('seen_at');\n" +
      "    t.integer('badge_id');\n" +
      "    t.foreign('badge_id').references('id').inTable('badges');\n" +
      '  });\n' +
      '}\n' +
      'export async function down(knex) {}\n',
    'db/migrations/20240301_lone.js':
      "exports.up = (knex) => knex.schema.createTable('badges', (t) => { t.increments('id'); t.string('label'); });\n",
    'db/schema.ts': "import { pgTable, serial } from 'drizzle-orm/pg-core';\nexport const badges = pgTable('badges', { id: serial('id').primaryKey() });\n",
    'db/migrations/20240401_dynamic.js': "exports.up = (knex) => knex.schema.createTable(NAME, (t) => { t.increments('id'); });\n",
  });
  const knex = f.entities.filter((e) => e.orm === 'knex');
  const rows = knex.map((e) => `${e.table} | ${e.fields.map((x) => `${x.name} ${x.type}${x.pk ? ' pk' : ''}${x.fk ? ` fk=${x.fk}` : ''}`).join(' | ')} @${ev(e)}`);
  assert.deepEqual(rows, [
    'users | id increments pk | email string | team_id integer fk=teams.id | seen_at timestamp | badge_id integer fk=badges.id @db/migrations/20240101_init.js:3-7',
    'teams | id uuid pk | name text | owner_id integer fk=users.id | created_at timestamp | updated_at timestamp @db/migrations/20240101_init.js:8-13',
  ], 'badges is the drizzle table\'s, not repeated; a computed table name is skipped');
  assert.equal(f.skipped.entities, 1);
});
