# Benchmark: archmap 1.0.0 against three other mapping plugins

On 2026-11-01 and 2026-11-02 the same architecture-mapping task was given to this plugin at 1.0.0 and to three other
mapping plugins for Claude Code: `draw-c4`, `oh-my-mermaid` and `cc-codemaps`. Each ran once on each of three private
repositories, under the same headless Claude Code 2.1.316 session with Opus as the orchestrator. The method was fixed
before the first run: the task prompt is [benchmark/prompt.md](benchmark/prompt.md), word for word for every tool, the
method is [benchmark/PROTOCOL.md](benchmark/PROTOCOL.md) (its `## Runs` section records what actually happened), the
owner's rubric is [benchmark/rubric.md](benchmark/rubric.md), and the choice of candidates is
[benchmark/CANDIDATES.md](benchmark/CANDIDATES.md). Every figure below comes from a tracked file under
`evidence/benchmark/`, and `tests/benchmark.test.mjs` fails when a cell of this page differs from it.

The repositories are named by letter only: (A) a Python API with a React front end and an embedded analytical
database, (B) a TypeScript monorepo with a Node API, an ORM and a job queue, (C) a Next.js application with an admin
API.

## Configurations

Each tool was loaded alone, from a clone at the pinned commit, with `claude --plugin-dir <clone>` and
`--setting-sources project`, so none of the owner's own plugins, skills or settings were in the session. The
marketplace install commands of the candidates are in [CANDIDATES.md](benchmark/CANDIDATES.md).

| Tool | Version | Install | Orchestrator model |
| --- | --- | --- | --- |
| `archmap` | 1.0.0, tag v1.0.0, commit bee1b5a | `claude --plugin-dir <clone>` of this repository at the tag | `opus` |
| `draw-c4` | 0.2.0, commit 90eea87 | `claude --plugin-dir <clone>` at the commit | `opus` |
| `oh-my-mermaid` | 0.2.0, commit 38ccdb6 | `claude --plugin-dir <clone>` at the commit, with its `omm` command line tool 0.2.0 installed locally under the workspace and put on `PATH` for its runs only | `opus` |
| `cc-codemaps` | 1.1.0, commit 0cf4b14 | `claude --plugin-dir <clone>` at the commit | `opus` |

## Results

One row per cell of the comparison: four tools on three repositories, one run each. Cost is the list price of the
whole run, all models and all subagents; seconds are the wall clock of the session; turns and max context are the
orchestrating session's only, context in thousands of tokens. Expectations are the five tool-neutral checks passed of
those graded. Rubric is the total of the four rubric axes (out of 20), followed by coverage, relations, flows and
readability. **The rubric scores were proposed by the orchestrator of the benchmark session and confirmed as their own by
the owner on 2026-11-02, after reading the artifacts, as the `scoredBy` of every summary.json cell records.**

| Tool | Repository | Run | Cost | Seconds | Orchestrator turns | Max context | Expectations | Rubric |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `archmap` | A | 1 | 1.61 USD | 238 | 25 | 85.1 K | 5/5 | 18 (5, 4, 4, 5) |
| `archmap` | B | 1 | 1.44 USD | 151 | 9 | 67.8 K | 5/5 | 16 (5, 3, 4, 4) |
| `archmap` | C | 2 | 1.38 USD | 171 | 10 | 64.8 K | 5/5 | 17 (5, 4, 4, 4) |
| `draw-c4` | A | 1 | 1.39 USD | 259 | 24 | 122.7 K | 4/5 (file references failed, 24 of 28) | 18 (4, 4, 5, 5) |
| `draw-c4` | B | 1 | 2.75 USD | 432 | 24 | 100.2 K | 5/5 | 17 (4, 4, 4, 5) |
| `draw-c4` | C | 2 | 1.48 USD | 327 | 27 | 114.1 K | 4/5 (file references failed, 22 of 23) | 18 (4, 4, 5, 5) |
| `oh-my-mermaid` | A | 1 | 1.94 USD | 421 | 30 | 131.7 K | 5/5 | 16 (4, 4, 4, 4) |
| `oh-my-mermaid` | B | 1 | 5.42 USD | 1030 | 84 | 158.7 K | 4/5 (file references failed, 71 of 76) | 15 (4, 4, 4, 3) |
| `oh-my-mermaid` | C | 2 | 1.77 USD | 321 | 43 | 106.1 K | 5/5 | 14 (4, 4, 3, 3) |
| `cc-codemaps` | A | 1 | 1.39 USD | 243 | 25 | 120.8 K | 5/5 | 15 (4, 4, 4, 3) |
| `cc-codemaps` | B | 1 | 2.16 USD | 483 | 58 | 121.5 K | 5/5 | 15 (4, 4, 4, 3) |
| `cc-codemaps` | C | 2 | 1.39 USD | 285 | 34 | 101.1 K | 5/5 | 15 (4, 4, 4, 3) |

