# node-api (test fixture)

This directory is a **test fixture** for `scripts/lib/prescan/node-backend.mjs`. It is not a real application.
Everything in it is fictional (a made-up online bookshop called Inkwell Books), nothing here is meant to be built
or run, and the files are only ever read as text by the pre-scan tests.

`src/sidefx.ts` is a canary: importing or running it would write `EXECUTED.txt` and throw. The tests assert the
extractor never does.

One realistic example of each pattern the Node backend extractor looks for:

| Pattern | File |
| --- | --- |
| NestJS controller and module | `src/books/` |
| NestJS bootstrap (global prefix) | `src/main.ts` |
| Express app and router (mounted with `app.use`) | `src/express/` |
| Hono app and sub-app (mounted with `app.route`) | `src/hono/app.ts` |
| Prisma models | `prisma/schema.prisma` |
| TypeORM entities | `src/entities/` |
| Drizzle tables and relations | `src/db/schema.ts` |
| OpenAPI document | `openapi.yaml` |
| BullMQ queue, producer and worker | `src/queues/` |

The Express, Hono and NestJS apps sit side by side only so one fixture covers all three; a real project would
pick one. The unresolvable names in `src/books/books.controller.ts`, `src/express/orders.router.ts`,
`src/hono/app.ts`, `src/db/schema.ts` and `src/queues/email.producer.ts` exist to exercise the `skipped` tally.
