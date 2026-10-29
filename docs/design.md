# archmap — design

> Design brief for the archmap Claude Code plugin. Decisions in §3 are settled; open items are in §13.
> The reference artifact and the evaluation ground truth are private and are not part of this repository.

---

## 1. Context — why this exists
archmap grows out of an interactive architecture artifact Claude produced for a FastAPI + React + DuckDB application
(the *reference artifact*):
- a system / backend / frontend graph with typed, colour-coded relations and responsibility zones;
- 7 step-through sequence diagrams;
- caching, auth and data-pull analysis;
- 25 ranked issues anchored to diagram nodes.

The goal is the **documentation core** of it as a reusable tool for any project. The agent should:
- recognise the architecture, the database structure (entities, fields, keys) and the relationships between them;
- render an interactive application diagram with typed relations, an ER diagram and sequence diagrams;
- optionally overlay problems, with a switch that hides them for a clean graph.

It must **update cheaply on command** when the app changes, and **token spend and model choice matter**.

Not wanted from the original artifact: caching tables, API-surface table, auth tables, key-findings prose.

Lessons from building the artifact:
1. The renderer code was the reusable asset. Hand-placed SVG coordinates were the most expensive and fragile part. Hence a
   data model with a fixed renderer and automatic, *stable* layout.
2. Evidence (`file:line`) on every element is what made the output trustworthy. Keep it mandatory.
3. Separating "inferred / outside repo" from "verified in code" (dashed zones) prevented over-claiming.

## 2. Prior art and differentiation (research done 2026-10-28; details in §14)
No existing tool does all of this in one model. Each capability exists somewhere, spread across many projects.
**Decision D13 (user, after reviewing the research): build archmap as planned.** It ships its own model, viewer, exporters and
introspection recipes, with no runtime dependency on external tools and no exploratory spike. The research stays as
positioning for the README and as a source of design ideas, not dependencies (§14.3).

What archmap combines that nothing else does:
- one evidence-carrying model that links C4-style components, the tables they read or write (CRUD matrix and lineage), the ER diagram,
  sequences, and deployment and trust views;
- an ER that reconciles ORM, migrations, DDL and read-only DB introspection, with per-field provenance;
- an architecture-level issues layer that can be switched off;
- git-diff incremental updates with a layout that stays stable;
- fully offline, self-contained HTML.

