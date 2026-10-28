---
name: architecture-map
description: Build or update an evidence-backed architecture map of a codebase - components, typed relations, data entities, CRUD access, sequence diagrams and optional architecture-level issues - as one JSON model plus a self-contained offline HTML viewer. Use when the user asks to map, diagram, document or visualise a system's architecture, to refresh an existing map after code changes, to review a system's structure for architecture-level issues, or runs /archmap:build, /archmap:update, /archmap:issues, /archmap:render or /archmap:check.
---

# architecture-map

You produce `docs/architecture/architecture.model.json` for the analysed project. Bundled scripts do everything
deterministic (prescan, merge, validate, layout, render, export); three agents do the reading and reasoning. You are
the orchestrator: you partition, dispatch, hand fragments on and run scripts. You do not read whole source trees.

Scripts are invoked as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"`. They need Node 18 or newer and have no
npm dependencies. Run them from the analysed project's root so relative paths stay repo-relative.

## Hard rules

1. **The agents write only the model.** Model + renderer: the model is the single source of truth (D1). Agents never
   write HTML, layout or issues files by hand; scripts do. Explorers write nothing at all and return JSON.
2. **Nothing without evidence.** Every node and edge carries a non-empty `evidence` of `{path, lines}`. An element that
   cannot cite a file and lines is left out and tallied in `skipped`. See [Evidence](#evidence-rules).
3. **Never execute the code you map.** Read it as text. Do not import, build, start, test or migrate the project, and
   do not run its tooling to "see" what happens. The only permitted side effect is the read-only introspection in
   [schema-introspection.md](references/schema-introspection.md).
4. **User-authored fields are never overwritten**: `locked` and `notes` on a node, `pinned` in the layout file.
   Merge and update keep them untouched.
5. **Clean by default.** The committed artifacts carry no issues. The issue pass runs only on `--issues`, and its
   output lives outside the repo (see [Output locations](#output-locations)).
6. **Silence is not coverage.** Whatever is skipped (introspection, generated code, an unreadable area) is recorded in
   `meta.sources` or an explorer's `skipped`, never dropped.

## References: when to read each

Read a reference at the step named, not up front. Detail lives there; this file only routes.

| File | Read it when |
|---|---|
| [references/model-schema.md](references/model-schema.md) | Before writing or merging any model content; it holds every key, the evidence rule, provenance, and the explorer fragment contract. Every agent reads it. |
| [references/relation-taxonomy.md](references/relation-taxonomy.md) | Choosing an edge `type`, zone `kind`, node `kind` or edge `confidence`. |
| [references/sequences.md](references/sequences.md) | Writing or updating `sequences[]` (the synthesizer, step 5 of build). |
| [references/discovery-generic.md](references/discovery-generic.md) | Any stack prescan does not recognise, and as the fallback for whatever a stack extractor skipped. |
| [references/stack-python-backend.md](references/stack-python-backend.md) | Prescan reports the `python` stack: FastAPI, Django, Flask, SQLAlchemy, Pydantic, Alembic, DuckDB, SQLite. |
| [references/stack-ts-frontend.md](references/stack-ts-frontend.md) | Prescan reports the `ts-frontend` stack: React, Next.js, React Native, routers, RTK Query, React Query, Redux, Zustand, axios, fetch. |
| [references/stack-node-backend.md](references/stack-node-backend.md) | Prescan reports the `node-backend` stack: NestJS, Express, Hono, Prisma, TypeORM, Drizzle, OpenAPI, queues. |
| [references/schema-introspection.md](references/schema-introspection.md) | Step 3 of build: before touching any database file, or when `--db <dsn>` is given. |
| [references/issues-catalog.md](references/issues-catalog.md) | Only when `--issues` is set: the `archmap-reviewer` reads it; you read it to word the hand-off. |

## Agents

| Agent | Default model | Reads | Returns |
|---|---|---|---|
| `archmap-explorer` | Sonnet, medium effort | One area's prescan slice plus excerpts (Grep, line ranges) | One size-capped JSON fragment, nothing else |
| `archmap-synthesizer` | Opus, high effort | Fragments and the merged model; targeted reads only | The updated model: cross-area edges, 3-7 sequences, CRUD and lineage, views |
| `archmap-reviewer` | Opus, high effort | The model and the issues catalogue; targeted reads only | An issues list for the overlay file |

Dispatch each with the `Agent` tool and pass the `model` override the chosen profile requires (see
[Token rules](#token-rules)). Give an agent exactly what it needs: its area, the relevant prescan slice and extract, the
names of the references to read, and the fragment contract. Never paste whole files into a prompt.

## Output locations

| Artifact | Where | Committed? |
|---|---|---|
| `architecture.model.json` | `docs/architecture/` of the analysed project | yes |
| `architecture.layout.json` | `docs/architecture/` (seeds for the next layout; holds `pinned`) | yes |
| `archmap.html` (clean) | `docs/architecture/` | yes |
| `archmap.theme.json` (optional) | `docs/architecture/`; user-authored | yes |
| `issues.json` | `<home>/.claude/archmap/<repo-slug>/` | no, outside the repo |
| `archmap.internal.html` | `<home>/.claude/archmap/<repo-slug>/` | no, outside the repo |

`<home>` is the user's home directory; `<repo-slug>` is the repository directory name, lowercased, with anything that
is not a letter, digit or `-` replaced by `-`. Create the directory when it is missing. Never write an issues file or
an issues-bearing HTML inside the analysed repo.

## Build flow

Triggered by `/archmap:build [--issues] [--profile p] [--db dsn] [--scope path] [--publish]`. Work in a scratch
directory (for example `.archmap-work/` outside version control, or the session scratchpad) for prescan output and
fragments; only the artifacts in the table above land in `docs/architecture/`.

### 1. Prescan (0 tokens)

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/prescan.mjs" . --out <work>/prescan.json
```

Add `--scope <path>` when the user limits the run to a subtree. Exit 0 is ok; exit 2 is a usage error or an unreadable
repo: stop and report the message. Read the JSON's `stacks`, `areas`, `sources` and `extracts`. Never `cat` the whole
file into a prompt if it is large; slice it per area.

Partition the repo into at most **8 areas**. Start from the prescan `areas`; merge small neighbours and split huge ones
until there are 8 or fewer, each owning a disjoint set of globs. Tell the user the partition in one short list before
dispatching.

### 2. Explorers, in parallel

Dispatch one `archmap-explorer` per area in a single message so they run concurrently. Each prompt carries: the area
name and globs, that area's slice of `areas` and `extracts`, the stack reference(s) to read (from the table above, or
[discovery-generic.md](references/discovery-generic.md)), and the instruction to follow the explorer fragment contract in
[model-schema.md](references/model-schema.md). Apply the profile's `model` override.

Save each returned fragment to `<work>/fragments/<area>.json`. If a reply is not a single JSON object, or is over its
caps, re-ask that one explorer once with the problem stated; if it fails again, record the area in `meta.sources` as
skipped with the reason and continue. Do not repair fragments by hand beyond trivial JSON syntax.

### 3. Introspection (read-only)

Follow [schema-introspection.md](references/schema-introspection.md). File databases that prescan listed (SQLite,
DuckDB) are introspected for schema only, never rows; a remote database only with an explicit `--db <dsn>`. The plugin
ships no driver: use the `sqlite3` or `duckdb` CLI, or the project's own Python. If none is available, skip the step and
record it in `meta.sources` with the reason. Introspected fields get `provenance: observed` and `foundBy:
introspection`. Write the result as one more fragment, `<work>/fragments/introspection.json`.

### 4. Merge and validate

`merge.mjs` is **not yet built** (later phase). Until it exists, you merge the fragments yourself, following the fragment
contract in model-schema.md: concatenate the arrays, dedupe by id, rename on collision and rewrite references, fill
`meta` (`schemaVersion`, `project`, `commit` = HEAD, `generatedAt`, `profile`, `sources`, `coverage` from each fragment's
`coverage`). When it exists, call it with the fragment directory and the target model path; it also preserves
user-authored fields. Then validate:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" docs/architecture/architecture.model.json --repo .
```

Exit 0 valid; exit 1 has findings (print them and fix the model, or re-dispatch the owning explorer); exit 2 is a usage
error. `--repo .` also checks that every evidence path and line range exists at `meta.commit`. A run without `--repo`
does not check evidence: say so if that is all you ran.

### 5. Synthesizer

Dispatch `archmap-synthesizer` with the merged model path. It reads the model and fragments, not the tree, plus
targeted source reads to confirm a cross-area claim. It adds cross-area edges, 3-7 sequences (read
[sequences.md](references/sequences.md)), `access[]` rows that drive the CRUD matrix and lineage, `relations[]`, and
`views[]`. It edits only `architecture.model.json`.

### 6. Validate, layout, render

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" docs/architecture/architecture.model.json --repo .
node "${CLAUDE_PLUGIN_ROOT}/scripts/layout.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json
```

Layout is build-time ELK; the layout file seeds the next run so only new or changed nodes move. If `--layout` names a
missing file, the first run creates it. Render writes the clean `archmap.html` beside the model. Add `--theme
docs/architecture/archmap.theme.json` when that file exists. Exit 1 from layout or render means the model is invalid and
nothing was written: go back to validate. Exit 2 is a usage or unreadable input.

### 7. Optional `--issues` (opt-in)

Only on `--issues`. Dispatch `archmap-reviewer` with the model path; it reads
[issues-catalog.md](references/issues-catalog.md). Issues are architecture-level, anchored to a node, edge, entity or
sequence step, with severity high, med or low and a category (security, data, reliability, performance, design, docs).
If `docs/audit/audit-plan.json` exists, its findings may be imported (`/archmap:issues --import-audit`).

Write `issues.json` under `<home>/.claude/archmap/<repo-slug>/` (the reviewer returns the list; you or `issues.mjs`
write it). `issues.mjs` is **not yet built**; until it is, write the file yourself to the schema in
`schema/archmap-issues.schema.json`. Then:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" docs/architecture/architecture.model.json --issues <issues.json> --repo .
node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json --issues <issues.json> --mode internal --out <home>/.claude/archmap/<repo-slug>/archmap.internal.html
```

`--mode shared` (also needs an explicit `--out`) produces a build with only the calibrated `summary`, `impact` and `fix`, without the internal `detail`.
The clean `docs/architecture/archmap.html` must stay issue-free: re-render it without `--issues` if in doubt.

### 8. Optional `--publish`

Only on `--publish`, and only when the Artifact tool is available in this session. Publish the clean build by default.
Publish an issues build only if the user asks for it, and then only the `shared` mode. If the tool is unavailable, say
so and stop; do not substitute another channel.

### 9. Usage ledger

Print a per-phase ledger: prescan, each explorer, introspection, synthesizer, reviewer, with tokens and duration taken
from the subagent completion notifications. `usage.mjs` is **not yet built**; until it exists, print the table from the
notifications you saw and label any figure you could not read as unknown, not zero.

## Update flow

Triggered by `/archmap:update [--issues] [--profile p] [--since sha]`. The model stores the analysed commit
(`meta.commit`) and each node's `paths`, so update re-analyses only what changed.

1. **Diffmap.** `diffmap.mjs` is **not yet built**; it compares `meta.commit` (or `--since`) with HEAD and maps changed
   files to affected areas (via `meta.coverage`), nodes (via `paths`) and entities. Until it exists, do this with
   `git diff --name-only <commit>..HEAD` and match the files against `meta.coverage` and node `paths` yourself. If
   nothing is affected, re-render only (step 5) and stop.
2. **Explorers** on the affected areas and on new files no area covers. Same dispatch as build step 2, with the old
   fragment's node ids supplied so ids stay stable.
3. **Merge, preserving user fields.** Replace only the affected areas' elements. `locked` and `notes` and layout
   `pinned` survive; a locked node keeps its authored content, and a conflict is reported, not resolved silently.
4. **Synthesizer only for touched edges and sequences**: pass it the list of affected ids.
5. **Validate, layout, render.** Layout is seeded from the previous positions in `architecture.layout.json`. Set
   `meta.commit` to HEAD and `generatedAt` anew.
6. **Issues**, only with `--issues`: re-review the affected anchors only and merge into the existing overlay.

## Other commands

- `/archmap:check`: script only (`staleness.mjs`, not yet built). Exit 0 when the model is fresh, 1 when it is behind
  HEAD. The SessionStart hook prints one line when stale and is silent when the project has no model; the LLM is never
  run automatically.
- `/archmap:issues [--import-audit] [--profile p]`: build step 7 over the current model.
- `/archmap:export mermaid|plantuml|svg|png|md [--view v]`: `export.mjs`, not yet built; no LLM.
- `/archmap:render [--internal|--shared]`: build step 6 (render) only; no LLM.

## Evidence rules

- Every node and edge: a non-empty `evidence` array of `{path, lines}`; `path` repo-relative, `lines` as `N` or `N-M`.
  Entities, fields and access rows carry evidence whenever it exists.
- Cite, do not quote. No source excerpts in the model.
- An element with no citable file and lines is not added. It goes in `skipped` (count and short reason).
- Edge `confidence` is `verified` (the code states the link), `inferred` (concluded from names, config or usage) or
  `external` (a third party you cannot read). Entity-field and relation `provenance` is `declared`, `observed` or
  `inferred`. Never mark `verified` or `declared` what you did not see in a file; when unsure, choose the weaker
  value. Meanings are in [relation-taxonomy.md](references/relation-taxonomy.md) and
  [model-schema.md](references/model-schema.md).
- Report honestly in your final message: what was validated, with which command and exit code, and what was not
  checked (for example evidence when `--repo` was not given).

## Token rules

- **Scripts first.** Prescan, merge, validate, layout, render, diffmap, export and staleness cost no tokens. Do not ask
  an agent for something a script can compute.
- **Excerpts, not trees.** Explorers use Grep and line ranges, never whole-tree reads, and return fragments capped at
  about 40 nodes, 80 edges, 60 entities and 80 access rows (split the area otherwise), one sentence per `desc` and
  `role`, no source excerpts.
- **Synthesizer and reviewer** receive fragments and the model, with targeted reads only to confirm a specific claim.
- **Update touches only affected areas**; it never re-explores the whole repo.
- **Profiles**, set with `--profile max|balanced|economy`, default `balanced`. A profile is applied as the `model`
  override on each `Agent` call, and recorded in `meta.profile`:

| Profile | `archmap-explorer` | `archmap-synthesizer` | `archmap-reviewer` |
|---|---|---|---|
| `max` | Opus (high) | Opus (high) | Opus (high) |
| `balanced` (default) | Sonnet (medium) | Opus (high) | Opus (high) |
| `economy` | Haiku | Sonnet | Sonnet |

The agents' own frontmatter holds the `balanced` defaults, so for `balanced` no override is needed. Say in one line
which profile ran and what it trades off; `economy` may miss cross-area links, so flag thin results instead of padding.

## Final report

End with: the files written (paths), the validate command and its exit code, element counts (nodes, edges, entities,
sequences), what was skipped or not checked and why, the profile, and the usage ledger. If anything is unverified, say
that plainly.