The cost of each tool over the three repositories is the sum of its three profiles' `total.costUsd`, rounded once, so
it can differ by a cent from the sum of the rounded cells above.

| Tool | Cost over A, B and C |
| --- | --- |
| `archmap` | 4.43 USD |
| `draw-c4` | 5.62 USD |
| `oh-my-mermaid` | 9.13 USD |
| `cc-codemaps` | 4.95 USD |

This plugin was the cheapest over the three repositories and the only tool whose orchestrator stayed under 90 K
tokens of context in every run; it passed every expectation on all three, as did `cc-codemaps`. With one run per cell,
these differences are not shown to be larger than the run-to-run spread (see Limits).

### Issue recall, outside the comparison

This run is outside the comparison: this plugin on repository A with one more line in the prompt, asking for the
issues overlay. No candidate produces an issues layer, so it measures this plugin's recall only, and its cost and turns
are not comparable with the table above because its prompt differs. The recall of 0.933 is 14 of the 15 counted
reference issues of repository A.

| Tool | Repository | Run | Recall | Issues reported | Cost | Orchestrator turns |
| --- | --- | --- | --- | --- | --- | --- |
| `archmap-issues` | A | 1 | 0.933 | 23 | 2.38 USD | 11 |

## What each tool produced

In generic terms, from the graded artifacts and the rubric notes; the artifacts themselves stay private.

### archmap

One model JSON with evidence per node and per edge, an offline HTML viewer, a layout file and Mermaid exports, all
under `docs/architecture`. The maps had 46 to 148 nodes, 32 to 74 typed edges and 3 to 4 sequences per repository, and
passed every expectation on all three repositories. Its weak spot was repository A: 13 entities, but only 4 with
fields, because the database file is not in the checkout. It spawns explorer and synthesizer subagents and never runs
the code it analyses. One run (repository A) polled its background explorers and took 25 orchestrator turns instead of
the usual 9 to 11.

### draw-c4

One self-contained HTML page with C4 levels, a model JSON and a README. The maps had 39 to 42 nodes over 3 to 4
levels, 43 to 52 labelled edges whose only kind flag is async, and 6 to 8 flows with step cues. File references live in
node descriptions, and two of the three runs left a few components without one, which is the failed file-reference
check. On one repository it used Claude Code's built-in Explore subagent. It edited an existing README of one
repository, because a project instruction asked for new documents to be listed there, and wrote a generator script
into another.

### oh-my-mermaid

A tree of small Markdown and Mermaid files, one folder per perspective and per element, 103 to 200 files per run, with
labelled typed edges and element descriptions that carry paths. It drew sequence diagrams on one repository and flow
perspectives on the others. It was the most expensive cell of the benchmark: 5.42 USD, 84 turns and 1030 seconds on
repository B, where it used the built-in Explore subagent. On one repository it executed project code to confirm a bug
it had found, which this plugin never does. It wrote its tree twice on one repository (under `docs/architecture` and
at the repository root) and edited an existing README on another.

### cc-codemaps

Three to five Markdown files: component tables in which each row names its implementing file or folder, tables of
typed relations, an ASCII module graph, a data file with every table and its fields, and a flows file with numbered
steps. It passed every expectation on all three repositories, with no subagents and 25 to 58 orchestrator turns. It
edited an existing README on one repository. It renders no diagram and ships no viewer.

## Limits

- **One run per cell.** No variance is measured, so no difference above is claimed to be larger than the run-to-run
  spread; the evals README shows this plugin's own cost on one task varying between runs.
- **List prices.** Costs are list prices from the dated rate table of `scripts/cost-profile.mjs`, not what any
  account was billed.
- **Private repositories.** The repositories, the transcripts, the artifacts and the key-component checklists are
  private. A third party cannot re-run the cells; it can re-run the method with the same prompt, rubric and
  expectations on its own repositories.
- **Rubric.** The rubric scores were proposed by the orchestrator of the benchmark session and confirmed as their own
  by the owner on 2026-11-02, after reading the artifacts; a rubric is one person's judgement in any case.
