# Stack reference: Node/TypeScript backend

Covers NestJS, Express and Hono; Prisma, TypeORM and Drizzle; OpenAPI documents; and BullMQ and other queues. Prescan
detects it from `package.json` dependencies and server-style files, and runs `scripts/lib/prescan/node-backend.mjs`
(also `stacks/node-backend.mjs`). The output is `extracts.node-backend`. The scanned code is only ever read as text;
never execute, import, build or start the project, run migrations, or invoke `prisma` or `drizzle-kit`.

## What prescan already extracts

All items carry `evidence: [{path, lines}]`, sorted, capped per kind (see `truncated`).

| Kind | What it holds |
|---|---|
| `routes` | NestJS controllers (`@Controller` prefix plus method decorators), Express and Hono routers with router mounts resolved, method and full path. Only string literals and single-literal constants are resolved. |
| `entities` | Prisma models, TypeORM entities and Drizzle tables, with fields, PK, FK and relations. |
| `openapi` | OpenAPI/Swagger documents (YAML or JSON): operations, capped. |
| `queues` | BullMQ queues with their producers (`queue.add`) and workers (`new Worker`). |
| `skipped`, `truncated` | Computed paths, variable queue names, and items dropped by the cap. |

## What you must still read yourself

1. **Nodes.** Prescan lists routes, not components. Read the bootstrap (`main.ts`, `server.ts`, `app.ts`, `index.ts`) for
   the app node, global prefixes, middleware and listen port. For NestJS read module files (`@Module` imports,
   `providers`, `controllers`): one module is one `module` node, and its providers are `service` nodes. For Express
   and Hono group routers by mount point into `route-group` nodes. Read config for databases, caches and external
   base URLs, citing environment variable names, never values.
2. **Edges.** Prescan has no call graph. Follow each controller or handler to the service it injects or imports
   (NestJS constructor parameters, Express handler imports), then to the repository, ORM client or queue. Cite the
   injection or call line. A `queue.add` producer and its `Worker` are joined by an async edge through the queue node;
   cross-check the queue name literal and mark variable names `inferred`.
3. **Entities.** Complete what prescan could not resolve: Prisma `@@map`/`@map` table names, enums, TypeORM
   embedded and inherited columns, Drizzle `relations(...)` helpers and `references(...)` targets, join tables for
   many-to-many. Prisma `schema.prisma` and Drizzle schema files are `declared`; for a live SQLite or DuckDB file
   use schema-introspection.md and tag `observed`. Compare an OpenAPI schema with the entity only to confirm field
   names; an API schema is not an entity.
4. **Access.** Map handlers and services to CRUD letters from ORM calls: Prisma `create`, `findMany`, `update`,
   `delete`, `upsert` (C and U); TypeORM repository `save`, `find`, `remove`; Drizzle `insert`, `select`,
   `update`, `delete`; raw `query(` strings. Cite the call line. Transactions touching several entities yield one
   access row per entity.
5. **OpenAPI.** When a spec exists, use it as the declared contract for route groups and external APIs, but verify
   that a handler for each operation exists in code before giving an edge `confidence: verified`. A spec that
   documents a path with no handler is a coverage note in `skipped`.
6. **Other queues.** Prescan only models BullMQ. For other queues (SQS, Kafka, RabbitMQ, NATS) use the generic
   recipe in discovery-generic.md: Grep for `publish`, `subscribe`, `sendMessage`, `consumer`.

## Fictional example

`ledger-svc` has a NestJS `InvoicesController` (prescan `GET /invoices`, line 14). You read the controller lines
10-40, see `InvoicesService` injected, read `invoices.service.ts:20-60`, find `this.prisma.invoice.findMany(...)` and
`reportQueue.add('render', ...)`. Emit a `calls` edge controller to service, an access row
`{node: invoices-service, entity: invoice, ops: "R"}`, and an async edge to the `report-render` queue node, each with its
line range.
