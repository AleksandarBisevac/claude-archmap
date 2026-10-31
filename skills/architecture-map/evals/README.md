# architecture-map evals

Five evals for the `architecture-map` skill, in the format of the `skill-creator` plugin (`evals.json`:
`skill_name`, and per eval an `id`, `prompt`, `expected_output` and checkable `expectations`). They follow
`docs/design.md`, section 10.

| Eval | Repository | What it checks |
| --- | --- | --- |
| 1 | A (FastAPI, React, DuckDB) | build: model validates, every node has evidence, at least 3 sequences, entities carry observed fields (or `meta.sources` records the skip), key components present |
| 2 | A | the same build with `--issues`: clean HTML has no issue ids, recall of at least 60 percent of high and medium reference issues |
| 3 | A, in a temporary git worktree | update after a new route and a new column: only affected nodes change, pins survive, `meta.commit` advances, tokens far below a full build |
| 4 | B (Hono, Drizzle monorepo) | Drizzle entities with declared fields and FKs, BullMQ edges async, each app a container |
| 5 | C (Next, Drizzle admin API) | smaller second-round build check |

## Repositories are never written into the tracked files

This repository is public. The eval prompts name no repository, path or client: they say "the repository whose
location is in the environment variable ...". Point three variables at local checkouts before you run anything:

```sh
export ARCHMAP_EVAL_REPO_A=<checkout of the FastAPI + React + DuckDB repository>
export ARCHMAP_EVAL_REPO_B=<checkout of the Hono + Drizzle monorepo>
export ARCHMAP_EVAL_REPO_C=<checkout of the Next + Drizzle admin API repository>
```

Eval 1 and 2 need `ARCHMAP_EVAL_REPO_A`, eval 3 also uses A (in a worktree), eval 4 needs `ARCHMAP_EVAL_REPO_B`, and
eval 5 needs `ARCHMAP_EVAL_REPO_C`. Install the `duckdb` CLI (or a Python `duckdb` module) to exercise the observed
fields of eval 1; without it the eval expects `meta.sources` to record the skipped introspection.

The key-component checklists and the issue ground truth stay in `.private/reference/` of the archmap checkout and are
referenced by path relative to `.private` only. They are not tracked.

## Workspace

Run directories live outside this repository, under `.claude/archmap/evals/` in your home directory
(`<home>/.claude/archmap/evals/`), one directory per iteration (`iteration-1/`, `iteration-2/`, ...) with an
`eval-<id>/with_skill/` and `eval-<id>/without_skill/` inside. Eval 3 puts its temporary worktree there too.
Issues files and internal HTML are never written inside an analysed repository.

## Running with skill-creator

1. Install `skill-creator` from the official plugin marketplace and the `archmap` plugin.
2. Export the three variables above in the shell that starts Claude Code.
3. Ask skill-creator to run the evals of `skills/architecture-map/evals/evals.json`. For every eval it spawns two
   runs in the same turn: **with-skill** (the skill is available) and **without-skill** (the baseline, no skill), each
   into its own `eval-<id>/` directory of the workspace above. Capture the tokens and duration of each run as it
   finishes.
4. Grade each run against its `expectations` (skill-creator's grader agent, or by script for the objective ones:
   `validate.mjs`, `grep` of the clean HTML for issue ids, `diffmap.mjs`, `git rev-parse HEAD` against `meta.commit`).
5. Aggregate into `benchmark.json` and review as the owner in the viewer:

   ```sh
   python3 <skill-creator>/eval-viewer/generate_review.py <workspace>/iteration-1 --skill-name architecture-map --benchmark <workspace>/iteration-1/benchmark.json
   ```

   Add `--static <out>.html` when no browser can be opened. Leave feedback per run in the viewer; the next iteration
   reads it.
6. Comparing the balanced and max profiles on eval 1 (`--profile max` against the default) through the token ledger
   is how the profiles would be priced against each other. That run was not measured: the max run was stopped before
   it finished, so this README makes no claim that balanced is cheaper than max. The cost claim rests on the
   with-skill against no-skill table below.

The phase is done when evals 1 to 5 have run with and without the skill and the owner has reviewed them, issue recall
is at least 60 percent, and the trigger description has been optimised with skill-creator's `run_loop`. The
balanced-versus-max comparison is not part of what was measured; it stays open for a later eval round.

## Cost of a build: before and after the script-driven flow