## 3. Decisions (settled with the user — do not reopen)
| # | Decision |
|---|---|
| D1 | **Model + renderer.** The agent writes only `architecture.model.json`. A bundled, tested renderer turns it into HTML. |
| D2 | The model and a clean `archmap.html` are committed under `docs/architecture/` of the analysed project. Issues are a separate overlay outside the repo: `~/.claude/archmap/<repo-slug>/issues.json` and `archmap.internal.html`. **The issue pass is opt-in by flag.** |
| Req | **Update on command.** The model stores the analysed commit and the evidence paths. `update` re-analyses only areas whose files changed. |
| D3 | v1 views: application graph (C4 levels 1-3, zoom, typed relations), ER (fields, PK/FK, cardinality), sequence diagrams, issues layer with on/off toggle, evidence on every element, CRUD matrix + data lineage, path finder + search, deployment + trust-boundary views, exports (Mermaid, PlantUML, SVG/PNG, Markdown summary). |
| D4 | Issues are **architecture-level**, visible through structure and relations, not line-level review. Categories: security, data, reliability, performance, design, docs. Severity high/med/low. Each issue is anchored to a node, edge, entity or sequence step. Security has two levels: full `detail` internal only, and a calibrated `summary/impact/fix` for shared builds. If `docs/audit/audit-plan.json` exists, its findings are importable. |
| D5 | Schema sources: always static (ORM models, migrations, DDL, Pydantic/OpenAPI, queries in code). Automatic **read-only** introspection of file DBs found in the repo (SQLite, DuckDB): schema only, never rows. A DuckDB file held by a running server is copied to a temp file first. A remote DB only with explicit `--db <dsn>`, read-only, `information_schema` only. Provenance per field: `declared` / `observed` / `inferred`. The plugin ships no DB driver; it uses `duckdb` / `sqlite3` CLIs or the project's own Python. If none is available, the step is skipped and recorded in `meta.sources`. |
| D6 | Layout is **build-time ELK** (elkjs vendored, run in Node). Positions are persisted in `docs/architecture/architecture.layout.json` and fed back as seeds, so only new or changed nodes move. Nodes can be pinned. The HTML is self-contained and offline. |
| D7 | v1 stack references: **Python backend** (FastAPI, Django, Flask; SQLAlchemy, Pydantic, Alembic; DuckDB/SQLite), **TypeScript frontend** (React, Next.js, React Native; routers; RTK Query, React Query, Redux, Zustand; axios/fetch), **Node/TS backend** (NestJS, Express, Hono; Prisma, TypeORM, Drizzle; OpenAPI; BullMQ/queues). Any other stack uses the generic recipe. **v1.1:** data platforms + infra (Palantir Foundry transforms/RIDs/ontology, dbt, Docker/compose, GitHub Actions/Azure Pipelines, Terraform/Bicep). |
| D8 | A Claude Code **plugin** named **`archmap`**, in its own repo **`AleksandarBisevac/claude-archmap`**. It is listed in the existing `quality-gates` marketplace (`AleksandarBisevac/claude-plugins`) through one entry with a github `source`. Install: `/plugin install archmap@quality-gates`. Do not put it inside the claude-plugins repo: that repo's tooling (`tools/verify.sh`, `release.py`, `sweep-selftests.py`, lints) hardcodes `plugins/audit` and enforces Python-3.8-stdlib scripts. The inner skill is `architecture-map`. |
| D9 | Three private eval repos: a FastAPI + React + DuckDB app (ground truth = the reference artifact), a Hono + Drizzle/Postgres + Better Auth + BullMQ + Next monorepo, and a Next + Drizzle admin API + MCP demo. Paths and ground truth live outside this repository. |
| D10 | Neutral theme (the reference artifact's look), with an optional `docs/architecture/archmap.theme.json` for fonts, chrome and accent. Relation, zone and severity colours are **fixed and semantic**, colour-blind-safe with dash patterns, in light and dark. |
| D11 | **Token economy, balanced profile by default.** Deterministic pre-scan (0 tokens). `archmap-explorer` on Sonnet medium in parallel, reading excerpts and returning JSON fragments. `archmap-synthesizer` and `archmap-reviewer` on Opus high, fed fragments and the model only. Scripts do layout, render, validate, diffmap and export. `--profile max\|balanced\|economy`. A per-phase token/duration ledger is printed at the end. |
| D13 | **Build everything in-house, as planned.** The prior-art research (§2, §14) does not change scope: own exporters, own introspection recipes, no external tool dependencies, no exploratory spike. Borrow techniques only (§14.3). |
| D12 | **Staleness:** a SessionStart hook (Node script, 0 tokens) is silent when the project has no model. Otherwise it compares `meta.commit` to HEAD through diffmap and prints one line, e.g. `Architecture map is 12 commits behind (3 nodes, 1 entity affected) — run /archmap:update`. `/archmap:check` returns an exit code (CI later). The LLM is never auto-run. |

## 4. Repository layout (`claude-archmap`; the plugin lives at the repo root)
```
.claude-plugin/plugin.json          name archmap, version, description, author, repository, license MIT, keywords
.claude-plugin/marketplace.json     dev marketplace (source "./") so `/plugin marketplace add <path>` works locally
commands/
  build.md    /archmap:build  [--issues] [--profile p] [--db dsn] [--scope path] [--publish]
  update.md   /archmap:update [--issues] [--profile p] [--since sha]
  check.md    /archmap:check                 (script only; exit 0 fresh / 1 stale)
  issues.md   /archmap:issues [--import-audit] [--profile p]
  export.md   /archmap:export mermaid|plantuml|svg|png|md [--view v]
  render.md   /archmap:render [--internal|--shared]   (no LLM)
skills/architecture-map/
  SKILL.md                         workflow, model contract, evidence rules, token rules (≤ 500 lines)
  references/
    model-schema.md  relation-taxonomy.md  discovery-generic.md
    stack-python-backend.md  stack-ts-frontend.md  stack-node-backend.md
    schema-introspection.md  issues-catalog.md  sequences.md
agents/
  archmap-explorer.md      model: sonnet  effort: medium  tools: Read, Grep, Glob, Bash
  archmap-synthesizer.md   model: opus    effort: high    tools: Read, Grep, Glob
  archmap-reviewer.md      model: opus    effort: high    tools: Read, Grep, Glob
hooks/hooks.json           SessionStart → node "${CLAUDE_PLUGIN_ROOT}/scripts/staleness.mjs"
scripts/                   Node ≥ 18, ESM, zero npm deps (only the vendored elkjs)
  prescan.mjs  validate.mjs  merge.mjs  diffmap.mjs  layout.mjs  render.mjs
  export.mjs   issues.mjs    staleness.mjs  usage.mjs
schema/  archmap-model.schema.json  archmap-issues.schema.json  archmap-theme.schema.json
assets/viewer/  template.html  viewer.js  viewer.css  elk.bundled.js (+ EPL-2.0 notice)
tests/   node:test suites per script + fixtures (incl. the golden model)
docs/    design.md (this plan, trimmed), roadmap.md
README.md  CHANGELOG.md (Keep a Changelog)  LICENSE  .github/workflows/ci.yml
```
Conventions borrowed from the audit plugin: commands call scripts as
`node "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs" $ARGUMENTS`; command frontmatter uses `description`, `argument-hint`,
`allowed-tools` (and `disable-model-invocation: true` for script-only commands); agent frontmatter uses `name`,
`description`, `tools`, `model`, `effort`; hooks always exit 0 and stay silent unless they have something to say.

## 5. The model (`docs/architecture/architecture.model.json`)
- `meta`: `schemaVersion`, `project`, `commit`, `generatedAt`, `repoUrl` (for evidence links), `profile`,
  `sources` (introspections run or skipped, and why), `coverage` (area → globs).
- `zones[]`: `{id, kind: browser|edge|service|data|external|platform|delivery, label, parent?, outside?}`.
- `nodes[]`: `{id, zone, kind (app|module|route-group|service|store|queue|job|external…), title, sub[], role, facts[],
  evidence[{path, lines}], paths[] (owned globs, used by diffmap), level: 1|2|3, locked?, notes?}`.
- `edges[]`: `{id, from, to, type, label?, desc, evidence[], confidence: verified|inferred|external, async?}`.
  The types come from the artifact (`api, static, auth, pull, sql, cache, persist, call, link, deploy`) plus `event`/`queue`.
- `entities[]`: `{id, store, name, kind: table|view|collection|dataset, fields[{name, type, pk?, fk?{entity, field},
  nullable?, provenance, evidence[]}], indexes[], evidence[]}`.
- `relations[]` (ER): `{from{entity, field}, to{entity, field}, cardinality: 1-1|1-n|n-m, kind: fk|join|name-convention, provenance}`.
- `access[]` (CRUD): `{node, entity, ops ("CRUD" subset), evidence[]}`. Drives the CRUD matrix and lineage.
- `sequences[]`: `{id, title, summary, participants[{id, label, sub, zone, node?}], steps[]}`. The step grammar is the
  artifact's: `{m:[from,to], k:type, t:label, d:detail, r:[refs], ret?, i?:issueId}`, `{frag:"alt|else|opt|loop|end", t}`,
  `{note:[ids], t, tone}`.
- `views[]`: named projections (system, per-container component views, deployment, trust) filtered by node and zone.
  Optional `kind: graph|deployment|trust` selects the viewer's renderer; without it the viewer falls back to matching the
  view's id and title against deployment and trust words. Additive: models without `kind` validate and render unchanged.
- User-authored fields (`locked`, `notes`, layout `pinned`) are never overwritten by update or merge.
- Issues file: `{id, sev, category, title, anchor{node|edge|entity|step}, summary, impact, fix, detail (internal only),
  evidence[], source: archmap|audit, track?}`.
- Compatibility: readers tolerate unknown keys. Removing or renaming a key needs a major version.

## 6. Command flows
- **build**:
  1. Run `prescan.mjs` and partition the repo into ≤ 8 areas.
  2. Run parallel `archmap-explorer` agents, one per area: a prescan slice in, a JSON fragment out.
  3. Run DB introspection (recipes, read-only).
  4. `merge.mjs` + `validate.mjs`.
  5. `archmap-synthesizer`: cross-area edges, 3–7 sequences, CRUD/lineage, views.
  6. Validate, then `layout.mjs`, then `render.mjs` → clean `archmap.html`.
  7. Optional `--issues`: `archmap-reviewer` (+ audit import) → `issues.json` + `archmap.internal.html` outside the repo.
  8. Optional `--publish`: Artifact tool, when available. Clean by default; issues only on request, and calibrated.
  9. Print the usage ledger.
- **update**:
  1. Run `diffmap.mjs`. If nothing is affected, re-render only and stop.
  2. Run explorers on the affected areas and on uncovered new files.
  3. Merge, preserving user fields.
  4. Run the synthesizer only for touched edges and sequences.
  5. Validate, run layout seeded from the previous positions, and render.
  6. Re-review issues for affected anchors only, and only with `--issues`.
- **check**: staleness report and exit code. **issues**: reviewer over the current model (+ `--import-audit`).
  **export / render**: scripts only.

## 7. Viewer
Port from the reference artifact's viewer (all inside one `<script>`):
- relation table `ET`, zone table `ZN`, `addMarkers`, `roundedPath`;
- `renderGraph` (zones, nodes, edge labels, issue badges);
- focus and selection (`focusNode`, `focusEdge`, `select`, `renderDetail`);
- legend chips that toggle relation types, and the zone key;
- `renderSeq` + `setStep` (sequences with numbered steps, fragments, notes, issue dots, prev/next and arrow keys);
- the CSS token system for light and dark (copy it as is).

Replace `edgeGeom` manual anchors with ELK's routed edge sections.

New in v1:
- ER tab: entity cards with field rows, PK/FK markers, crow's-foot cardinality, and provenance styling.
- CRUD matrix tab, with click-through between nodes and entities.
- Lineage path highlight.
- Search, and a path finder (BFS between two nodes, with the path highlighted).
- Deployment and trust views, with trust boundaries drawn as dashed enclosures.
- Global **Issues** switch: it hides badges, flags, issue rows and step dots. Clean builds physically contain no issues.
- Evidence chips link to `repoUrl/blob/<commit>/<path>#L…`.

## 8. Token economy
- 0-token scripts: prescan, validate, merge, layout, render, export, diffmap, staleness.
- Explorers read excerpts (Grep, line ranges), never whole trees, and return size-capped JSON fragments.
- The synthesizer and reviewer read fragments and the model, plus targeted reads only.
- `update` touches only affected areas.
- Profiles set the `model` override per Agent call: max = Opus high everywhere; economy = Haiku explorer, Sonnet synthesizer and reviewer.
- The usage ledger takes tokens and duration from subagent completion notifications.

## 9. Implementation steps
0. Scaffold the repo (git init, MIT, README, CHANGELOG, CI skeleton, `docs/design.md`), create the GitHub repo and
   list it in the `quality-gates` marketplace.
1. JSON Schemas, `validate.mjs`, and the golden fixture: a hand-written, anonymised model derived from the reference artifact.
2. Port the viewer into `assets/viewer/*`, driven by the model. Write `layout.mjs` (elkjs: layered algorithm, compound zones,
   field ports for ER, seeds, pins) and `render.mjs` (clean / internal / shared). Render the golden fixture until it matches the reference.
3. `prescan.mjs` with extractors for the three v1 stacks, tested on small fixture repos.
4. Skill `architecture-map` (SKILL.md + references) and the three agents.
5. Commands, plus `merge.mjs`, `diffmap.mjs`, `usage.mjs`.
6. Staleness hook + `check`. Issues: reviewer, `issues.mjs` (audit import: `bugs[]` and `phases[].review.findings[]`,
   including legacy string findings), and calibration.
7. `export.mjs`: Mermaid flowchart / erDiagram / sequenceDiagram, PlantUML, Markdown; SVG always; PNG via headless Chromium when present.
8. skill-creator loop on the inner skill (§10). Iterate on SKILL.md and the references.
9. Description optimisation with skill-creator `scripts/run_loop` for the skill's trigger description.
10. Add the github-source entry to `quality-gates/.claude-plugin/marketplace.json` (done at step 0). Release archmap v1.0.0 with tag `v1.0.0` in its own repo.
11. `docs/roadmap.md`: v1.1 data platforms + infra; then the CI drift gate, ownership/churn/coverage overlays, entity state machines,
    and architecture diff between commits.

## 10. Verification
- **Unit** (`node --test`):
  - The schema accepts the golden fixture and rejects dangling ids and missing evidence.
  - Layout is deterministic, and seeded re-layout keeps unaffected and pinned nodes within tolerance.
  - diffmap maps changed files to the right nodes.
  - The clean render contains no issue ids or text (grep), and the internal render has the toggle.
- **Visual:** Playwright screenshots of every tab (light and dark, desktop and 400 px) of the golden render, with no console errors.
- **skill-creator evals** (with-skill vs without-skill, reviewed by the user in `eval-viewer/generate_review.py`;
  skill-creator from the official plugin marketplace):
  1. Build on the FastAPI + React + DuckDB eval repo. The model validates, and the key components of the reference
     are present (checklist kept with the private ground truth). Entities carry `observed` fields from DuckDB.
     There are ≥ 3 sequences, and every node has evidence.
  2. The same build with `--issues`. Recall against the reference's 25 issues (private ground truth) is ≥ 60 % of
     the high and medium ones, and the clean HTML contains no issues.
  3. Update after a scripted change in a temp worktree (new route + new column). Only affected nodes change, pins survive,
     `meta.commit` advances, and token use is far below a full build.
  4. Build on the Hono + Drizzle monorepo. Drizzle entities have declared fields and FKs, BullMQ edges are async, and each app is a container.
  5. Build on the Next + Drizzle admin API repo, as a smaller second-round check.
- **Hook:** a stale repo prints one line; a fresh repo or one without a model prints nothing; the exit code is always 0.
- **Tokens:** the ledger prints after build and update, and the balanced profile is cheaper than max on eval 1.

## 11. Issues catalogue seed (architecture-level, from the reference analysis)
These generalise into `references/issues-catalog.md`:
- No authentication at an app boundary (trusting an upstream proxy).
- URL or path input reaching SQL identifiers without an allowlist; read-write connections where read-only suffices.
- Data scoped by whoever triggers a bootstrap (per-user credentials used for shared data).
- Readiness inferred from a side effect (a file exists) that is created early.
- Background work without failure handling (flag stuck); retries that catch the wrong exception class.
- A "refresh" UI that clears caches but not data; cache invalidation that runs in a different process.
- Unauthenticated admin endpoints; credentials kept in the process environment.
- Process-global state that blocks scaling.
- Datasets or tables pulled but never read; entities listed in code but never loaded.
- Ungated production deploys; mutable refs to reusable CI workflows; end-of-life base images.
- Documentation describing a different system (docs drift).

## 12. Out of scope for v1
Caching, auth and API tables as separate pages; line-level code review; live data reads; auto-running the LLM on hooks;
Foundry / dbt / IaC-specific extraction (v1.1).

## 13. Open questions (verify, do not assume)
- Does the current Claude Code plugin agent frontmatter accept `effort`, and does the Agent tool accept a per-call `model` override?
  Check with the `claude-code-guide` agent or the docs, and with `claude plugin validate .`.
- The marketplace entry format for a plugin at a repo root via a github `source`. Confirm with `claude plugin validate` in the claude-plugins clone.
- Pin an elkjs version that is at least two weeks old, and record its licence notice.
- Node ≥ 18 is assumed on users' machines. Confirm it is acceptable for the team.

## 14. Prior-art research results (2026-10-28)
Feature claims come from READMEs and listing pages. Star counts and push dates come from the GitHub API on that day.

### 14.1 Closest items in the Claude Code ecosystem
| Item | Output | ER fields/PK/FK | Sequences | Evidence | Issues overlay | Incremental | Stable layout |
|---|---|---|---|---|---|---|---|
| [Archify](https://github.com/tt-a1i/archify) (~90.7k★, Apache-2.0) | typed JSON IR → self-contained HTML, 10 diagram types | yes (by hand) | yes | pinned commit, on request | no | chat edits, `compare` | agent-chosen |
| [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) (~88.7k★, MIT) | `.ua/knowledge-graph.json` + local dashboard | no | guided tours | partial | diff overlay | yes (fingerprints, post-commit hook) | n/s |
| [graphify](https://github.com/Graphify-Labs/graphify) (~137k★) | `graph.json` + HTML + Mermaid | reads SQL, no ER | no | file + line | no | `--update`, hooks | no (force layout) |
| code-modernization `/modernize-map` (official Anthropic plugin) | `topology.json` + d3 HTML + Mermaid lineage | no | flow walkthrough | file per node | 3–7 observations | no | n/s |
| [arch-lens](https://github.com/cognitive-fab/arch-lens) | analysis JSON → HTML (Archify) | no | yes | paths verified against a pinned commit | rules only | `check`/`review --base` | deterministic lanes |
| [draw-c4-skill](https://github.com/ShibaInu0817/draw-c4-skill) | `model.json` + HTML | no | flow player | instructed | no | manual | **keep coords, park new nodes** |
| [codemap-skill](https://github.com/Asixa/codemap-skill) | `modules.json` + HTML | no | no | findings file:line | **health score per module, colour mode** | **`check` + `update`** | n/s |
| [knossos](https://github.com/AraneaDev/knossos) | live pane + web client, SARIF | no | routes | **file:line + confidence on every relation** | issues tab | watcher | n/s |
| [diagram-codebase](https://github.com/ompug/diagram-codebase) | `model.json` + Mermaid + FigJam | ERD | sequence | **file, line range, symbol on every node and edge** | no | `--update` | hash-keyed |
| [DB Schema Spy](https://github.com/petrovicistefan/claude-code-plugins/tree/main/db-schema-spy) | Mermaid ER + text | yes, from Prisma/Drizzle/TypeORM/Django/Rails + read-only DB | n/a | no | schema smells as a list | no | n/a |
| [dobrinov/schema](https://github.com/dobrinov/schema) | interactive ER HTML, visual diff between git refs | yes (dumps/DDL only) | n/a | n/a | n/a | ref diff | several layouts |

Other related items:
- [floorplan](https://github.com/haydenschmitty/floorplan) (front-end calls matched to API endpoints, health check "Show on map").
- [show-me](https://github.com/Ofori01/show-me) (verifies every cited file:line contains the quoted text).
- [mermaidiff](https://github.com/osmangoninahid/mermaidiff).
- [CodeBoarding](https://github.com/CodeBoarding/CodeBoarding) (MIT, `analysis.json`, incremental runs, PR diffs).
- [GitNexus](https://github.com/abhigyanpatwari/GitNexus) (noncommercial licence).

### 14.2 Outside the Claude ecosystem
- **AI wikis:**
  - DeepWiki (hosted, LLM, regenerates in full).
  - Google Code Wiki (public repos, regenerates after each change).
  - GitDiagram (one Mermaid diagram).
  - CodeViz (IDE, mostly cloud).
  - Eraser (SaaS, PR bot).
  - Windsurf Codemaps (task snapshots).

  None exports a model. None does ER, CRUD, a toggle or a stable layout.
- **Architecture as code** (hand-modelled): LikeC4 (MIT; custom kinds, `link path#L`, sequence variant, manual
  layouts with a drift check, single-file HTML, exports to Mermaid, PlantUML, D2 and draw.io), Structurizr (DSL; layout merged by name),
  IcePanel (SaaS), Ilograph, C4-PlantUML, D2 + TALA (now MPL-2.0), Backstage, Archi.
- **Schema tools:** tbls (MIT; 12+ DBs, not DuckDB; virtual relations, lint, diff), SchemaSpy, SchemaCrawler, DBML/dbdocs,
  prisma-erd-generator, Azimutt, ChartDB, Atlas (Community inspect JSON; `--web` uploads the schema).
- **Dependency graphs:** dependency-cruiser (rules, `--baseline`, `--affected <rev>`), Madge, pydeps, Nx graph (files per edge,
  affected), Emerge.
- **Code → CRUD/lineage:** only CAST Imaging (commercial). AppMap does it from runtime traces.

### 14.3 Ideas worth borrowing (techniques, not dependencies)
- From draw-c4-skill: keep existing coordinates and "park" new nodes near their zone (complements D6 seeding).
- From show-me: `validate.mjs` can verify that each evidence `path:lines` exists at `meta.commit`, and optionally that it contains a quoted
  symbol. This cheaply guards against hallucinated relations.
- From knossos and graphify: tag each edge with how it was found: `static` (parser/regex), `llm`, `introspection`.
- From dependency-cruiser `--affected`: diffmap should also mark *dependents* of changed nodes as candidates for re-check.
- From codemap-skill: an optional health colour mode (max severity per node) as one view of the issues layer.
- From tbls `detectVirtualRelations`: name-convention relation inference (`<table>_id`) as an `inferred` ER relation strategy.
- README positioning: name these neighbours and say why archmap differs (one linked model, ER + CRUD, issues toggle,
  stable incremental layout, offline).
