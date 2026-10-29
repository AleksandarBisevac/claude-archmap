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

1. **Only the orchestrator writes the model.** Agents have no write tools for it and return JSON; scripts write HTML,
   layout and issues files. Model + renderer: the model is the single source of truth (D1).
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
| `archmap-synthesizer` | Opus, high effort | Fragments and the merged model; targeted reads only | One JSON object (no write tools): cross-area `edges`, 3-7 `sequences`, `access`, `relations`, `views`, `notes`, `conflicts` |
| `archmap-reviewer` | Opus, high effort | The model and the issues catalogue; targeted reads only | One JSON object (no write tools): `issues`, optional `import`, `unreviewed`; you write it as `issues.json` |

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

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/merge.mjs" <work>/fragments --out docs/architecture/architecture.model.json \
  --commit "$(git rev-parse HEAD)" --project <name> --profile <profile> --generated-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --json
```

`merge.mjs` follows the fragment contract in model-schema.md: it concatenates the arrays in area order, dedupes
identical elements, renames an id collision to `<id>-<area>` and rewrites the references, and fills `meta`
(`schemaVersion`, `project`, `commit`, `generatedAt`, `profile`, `sources`, `coverage` from each fragment's `coverage`).
`generatedAt` is never invented, so always pass it. When `docs/architecture/architecture.model.json` already exists, add
`--previous docs/architecture/architecture.model.json` so `locked` and `notes` survive. The result is validated before
anything is written. Exit 0 ok; exit 1 the result is invalid (print the findings, fix or re-dispatch the owning
explorer); exit 2 is a usage error. It reports `conflicts` (for example a locked node the new analysis disagrees with):
report them, do not resolve them silently. Then validate:

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
`views[]`. It has no write tools and returns one JSON object (`edges`, `sequences`, `access`, `relations`, `views`,
`notes`, `conflicts`). Save it as `<work>/synth.json`. Then the orchestrating session merges that object into the model and runs validate (step 6),
by re-running `merge.mjs` from step 4 with `--synth <work>/synth.json` and `--previous` on the model just written; a
non-empty `conflicts` is reported, not resolved silently. Only the orchestrator writes `architecture.model.json`.

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

`issues.mjs` does the deterministic half and never writes inside the repo (it refuses an `--out` in the project's git
tree). Get the overlay directory, then import, merge and write there. `--existing` is optional: absent, or naming
a file that does not exist yet (a first build), it means an empty overlay.

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" path
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" import-audit docs/audit/audit-plan.json --model docs/architecture/architecture.model.json --existing <overlay-dir>/issues.json --out <overlay-dir>/issues.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" merge --existing <overlay-dir>/issues.json --incoming <reviewer.json> --model docs/architecture/architecture.model.json --out <overlay-dir>/issues.json
```

`import-audit` runs only with `--import-audit` (re-importing is idempotent; non-audit issues are kept). `merge` takes the
reviewer's returned object, saved to a scratch file as `<reviewer.json>`, and replaces the existing issues on the
anchors it covers (`--anchors a,b` to limit it). Output is validated against the model.
Then:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" docs/architecture/architecture.model.json --issues <overlay-dir>/issues.json --repo .
node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json --issues <overlay-dir>/issues.json --mode internal --out <overlay-dir>/archmap.internal.html
```

Before any `--mode shared` render, and before `--publish` of a shared build, lint the overlay (exit 0 clean, 1 findings:
fix the wording, do not render until it is clean):

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" lint <overlay-dir>/issues.json
```

`--mode shared` (also needs an explicit `--out`) produces a build with only the calibrated `summary`, `impact` and `fix`, without the internal `detail`.
The clean `docs/architecture/archmap.html` must stay issue-free: re-render it without `--issues` if in doubt.

### 8. Optional `--publish`

Only on `--publish`, and only when the Artifact tool is available in this session. Publish the clean build by default.
Publish an issues build only if the user asks for it, and then only the `shared` mode. If the tool is unavailable, say
so and stop; do not substitute another channel.

