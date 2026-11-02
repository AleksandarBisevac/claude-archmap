# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The release benchmark, `skills/architecture-map/evals/BENCHMARK.md`: 1.0.0 against three other mapping plugins on the same prompt and repositories, every figure derived by a test from the tracked profiles.
- Four prescan extractors for the parts of a system that are not application code, each with `file:line` evidence, confidence and provenance like every other node, a fixture repository under `tests/fixtures/repos/` and a prescan test: containers (Dockerfiles and compose files: services, images, ports, volumes and the dependencies between services), pipelines (GitHub Actions and Azure Pipelines: workflows, jobs, triggers, stages and the artefacts they pass on), infrastructure as code (Terraform and Bicep: resources, modules and the references between them) and data platform projects (dbt models, sources and tests, with lineage from `ref()` and `source()` calls). They are wired into stack detection, area partitioning, the fragment merge, the taxonomy, the viewer and the exports; an area's stacks include the platform stacks detected inside it; the schema gains the edge types `depends`, `lineage` and `artifact`, additive, so every committed map still validates.
- Entity fields are read from static schema sources (ORM models, migrations, DDL) when introspection is skipped or no database file is in the checkout, with `declared` provenance; richer relations: ORM call access rows and sql edges, queue pairing, and `nodesWithoutEdges` in the synthesizer's digest.
- The flow player on the Sequences tab (Play on graph) for sequences whose participants name graph nodes, and draft sequences for HTTP responses, queues and pulls.
- A mixed-platform fixture (a Node API, a compose file, a GitHub Actions workflow, a Terraform module and a dbt project), the end-to-end case e6 over it and a tracked build cost profile, `skills/architecture-map/evals/evidence/iteration-3/mixed-with-skill-1.json`.
- The skill description and the README (What a build delivers) name the four new node kinds: compose services, pipelines and jobs, IaC resources, and dbt models and sources.

### Fixed

- BUG-5-6o1: an edge written to an area whose evidence lines name a file that exactly one node of that area owns now targets that node, not the area hub, so the SessionStart hook edge in the committed map reaches the node that holds `scripts/staleness.mjs`; the committed map is rebuilt at the fix: 43 nodes, 25 edges, 1 entity, 4 sequences and 6 views.
- The three low findings of the benchmark phase re-review: P12-R5, `BENCHMARK.md` and `PROTOCOL.md` cite where the confirmation of the rubric scores is recorded instead of asserting it; P12-R6, `scripts/cost-profile.mjs` replaces a description-derived label that holds a path-like token, a quoted string or more than a few words with a redacted label, so no repository text lands in a tracked profile; P12-R7, the tracked grader is run over every benchmark cell and its agreement with the recorded grading is kept as counts in `skills/architecture-map/evals/evidence/benchmark/grader-equivalence.json`, which the report cites.
- The roadmap item v1.1 is closed on 2026-11-03 with its evidence. The version bump and the tag are the owner's decision.

## [1.0.0] - 2026-11-01

The first release: a Claude Code plugin that maps a repository's architecture into one evidence-backed model,
`docs/architecture/architecture.model.json`, and renders it as a self-contained, offline HTML viewer,
`docs/architecture/archmap.html`. Agents read the code and write the model; tested scripts merge, validate, lay out
and draw it. Node.js 18 or later, no npm dependencies (elkjs is vendored).

### Added

#### Commands and the `architecture-map` skill

- Six commands. `/archmap:build` and `/archmap:update` run agents, as does `/archmap:issues`; `/archmap:check`,
  `/archmap:export` and `/archmap:render` are scripts only and spend no tokens.
- `/archmap:build [--issues] [--profile max|balanced|economy] [--db dsn] [--scope path] [--publish]`: the build flow
  of the skill. The orchestrating session is a driver loop: `pipeline.mjs plan` prescans and partitions the repository
  into at most eight areas and prints the explorer calls, one message dispatches them, `pipeline.mjs finish` merges and
  validates and prints the synthesizer call, and `pipeline.mjs render` validates, lays out and renders. Target: at
  most 12 orchestrator turns and a context under 80 K tokens; the session reads no reference, script or agent file
  during a build.
- `/archmap:update [--issues] [--profile ...] [--since sha]`: the update flow re-analyses only the areas git says
  changed, keeps locked nodes, notes and pinned positions, keeps unchanged elements byte-identical, and re-renders only
  when nothing is affected.
- `/archmap:issues [--import-audit] [--profile ...]`: the issues flow runs the reviewer over the current model and
  optionally imports the open findings of an audit plan; the overlay is written outside the repository.
- `/archmap:check`: the staleness report as an exit code (0 fresh, 1 stale), for CI.
- `/archmap:render [--internal|--shared]`: re-render from the existing model; the clean build by default.
- `/archmap:export mermaid|plantuml|svg|png|md [--view v]`: exports from the model with no model run (see Scripts).
- The skill's references: the model contract (model schema, relation taxonomy, sequences), the discovery recipes
  (a generic recipe, three stack references and read-only schema introspection) and the architecture-level issues
  catalogue. Its trigger description was optimised against a trigger eval set.

#### Scripts

All scripts are plain Node, deterministic and offline, and none of them executes the code it scans.

- `prescan.mjs`: inventory, stack detection, area partitioning and the generic recipe, with three stack extractors:
  Python backend (FastAPI, Django, Flask; SQLAlchemy, Pydantic, Alembic), TypeScript frontend (React, Next.js,
  React Native; routers; RTK Query, React Query, Redux, Zustand; axios and fetch) and Node backend (NestJS, Express,
  Hono; Prisma, TypeORM, Drizzle; OpenAPI; BullMQ). It lists the tables that SQL in code names (skipping CTE names),
  detects file databases, finds one app per workspace in a monorepo, and skips test data: only fixture directories by
  default, with the count and the directories it skipped reported in the plan.
