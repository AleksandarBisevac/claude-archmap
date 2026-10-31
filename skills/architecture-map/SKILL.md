---
name: architecture-map
description: Use to map or refresh the architecture of a code repository: which components or services exist, what calls what, what each reads or writes in databases, queues and external APIs, and how requests and background jobs flow. Trigger on requests for C4 or container diagrams, architecture or onboarding docs (including Confluence pages), mapping an inherited or multi-service monorepo, updating an existing architecture doc after code changes, and system-level checks such as auth boundaries, shared state or cross-service coupling. Output is evidence-cited with an offline HTML viewer. Do not use for explaining a single file, reviewing a PR, writing ADRs, API specs, slide decks or refactors. Also runs the commands /archmap:build, /archmap:update, /archmap:issues, /archmap:render and /archmap:check.
---

# architecture-map

You produce `docs/architecture/architecture.model.json` for the analysed project. Bundled scripts do everything
deterministic; three agents do the reading and reasoning. You are the orchestrator, and a build is a short loop: you
run the driver `scripts/pipeline.mjs`, dispatch the Agent calls it prints, and read its one-line JSON. You do not read
source trees, extracts, fragments, the digest or the model.

Scripts are invoked as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"`. They need Node 18 or newer and have no
npm dependencies. Run them from the analysed project's root so relative paths stay repo-relative.

## Hard rules

1. **Only the orchestrator writes the model.** Agents never write it: the reviewer returns JSON, the synthesizer and
   an explorer each write only their own JSON file in the work directory; scripts write HTML, layout and issues files.
   Model + renderer: the model is the single source of truth (D1).
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

## References

The driver writes every agent's brief, and each brief carries the contract, the caps and the vocabulary its agent
needs, so nobody reads a reference during a build. The references back the briefs and the steps outside the build
flow; read one only at the step that names it.

| File | Holds |
|---|---|
| [references/model-schema.md](references/model-schema.md) | Every key, the evidence rule, provenance and the explorer fragment contract the briefs restate. |
| [references/relation-taxonomy.md](references/relation-taxonomy.md) | Edge `type`, zone `kind`, node `kind` and edge `confidence` words. |
| [references/sequences.md](references/sequences.md) | The `sequences[]` grammar the synthesizer brief restates. |
| [references/discovery-generic.md](references/discovery-generic.md) | Any stack prescan does not recognise; an explorer brief names it when the extract leaves a question open. |
| [references/stack-python-backend.md](references/stack-python-backend.md) | The `python` stack: FastAPI, Django, Flask, SQLAlchemy, Pydantic, Alembic, DuckDB, SQLite. |
| [references/stack-ts-frontend.md](references/stack-ts-frontend.md) | The `ts-frontend` stack: React, Next.js, React Native, routers, RTK Query, React Query, Redux, Zustand, axios, fetch. |
| [references/stack-node-backend.md](references/stack-node-backend.md) | The `node-backend` stack: NestJS, Express, Hono, Prisma, TypeORM, Drizzle, OpenAPI, queues. |
| [references/schema-introspection.md](references/schema-introspection.md) | The read-only introspection rules the driver follows; read it only for `--db <dsn>`. |
| [references/issues-catalog.md](references/issues-catalog.md) | Only with `--issues`: the `archmap-reviewer` reads it; you read it to word the hand-off. |

## Agents

| Agent | Default model | Reads | Returns |
|---|---|---|---|
| `archmap-explorer` | Sonnet, low effort | Its brief, its area's extract file, excerpts (Grep, line ranges) | Writes one size-capped fragment file; replies with three lines |
| `archmap-synthesizer` | Sonnet, medium effort | Its brief and the merge digest with its drafted sequences; at most 12 targeted reads | Writes one JSON object to the synth path: 3-7 `sequences`, `views`, `notes`, `conflicts`; replies with three lines |
| `archmap-reviewer` | Opus, high effort | The model and the issues catalogue; targeted reads only | One JSON object (no write tools): `issues`, optional `import`, `unreviewed`; you write it as `issues.json` |

