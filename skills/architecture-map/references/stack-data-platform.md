# Stack reference: data-platform

Covers data platform projects built with dbt: a `dbt_project.yml` with SQL models and schema files. Prescan detects it
from the file name `dbt_project.yml` alone and runs `scripts/lib/prescan/data-platform.mjs` (also
`stacks/data-platform.mjs`). The output is `extracts.data-platform`. The scanned files are only ever read as text; never
run `dbt` (`run`, `build`, `compile`, `test`, `docs`), a warehouse client or a macro, and never open `profiles.yml`,
`target/`, `dbt_packages/`, `logs/` or any `.env` file: they hold connection values and compiled output, and prescan does
not read them either.

## What prescan already extracts

All items carry `evidence: [{path, lines}]`, sorted by path then line, capped per kind (see `truncated`). `scope` is the
directory of the project (`.` for the repo root) and `project` its `name`; a repo can hold several projects.

| Kind | What it holds |
|---|---|
| `models` | One item per `*.sql` file under the project's model paths (`model-paths`, default `models`): `name` (the file name), `layer` (the directory below the model path, such as `staging` or `marts/core`, else null) and `materialization`. The materialization follows dbt's precedence: `config(materialized=...)` in the file, then the model's `config:` in a schema file, then the `models:` block of `dbt_project.yml` folder by folder, then `view`. Evidence is the file. |
| `sources` | One item per table under `sources:` in a schema `.yml`: `source`, `name` and `address` (`source.table`). Evidence is the table entry. No description, column or freshness text is extracted. |
| `tests` | One item per entry of a `tests:` or `data_tests:` list on a model, a model column, a source table or a source table column: `name` as written (`unique`, `not_null`, `relationships`, a package test), `target` (a model name or a source address), `targetKind` (`model` or `source`) and `column` (null for a test on the whole model or table). Arguments such as accepted values or a relationship target are not extracted. Evidence is the list entry. |
| `lineage` | One edge per upstream and model pair read from the `ref()` and `source()` calls inside the model's Jinja: `from` (the upstream model name or source address), `fromKind` (`model` or `source`), `to` (the model that holds the call) and `via` (`ref` or `source`). Evidence is one entry per line that holds a call, at the line the call starts on. |
| `skipped`, `truncated` | `skipped.references` counts calls whose target the project does not declare (an unknown model or source, a package ref to another package, a name that is a variable), `skipped.tests` the tests on a model no `.sql` file declares; `truncated` counts items dropped by the cap. |

Calls are read only from Jinja expressions and statements. A call inside a SQL comment (`--`, `/* */`) or a Jinja
comment (`{# #}`), or written outside `{{ }}` and `{% %}`, is not an edge. A two-argument `ref('package', 'model')` is an
edge only when the package is the project itself.

## What you must still read yourself

1. **Nodes.** A model is not an architecture node by itself, and a repo of fifty models is not fifty nodes. Group the
   models by `layer` and by what they hold: a source table the project reads is the border of the system (a `store` node
   or an external system, cited at the `sources` evidence), the warehouse the models build into is one `store` node, and
   a layer (`staging`, `intermediate`, `marts`) is a group, not a node. Name the few models that are an output others
   consume (the ones that no other model reads, or that an exposure, a dashboard or a job names) and cite the file lines.
2. **Edges.** `lineage` is data flow, not a call, and the taxonomy has no relation of its own for it. A model that reads a
   source table or another model runs SQL against the warehouse: type the edge `sql` between the nodes that hold them,
   and cite the line of the call. Collapse the edges of one layer into one edge between the groups when the
   individual ones add nothing, and say so in `notes`. A `source` edge crosses the project border: the producer is whatever
   loads that table, which is outside the checkout unless a job, an ingestion config or another extract names it; do not
   invent it.
3. **Materialization.** `view`, `table`, `incremental`, `ephemeral` and `materialized_view` say how a model is stored and
   refreshed. An `ephemeral` model is never a table: do not draw it as a store. `incremental` and `table` models are the
   ones that persist data; write that in the node's `notes`.
4. **Tests.** A test is a data quality check, not a component. Use the tests on a model (`unique`, `not_null`,
   `relationships`) as evidence of its grain and keys when you describe it, and name a source with no tests as a gap when
   it matters for the path you trace. Singular tests (`tests/*.sql`), unit tests and `exposures:` are not extracted: read
   them when the path goes through them.
5. **Not followed.** Macros (`macros/`), `{% set %}` and `{% for %}` that build names, `var()` and `env_var()` values,
   `seeds/`, `snapshots/`, Python models, `packages.yml` and the compiled `target/` output are not read. A model built
   from a macro call can hide a `ref`; read the macro when a model has no lineage and plainly must have an input.
6. **Credentials.** The warehouse, schema and account come from `profiles.yml` or the environment and are outside the
   checkout. Never write a host, account, user, password, token or key; name the platform only when a cited file says so.

## Fictional example

`models/staging/stg_orders.sql:1-5` is a model in the `staging` layer, a `view` because `dbt_project.yml:9-10` sets
`+materialized: view` for that folder. It reads the `shop.orders` source at `:5`. `models/marts/orders_enriched.sql:1-7`
is `incremental` (its own `config()` at `:1`) and reads `stg_orders` at `:6` and `stg_customers` at `:7`;
`models/marts/customer_summary.sql:1-5` is a `table` that reads `orders_enriched` at `:4`. You emit a `store` node for the
warehouse the marts build into, citing the two mart files, an edge from the `shop` source system's node to it typed from
the source edges (`confidence: inferred`, as no loader is in the checkout) and one edge group for the staging layer in
`notes`.
`models/staging/_models.yml:8-9` holds the `unique` and `not_null` tests on `stg_orders.order_id`: cite them when you say
that the order id is the grain of the staging model.
