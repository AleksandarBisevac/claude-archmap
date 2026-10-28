import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

test('nb6 unknown patterns are skipped and counted, never guessed; the fragment is size-capped', () => {
  // Fixture tally: @Get(CONST), get(CONST), express .route(path) chain, a template path in Hono,
  // a pgTable whose name is not a literal, a queue.add whose job name is a variable.
  assert.deepEqual(frag.skipped, { entities: 1, openapi: 0, queues: 1, routes: 4 });
  assert.deepEqual(frag.truncated, { entities: 0, openapi: 0, queues: 0, routes: 0 });

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
  assert.deepEqual(odd.skipped, { entities: 1, openapi: 2, queues: 2, routes: 1 });
  for (const k of KINDS) assert.deepEqual(odd[k], [], `${k}: nothing is guessed from unknown shapes`);

  const lines = ["import express from 'express';", 'const app = express();'];
  for (let i = 0; i < 400; i++) lines.push(`app.get('/r${String(i).padStart(3, '0')}', h);`);
  const big = memFrag({ 'm/routes.ts': lines.join('\n') + '\n' });
  assert.ok(big.routes.length <= 300 && big.routes.length > 0, `routes capped (${big.routes.length})`);
  assert.equal(big.truncated.routes, 400 - big.routes.length);
  assert.equal(big.routes[0].url, '/r000', 'the cap keeps the first items in sort order');
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
