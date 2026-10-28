# Stack reference: Python backend

Covers FastAPI, Django and Flask; SQLAlchemy, Pydantic and Alembic; DuckDB and SQLite. Prescan detects it from
`pyproject.toml`, `requirements*.txt`, `setup.py`, `Pipfile` or `.py` files, and runs `scripts/lib/prescan/python.mjs`
(also reachable as `stacks/python.mjs`). The output is `extracts.python`. The scanned code is only ever read as text;
never execute, import or run the project, and do not start its server to "see" the routes.

## What prescan already extracts

All items carry `evidence: [{path, lines}]`, sorted by path then line, capped per kind (see `truncated`).

| Kind | What it holds |
|---|---|
| `routes` | FastAPI and Flask decorators (`@app.get`, `@router.post`, `@bp.route`), Django `urls.py` `path(...)` and `re_path(...)`, with method and path. |
| `entities` | SQLAlchemy models (declarative classes and `Table(...)`) and Django models, with `table`, `fields` (`name`, `type`, `pk`, `fk`). |
| `schemas` | Pydantic models with bases and fields. |
| `migrations` | Alembic migration operations (create/drop table, add column, foreign keys). |
| `sqlTables` | Table names found in raw SQL strings. |
| `httpCalls` | Outbound `requests`, `httpx` and `urllib` calls with URL where it is a literal. |
| `skipped`, `truncated` | Counts of recognised shapes it could not resolve statically (a computed path, a dynamic table name) and of items dropped by the cap. |

Trust these as `declared` evidence. Do not re-Grep for decorators it already listed.

## What you must still read yourself

1. **Nodes.** Prescan lists routes, not components. Read the app factory or entrypoint (`main.py`, `app.py`, `manage.py`,
   `asgi.py`, `wsgi.py`) to find `include_router`, `register_blueprint` and `INSTALLED_APPS`, and group routes into
   `route-group` nodes by router or Django app. Read service and repository modules (imports, class headers) to name
   `service` nodes. Read settings files for databases, caches, task queues and third-party base URLs.
2. **Edges.** Prescan has no call graph. Follow each handler's body (a line range around the route) to the service it
   calls, from the service to the repository or session, and from there to the store. Cite the call site. Celery or RQ
   `delay(` and `apply_async` calls are async edges to a `job` node; the task definition is the target.
3. **Entities.** Complete what prescan marked unresolved: mixins and abstract bases (read the base class), Django
   fields declared through helper functions, SQLAlchemy `relationship(...)` and `ForeignKey(...)` targets, association
   tables. A Pydantic schema is not an entity unless it maps a table; use it to confirm field names and types, and
   tag them `declared`. Alembic revisions give the latest column set when models are split or generated; read the head
   revision, not the whole history.
4. **Access.** For each service or handler, find the session or ORM calls that touch an entity: `session.add`,
   `query(`, `select(`, `.objects.create`, `.filter`, `.update`, `.delete`, `execute("INSERT ...")`. Map to CRUD letters
   and cite the line. A repository class that wraps the model gives the access row for its callers too.
5. **File databases.** DuckDB and SQLite files appear in prescan `sources` as listed, never opened. Observe their
   schema with the read-only recipes in schema-introspection.md, and record `provenance: observed` for the fields
   you read live. Where a store is created in code (`duckdb.connect("data/app.duckdb")`, `sqlite3.connect`,
   `sqlalchemy.create_engine`), cite that line for the store node.
6. **Externals.** `httpCalls` gives literal URLs only. Read client wrapper modules for base URLs set from settings or
   environment variable names, and cite the variable name, never its value.

## Fictional example

A repo `shop-api` has `app/main.py` calling `include_router(orders.router)`. Prescan lists `POST /orders` at
`app/routers/orders.py:18` and a SQLAlchemy `Order` entity. You read `orders.py:18-40`, see `OrderService.create`, read
`app/services/orders.py:12-30` where `session.add(Order(...))` appears, and emit: a `route-group` node, a `service` node,
an edge `calls` between them, an `Order` entity if missing fields, and an access row `{node: orders-service, entity: order, ops: "C"}`.
