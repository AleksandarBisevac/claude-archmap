import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Case ids (d1, d2, ...) lead every title so the suite prints them first.
// The architecture-map skill's discovery references tell an explorer what prescan already
// extracts per stack and what it must still read itself (docs/design.md D5, D7, section 8).
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const REF = 'skills/architecture-map/references';
const generic = read(`${REF}/discovery-generic.md`);
const python = read(`${REF}/stack-python-backend.md`);
const tsFront = read(`${REF}/stack-ts-frontend.md`);
const nodeBack = read(`${REF}/stack-node-backend.md`);
const introspection = read(`${REF}/schema-introspection.md`);

// A name counts as named when it appears case-insensitively and is not part of a longer word.
const tokenRe = (name) =>
  new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'i');
const missing = (text, names) => names.filter((n) => !tokenRe(n).test(text));

test('d1 stack-python-backend.md names every framework, ORM and store listed for Python', () => {
  assert.deepEqual(
    missing(python, ['FastAPI', 'Django', 'Flask', 'SQLAlchemy', 'Pydantic', 'Alembic', 'DuckDB', 'SQLite']),
    [],
  );
});

test('d2 stack-ts-frontend.md names every framework, router and client library listed for TS frontends', () => {
  assert.deepEqual(
    missing(tsFront, [
      'React', 'Next.js', 'React Native', 'RTK Query', 'React Query', 'Redux', 'Zustand', 'axios', 'fetch', 'router',
    ]),
    [],
  );
});

test('d3 stack-node-backend.md names every framework, ORM and queue listed for Node backends', () => {
  assert.deepEqual(
    missing(nodeBack, ['NestJS', 'Express', 'Hono', 'Prisma', 'TypeORM', 'Drizzle', 'OpenAPI', 'BullMQ', 'queue']),
    [],
  );
});

test('d4 each stack reference says what prescan extracts and what the explorer must still read', () => {
  for (const [name, text] of Object.entries({ python, tsFront, nodeBack })) {
    assert.match(text, /prescan/i, `${name}: names prescan`);
    assert.match(text, /scripts\/lib\/prescan/, `${name}: points at scripts/lib/prescan`);
    assert.match(text, /must (still )?read/i, `${name}: says what the explorer must still read`);
    assert.deepEqual(missing(text, ['nodes', 'edges', 'entities', 'access']), [], `${name}: completion targets`);
  }
});

test('d5 schema-introspection.md states read-only and schema-only, never rows', () => {
  assert.match(introspection, /read-only/i);
  assert.match(introspection, /schema only/i);
  assert.match(introspection, /never (read |select |fetch )?rows/i);
  assert.deepEqual(missing(introspection, ['duckdb', 'sqlite3']), []);
});

test('d6 schema-introspection.md has the DuckDB temp-copy rule for a file held by a running server', () => {
  assert.match(introspection, /running server/i);
  assert.match(introspection, /cop(y|ies)[^.]*temp/i);
});

test('d7 schema-introspection.md restricts remote databases to --db <dsn> and information_schema, no driver', () => {
  assert.match(introspection, /--db <dsn>/);
  assert.match(introspection, /information_schema/);
  assert.match(introspection, /explicit/i);
  assert.match(introspection, /no (shipped )?driver/i);
});

test('d8 schema-introspection.md records a skipped step in meta.sources with the reason', () => {
  assert.match(introspection, /meta\.sources/);
  assert.match(introspection, /skipped/i);
  assert.match(introspection, /reason/i);
});

test('d9 discovery-generic.md forbids whole-tree reads and prescribes Grep plus line-range reads', () => {
  assert.match(generic, /never[^.\n]*whole (tree|repo)/i);
  assert.match(generic, /\bGrep\b/);
  assert.match(generic, /line[- ]range/i);
  assert.deepEqual(
    missing(generic, ['entrypoints', 'routes', 'stores', 'queues', 'externals', 'deploy units']),
    [],
  );
});

test('d10 no discovery reference tells the explorer to execute the scanned project, and all say so', () => {
  for (const [name, text] of Object.entries({ generic, python, tsFront, nodeBack, introspection })) {
    assert.match(text, /never (execut|run|import)/i, `${name}: states the never-execute rule`);
  }
});