Dispatch each with the `Agent` tool exactly as the driver prints the call: `subagent_type`, `description`, `prompt`,
and `model` when the profile needs an override (see [Token rules](#token-rules)). The prompt is a pointer to the brief
file; never paste a brief, an extract, a fragment or the digest into a prompt.

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

Triggered by `/archmap:build [--issues] [--profile p] [--db dsn] [--scope path] [--publish]`. Read this file once. During
a build you read no reference, script or agent file and run nothing but the three driver steps; the driver runs
prescan, the partition, the briefs, introspection, merge, validate, layout, render and the usage ledger, and prints one
JSON line per step with every script's exit code and findings. A build without `--issues` is seven assistant turns:
loading the skill, then one turn per step below. `<work>` is a scratch directory outside version control (the session
scratchpad, or a git-ignored `.archmap-work/`); plan refuses one the repo would map.

**Dispatch rule.** Send every Agent call a step prints in ONE message, as foreground calls: they run concurrently and
the message returns when all have replied. Never set `run_in_background`, never use ScheduleWakeup or Monitor, and do
not poll, sleep or check on agents during a build: there is nothing to wait for outside that one message.

| Cap | Value | Held by |
|---|---|---|
| areas per build | 8 | the prescan partition |
| explorer tool calls | 20 | the explorer brief |
| fragment nodes | 40 | the merge keeps the first 40 |
| fragment edges | 80 | the merge keeps the first 80 |
| fragment entities | 60 | the merge keeps the first 60 |
| fragment access rows | 80 | the merge keeps the first 80 |
| synthesizer source reads | 12 | the synthesizer brief |
| sequences | 3-7 | the synthesizer brief |
| brief | 4000 characters | plan and finish |
| digest | under 30 K characters | finish |

**Replies.** An explorer replies with exactly three lines; the synthesizer too:

```
fragment: <work>/fragments/<area>.json
counts: nodes=<n> edges=<n> entities=<n> access=<n>
tool calls: <n>

synth: <work>/synth.json
counts: <n> sequences, <n> views
tool calls: <n>
```

Read the counts and the token figure on the Agent completion line, and move on. Do not open a fragment or the synth
file. A reply that is not those three lines is not acted on, and a weak or missing fragment is never sent back: the
merge normalises a fragment and truncates it to the caps, recording the area and the count dropped in `meta.sources`.

### 1. Plan

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" plan . --work <work> [--scope <path>] [--profile <p>] [--issues]
```

Exit 0: `areas` is the partition and `agents` the explorer calls, one per area, each reading
`<work>/extracts/<area>.json` and writing `<work>/fragments/<area>.json`. Exit 2: stop and report `error`.

### 2. Dispatch the explorers

In one message: the partition as one short list for the user, and every call in `agents` (the dispatch rule above).

### 3. Finish

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" finish --work <work> --usage <area>=<tokens>@<duration> ...
```

One `--usage` per explorer, copied off its completion line (`--usage api=34.5k@1m2s`); leave out a figure you could not
read and the ledger prints it as unknown, never as zero. Exit 0: the model is merged and validated with `--repo`, and
`agents` holds the synthesizer call. Exit 2 with `missing`: those areas wrote no fragment; run finish again with
`--allow-missing` and name them in the report as not mapped. Exit 1: the merged result is invalid; report `findings`
and stop, never patch the model by hand. Report any `conflicts`; do not resolve them silently.

### 4. Dispatch the synthesizer

The one call in finish's `agents`, alone in one message, the same dispatch rule.

### 5. Render

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" render --work <work> --usage synthesizer=<tokens>@<duration>
```

Only the orchestrator writes `architecture.model.json`, through this step.
In it the orchestrator's driver merges the synthesizer's object into the model and validates it with `--repo`, lays it
out (seeded from the previous layout, so only new nodes move) and renders the clean `archmap.html`. Exit 1: a step found
the model invalid and nothing was rendered; report `findings`.

### 6. Report

Write the final message from render's `report`: the files, the validate command and its exit code, the counts, what
was not mapped or skipped, the conflicts, the profile and the usage ledger. With `--issues` or `--publish`, continue
with the optional steps below first.

## Optional steps

### `--issues` (opt-in)

Only on `--issues`. Render then prints the `archmap-reviewer` call in `agents`; dispatch it the same way. It reads
[issues-catalog.md](references/issues-catalog.md) and returns one JSON object; save that reply to
`<work>/reviewer.json`. Issues are architecture-level, anchored to a node, edge, entity or sequence step, with severity
high, med or low and a category (security, data, reliability, performance, design, docs). If
`docs/audit/audit-plan.json` exists, its findings may be imported (`/archmap:issues --import-audit`).

`issues.mjs` does the deterministic half and never writes inside the repo (it refuses an `--out` in the project's git
tree). Get the overlay directory, then import, merge and write there. `--existing` is optional: absent, or naming
a file that does not exist yet (a first build), it means an empty overlay.

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" path
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" import-audit docs/audit/audit-plan.json --model docs/architecture/architecture.model.json --existing <overlay-dir>/issues.json --out <overlay-dir>/issues.json
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" merge --existing <overlay-dir>/issues.json --incoming <work>/reviewer.json --model docs/architecture/architecture.model.json --out <overlay-dir>/issues.json
```

`import-audit` runs only with `--import-audit` (re-importing is idempotent; non-audit issues are kept). `merge` replaces
the existing issues on the anchors the reviewer's object covers (`--anchors a,b` to limit it). Output is validated
against the model. Then validate, render the internal build and record the reviewer's ledger row:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" docs/architecture/architecture.model.json --issues <overlay-dir>/issues.json --repo .
node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json --issues <overlay-dir>/issues.json --mode internal --out <overlay-dir>/archmap.internal.html
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" ledger --work <work> --usage reviewer=<tokens>@<duration>
```

Before any `--mode shared` render, and before `--publish` of a shared build, lint the overlay (exit 0 clean, 1 findings:
fix the wording, do not render until it is clean):

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/issues.mjs" lint <overlay-dir>/issues.json
```

`--mode shared` (also needs an explicit `--out`) produces a build with only the calibrated `summary`, `impact` and `fix`, without the internal `detail`.
The clean `docs/architecture/archmap.html` must stay issue-free: re-render it without `--issues` if in doubt.

### `--publish`

Only on `--publish`, and only when the Artifact tool is available in this session. Publish the clean build by default.
Publish an issues build only if the user asks for it, and then only the `shared` mode. If the tool is unavailable, say
so and stop; do not substitute another channel.

### `--db <dsn>`

The driver introspects the database files prescan lists (SQLite, DuckDB) when their CLI is on `PATH`, schema only and
read-only, and records a skip with its reason otherwise. It never takes a DSN, because it would have to store it. For a
remote database the user named with `--db`, after finish and before render follow
[schema-introspection.md](references/schema-introspection.md) and write the result as one more fragment,
`<work>/fragments/db.json`; render merges it. Never print or store the DSN.

## Update flow

Triggered by `/archmap:update [--issues] [--profile p] [--since sha]`. The model stores the analysed commit
(`meta.commit`) and each node's `paths`, so update re-analyses only what changed, with the same driver, steps and
dispatch rule as the build flow:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" plan . --work <work> --update [--since <sha>] [--profile <p>] [--issues]
```

Plan runs prescan, then `diffmap.mjs` against `docs/architecture/architecture.model.json`, and briefs only the affected
areas and the areas of new files no area owns; each brief names the previous model so the explorer reuses its area's
node ids. When `agents` is empty nothing is affected: skip to render, which re-renders only. Then finish and render as
in the build flow: `merge.mjs` runs with `--previous` and `--areas` listing exactly the areas diffmap named (and that
wrote a fragment), so every other area keeps its elements and ids, and the synthesizer brief lists the touched ids so
only those sequences and views are rewritten. `locked`, `notes` and layout `pinned` survive; a locked node keeps its
authored content and a `conflict` is reported, not resolved silently. Uncommitted edits to tracked files are not seen:
say so. Issues, only with `--issues`: re-review the affected anchors only and merge into the existing overlay.

## What the driver runs

Each step of `pipeline.mjs` wraps the bundled scripts, which stay usable on their own:

| Script | Does | Exit codes |
|---|---|---|
| `prescan.mjs` | Inventory, stacks, the area partition and one extract per area | 0 ok, 2 usage or unreadable repo |
| `diffmap.mjs` | Maps the commits since `meta.commit` onto areas, nodes, entities and sequences (update) | 0 ok, 2 usage or unknown base |
| `merge.mjs` | Normalises and truncates the fragments, computes cross-area edges, zones, access rows and relations, writes the digest, merges the synthesizer's object | 0 ok, 1 invalid result, 2 usage |
| `validate.mjs` | Schema, references and, with `--repo`, every evidence path and line range at `meta.commit` | 0 valid, 1 findings, 2 usage |
| `layout.mjs` | Build-time ELK layout, seeded from the previous layout file | 0 ok, 1 invalid model, 2 usage |
| `render.mjs` | The self-contained offline HTML viewer | 0 ok, 1 invalid input, 2 usage |
| `usage.mjs` | The per-phase token ledger the driver writes to `<work>/usage.jsonl` | 0 ok, 2 usage |

A run without `--repo` does not check evidence; the driver always passes it.

## Other commands

- `/archmap:check`: script only, `node "${CLAUDE_PLUGIN_ROOT}/scripts/staleness.mjs" --check`. Exit 0 when the model is
  fresh, 1 when it is behind HEAD, 2 when there is no usable model. The SessionStart hook (`hooks/hooks.json`) runs the
  same script without `--check`: it prints one line when the model is stale, nothing otherwise, and always exits 0; the
  LLM is never run automatically.
- `/archmap:issues [--import-audit] [--profile p]`: the `--issues` step over the current model.
- `/archmap:export mermaid|plantuml|svg|png|md [--view v]`: script only, `node "${CLAUDE_PLUGIN_ROOT}/scripts/export.mjs" docs/architecture/architecture.model.json <format> [--view v] [--layout docs/architecture/architecture.layout.json]`.
  Writes Mermaid (flowchart per view, erDiagram, sequenceDiagram), PlantUML, Markdown summary or SVG to
  `docs/architecture/exports/`; png rasterises the svgs with a headless Chromium when one is present (`CHROME_PATH`).
  Exports are clean only: no issues ever appear in them. Exit 1 invalid model, 2 usage or unreadable, 3 no Chromium
  for png. No LLM.
- `/archmap:render [--internal|--shared]`: layout and render only; no LLM.

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
  checked.

## Token rules

- **Scripts first.** The driver and the scripts it wraps cost no tokens. Do not ask an agent for something a script
  can compute, and do not do a script's work in your own context.
- **Your context stays small.** You read this file once and the driver's one-line JSON; never an extract, a fragment,
  the digest, the synth file or the model, and no reference, script or agent file during a build.
- **Excerpts, not trees.** Explorers start from the prescan extract, use Grep and line ranges, never whole-tree reads,
  stay within 20 tool calls, and write fragments within the caps, one sentence per `desc` and `role`, no source excerpts.
- **The synthesizer reads the digest only**: the merge computes edges, zones, access rows and relations and pre-drafts
  sequences, so the agent confirms flows and writes views within 12 targeted reads.
- **The reviewer** receives the model, with targeted reads only to confirm a specific claim.
- **Update touches only affected areas**; it never re-explores the whole repo.
- **The ledger is the driver's.** Explorer, synthesizer and reviewer tokens reach it as `--usage` pairs; you never
  record a row yourself. It shows what the completion lines reported, not your own context, which
  `scripts/cost-profile.mjs` measures from the session transcript.
- **Profiles**, set with `--profile max|balanced|economy`, default `balanced`. The driver applies a profile as the
  `model` field of each Agent call it prints and records it in `meta.profile`:

| Profile | `archmap-explorer` | `archmap-synthesizer` | `archmap-reviewer` |
|---|---|---|---|
| `max` | Opus (high) | Opus (high) | Opus (high) |
| `balanced` (default) | Sonnet (low) | Sonnet (medium) | Opus (high) |
| `economy` | Haiku | Sonnet | Sonnet |

The balanced synthesizer moved from Opus to Sonnet because the digest leaves it no structural reasoning: the edges,
access rows and relations are computed and the main flows arrive drafted, so it confirms cited steps, picks 3-7
flows and names views. Opus stays on `max`; if balanced sequences come out thin, rerun with `--profile max`.
The agents' own frontmatter holds the `balanced` defaults, so for `balanced` no override is printed. Say in one line
which profile ran and what it trades off; `economy` may miss cross-area links, so flag thin results instead of padding.

## Final report

End with what render's `report` lists: the files written (paths), the validate command and its exit code, element
counts (nodes, edges, entities, sequences), what was not mapped, skipped or not checked and why, the profile, and the
usage ledger. State that the ledger shows what the agents' completion notifications reported and not the
orchestrator's own context. If anything is unverified, say that plainly.
