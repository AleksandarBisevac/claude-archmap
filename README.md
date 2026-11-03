# archmap

archmap is a Claude Code plugin that maps a repository's architecture into one evidence-backed model
(`docs/architecture/architecture.model.json`) and renders it as a self-contained, offline HTML viewer
(`docs/architecture/archmap.html`). Agents read the code and write the model; tested scripts merge, validate, lay out
and draw it. The design is in [docs/design.md](docs/design.md).

## Status

Released: version 1.1.0 is a Claude Code plugin that maps a repository's architecture into one evidence-backed model
and renders it as an offline HTML viewer; beyond the 1.0.0 application map, 1.1 adds compose services, pipelines and
jobs, IaC resources and dbt models and sources, with the flow player; see the [CHANGELOG](CHANGELOG.md).
All six commands below work and are covered by the test suite and by five evals on three private repositories plus a
build of this repository (see [What a build costs](#what-a-build-costs)).

What comes next is in the [roadmap](docs/roadmap.md).

## Install

```
/plugin marketplace add AleksandarBisevac/claude-plugins
/plugin install archmap@quality-gates
```

For local development, from a clone of this repository:

```
/plugin marketplace add <path to your clone>
/plugin install archmap@archmap-dev
```

## Commands

Each row is the `description` and `argument-hint` of the command's file in `commands/`.

| Command | Arguments | What it does |
| --- | --- | --- |
| `/archmap:build` | `[--issues] [--profile max\|balanced\|economy] [--db dsn] [--scope path] [--publish]` | Build the evidence-backed architecture map of this repository - model, layout and a self-contained offline HTML viewer in docs/architecture/. |
| `/archmap:check` | none | Check whether the architecture map is behind HEAD. Script only, no analysis and no model run; exit 0 when fresh, 1 when stale. |
| `/archmap:export` | `mermaid\|plantuml\|svg\|png\|md [--view v]` | Export the architecture model as Mermaid, PlantUML, SVG, PNG or Markdown files, with no analysis and no model run. Exports are clean, with no issues. |
| `/archmap:issues` | `[--import-audit] [--profile max\|balanced\|economy]` | Review the architecture map for architecture-level issues, optionally importing open audit findings; the overlay is written outside the repository. |
| `/archmap:render` | `[--internal\|--shared]` | Re-render the architecture map HTML from the existing model, with no analysis and no model run. Default is the clean build in docs/architecture/. |
| `/archmap:update` | `[--issues] [--profile max\|balanced\|economy] [--since sha]` | Refresh the architecture map after code changes - re-analyses only the areas git says changed, keeps locked nodes, notes and pinned positions. |

`build`, `update` and `issues` run agents; `check`, `export` and `render` are scripts only and spend no tokens. The
profile sets the models of the agents: `balanced` (the default) runs the explorers and the synthesizer on Sonnet and
the issues reviewer on Opus; `max` runs all of them on Opus; `economy` runs the explorers on Haiku and the other
two on Sonnet.

## What a build delivers

One model, `docs/architecture/architecture.model.json`, checked against `schema/archmap-model.schema.json`:

- **nodes**: the components (browser apps, services, data stores, external systems, platforms) at C4 levels 1 to 3,
  each with `file:line` evidence. Beyond application code a build also maps four kinds of non-code parts: compose
  services (from Dockerfiles and compose files), pipelines and jobs (GitHub Actions and Azure Pipelines), IaC
  resources (Terraform and Bicep) and dbt models and sources, with their tests and lineage; they carry the same
  evidence, confidence and provenance as every other node;
- **edges**: typed calls, reads, writes and messages between them, each with evidence and a confidence of
  `verified`, `inferred` or `external`, so what was read in code is kept apart from what was inferred;
- **entities**: tables, views, collections and datasets with their fields, keys and per-field provenance
  (`declared` from ORM models, migrations or DDL, `observed` from read-only introspection of a file database,
  `inferred` from queries in code);
- **relations** between entities with cardinality, and **access**: which component creates, reads, updates or
  deletes which entity, the CRUD matrix and the data lineage;
- **sequences**: step-through request and job flows, which a sequence whose participants name graph nodes can also
  play on the architecture graph (Play on graph: previous, next, play and the arrow keys light each message's two
  components and the relation between them and dim the rest);
- **views**: the application graph and the deployment and trust-boundary views.

The viewer, `docs/architecture/archmap.html`, is one self-contained file that works offline: the application graph
with responsibility zones, the ER diagram, the sequence diagrams, the CRUD matrix and lineage, search and a path
finder, every element linked to its evidence. The layout is computed at build time and stored in
`docs/architecture/architecture.layout.json`, so nodes keep their place from one build to the next and can be pinned.

The issues overlay is opt-in (`--issues`, or `/archmap:issues` later): a reviewer agent looks for architecture-level
issues anchored to nodes, edges, entities or sequence steps. The overlay and the HTML that shows it are written to
`<home>/.claude/archmap/<repo-slug>/`, outside the repository, so they never enter the committed build; the committed
`archmap.html` carries no issue.

After code changes, `/archmap:update` re-analyses only the areas whose files git says changed and keeps locked nodes,
notes and pinned positions. A SessionStart staleness hook prints one line when the model is behind HEAD (and nothing
otherwise), and `/archmap:check` gives the same answer as an exit code for CI.

This repository carries its own map, built by its own skill (balanced profile, without `--issues`): it is the map of a
build made at commit `ddbd0be`, updated with `/archmap:update` at commit `549c3c3` (the 1.1.0 head) and committed
unchanged. Open
[docs/architecture/archmap.html](docs/architecture/archmap.html) for the viewer, beside its model and layout in
`docs/architecture/`. The model has these counts, as its build report lists
them; it passed `validate.mjs --repo`. The figures are those of the committed-map row of the self-build table in
[the evals README](skills/architecture-map/evals/README.md). From that commit on, the SessionStart staleness hook
reports in this repository whenever the map falls behind HEAD, which is the hook working as designed.

| Nodes | Edges | Entities | Sequences | Views |
| --- | --- | --- | --- | --- |
| 51 | 41 | 1 | 4 | 6 |

## What a build costs

Cost at list prices of a headless run of each eval, with the skill and without it (the baseline: the same prompt on
the same orchestrator model with no skill). "Before" is the same eval in iteration 1, when the orchestrating session
held every fragment and the whole model in its own context; the other columns are iteration 2, the script-driven
flow, where `scripts/pipeline.mjs` runs every scripted step and the explorers write their fragments to files. The
turns and the context are those of the orchestrating session. Each file in the Evidence column is under
`skills/architecture-map/evals/evidence/`. Evals 1 to 5 ran on three private repositories; the self-build rows are the
builds of this repository and its update at the release head, the runs whose whole output can be shared. The
mixed-platform row is one build of the `tests/fixtures/repos/mixed-platform` fixture (a small Node API, a compose file,
a GitHub Actions workflow, a Terraform module and a dbt project), which is public too.

| Eval | With skill | Baseline, no skill | Orchestrator turns | Orchestrator max context | Before: iteration 1, with skill | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (build) | 1.16 USD | 1.55 USD | 11 | 62.9 K | 13.78 USD, 38 turns, 278.9 K | 7/7 expectations | with skill `iteration-2/1-with-skill-1.json`; baseline `iteration-2/1-without-skill-1.json`; before `iteration-1/1-with-skill-1.json` |
| 2 (build with `--issues`), current reviewer, three runs | 2.40 to 2.61 USD | 2.29 USD | 12 to 14 | 68.9 to 69.4 K | 9.71 USD, 45 turns, 262.9 K | 7/7 in each run; issue recall 0.93 in each run | with skill `iteration-2/2-with-skill-4.json`, `iteration-2/2-with-skill-5.json`, `iteration-2/2-with-skill-6.json`; baseline `iteration-1/2-without-skill-1.json`; before `iteration-1/2-with-skill-1.json` |
| 3 (build, then update) | 1.89 USD | 1.00 USD | 29 | 94.5 K | 6.40 USD, 46 turns, 193.6 K | 8/8 expectations; baseline 0/8 | with skill `iteration-2/3-with-skill-1.json`; baseline `iteration-2/3-without-skill-1.json`; before `iteration-1/3-with-skill-1.json` |
| 4 (monorepo build) | 1.57 USD | 1.82 USD | 11 | 67.7 K | 12.55 USD, 67 turns, 267.4 K | 8/8 expectations | with skill `iteration-2/4-with-skill-1.json`; baseline `iteration-1/4-without-skill-1.json`; before `iteration-1/4-with-skill-1.json` |
| 5 (build) | 1.65 USD | 2.96 USD | 13 | 75.7 K | 9.53 USD, 47 turns, 271.4 K | 7/7 expectations; baseline 0/7 | with skill `iteration-2/5-with-skill-1.json`; baseline `iteration-2/5-without-skill-1.json`; before `iteration-1/5-with-skill-1.json` |
| self-build (balanced, no issues) | 1.00 USD | - | 10 | 57.6 K | - | model validates | with skill `iteration-2/self-with-skill-2.json` |
| self-build update (balanced, no issues) | 0.80 USD | - | 11 | 54.6 K | - | model validates | with skill `iteration-2/self-with-skill-3.json` |
| self-build (balanced, no issues) | 1.65 USD | - | 16 | 72.6 K | - | model validates | with skill `iteration-2/self-with-skill-4.json` |
| self-build update (balanced, no issues), the committed map | 0.92 USD | - | 11 | 50.4 K | - | model validates | with skill `iteration-3/self-with-skill-5.json` |
| mixed-platform build (balanced, no issues) | 0.50 USD | - | 9 | 45.1 K | - | model validates | with skill `iteration-3/mixed-with-skill-1.json` |

Read the table with these caveats, which [the evals README](skills/architecture-map/evals/README.md) states in full:

- **Eval 3 is two flows.** The session builds the map and then updates it after a new route and a new column, so its
  29 turns cover a build and an update, and the 12-turn target of a single build does not apply to it.
- **The baselines of evals 3 and 5 are not like for like.** Their expectations are archmap-shaped (the validate
  script, the model file, the viewer), so the no-skill runs score 0 and their cost buys a different, ungraded output.
- **Eval 2 recall depends on the reviewer.** The row is the three runs on the current reviewer, each matching 14 of
  15 high and medium reference issues. The three earlier runs, on the reviewer before its catalogue named the reads
  it must make, reached 0.67, 0.53 and 0.53 (mean 0.58, below the 0.60 threshold) at 1.80 to 2.05 USD; their figures
  are in the evals README's run-by-run table.
- **The baselines of evals 2 and 4 are iteration-1 runs**, as they were not rerun; the iteration-1 baselines of the
  other evals are tracked beside the iteration-2 ones.
- Eval 5 took 13 turns and eval 2 up to 14, one and two over the 12-turn target of a build.
- **The committed map is an update, not a fresh build.** It is the `/archmap:update` of the build made at commit
  `ddbd0be` (the run 4 row, the third `self-build` row, 1.65 USD in 16 orchestrator turns), run at `549c3c3`:
  it cost 0.92 USD in 11 orchestrator turns, and its orchestrator's median context was 43.7 K tokens,
  against 55.2 K for the build. The earlier update row (run 3) is the same comparison one build earlier:
  `/archmap:update` re-analysed only the areas whose files changed between the build at `8174e41` and `63d7495`,
  so it cost 0.80 USD against the build's 1.00 USD; its orchestrator's median
  context was 47.3 K tokens, against 46.4 K for the build.

The 1.0.0 build was also benchmarked against three other mapping plugins for Claude Code, on the same prompt and the
same three repositories, for cost, duration, turns, expectations passed and a rubric score:
[the benchmark report](skills/architecture-map/evals/BENCHMARK.md) gives every figure and the evidence it comes from.

## How these numbers were measured

- **Cost, turns and context.** Every run was a headless `claude -p` session whose `stream-json` transcript was
  profiled with `node scripts/cost-profile.mjs <stream.jsonl> --json --basename`. The cost is the profile's
  `total.costUsd` at the list prices of the rate table dated 2026-10-31 (the `rates` block of each file), taken
  from the session's last `result` event; the turns and the context are the orchestrator row of `byAgent`, the
  context being the largest turn's cache read + cache write + input. The profiles are tracked under
  `skills/architecture-map/evals/evidence/`, one file per run; the transcripts themselves stay private.
- **Results.** Each run was graded against the `expectations` of its eval in
  `skills/architecture-map/evals/evals.json`, by script where the expectation is objective (`validate.mjs`, a search
  of the clean HTML for issue ids, `diffmap.mjs`, `meta.commit` against `git rev-parse HEAD`).
- **Issue recall.** `skills/architecture-map/evals/score-recall.mjs` scores the run's issues overlay against the
  private reference issues: a reference issue of high or medium severity counts as recalled when a produced issue
  has its category and its anchor or one of its keywords.
- **Tests.** `node --test`, from the repository root, runs more than 400 test cases over the scripts, the schema, the
  viewer, the commands and the skill, with no npm dependency.
- **The checks behind this page.** `tests/readme.test.mjs` fails when a row of the command table differs from its
  file in `commands/`, or when a figure of the cost table differs from the profile its row cites;
  `tests/evals.test.mjs` does the same for every figure of
  [the evals README](skills/architecture-map/evals/README.md), which gives the method, the run-by-run figures and
  where the money goes in each run.

## Requirements

Node.js 18 or later. No npm dependencies (elkjs is vendored). PNG export needs a headless Chromium.

## License

MIT. The vendored elkjs is EPL-2.0; its notice ships next to it.
