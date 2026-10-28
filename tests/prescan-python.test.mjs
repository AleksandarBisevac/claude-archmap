import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (py1..py8) lead every title so the suite prints them first.
// The python stack plug-in of prescan, run on the fictional bookshop fixture in
// tests/fixtures/repos/python-api/ (read as text only - the extractor must never import it).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'repos', 'python-api');
const PY_MODULE = join(ROOT, 'scripts', 'lib', 'prescan', 'python.mjs');
const { default: pythonExtractor, extractPython } = await import(pathToFileURL(PY_MODULE).href);

const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });

const fixtureFiles = walk(FIXTURE).sort();
const fixtureRead = (p) => readFileSync(join(FIXTURE, p), 'utf8');
const frag = extractPython(fixtureFiles, fixtureRead);
const memFrag = (files) => extractPython(Object.keys(files).sort(), (p) => files[p] ?? null);

const KINDS = ['entities', 'httpCalls', 'migrations', 'routes', 'schemas', 'sqlTables'];
const pick = (items, keys) => items.map((i) => Object.fromEntries(keys.map((k) => [k, i[k]])));
const ev = (i) => `${i.evidence[0].path}:${i.evidence[0].lines}`;

test('py1 routes: FastAPI and Flask decorators and Django urls, with method, full path and line evidence', () => {
  const got = frag.routes.map((r) => `${r.framework} ${r.method} ${r.url} ${r.handler} ${ev(r)}`);
  assert.deepEqual(got, [
    'flask GET /admin/stock stock app/admin.py:7-8',
    'flask POST /admin/stock stock app/admin.py:7-8',
    'flask GET /admin/orders/<int:order_id> order app/admin.py:12-13',
    'flask GET /admin/ping ping app/admin.py:17-18',
    'fastapi GET /health health app/main.py:12-13',
    'fastapi GET /api/v1/books list_books app/main.py:17-18',
    'fastapi POST /api/v1/books create_book app/main.py:22-27',
    'fastapi GET /api/v1/books/{book_id} get_book app/main.py:31-32',
    'fastapi DELETE /api/v1/items/{item_id} delete_item app/main.py:36-37',
    'django ANY /catalog/ views.catalog shop/urls.py:9',
    'django ANY /catalog/<int:pk>/ views.catalog_detail shop/urls.py:10',
    'django ANY ^authors/(?P<slug>[\\w-]+)/$ views.author shop/urls.py:11',
    'django ANY /old/legacy/ views.legacy shop/urls.py:13',
  ]);
});

test('py2 entities: SQLAlchemy and Django models with fields, types, PK and FK', () => {
  const byName = Object.fromEntries(frag.entities.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(byName).sort(), ['Author', 'Book', 'Edition', 'Publisher']);
  assert.equal(byName.Author.framework, 'sqlalchemy');
  assert.equal(byName.Author.table, 'authors');
  assert.deepEqual(pick(byName.Author.fields, ['name', 'type', 'pk', 'fk']), [
    { name: 'id', type: 'Integer', pk: true, fk: null },
    { name: 'name', type: 'String(120)', pk: false, fk: null },
  ]);
  assert.equal(byName.Book.table, 'books');
  assert.deepEqual(pick(byName.Book.fields, ['name', 'type', 'pk', 'fk']), [
    { name: 'id', type: 'int', pk: true, fk: null },
    { name: 'title', type: 'str', pk: false, fk: null },
    { name: 'author_id', type: 'int', pk: false, fk: 'authors.id' },
  ]);
  assert.equal(byName.Publisher.framework, 'django');
  assert.equal(byName.Publisher.table, null, 'a Django table name is never guessed from the app label');
  assert.deepEqual(pick(byName.Publisher.fields, ['name', 'type', 'pk', 'fk']), [
    { name: 'name', type: 'CharField', pk: false, fk: null },
    { name: 'country', type: 'CharField', pk: false, fk: null },
  ]);
  assert.equal(byName.Edition.table, 'editions');
  assert.deepEqual(pick(byName.Edition.fields, ['name', 'type', 'pk', 'fk']), [
    { name: 'publisher', type: 'ForeignKey', pk: false, fk: 'Publisher' },
    { name: 'isbn', type: 'CharField', pk: true, fk: null },
    { name: 'printed_on', type: 'DateField', pk: false, fk: null },
  ]);
  assert.ok(!frag.entities.some((e) => e.name === 'Base'), 'a base class without __tablename__ is not an entity');
});

test('py3 schemas: Pydantic models with fields, inheritance followed across the repo', () => {
  assert.deepEqual(
    frag.schemas.map((s) => [s.name, s.bases, pick(s.fields, ['name', 'type'])]),
    [
      ['BookBase', ['BaseModel'], [{ name: 'title', type: 'str' }, { name: 'isbn', type: 'str' }, { name: 'price_cents', type: 'int' }]],
      ['BookIn', ['BookBase'], [{ name: 'author_id', type: 'int' }]],
      ['BookOut', ['BookBase'], [{ name: 'id', type: 'int' }, { name: 'subtitle', type: 'Optional[str]' }]],
    ],
  );
});