Measured with `scripts/cost-profile.mjs` on the `stream-json` transcript of a headless run, at list prices, on the
same evals and the same repositories. Iteration 1 let the orchestrating session hold every fragment and the whole
model in its context; iteration 2 runs the build through `scripts/pipeline.mjs` (plan, finish, render, issues),
explorers write their fragment to a file and reply in three lines, and merge.mjs computes entities, relations,
cross-area edges and zones. The baseline is the same prompt without the skill, on the same orchestrator model.

| Eval | Iteration 1, with skill | Iteration 2, with skill | Baseline, no skill | Orchestrator turns | Result |
| --- | --- | --- | --- | --- | --- |
| 1 (build) | 13.78 USD | 1.16 USD | 1.55 USD | 11 | 7/7 expectations |
| 2 (build, issues) | 9.71 USD | 2.02 USD | 2.29 USD | 17 | first run 7/7; reruns 6/7; issue recall over three runs 0.67, 0.53, 0.53 (mean 0.58) |
| 3 (update) | 6.40 USD | 1.89 USD | 1.00 USD | 29 | 8/8 expectations; baseline 0/8 |
| 4 (monorepo build) | 12.55 USD | 1.57 USD | 1.82 USD | 11 | 8/8 expectations |
| 5 (build) | 9.53 USD | 1.65 USD | 2.96 USD | 13 | 7/7 expectations; baseline 0/7 |

