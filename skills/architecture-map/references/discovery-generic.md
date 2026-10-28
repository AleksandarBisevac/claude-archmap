# Generic discovery recipe

Use this for any stack prescan does not recognise (Go, Rust, Java, Ruby, PHP, a data platform, a mixed repo), and as the
fallback inside a recognised stack for whatever its extractor skipped. Prescan (`scripts/prescan.mjs`) still gives you
the stack-independent hints for every repo: `entryPoints`, `topLevelDirs`, `containers`, `ci`, `manifests`, and the
`areas` and `sources` lists. Start from those; do not rediscover them.

## Hard rules

- Never read a whole tree and never read a whole large file. Find with Grep, then read a line range around each hit
  (for example 30 to 60 lines). A file is read in full only when it is short and is itself the thing you are modelling.
- Never execute, import, build or run the scanned project: no test runs, no dev servers, no package scripts, no
  migrations. Read text only.
- Every node, edge and entity you emit cites `{path, lines}` that you actually read. If you cannot cite it, count it in
  `skipped` instead.
- Stay inside your area's globs. Edges may point at ids another area owns.

## The recipe

Work in this order. Each step is a small Grep, then line-range reads of the best hits.

1. **Entrypoints.** Start from the prescan `entryPoints` and `manifests`. Read the manifest's scripts, `main`, `bin`,
   `[project.scripts]`, `Procfile` or `Makefile` targets. Grep for the process start: `listen(`, `serve(`, `main(`,
   `ListenAndServe`, `app.run`, `uvicorn`, `if __name__`. One entrypoint is usually one app node.
2. **Routes and handlers.** Grep for the framework's registration idiom: decorators (`@Get`, `@app.route`), router calls
   (`.get(`, `.POST(`, `HandleFunc`), route tables and URL config files. Record method and path per handler; group by
   router or controller into `route-group` nodes rather than one node per endpoint.
3. **Stores.** Grep for connection strings and clients: `DATABASE_URL`, `connect(`, `createPool`, `sqlite`, `duckdb`,
   `redis`, `mongodb`, `s3`, `bucket`. Then find the schema source: ORM models, migration directories, `.sql` files,
   `CREATE TABLE`. One store node per database or bucket, entities under it. Entities need fields; see
   schema-introspection.md for observing a live file database.
4. **Queues and jobs.** Grep for `queue`, `topic`, `subscribe`, `publish`, `consume`, `worker`, `cron`, `schedule`,
   `celery`, `sidekiq`, `kafka`, `sqs`. Producers and consumers become `queue` and `job` nodes joined by async edges
   (see relation-taxonomy.md).
5. **Externals.** Grep for outbound clients and base URLs: `http.Client`, `requests.`, `fetch(`, SDK imports, `https://`
   constants, environment variables ending `_URL`, `_HOST`, `_ENDPOINT`. Each third-party service is one `external`
   node. Never copy a secret value; cite the line that names the variable.
6. **Deploy units.** Read the prescan `containers` and `ci` files (Dockerfile, compose, workflows, pipelines) and any
   `k8s/`, `terraform/`, `serverless.yml` hits. A deploy unit maps to a zone or an app node; note ports, entry commands
   and which paths it builds.
7. **Edges.** For each pair you can connect, find the call site: an import of a client, a call to a route, a publish to a
   queue name. Cite the call site. Use `confidence: verified` only when both ends and the call are read; otherwise
   `inferred`.
8. **Access.** For each service or handler that touches an entity, record the CRUD letters you can see (insert = C,
   select = R, update = U, delete = D) with the line of the query.

## Size discipline

- Grep with `-n` and a file glob, limit hits (`head`), and narrow the pattern rather than widening the read.
- Prefer one targeted Grep per question over listing directories. List a directory only when the hint lists are empty.
- If an area exceeds the fragment caps in model-schema.md, return what you have, split the rest into `skipped`, and say
  so in `skipped.reasons`.
- Report what you did not read: `coverage` lists the globs you read, `skipped` tallies the rest.