- `merge.mjs`: explorer fragments and the synthesizer's output into the model, preserving user-authored fields
  (locked nodes, notes, pinned positions). It computes the cross-area edges, the zones, the CRUD rows and the relations,
  makes entities from declared and inferred tables, writes the synthesizer's digest, normalises evidence it can check
  against the repository, and drops a dangling reference with a note instead of refusing the build.
- `validate.mjs`: the JSON Schema subset, referential integrity across nodes, edges, entities, sequences and views,
  and the evidence checks; with `--repo` every `file:line` must exist in the repository.
- `layout.mjs`: build-time ELK layout, persisted in `architecture.layout.json` and fed back as seeds, so only new or
  changed nodes move and pinned nodes stay.
- `render.mjs`: the clean, internal and shared builds of the viewer from one template. The clean build physically
  contains no issue; the shared build carries only the calibrated summary of a security issue.
- `diffmap.mjs`: changed files to the affected areas, nodes, dependents, entities and sequences; it ignores the map's
  own output directory and `docs/audit`.
- `staleness.mjs` and the SessionStart hook: silent when the project has no model, otherwise one line when the model
  is behind HEAD; never runs the model.
- `export.mjs`: Mermaid (flowchart, erDiagram, sequenceDiagram), PlantUML, a Markdown summary and static SVG from the
  model, and PNG when a headless Chromium is present. Exports are always clean. Exit 1 on an invalid model, 2 on usage
  or an unreadable file, 3 when PNG has no Chromium.
- `issues.mjs`: audit import, overlay merge and the write of `issues.json` and `archmap.internal.html` under
  `<home>/.claude/archmap/<repo-slug>/`, outside the repository, with a symlink guard and a calibration lint for
  shared builds.
- `usage.mjs`: the per-phase token and duration ledger, which states what it cannot see.
- `pipeline.mjs`: the driver of build and update (`plan`, `finish`, `render`, and an `issues` step), with read-only
  introspection of file databases through the `sqlite3` or `duckdb` CLI or an isolated Python when one is present, the
  skip recorded in `meta.sources` otherwise, a private work directory and a realpath guard.
- `cost-profile.mjs`: an offline profiler of a headless session's `stream-json` transcript: cost at list prices,
  turns and the largest context per agent, with output tokens reconciled against the result event.

#### Model schema and viewer

- JSON Schemas for the model, the issues overlay and the theme. The model holds nodes at C4 levels 1 to 3, typed
  edges with a confidence of `verified`, `inferred` or `external`, entities with fields, keys and per-field provenance
  (`declared`, `observed`, `inferred`), relations with cardinality, access rows, sequences and views. Every element
  carries `file:line` evidence.
- The viewer: the application graph with responsibility zones, typed relations and a legend that toggles them; the ER
  diagram with field rows, PK and FK markers, crow's-foot cardinality and provenance styling; step-through sequence
  diagrams; the CRUD matrix with click-through between nodes and entities, and the data lineage; the deployment and
  trust-boundary views, chosen by a schema field; search and a path finder; evidence chips that link to the commit.
- A global Issues switch that hides every badge, flag, issue row and step dot.
- One self-contained HTML file that works offline, in light and dark, with fixed colour-blind-safe semantic colours
  and dash patterns, an optional theme file for fonts, chrome and accent, and a minimum legible scale at narrow widths.

#### Agents and profiles

- `archmap-explorer` reads its brief and a prescan extract, writes a capped fragment file and replies in three lines;
  explorers run in parallel, one per area.
- `archmap-synthesizer` writes only the sequences and the views, from the digest that `merge.mjs` prepares.
- `archmap-reviewer` looks for architecture-level issues (security, data, reliability, performance, design, docs),
  each anchored to a node, edge, entity or sequence step, from the model and targeted reads, and writes the issues
  file.
- `--profile` sets the agents' models: `balanced` (the default) runs the explorers and the synthesizer on Sonnet and
  the reviewer on Opus; `max` runs all of them on Opus; `economy` runs the explorers on Haiku and the other two on
  Sonnet.

#### Evals and evidence

- Five evals in the skill-creator format, run on three private repositories that no tracked file names, a trigger
  eval set, and `score-recall.mjs`, which scores an issues overlay against private reference issues.
- The cost profile of every eval run, tracked under `skills/architecture-map/evals/evidence/`, and tests that derive
  every figure of the README and the evals README from those files.
- The measured cost of a build at list prices, in the script-driven flow: 1.16 USD, 11 orchestrator turns and a
  62.9 K context for eval 1, against 13.78 USD, 38 turns and 278.9 K when the orchestrating session held every
  fragment itself; 1.00 USD, 10 turns and 57.6 K for the build of this repository. Eval 2 with `--issues` recalls
  14 of 15 high and medium reference issues (0.93) in each of three runs.

#### The map of this repository

- `docs/architecture/` carries this repository's own map, built by its own skill (balanced profile, no issues) at
  8174e41 and brought up to the release head with `/archmap:update` at 63d7495, committed as the public example:
  34 nodes, 23 edges, 1 entity, 4 sequences and 5 views, validated with `validate.mjs --repo`.

#### Repository

- The plugin manifest, a local development marketplace, the design brief (`docs/design.md`), CI, a test suite of
  more than 400 cases run with `node --test`, an anonymised golden model fixture, a visual check of the golden render,
  and a repository-wide guard that no tracked file carries a term from a private denylist.
