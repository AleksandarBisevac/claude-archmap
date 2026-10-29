# Schema introspection

Static schema sources come first (ORM models, migrations, DDL, Pydantic or OpenAPI): they give `declared` fields.
Introspection adds `observed` fields from a live database. It is optional, read-only and bounded by the rules below.

## Rules

- **Read-only.** Open every database read-only. Run no statement that writes, alters, vacuums, attaches or installs.
- **Schema only, never rows.** Read table, column, type, key and index metadata. Never SELECT rows from a user table,
  never `COUNT(*)`, `LIMIT` sample or preview data. Rows may hold personal data and are not part of the model.
- **No shipped driver.** The plugin ships no database driver. Use the `duckdb` or `sqlite3` command-line tools, or the
  project's own Python (`python3 -I -c` with the driver it already depends on). Never `pip install` or `npm install`
  anything. Never execute the scanned project's own code (no importing its modules, no running its scripts or
  migrations); only open the database file with a tool.
- **Only files found in the repo.** Prescan lists database files (`*.duckdb`, `*.db`, `*.sqlite`, `*.sqlite3`) in
  `sources` as listed, never opened. You open them here, one by one.
- **Remote databases need an explicit opt-in.** A remote database is touched only when the user passed
  `--db <dsn>` explicitly. Use read-only credentials and query `information_schema` only (`tables`, `columns`,
  `table_constraints`, `key_column_usage`, `statistics`). Never read the DSN from the project's environment or config
  on your own, never print or store it, and never put it in the model.
- **Record every skip.** If a step is not run (no CLI available, file locked, file empty or encrypted, remote not
  requested, not read-only), add an entry to `meta.sources` with `status: "skipped"` and the reason. A skipped step is
  recorded, never dropped. A step that ran is recorded with `status: "ok"` and the path.

## SQLite

```sh
sqlite3 -readonly path/to/app.db ".tables"
sqlite3 -readonly path/to/app.db ".schema"
sqlite3 -readonly path/to/app.db "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
sqlite3 -readonly path/to/app.db "PRAGMA table_info('orders'); PRAGMA foreign_key_list('orders'); PRAGMA index_list('orders')"
```

`sqlite_master` and `PRAGMA` return metadata only. Do not run `SELECT * FROM orders`.

## DuckDB

A DuckDB file held by a running server holds a write lock, and opening it can fail or disturb the server. Copy it to a
temp file first, then open the copy read-only. Copy the `.wal` file beside it if one exists.

```sh
tmp="$(mktemp -d)" && cp path/to/app.duckdb "$tmp/app.duckdb"
duckdb -readonly "$tmp/app.duckdb" -c "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('information_schema','pg_catalog') ORDER BY 1, ordinal_position"
duckdb -readonly "$tmp/app.duckdb" -c "SELECT * FROM duckdb_constraints()"
duckdb -readonly "$tmp/app.duckdb" -c "SELECT * FROM duckdb_indexes()"
```

Delete the temp copy when done. Do not open the original while a server may be running.

## Via the project's own Python

When no CLI is installed, use the interpreter the project already uses, reading metadata only. Run it isolated with
`python3 -I -c`: plain `python -c` puts the current directory first on `sys.path`, so a `duckdb.py` or `sqlite3.py`
in the analysed repo would be imported and executed, which breaks the rule above. `-I` drops the current directory and
the `PYTHON*` environment variables from the import path. Point it at the temp copy (`$tmp` from the DuckDB section),
never at the original:

```sh
python3 -I -c "import sys, duckdb; c=duckdb.connect(sys.argv[1], read_only=True); print(c.execute('SELECT table_name, column_name, data_type FROM information_schema.columns').fetchall())" "$tmp/app.duckdb"
```

If the module is not importable under `-I`, skip and record it; do not install it and do not drop `-I` to make it
import.

## Remote database (explicit only)

```sh
psql "<dsn from --db>" -c "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'"
```

Only `information_schema` and only with `--db <dsn>`. Never use a client the user did not already have.

## Turning output into the model

- Each table or view becomes an entity (`kind` is `table` or `view`) with `fields` marked `provenance: observed`.
  Merge with the declared entity of the same name; where the live schema and the model disagree, keep both facts
  (the declared field and an observed one) and note the drift.
- Foreign keys read from constraints become relations with `kind: fk`; an unenforced name match is `name-convention`
  with `provenance: inferred`.
- Cite the evidence as the database file path and, if the tool gave one, the DDL line; otherwise cite the file that
  creates the store in code.
- Fictional example: `data/shop.duckdb` lists `orders(id, customer_id, total)`. Static models declared `id` and
  `total`; add `customer_id` as `observed` and record `{kind: "duckdb", path: "data/shop.duckdb", status: "ok"}` in
  `meta.sources`. If the `duckdb` CLI is missing, record `{kind: "duckdb", path: "data/shop.duckdb", status: "skipped", reason: "duckdb CLI not installed"}`.