The iteration-1 cells of evals 1, 2 and 4 are 13.78, 9.71 and 12.55 USD, where the private log, the P10 phase
description and the first version of this table quote 13.84, 9.79 and 12.79 USD. The cells are re-derived from the
tracked profiles at the current rate table, in which the Sonnet 5.5 cache-read price was halved in P8.8 (0.20 to 0.10
USD per million tokens, the pricing page's 0.05x input), applied to the Sonnet explorers' cache reads of those runs;
the Opus-only baselines did not move.

The eval 2 row shows its first run: the cost, the turns and the first grade are that run's
(`evidence/iteration-2/2-with-skill-1.json`), and only the result cell carries all three runs: the recall cell lists
the values of the first run, rerun 1 and rerun 2, in that order, each from `score-recall.mjs` on that run's issues
overlay (the table "Eval 2, run by run" below gives every figure with the run and the evidence file it comes from). Eval 3 is an update: the session builds the map of repository A and then updates it after a
new route and a new column, so its 29 turns cover two flows and the 12-turn target of a single build does not apply
to it, and eval 5 took 13 turns, one over the target. The iteration-1 figures of evals 3 and 5 come from their iteration-1 transcripts by the same script. The
no-skill baselines of evals 3 and 5 score 0 because their expectations are archmap-shaped (the validate script, the
model file, the viewer), so their cost column is therefore not a like-for-like comparison.

Eval 2 was run six times, on two versions of the reviewer. Three runs were on the final P8 code: the first run (the row
above) and two reruns, after the P8.5 and P8.8 changes. The first run exceeded the 12-turn target with 17 turns because the `--issues` flow adds two steps (the
reviewer dispatch and the issues step) and the session spent five turns reading script sources to learn where the
overlay goes when the caller wants it outside the repository and how to print and copy the ledger. SKILL.md now names
both in its build flow (audit task P10.19), and the reruns confirm the five source-reading turns are gone: they took
11 and 13 orchestrator turns (11 meets the target, 13 is one over it), 2.05 and 1.80 USD, and a context of at most
69.6 K tokens, against 17 turns and 2.02 USD. Evals 1 and 4 stay within the target, and the orchestrator's context
never exceeds 72 K tokens in evals 1, 2 and 4. Rerun 1 is the profile `evidence/iteration-2/2-with-skill-2.json` and
rerun 2 is `evidence/iteration-2/2-with-skill-3.json`.

Issue recall over the three eval 2 runs on the P8 reviewer is 0.67 (10 matched), 0.53 (8 matched) and 0.53 (8 matched),
a mean of 0.58, so two of the three runs and the mean were below the 60 percent threshold; each rerun graded 6/7, and the
expectation it failed is the recall one. Four medium reference issues, one each in performance, security, reliability
and design, were missed in all three runs. The reviewer returned 14 issues in the first run and 12 in each rerun.

P11.1 changed the reviewer: every pattern of the issues catalogue now names the targeted reads the reviewer must make
(the entry point's exception handlers, writes to the process environment, the loop around a bulk pull, the client's
readiness call), and a readiness and loading-state pattern was added. P11.2 ran eval 2 three more times on that
reviewer, one run at a time (P11.2 run 1 to 3 below). All three P11.2 runs reach a recall of 0.93 (14 of 15 high and
medium reference issues matched), above the 0.60 threshold, and each graded 7/7. Each misses one issue, a different one
in each run (by category reliability, reliability and security), so none of the four issues missed in all three first
runs is missed in every P11.2 run. The orchestrator took 12, 13 and 14 turns (12 meets the 12-turn target, the other
two are one and two over it) at 2.58, 2.40 and 2.61 USD, under the 5 USD target and under twice the 2.29 USD baseline.
The reviewer returned 18 issues in each of these runs, in 13 to 19 reviewer turns, and the runs cost about 0.6 USD more
on average than the P8 ones (mean 2.53 against 1.96 USD).

Eval 2, run by run. The recall comes from `score-recall.mjs` on the issues overlay of the run against the reference
issues (private, like the transcripts); the other figures are from the evidence profile in the row. The missed column
counts the missed high and medium reference issues by category. The P11.2 runs sit under `iteration-2/` because the
workspace they ran in is its `iteration-2`.

| Run | Reviewer | Evidence | Orchestrator turns | Cost | Max context | Recall | Missed (by category) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| first run | P8 | `evidence/iteration-2/2-with-skill-1.json` | 17 | 2.02 USD | 71.7 K | 0.67 | security 2 (one high), performance 1, reliability 1, design 1 |
| rerun 1 | P8 | `evidence/iteration-2/2-with-skill-2.json` | 11 | 2.05 USD | 68.5 K | 0.53 | security 3, reliability 2, performance 1, design 1 |
| rerun 2 | P8 | `evidence/iteration-2/2-with-skill-3.json` | 13 | 1.80 USD | 69.6 K | 0.53 | security 2, reliability 2, performance 2, design 1 |
| P11.2 run 1 | P11.1 | `evidence/iteration-2/2-with-skill-4.json` | 12 | 2.58 USD | 68.9 K | 0.93 | reliability |
| P11.2 run 2 | P11.1 | `evidence/iteration-2/2-with-skill-5.json` | 13 | 2.40 USD | 69.4 K | 0.93 | reliability |
| P11.2 run 3 | P11.1 | `evidence/iteration-2/2-with-skill-6.json` | 14 | 2.61 USD | 69.4 K | 0.93 | security |

The self-build is a build of this repository itself, with the balanced profile and without `--issues`, run the way
eval 1 is run, and the table below has one row per run of it. It is the one run whose whole output is public: the repository, its model and the profile of its
transcript can all be shared, which the repositories of the evals cannot. The cost, turns, context and model figures are
from the evidence profile of each row (the model split is its `byModel` block: the Opus orchestrator, and the Sonnet
explorers and synthesizer); the map counts are those of the `architecture.model.json` the run built, as its build
report lists them, and each model passed `validate.mjs` with `--repo`, exit 0.

- **Run 1** built commit `2faa6de`, before the P8.5 and P8.9 skip of fixture directories; its model is not tracked.
- **Run 2** built commit `8174e41`, the head of this branch after P11.5, and is the committed map: its model, layout and
  clean viewer are `docs/architecture/architecture.model.json`, `docs/architecture/architecture.layout.json` and
  `docs/architecture/archmap.html` at the repository root, unchanged from the run. The drop from 63 to 30 nodes is the
  P8.5 and P8.9 skip of fixture directories: in the run 1 model, 32 of the 63 nodes and 15 of the 16 entities cite
  only files under `tests/fixtures/`, which prescan now skips as test data.

| Build | Evidence | Cost | Orchestrator turns | Orchestrator max context | Opus | Sonnet | Nodes | Edges | Entities | Sequences | Views |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| self-build run 1 (balanced, no issues) | `evidence/iteration-2/self-with-skill-1.json` | 1.11 USD | 12 | 58.4 K | 12 turns, 0.50 USD | 51 turns, 0.62 USD | 63 | 28 | 16 | 4 | 5 |
| self-build run 2 (balanced, no issues), the committed map | `evidence/iteration-2/self-with-skill-2.json` | 1.00 USD | 10 | 57.6 K | 10 turns, 0.44 USD | 49 turns, 0.56 USD | 30 | 18 | 1 | 4 | 5 |

Where the money goes in iteration 2, in percent of each run's cost. The figures are shares of the result-event total
(the per-model figure in the table above); the per-agent rows come from the stream, whose output counts are a lower
bound, so the output the stream under-counts is not attributed to any agent and is its own column.

| Eval | Explorers | Orchestrator | Synthesizer | Reviewer | Not attributed (stream output under-count) |
| --- | --- | --- | --- | --- | --- |
| 1 | 38.4 | 28.2 | 5.9 | - | 27.4 |
| 2 | 16.8 | 20.5 | 3.6 | 23.5 | 35.6 |
| 4 | 41.8 | 25.1 | 8.2 | - | 24.8 |

Eval 2 adds the reviewer on the larger model (23 percent of its run). The ten rounds that led here are in the private results log; each round's root causes became a fix task of the
audit plan (P10.6 to P10.15).

### How each number was produced

Every cost, turn and context figure above is the output of one command on the `stream-json` transcript of the run
(the transcripts stay in the private workspace, they are not tracked):

```sh
node scripts/cost-profile.mjs <stream.jsonl> --json --basename
```

The profile is saved as it printed, one file per run, under `evidence/<iteration>/<eval>-<configuration>-<run>.json`
in this directory, named by eval number and configuration only. `--basename` records the transcript by its base name,
so a profile carries no directory of the machine that ran it. The cost is the profile's `total.costUsd` rounded to two
decimals, at the list prices of the rate table dated 2026-10-31 (the `rates` block of each file); a price change moves
every figure, so the table is re-derived whenever the date moves. The turns and the context are the `orchestrator`
row of `byAgent`: its `turns`, and its `maxContext` in tokens (cache read + cache write + input of the largest turn).
Two rules decide what a figure is. The per-model figure, and so the cost, is the last `result` event's `modelUsage`,
which is cumulative for the session; the per-agent output is the stream's lower bound, because the stream counts
output at emission time. Where the stream's input and cache sums differ from that result event (iteration 1 of eval 4,
iteration 2 of eval 3: `reconciliation.matchesModelUsage` is false in their files), the cost is still the result
event's. `tests/evals.test.mjs` (e19) reads this section and the cost table and fails when a cell, a turn count or the
stated maximum context differs from the file it names.

