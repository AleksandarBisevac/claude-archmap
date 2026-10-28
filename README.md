# archmap

> **Status: pre-release (0.x).** The plugin is being built; commands are not usable yet. See [docs/design.md](docs/design.md).

archmap is a Claude Code plugin that maps a repository's architecture into one evidence-backed model
(`docs/architecture/architecture.model.json`) and renders it as a self-contained, offline HTML viewer:

- application graph (C4 levels 1–3) with typed, colour-coded relations and responsibility zones;
- ER diagram with fields, keys, cardinality and per-field provenance (declared / observed / inferred);
- sequence diagrams, CRUD matrix and data lineage, deployment and trust-boundary views;
- `file:line` evidence on every element;
- an optional, architecture-level issues overlay that can be switched off, and is never in the committed build;
- cheap incremental updates from git diffs, with a layout that stays stable.

## Install

```
/plugin marketplace add AleksandarBisevac/claude-plugins
/plugin install archmap@quality-gates
```

For local development:

```
/plugin marketplace add /path/to/claude-archmap
/plugin install archmap@archmap-dev
```

## Planned commands

| Command | Purpose |
|---|---|
| `/archmap:build` | Analyse the repo and write the model and `archmap.html` |
| `/archmap:update` | Re-analyse only what changed since the model's commit |
| `/archmap:check` | Report staleness (exit code for CI) |
| `/archmap:issues` | Run the issues pass, optionally importing audit findings |
| `/archmap:export` | Export Mermaid, PlantUML, SVG/PNG or Markdown |
| `/archmap:render` | Re-render HTML from the model (no LLM) |

## Requirements

Node.js ≥ 18. No npm dependencies (elkjs is vendored).

## License

MIT. The vendored elkjs is EPL-2.0; its notice ships next to it.
