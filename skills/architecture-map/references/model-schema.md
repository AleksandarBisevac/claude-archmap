# Model schema

The model is one JSON file, `docs/architecture/architecture.model.json`, validated against
`schema/archmap-model.schema.json`. Agents write only this file; a bundled renderer turns it into HTML.
Do not invent keys the schema lacks. Required keys per object are marked **req**.

## Top-level keys

`meta`, `zones`, `nodes`, `edges` are required. `entities`, `relations`, `access`, `sequences`, `views` are optional.

| Key | Holds |
|---|---|
| `meta` | Provenance of the whole model (below). |
| `zones[]` | Trust and deployment regions. `{id, kind, label, parent?, outside?}`. Kinds are in relation-taxonomy.md. |
| `nodes[]` | Architecture components. `{id, zone, kind, title, paths, level, evidence}` req; `sub[]`, `role`, `facts[]`, `locked`, `notes` optional. |
| `edges[]` | Typed relations between nodes. `{id, from, to, type, desc, evidence, confidence}` req; `label`, `foundBy` (`static`, `llm`, `introspection`), `async` optional. |
| `entities[]` | Stored data shapes. `{id, store, name, kind, fields}` req; `indexes`, `evidence` optional. `kind` is `table`, `view`, `collection` or `dataset`. |
| `relations[]` | ER links between entity fields. `{from{entity, field}, to{entity, field}, cardinality, kind, provenance}`, all req. `cardinality` is `1-1`, `1-n` or `n-m`; `kind` is `fk`, `join` or `name-convention`. |
| `access[]` | CRUD matrix rows. `{node, entity, ops}` req, `evidence` optional. `ops` is a non-empty subset of `CRUD` with no letter repeated, in that order (for example `CR`, `RU`). |
| `sequences[]` | Sequence diagrams. Grammar in sequences.md. |
| `views[]` | Named projections. `{id}` req; `title`, `nodes[]`, `zones[]` optional; `kind` (`graph`\|`deployment`\|`trust`) optional, picks the viewer's renderer (without it the viewer guesses from the id and title). |

An `entity` field is `{name, type, provenance}` req plus `pk`, `fk{entity, field}`, `nullable`, `evidence[]`.
A `node.level` is the C4 level: 1, 2 or 3.

## meta keys

| Key | Rule |
|---|---|
| `schemaVersion` **req** | Semantic version string of the model contract. |
| `project` **req** | Project name. |
| `commit` **req** | The commit the model was analysed at. `update` and the staleness check compare it to HEAD. |
| `generatedAt` **req** | ISO timestamp of the run. |
| `repoUrl` | Base URL used to turn evidence into links. |
| `profile` **req** | `max`, `balanced` or `economy`. |
| `sources` **req** | Array of introspections run or skipped, and why (a skipped step is recorded here, never dropped). |
| `coverage` **req** | Object: area name to array of globs. Drives `update`, which re-analyses only areas whose files changed. |

## The evidence rule

Every node and every edge carries `evidence`: a non-empty array of `{path, lines}`. `path` is repo-relative;
`lines` is `N` or `N-M` (digits only, for example `42` or `10-24`). Entities, fields and access rows carry evidence too
whenever it exists. An element that cannot cite a file and lines does not enter the model; put it in the explorer's
`skipped` tally instead. Quote nothing from the source, cite it.

## Provenance

Entity fields and relations carry `provenance`:

- `declared`: stated in code or schema files (ORM model, migration, DDL, Pydantic or OpenAPI).
- `observed`: read from a live schema by read-only introspection (schema only, never rows).
- `inferred`: concluded from names or usage (for example a `user_id` column with no declared FK).

Edges carry the separate `confidence` scale (`verified`, `inferred`, `external`), explained in relation-taxonomy.md.

## User-authored fields

`locked` and `notes` on a node, and `pinned` in the layout file `docs/architecture/architecture.layout.json`,
belong to the user. Update and merge never overwrite or drop them. A locked node keeps its authored content;
new evidence may be attached only through a reported conflict, not silently.

## Compatibility

Readers tolerate unknown keys. Writers should not rely on that: emit only schema keys. Removing or renaming a key
needs a major `schemaVersion`; adding an optional key is minor.

## Explorer fragment contract

An `archmap-explorer` returns exactly one JSON object per area. The merge script consumes it; prose around it is
discarded, so return JSON only. Keep it size-capped: at most about 40 nodes, 80 edges, 60 entities and 80 access rows
per fragment (split the area otherwise), `desc` and `role` one sentence each, no source excerpts.

```json
{
  "area": "billing-api",
  "nodes": [],
  "edges": [],
  "entities": [],
  "access": [],
  "coverage": ["services/billing/**"],
  "skipped": { "count": 3, "reasons": ["generated clients", "vendored code"] }
}
```

Rules:

- `nodes`, `edges`, `entities`, `access` are partial arrays using the model's own element shapes. Each element
  carries `evidence` as above. Nodes need `id`, `zone`, `kind`, `title`, `paths`, `level`; edges need `from`, `to`,
  `type`, `desc`, `confidence`. The `id` strings are proposals; the merge script dedupes and renames on collision.
- Edges may point at node ids owned by another fragment. Use the id the prescan or the area map gave you.
- `coverage` lists the globs the explorer actually read. These become `meta.coverage[area]`.
- `skipped` tallies what was seen and left out: `count` and short `reasons`. Never silently omit.
- Do not emit `meta`, `zones`, `sequences`, `views`, `locked` or `notes`. The synthesizer owns those.
- Do not emit an element without evidence, and do not guess lines: cite the lines you read.
