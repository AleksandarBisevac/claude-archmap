# Roadmap after 1.0.0

Version 1.0.0 maps application code: a backend, a frontend and a Python service, into one evidence-backed model and an
offline viewer (see the [README](../README.md) and the [design](design.md)). This page lists what comes next, in order.
Each item says what it delivers and what evidence closes it. An item is closed by evidence in the repository, such as a
passing test, a committed fixture or a tracked cost profile, never by a statement alone.

## v1.1: data platforms, pipelines and infrastructure

Delivers extraction of the parts of a system that are not application code, added to the stack references and to the
prescan so that a map shows them with the same file:line evidence, confidence and provenance as every other node:

- Data platform projects: dbt projects and transforms and datasets of a data platform, described generically as
  models, sources, tests and their lineage edges, with no product-specific vocabulary in the model.
- Containers: Docker and compose files, as services, images, ports, volumes and the dependencies between services.
- Pipelines: GitHub Actions and Azure Pipelines workflows, as jobs, triggers, stages and the artefacts they pass on.
- Infrastructure as code: Terraform and Bicep, as resources, modules and the references between them.

Closed by: a small fixture repository per kind under `tests/fixtures/`, a prescan test for each extractor that checks
node, edge and evidence output, the model schema still accepting every committed map (backward compatible), and one
build of a mixed fixture whose cost profile is tracked beside the existing ones.

## CI drift gate on /archmap:check

Delivers a mode of `/archmap:check` that exits non-zero when the committed map no longer matches the code, so a pull
request pipeline can refuse a change that leaves the map stale. The staleness hook of 1.0.0 stays silent and always
exits 0; the gate is a separate, explicit command.

Closed by: a test that runs the gate on a fixture with a changed file and sees a non-zero exit, and on an unchanged
fixture and sees zero, plus a documented workflow snippet in the README.

## Ownership, churn and coverage overlays

Delivers three overlays on the application graph, next to the issues overlay: who owns a node (from the ownership
file and history), how often its files change (churn) and how much of it the tests cover (coverage). Overlays are
separate files, so the model itself does not change.

Closed by: a fixture overlay per kind, a render test that shows the overlay toggle in the viewer, and the clean render
still carrying no overlay text.

## Entity state machines

Delivers state machines for entities that have a status or lifecycle field: the states, the transitions and the code
that performs each transition, drawn in the viewer and exportable like the sequences.

Closed by: a fixture entity with a known lifecycle, a model test that checks every transition has file:line evidence,
and an export test for the state diagram.

## Architecture diff between two commits

Delivers a comparison of the map at two commits: nodes, edges and entities added, removed or moved, shown in the
viewer and as a Markdown summary. It extends the file-to-node mapping `diffmap` already does.

Closed by: a test over two committed fixture models with a known set of differences, and a determinism check that the
same two inputs give byte-identical output.

## Open bug BUG-5-6o1, closed on 2026-11-02

Closed on 2026-11-02 by the regression test m31 of `tests/merge.test.mjs`, the fix at commit `ddbd0be` (an edge written
to an area whose evidence lines name a file that exactly one node of that area owns now targets that node, not the area
hub) and the rebuilt committed map: `docs/architecture/` is a fresh `/archmap:build` at that commit, 43 nodes and 25
edges, and its SessionStart hook edge targets the node that holds `scripts/staleness.mjs`. Both READMEs state the new
counts.

An edge target was resolved to the wrong script node: in the committed map of this repository the session-start hook
edge pointed at the pipeline script node instead of the node that holds the staleness script. It was documented in the
evals README as a known build error of that map.

Closed by: a regression test that builds the case and asserts the edge target, then a rebuilt committed map whose
counts the README and the evals README state again.

## Reviewer recall per release

Delivers the issues reviewer's recall, measured against a labelled overlay, recorded for each release instead of once.
The 1.0.0 figure is the one in the evals README.

Closed by: a tracked recall figure for every release in the changelog, derived by the existing recall scorer, and a
test that fails when a release entry lacks the figure.

## Benchmark against other plugins (after 1.0.0), closed on 2026-11-02

Closed on 2026-11-02 by the report `skills/architecture-map/evals/BENCHMARK.md`, against the criterion below: it is
repo-free (the repositories are named by letter and a generic description, with no client and no machine path); the
task is the tracked prompt `skills/architecture-map/evals/benchmark/prompt.md`; the plugin versions and commits are in
`skills/architecture-map/evals/benchmark/CANDIDATES.md` and the report's configuration table; the rate table date,
2026-10-31, is in the report and in the `rates` block of every profile; and the raw cost profiles are tracked under
`skills/architecture-map/evals/evidence/benchmark/`, where `tests/benchmark.test.mjs` re-derives every figure of the
report from them. The task prompt is public, but the repositories it ran on are private, so a third party re-runs the
method on its own repositories, not the cells; the report says so in its limits.

Delivers a comparison of the same build task run with this plugin and with other architecture and codebase-mapping
plugins for Claude Code: cost, turns, context, and how many of the facts the task needs each map gets right. It is
parked as proposal PROP-2 in the audit plan and starts once 1.0.0 is released.

Closed by: a repo-free report, meaning it names no private repository, client or machine path, built from a public or
synthetic task, with the task, the plugin versions, the rate table date and the raw cost profiles tracked so every
figure can be re-derived, in the manner of the README cost table.