### 9. Usage ledger

Record one row per step in `<work>/usage.jsonl` as it finishes, taking tokens and duration from the subagent completion
notifications (a script step costs no tokens: `--tokens 0`). Leave out a figure you could not read; it prints as
unknown, never as zero.

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" add <work>/usage.jsonl --phase explorer --label <area> --agent archmap-explorer --model <model> --tokens <n> --duration-ms <n>
node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" print <work>/usage.jsonl
```

Phases are `prescan`, `explorer`, `introspection`, `merge`, `synthesizer`, `reviewer`, `layout`, `render`. Put the printed
table in the final report (`print --json` for the machine form).

## Update flow

Triggered by `/archmap:update [--issues] [--profile p] [--since sha]`. The model stores the analysed commit
(`meta.commit`) and each node's `paths`, so update re-analyses only what changed.

1. **Diffmap.**

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/diffmap.mjs" docs/architecture/architecture.model.json --repo . --json
   ```

   Add `--since <sha>` when given. It compares `meta.commit` with HEAD and reports `areas` (via `meta.coverage`), `nodes`
   (via `paths`), `dependents` (one edge away), `entities`, `sequences` and `uncovered` (new files no area owns). Exit 0
   also when nothing is affected: if `areas`, `nodes`, `entities` and `uncovered` are all empty, re-render only (step 5)
   and stop. Exit 2 is a usage error, an unreadable model or an unknown base commit. Uncommitted edits to tracked files
   are not seen: say so.
2. **Explorers** on the affected areas and on new files no area covers. Same dispatch as build step 2, with the old
   fragment's node ids supplied so ids stay stable.
3. **Merge, preserving user fields.**

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/merge.mjs" <work>/fragments --previous docs/architecture/architecture.model.json --out docs/architecture/architecture.model.json \
     --areas <a,b> --commit "$(git rev-parse HEAD)" --generated-at <iso> --json
   ```

   Only the listed areas' fragments are read and only their elements are replaced; everything else keeps its ids.
   `--areas` must list every area that has a fragment in the directory, including the area of the fragment written for
   the `uncovered` files, and every listed area must have a fragment (an explorer that failed leaves a hole). Either
   mismatch is reported as a `conflict` and exits 1 under `--strict`; do not leave it unresolved, because an area named
   without a fragment has its elements removed and nothing replaces them. `locked` and `notes` and layout `pinned` survive; a locked node keeps its authored content, and a `conflict` is
   reported, not resolved silently. Cross-area edges and access rows whose evidence sits in an affected area are
   replaced too, which is what step 4 refills.
4. **Synthesizer only for touched edges and sequences**: pass it the list of affected ids. It returns only the touched or new elements with the same ids; you merge
   them with the same `merge.mjs` call as step 3, with `--synth <work>/synth.json` added (keep `--areas <a,b>`):

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/merge.mjs" <work>/fragments --previous docs/architecture/architecture.model.json --out docs/architecture/architecture.model.json \
     --areas <a,b> --synth <work>/synth.json --commit "$(git rev-parse HEAD)" --generated-at <iso> --json
   ```

   Never run this without `--areas`: the fragments directory holds only the affected areas, and without `--areas`
   `merge.mjs` treats every area as affected, so every unaffected area's elements would be classed as owned, removed and
   not re-added. Then run validate.
5. **Validate, layout, render.** Layout is seeded from the previous positions in `architecture.layout.json`. Set
   `meta.commit` to HEAD and `generatedAt` anew.
6. **Issues**, only with `--issues`: re-review the affected anchors only and merge into the existing overlay.

## Other commands

- `/archmap:check`: script only, `node "${CLAUDE_PLUGIN_ROOT}/scripts/staleness.mjs" --check`. Exit 0 when the model is
  fresh, 1 when it is behind HEAD, 2 when there is no usable model. The SessionStart hook (`hooks/hooks.json`) runs the
  same script without `--check`: it prints one line when the model is stale, nothing otherwise, and always exits 0; the
  LLM is never run automatically.
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
