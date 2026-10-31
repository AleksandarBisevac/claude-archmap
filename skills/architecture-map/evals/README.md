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
6. Compare the balanced and max profiles on eval 1 (`--profile max` against the default) through the token ledger: the
   balanced profile must be cheaper.

The phase is done when evals 1 to 5 have run with and without the skill and the owner has reviewed them, issue recall
is at least 60 percent, and the trigger description has been optimised with skill-creator's `run_loop`.

## Cost of a build: before and after the script-driven flow

Measured with `scripts/cost-profile.mjs` on the `stream-json` transcript of a headless run, at list prices, on the
same evals and the same repositories. Iteration 1 let the orchestrating session hold every fragment and the whole
model in its context; iteration 2 runs the build through `scripts/pipeline.mjs` (plan, finish, render, issues),
explorers write their fragment to a file and reply in three lines, and merge.mjs computes entities, relations,
cross-area edges and zones. The baseline is the same prompt without the skill, on the same orchestrator model.

| Eval | Iteration 1, with skill | Iteration 2, with skill | Baseline, no skill | Orchestrator turns | Result |
| --- | --- | --- | --- | --- | --- |
| 1 (build) | 13.84 USD | 1.22 USD | 1.55 USD | 11 | 7/7 expectations |
| 2 (build, issues) | 9.79 USD | 2.09 USD | 2.29 USD | 17 | 7/7, issue recall 0.67 |
| 4 (monorepo build) | 12.79 USD | 1.66 USD | 1.82 USD | 11 | 8/8 expectations |

Where the money goes in iteration 2 (eval 1): explorers 41 percent, orchestrator 36 percent, synthesizer 7 percent;
the orchestrator's context never exceeds 72 K tokens. Eval 2 adds a reviewer on the larger model (23 percent of its
run). The ten rounds that led here are in the private results log; each round's root causes became a fix task of the
audit plan (P10.6 to P10.15).
