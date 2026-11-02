# Benchmark protocol: the same build task, this plugin against other mapping plugins

The release-1.0.0 benchmark gives one task to this plugin (archmap 1.0.0) and to the plugins listed in
`CANDIDATES.md`, on the same repositories, with the same orchestrator model and the same headless flags, and compares
what each costs and what each produces. This document is the method, written before any cell was run. It names no
repository, path of a machine or client; a third party reproduces the method on its own repositories.

Three documents hold the method. This one states it. `prompt.md` is the task, the whole file being the prompt every
tool receives, word for word. `rubric.md` is the owner's score. `CANDIDATES.md` fixes which plugins are compared, at
which commit, and how each is installed. The short names used below and in the evidence file names are `archmap` (this
plugin) and the names in the first column of the candidates table: `draw-c4`, `oh-my-mermaid`, `cc-codemaps`.

## Repositories

Three repositories, referred to everywhere in tracked files by letter and by these descriptions only:

- (A) a Python API with a React front end and an embedded analytical database
- (B) a TypeScript monorepo with a Node API, an ORM and a job queue
- (C) a Next.js application with an admin API

They are private. Each one is a local checkout, and its location is given to the session in an environment variable
that no tracked file fills in: `ARCHMAP_EVAL_REPO_A`, `ARCHMAP_EVAL_REPO_B` and `ARCHMAP_EVAL_REPO_C`, the variables
the evals README sets up. `prompt.md` carries the placeholder `<ENV_NAME>` where the variable's name belongs;
`run-candidate.sh` (below) replaces it with the variable of the repository of the cell (`ARCHMAP_EVAL_REPO_A` for a
run on repository A, and so on) before it hands the prompt to the session, and changes nothing else. Every cell runs
on a fresh copy of the repository at the same commit, so no cell reads the output of another.

The key components of each repository are listed in a checklist kept private under `.private/reference/` of the
archmap checkout (one file per repository) and never tracked. The issue ground truth of repository A is there too.

## Configurations

One configuration per tool. Each is loaded alone, through `claude --plugin-dir <clone>` on a clone of its repository
at the commit that `CANDIDATES.md` pins (for this plugin, a clone at the tag `v1.0.0`), with
`--setting-sources project`, so that none of the owner's own plugins, skills or user settings load into the session. An
isolated Claude Code configuration directory was tried instead and is not logged in, so the benchmark uses plugin
directories of clones.

The session is one headless invocation, the same for every tool, made by `run-candidate.sh` (below):

```sh
env -u CLAUDECODE claude -p "<prompt>" --plugin-dir <clone> --model opus \
  --output-format stream-json --verbose --setting-sources project \
  --permission-mode auto --permission-prompts none
```

run from the root of the fresh copy of the repository, with the variable of the cell exported and pointing at that
copy. The flags other than `--plugin-dir` and `--model` are those the evals of the evals README run with; the README
records the transcript format (`stream-json`) and the variables, and `run-candidate.sh`, tracked beside this
document, passes every one of them (b13 of `tests/benchmark.test.mjs` checks them and their order). The orchestrator
model is Opus for every cell (`--model opus`), so that a difference in cost is not a difference in model. Subagents
use whatever model the tool itself chooses; that is part of what is measured.

Each cell is run by `run-candidate.sh`, beside this document, which takes every location as an argument:

```sh
run-candidate.sh <run-dir> <ENV_NAME> <prompt-file> (--plugin-dir <dir> | --plugin <name@marketplace> --marketplace <url-or-path>) \
  [--model <model>] [--path-prepend <dir>] [-- <extra claude args>]
```

