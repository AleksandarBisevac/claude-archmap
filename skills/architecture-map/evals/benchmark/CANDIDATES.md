# Benchmark candidates

The release-1.0.0 benchmark runs the same build task on the same evaluation repositories with this plugin (archmap
1.0.0) and with the plugins below. This document fixes which plugins are compared, at which version, and how they
are installed. It was written on 2026-11-01; the facts about each candidate are what its public repository states on
that date, and where the README is the only source the text says so.

The short name in the first column of the candidates table (`draw-c4`, `oh-my-mermaid`, `cc-codemaps`) is the name
later evidence files use.

## Selection criteria

A plugin is a candidate only if it meets all four of the first criteria; the fifth decides between candidates that
meet them.

- **Installable**: publicly installable into Claude Code as a plugin with `claude plugin marketplace add` and
  `claude plugin install` (or a `--plugin-dir` of a public clone), with no account or API key beyond Claude Code
  itself.
- **Headless**: works under `claude -p`; the artifact is written to files, not shown only in a viewer process or in
  the chat answer.
- **Whole repository**: produces an architecture artifact of the whole repository (components and their relations at
  least), not a per-file summary and not the walkthrough of one feature.
- **Maintained**: a commit within the twelve months before 2026-11-01, and an open-source license.
- **Different form**: when the choice is wide, prefer a different artifact form from the others (interactive HTML,
  Mermaid, Markdown), so that the comparison covers more than one output style.

## Candidates

| Name | Source | Version | Install | Output |
|---|---|---|---|---|
| `draw-c4` | https://github.com/ShibaInu0817/draw-c4-skill | plugin.json 0.2.0, commit 90eea87a0fe3 (2026-10-29), MIT | `claude plugin marketplace add ShibaInu0817/draw-c4-skill` then `claude plugin install draw-c4@draw-c4-skill` | `architecture.html` (one self-contained file with up to four C4 levels, pan and zoom, inspector, step-through flow player and search) and `model.json` (nodes, edges, levels, flows) |
| `oh-my-mermaid` | https://github.com/oh-my-mermaid/oh-my-mermaid | plugin.json 0.2.0, tag v0.2.0, commit 38ccdb69298a (2026-04-07), MIT | `claude plugin marketplace add oh-my-mermaid/oh-my-mermaid` then `claude plugin install oh-my-mermaid@oh-my-mermaid` | a `.omm/` directory with one folder per perspective, each with `diagram.mmd` (Mermaid graph), `description.md`, `context.md` and optional constraint, concern, todo and note fields |
| `cc-codemaps` | https://github.com/STRML/cc-codemaps | plugin.json 1.1.0, commit 0cf4b1484a2f (2026-04-13), MIT | `claude plugin marketplace add STRML/cc-codemaps` then `claude plugin install cc-codemaps@cc-codemaps` | Markdown files under `codemaps/` (`architecture.md` always, plus `backend.md`, `frontend.md`, `data.md`, `integrations.md` and `workers.md` when they apply), with tables, code blocks and ASCII diagrams |

Each of the three also runs from a clone with `claude --plugin-dir <clone>`. The commit in the Version column is the
one pinned for the benchmark.

How each is started:

- `draw-c4`: the skill `draw-c4` (slash command `/draw-c4:draw-c4`), which triggers on requests such as "show me the
  architecture" or "diagram my codebase". Its bundled scripts need Python 3 and its standard library only.
- `oh-my-mermaid`: the skill `omm-scan` ("scan architecture", "update architecture"); `omm-view` and `omm-push` are
  separate skills. `omm-scan` needs the `omm` command line tool from npm (`npm install -g oh-my-mermaid`) and
  installs it itself when it is missing. An account on its web service is needed only for `omm push`, which the
  benchmark does not use.
- `cc-codemaps`: the skill `update-codemaps` (user-invocable as `/update-codemaps`). It detects the project language
  from CLAUDE.md, the README or build markers (TypeScript and JavaScript, Python, Go, Rust, C and C++, PHP, Java and
  Kotlin, Ruby, Swift, C#, Lua). No dependencies are listed. It targets fewer than 200 lines per file and
  regenerates the files in full on each run.

### What each produces compared with this plugin

This plugin produces components, typed relations, database entities with fields, sequences, evidence references per
element and an issues layer, in one model rendered as an offline HTML viewer.

| Name | Components | Relations | Entities | Sequences | Evidence | Issues |
|---|---|---|---|---|---|---|
| `draw-c4` | yes, up to four C4 levels | yes, typed edges | no (the README states no ER view) | yes, runtime flows with a step-through player | not stated (the README does not state file references per node) | no |
| `oh-my-mermaid` | yes, as Mermaid graphs | yes, labelled edges | no (a storage perspective lists the stores) | flows as perspective graphs (request lifecycle, data flow), not step sequences | file paths in node labels, not file and line | a free-text concern field per element |
| `cc-codemaps` | yes, as a module map in text | as an ASCII module graph | data types and schemas as text in `data.md` | no | file paths in tables | no |

## Considered and rejected

| Name | Source | Criterion | Reason |
|---|---|---|---|
| `design-explainer` | https://github.com/Scrigo/design-explainer | Headless | The result is a likeC4 model shown by a local browser viewer process that the skill starts; the README names Linux or WSL2 and says macOS is untested; it needs `npx likec4` at run time. |
| `c4-skill` (C4 Structurizr) | https://github.com/bitsmuggler/c4-skill | Installable | Installed by cloning and symlinking a command file into the user's Claude commands directory, with no marketplace flow; diagram export needs Docker (Structurizr, PlantUML); no license file. |
| `code-map` | https://github.com/stack-muse/code-map | Installable | A bare skill directory without `.claude-plugin`, installed by copying it into the user's skills directory or into the analysed repository, so it cannot be installed alone into an isolated plugin set. |
| `codegraph-mapper` | https://github.com/MythEclipse/codegraph-mapper | Maintained | Its README says the features moved into another plugin (`coder-workflow`), so the standalone plugin is superseded. |
| `walkthrough` | https://github.com/alexanderop/walkthrough | Whole repository | Explains one feature or flow; not an architecture artifact of the whole repository. |
| `codebase-explorer` | https://github.com/quicksilversurfer/codebase-explorer | Whole repository | Answers in the chat; not an architecture artifact of the whole repository. |
| `ProvenMap` (`prov-claude`, `pmap-claude`) | https://github.com/provenmap/prov-claude | Installable | The architecture board lives on a hosted portal that needs an account. |