| Eval | Evidence, iteration 1 | Evidence, iteration 2 | Evidence, baseline | Evidence, other baseline runs |
| --- | --- | --- | --- | --- |
| 1 | `evidence/iteration-1/1-with-skill-1.json` | `evidence/iteration-2/1-with-skill-1.json` | `evidence/iteration-2/1-without-skill-1.json` | `evidence/iteration-1/1-without-skill-1.json` |
| 2 | `evidence/iteration-1/2-with-skill-1.json` | `evidence/iteration-2/2-with-skill-1.json` (first run), `evidence/iteration-2/2-with-skill-2.json` and `evidence/iteration-2/2-with-skill-3.json` (reruns) | `evidence/iteration-1/2-without-skill-1.json` | - |
| 3 | `evidence/iteration-1/3-with-skill-1.json` | `evidence/iteration-2/3-with-skill-1.json` | `evidence/iteration-2/3-without-skill-1.json` | `evidence/iteration-1/3-without-skill-1.json` |
| 4 | `evidence/iteration-1/4-with-skill-1.json` | `evidence/iteration-2/4-with-skill-1.json` | `evidence/iteration-1/4-without-skill-1.json` | - |
| 5 | `evidence/iteration-1/5-with-skill-1.json` | `evidence/iteration-2/5-with-skill-1.json` | `evidence/iteration-2/5-without-skill-1.json` | `evidence/iteration-1/5-without-skill-1.json` |

The baseline column takes the iteration-2 baseline run where there is one (evals 1, 3 and 5) and the iteration-1
baseline for evals 2 and 4, which were not rerun; the other baseline run of each eval is tracked beside it. The profiles
of the builds of this repository by its own skill are `evidence/iteration-2/self-with-skill-1.json` (run 1) and
`evidence/iteration-2/self-with-skill-2.json` (run 2, the committed map). The three P11.2
runs are `evidence/iteration-2/2-with-skill-4.json` to `evidence/iteration-2/2-with-skill-6.json`, named in the eval 2
run-by-run table, and e19 reads that table and the self-build rows against these files too.