It runs the session above from `<run-dir>/repo` with `<ENV_NAME>` exported to that directory and the prompt file's
`<ENV_NAME>` placeholder replaced by the variable's name, unsets `CLAUDECODE` (through `env -u`), and writes into `<run-dir>` only: `stream.jsonl`, `stderr.log`, `exit-code`, `timing.json`
(`started` and `finished` in epoch seconds and `total_duration_seconds`) and `command.txt`, the command line it ran
with the prompt given by its file path. `--plugin-dir` passes a clone through (the benchmark's mode); `--plugin`
instead adds the marketplace and installs the plugin, at project scope of the repository copy, under an isolated
configuration directory `<run-dir>/config`, and records the installed version in `plugin-version.txt`. That directory
starts logged out, so it must be logged in once (`claude /login` with `CLAUDE_CONFIG_DIR` set to it) before a session
can run there. `--path-prepend <dir>` puts a directory first on `PATH` for the session only, which is how the tool
whose CLI is installed under the workspace gets its `node_modules/.bin`; `--model` and the arguments after `--` are
passed to `claude`. The script exits 2 on a usage error and otherwise with the session's exit status.

One run per cell: four tools on each of three repositories, twelve runs. A tool whose installation needs a command line
program from npm gets that program installed locally under the workspace, not globally, and the workspace's
`node_modules/.bin` is put on `PATH` for the run of that tool only.

One more run is outside the comparison table: this plugin on repository A with one extra line added to the prompt, a
line asking for the issues overlay ("Also produce the issues overlay: the risks you find in the system, each one
tied to a component."). It exists only to measure issue recall, which no candidate produces. Its cost and turns are
recorded in its evidence file but are not compared with the table's, because its prompt differs. Its short name in the
evidence files is `archmap-issues`.

## Metrics

Every figure comes from a file the run left, never from the model's own report of itself.

- **Cost** in USD: `node scripts/cost-profile.mjs <stream.jsonl> --json --basename` on the run's `stream-json`
  transcript; the figure is the profile's `total.costUsd`, rounded to two decimals, over all models and all subagents of
  the run. It is a list price from the rate table of `scripts/cost-profile.mjs` (`RATES`), whose date is recorded in the
  `rates` block of each saved profile; this protocol was written against the table dated 2026-10-31. A price change
  moves every figure, so the comparison is re-derived from the transcripts whenever the date moves.
- **Duration** in seconds: wall-clock time of the headless session, `total_duration_seconds` of the `timing.json` that
  `run-candidate.sh` writes from the clock read just before the session starts and just after it exits.
- **Turns**: the `turns` of the `orchestrator` row of the profile's `byAgent`. It counts the orchestrating session's
  turns only; subagent turns are in their own rows and in the cost.
- **Context**: the `maxContext` of the same `orchestrator` row, in tokens (cache read, cache write and input of the
  largest turn).
- **Pass rate**: the share of the tool-neutral expectations below that the run meets, graded against the artifact on
  disk by the tracked grader `grade-benchmark.mjs` beside this document,
  `node skills/architecture-map/evals/benchmark/grade-benchmark.mjs <run-dir> <A|B|C> <tool> <checklist.json>`
  (Expectations, below). It is passed over graded, and an expectation recorded as not graded counts in neither.
- **Recall**: the issue recall of this plugin only, on the issues-overlay run, with
  `node skills/architecture-map/evals/score-recall.mjs <issues.json> <ground-truth.json> --json` against the private
  ground truth of repository A. The candidates do not produce an issues layer, so their recall is not applicable.
- **Rubric**: the owner's score from `rubric.md`, four axes of 1 to 5, proposed by the orchestrator of the
  benchmark session and confirmed by the owner as their own after reading each artifact (on 2026-11-02 for the
  recorded runs; the confirmation is recorded in the sign-off summary of phase P12 in `docs/audit/audit-plan.json`,
  dated 2026-11-02).
  It is the only judgement in the table and the only figure no tracked script produces.

## Expectations

The same checks for every tool, stated in terms that need no archmap file, graded by `grade-benchmark.mjs`, tracked
beside this document (Node 18, no dependencies):

```sh
node skills/architecture-map/evals/benchmark/grade-benchmark.mjs <run-dir> <A|B|C> <tool> <checklist.json> \
  [--draw-c4-plot <plot.py>]
```

It reads the cell `run-candidate.sh` left: `<run-dir>/repo`, whose artifacts are the files `git status` reports new
or changed by the run, and `<run-dir>/exit-code`. It writes `<run-dir>/grading.json` and prints the summary line. The
checklist is the repository's key-component checklist, a JSON file
`{"A": [{"component": "<name>", "terms": ["<substring>", ...]}, ...], "B": [...], "C": [...]}` passed by its path;
the benchmark's own checklists stay private under `.private/reference/` and none is tracked. `--draw-c4-plot` names
`draw-c4`'s own `plot.py`, which extracts the model from its HTML page when the run left no `model.json`; without
either, the flows and file references of `draw-c4` are not graded. The script's header states how each check reads
each tool's output, and `tests/benchmark.test.mjs` (b24 to b31) runs it on synthetic cells. A check is graded when it
can be done mechanically from the artifact; otherwise it is recorded as not graded, with the reason.

- **Key components**: each key component of the repository's private checklist is named in the produced artifact,
  matched by its name or by its path. The result is reported as found over listed, and the expectation passes only
  when every one is found.
- **Flows**: the artifact describes at least three flows (request or data flows as steps between components).
- **File references**: every component in the artifact carries a file reference, a file or folder path (for this
  plugin, the evidence of each node of its model). Elements a tool marks as external systems, actors or the system
  boundary are left out, and a route table is not a component table. The check is that a reference is there; whether
  its path exists in the repository is not checked.
- **Artifact on disk**: the artifact is one or more files under `docs/architecture` of the repository, not only text in
  the chat answer. For a tool that writes to a fixed location of its own, the location its README documents counts, and
  the evidence file records that location.
- **Exit status**: the run exits 0.

A check that cannot be done mechanically on a tool's output (a flow drawn only inside an interactive viewer, a
reference that sits in an image) is recorded as not graded and does not count as failed. Where a check is not graded
the evidence file says why, and the owner's rubric still covers the artifact.

## Limits

- One run per cell, so no variance is measured and no claim is made that a difference is larger than the run-to-run
  spread. The evals README shows this plugin's own cost on one task differing from run to run.
- Costs are list prices from a dated rate table, not what any account was billed.
- The repositories and the transcripts are private. A third party cannot re-run the cells; it can re-run the method
  with the same prompt, rubric and expectations on its own repositories, and the evidence files show what was measured.
- Four tools are compared, chosen by `CANDIDATES.md` on the criteria it states; this is not a survey of every
  mapping plugin, and a plugin that changes after its pinned commit may behave differently.
- The orchestrator model is fixed to Opus, but a tool may start subagents on other models, which the cost includes.
- The rubric is one person's judgement, the owner's, so it carries that person's bias; the other metrics do not.

## Evidence

One JSON file per run, tracked, under `skills/architecture-map/evals/evidence/benchmark/`, named
`<tool>-<repo-letter>-<run>.json` (for example `cc-codemaps-B-1.json`; the issues run is `archmap-issues-A-1.json`).
Each per-run file is the profile exactly as `cost-profile.mjs --json --basename` printed it, with nothing added.
`summary.json` beside them holds one record per cell naming its evidence file, with the duration from `timing.json`,
the exit status, the result of each expectation (`pass`, `fail` or `not graded` with the reason), the recall where it
applies and the rubric scores. The raw `stream-json` transcripts, the produced artifacts and the key-component
checklists stay private and are not tracked.

## Runs

- **Dates**: the run-1 cells on 2026-11-01 (evening, CET); the cells the owner started and the run-2 cells on
  repository C on 2026-11-02 (morning).
- **Claude Code**: Claude Code 2.1.316. **Orchestrator model**: `opus` for every cell (`--model opus`); subagents
  used whatever model each tool chose.
- **Rate table**: the `RATES` table of `scripts/cost-profile.mjs` dated 2026-10-31, the `rates.date` of every evidence
  file.
- **Versions**, all as `CANDIDATES.md` pins them:
  - `archmap`: this plugin at the tag v1.0.0 (commit bee1b5a).
  - `draw-c4`: 0.2.0 at commit 90eea87.
  - `oh-my-mermaid`: 0.2.0 at commit 38ccdb6, with its `omm` command line tool 0.2.0 installed locally under the
    workspace.
  - `cc-codemaps`: 1.1.0 at commit 0cf4b14.
- **Who launched which cells**: the orchestrating session ran this plugin's cells, the issues-overlay run, and
  `cc-codemaps` and `oh-my-mermaid` on A and B. The Claude Code auto-mode permission classifier refused to launch the
  other third-party cells from that session ("code from an external source"), so the owner started them from a
  terminal with the same `run-candidate.sh` command line: `draw-c4` on A, B and C, and `cc-codemaps` and
  `oh-my-mermaid` on C.
- **Deviation on repository C**: in run 1 project-level tooling of that repository interfered with the writes of two
  tools (and left two unaffected), so run 1 on C was discarded for every tool, and run 2 was made for all four tools on
  fresh clones with the repository's project-level Claude Code configuration removed (from the clone only). The C
  evidence files are therefore `<tool>-C-2.json`; the discarded run-1 profiles stay private.
- **Expectations**: the 13 cells were graded with the rules of `grade-benchmark.mjs`: the tracked script reproduces
  the private grader used on 2026-11-01/02 rule for rule, giving the same results and the same summary line on the
  same cell (only the evidence text of a check not graded now states its reason; the counts of the comparison, taken
  on 2026-11-03, are in `evidence/benchmark/grader-equivalence.json` and in BENCHMARK.md). None is recorded as not graded;
  every expectation of every tool was graded mechanically. The file reference check ("every component carries a file
  reference") leaves out the elements a tool marks as external systems, actors or the system boundary.
- **Rubric**: the scores in `summary.json` were proposed by the orchestrator and confirmed by the owner as their own
  on 2026-11-02, after reading the artifacts, as each cell's `scoredBy` records and as the sign-off summary of phase P12
  in `docs/audit/audit-plan.json` (dated 2026-11-02) records in the owner's own words.
- **Recall**: the `archmap-issues` run on A (`archmap-issues-A-1.json`, outside the comparison table) has a recall of
  0.933, 14 of the 15 counted reference issues with one miss, and reported 23 issues.
- **Side effects observed**: two candidates edited an existing README of the repository they mapped (a project
  instruction asked for new documents to be listed there); one candidate ran project code to confirm a bug it found;
  one candidate wrote a generator script into the repository; one candidate wrote its tree twice, under
  `docs/architecture` and at the repository root. This plugin wrote only under `docs/architecture`, and wrote its
  issues overlay outside the repository.
- **Originals**: the three source repositories were compared with a snapshot taken before the benchmark after every
  wave of cells, and were unchanged.