test('py4 migrations: Alembic ops with table, revision and direction', () => {
  const rows = frag.migrations.map((m) => `${m.revision}/${m.direction} ${m.op} ${m.table} ${ev(m)}`);
  assert.deepEqual(rows, [
    '0001/upgrade create_table authors migrations/versions/0001_create_books.py:10-14',
    '0001/upgrade create_table books migrations/versions/0001_create_books.py:15',
    '0001/upgrade create_index books migrations/versions/0001_create_books.py:16',
    '0001/downgrade drop_table books migrations/versions/0001_create_books.py:20',
    '0001/downgrade drop_table authors migrations/versions/0001_create_books.py:21',
    '0002/upgrade add_column books migrations/versions/0002_add_isbn.py:12',
    '0002/upgrade alter_column books migrations/versions/0002_add_isbn.py:13',
    '0002/upgrade execute null migrations/versions/0002_add_isbn.py:14',
    '0002/downgrade drop_column books migrations/versions/0002_add_isbn.py:19',
  ]);
  const m1 = frag.migrations.filter((m) => m.revision === '0001');
  assert.equal(m1[0].down_revision, null);
  assert.deepEqual(pick(m1[0].columns, ['name', 'type', 'pk', 'fk']), [
    { name: 'id', type: 'Integer', pk: true, fk: null },
    { name: 'name', type: 'String(120)', pk: false, fk: null },
  ]);
  assert.deepEqual(pick(m1[1].columns, ['name', 'fk']), [{ name: 'id', fk: null }, { name: 'author_id', fk: 'authors.id' }]);
  assert.equal(m1[2].name, 'ix_books_author_id');
  const m2 = frag.migrations.filter((m) => m.revision === '0002');
  assert.equal(m2[0].down_revision, '0001');
  assert.deepEqual(pick(m2[0].columns, ['name', 'type']), [{ name: 'isbn', type: 'String(13)' }]);
});

test('py5 raw SQL tables and outbound HTTP calls', () => {
  assert.deepEqual(
    frag.sqlTables.map((t) => `${t.table} ${t.op} ${ev(t)}`),
    [
      'authors select app/reports.py:6-10',
      'books select app/reports.py:6-10',
      'orders delete app/reports.py:14',
      'order_archive insert app/reports.py:15',
      'orders select app/reports.py:15',
      'stock update app/reports.py:16',
      'books update migrations/versions/0002_add_isbn.py:14',
    ],
  );
  assert.deepEqual(
    frag.httpCalls.map((c) => `${c.client} ${c.method} ${c.url} ${ev(c)}`),
    [
      'requests GET https://isbn.example.invalid/v1/books app/clients.py:11',
      'httpx POST https://courier.example.invalid/api/pickups app/clients.py:16',
      'requests PUT https://isbn.example.invalid/v1/rates app/clients.py:21',
      'requests DELETE https://isbn.example.invalid/v1/cache app/clients.py:22',
      'urllib GET https://status.example.invalid/ping app/clients.py:23',
    ],
  );
});

test('py6 every item carries {path, lines} evidence inside the file, output sorted and deterministic', () => {
  for (const kind of KINDS) {
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
  const again = extractPython(fixtureFiles.slice().reverse(), fixtureRead);
  assert.equal(JSON.stringify(again), JSON.stringify(frag), 'input order does not change the output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(frag)), 'no timestamps');
});

test('py7 unknown patterns are skipped and counted, never guessed; the fragment is size-capped', () => {
  // Fixture tally: Django include(), a bulk_insert whose table is not a literal, an f-string table.
  assert.deepEqual(frag.skipped, { entities: 0, httpCalls: 0, migrations: 1, routes: 1, schemas: 0, sqlTables: 1 });

  const odd = memFrag({
    'svc/odd.py':
      'import requests\nfrom flask import Flask\napp = Flask(__name__)\n\n' +
      '@app.route(PATHS[0])\ndef a():\n    pass\n\n' +
      '@stranger.get("/x")\ndef b():\n    pass\n\n' +
      'def go(u):\n    requests.get(build_url(u))\n    requests.get(f"{BASE}/x")\n\n' +
      'class T(Base):\n    __tablename__ = compute()\n    id = Column(Integer, primary_key=True)\n',
  });
  assert.deepEqual(odd.skipped, { entities: 1, httpCalls: 2, migrations: 0, routes: 2, schemas: 0, sqlTables: 0 });
  for (const k of KINDS) assert.deepEqual(odd[k], [], `${k}: nothing is guessed from unknown shapes`);

  const many = {};
  for (let i = 0; i < 400; i++) many[`m/r${String(i).padStart(3, '0')}.py`] = `from flask import Flask\napp = Flask(__name__)\n@app.get("/r${i}")\ndef h${i}():\n    pass\n`;
  const big = memFrag(many);
  assert.ok(big.routes.length <= 300 && big.routes.length > 0, `routes capped (${big.routes.length})`);
  assert.equal(big.truncated.routes, 400 - big.routes.length);
  assert.equal(big.routes[0].url, '/r0', 'the cap keeps the first items in sort order');
  assert.ok(JSON.stringify(big).length < 200 * 1024, 'fragment stays small');
});

test('py8 nothing is executed or imported from the scanned repo; the plug-in runs inside prescan', () => {
  const canary = join(FIXTURE, 'app', 'EXECUTED.txt');
  assert.ok(!existsSync(canary), 'canary absent before');
  extractPython(fixtureFiles, fixtureRead);
  assert.ok(!existsSync(canary), 'the import-time canary in app/sidefx.py was never run');

  const src = readFileSync(PY_MODULE, 'utf8');
  assert.ok(!/child_process|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|node:vm|node:worker_threads/.test(src), 'python.mjs has no way to run code');

  assert.equal(pythonExtractor.id, 'python');
  assert.equal(pythonExtractor.detect({ files: ['app/main.py'] }), true);
  assert.equal(pythonExtractor.detect({ files: ['web/index.ts'] }), false);

  const dir = mkdtempSync(join(tmpdir(), 'archmap-pyfix-'));
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
      const out = await prescan(dir, { extractors: [pythonExtractor] });
      assert.deepEqual(out.stacks, ['python']);
      assert.equal(JSON.stringify(out.extracts.python), JSON.stringify(frag));
      assert.ok(!existsSync(join(dir, 'app', 'EXECUTED.txt')));
      rmSync(dir, { recursive: true, force: true });
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});