- **Repository C is run 2.** The repository's own Claude Code configuration blocked two of the tools from writing their
  result in run 1, so run 1 on C was discarded for every tool, and every C cell is run 2 on a fresh clone without that
  configuration.
- **Who launched which cells.** Five cells were started by the owner from a terminal with the same `run-candidate.sh`
  command line, because the orchestrating session's permission classifier refused to launch third-party code:
  `draw-c4` on A, B and C, and `cc-codemaps` and `oh-my-mermaid` on C. The other cells were launched by the
  orchestrating session.
- **Models.** The orchestrator model is fixed to Opus, but the subagent models vary per tool: this plugin's subagents
  ran on Sonnet, the built-in Explore subagent of two cells ran on Opus, and the cost includes them all.
- **Four tools.** The candidates were chosen by the criteria of CANDIDATES.md; this is not a survey of every mapping
  plugin, and a candidate that changes after its pinned commit may behave differently.

## How each number was produced

Each cell was run by [benchmark/run-candidate.sh](benchmark/run-candidate.sh), which runs one headless `claude -p`
session from a fresh copy of the repository and writes its `stream-json` transcript and a `timing.json`. The
transcript was profiled with:

```sh
node scripts/cost-profile.mjs <stream.jsonl> --json --basename
```

and the profile saved exactly as it printed, one file per run, under `evidence/benchmark/` in this directory, named
`<tool>-<repository>-<run>.json`; `summary.json` beside them holds one record per cell. The columns come from:

- **Cost**: the profile's `total.costUsd`, rounded to two decimals, at the list prices of the
  rate table dated 2026-10-31 (the `rates` block of each file).
- **Orchestrator turns** and **max context**: the `turns` and the `maxContext` of the `orchestrator` row of the
  profile's `byAgent` (the context is the cache read, cache write and input of the largest turn).
- **Seconds**: `total_duration_seconds` of the run's `timing.json`, recorded as `seconds` in `summary.json`.
- **Expectations**: `passed` of `graded` in `summary.json`. The harness grades the five checks of PROTOCOL.md against
  the artifact on disk: key components (every key component of the repository's private checklist is named, by name
  or path), flows (at least three), file references (every component carries a path that exists, leaving out external
  systems, actors and the system boundary), artifact on disk (files under `docs/architecture`, or the tool's own
  documented location) and exit status (the run exits 0). None was recorded as not graded.
- **Rubric**: the four axes and the total of the `rubric` block in `summary.json`, proposed by the orchestrator and confirmed by the owner as stated above.
- **Recall** and **issues reported**: `recall` and `issuesReported` of the issues cell in `summary.json`, from
  `node skills/architecture-map/evals/score-recall.mjs <issues.json> <ground-truth.json> --json` against the private
  ground truth of repository A.

`tests/benchmark.test.mjs` (b21) reads the tables of this page and fails when a cost, turn or context cell differs from
the evidence file named below, or a seconds, expectations, rubric or recall cell differs from `summary.json`; b23
feeds it tampered copies to show that it does.

| Tool | Repository | Run | Evidence |
| --- | --- | --- | --- |
| `archmap` | A | 1 | `evidence/benchmark/archmap-A-1.json` |
| `archmap` | B | 1 | `evidence/benchmark/archmap-B-1.json` |
| `archmap` | C | 2 | `evidence/benchmark/archmap-C-2.json` |
| `draw-c4` | A | 1 | `evidence/benchmark/draw-c4-A-1.json` |
| `draw-c4` | B | 1 | `evidence/benchmark/draw-c4-B-1.json` |
| `draw-c4` | C | 2 | `evidence/benchmark/draw-c4-C-2.json` |
| `oh-my-mermaid` | A | 1 | `evidence/benchmark/oh-my-mermaid-A-1.json` |
| `oh-my-mermaid` | B | 1 | `evidence/benchmark/oh-my-mermaid-B-1.json` |
| `oh-my-mermaid` | C | 2 | `evidence/benchmark/oh-my-mermaid-C-2.json` |
| `cc-codemaps` | A | 1 | `evidence/benchmark/cc-codemaps-A-1.json` |
| `cc-codemaps` | B | 1 | `evidence/benchmark/cc-codemaps-B-1.json` |
| `cc-codemaps` | C | 2 | `evidence/benchmark/cc-codemaps-C-2.json` |
| `archmap-issues` | A | 1 | `evidence/benchmark/archmap-issues-A-1.json` |
