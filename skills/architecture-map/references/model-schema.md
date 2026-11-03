# Model schema

The model is one JSON file, `docs/architecture/architecture.model.json`, validated against
`schema/archmap-model.schema.json`. Only the orchestrator writes this file; a bundled renderer turns it into HTML.
Do not invent keys the schema lacks. Required keys per object are marked **req**.

## Top-level keys

`meta`, `zones`, `nodes`, `edges` are required. `entities`, `relations`, `access`, `sequences`, `views` are optional.

| Key | Holds |
|---|---|
| `meta` | Provenance of the whole model (below). |
| `zones[]` | Trust and deployment regions. `{id, kind, label, parent?, outside?}`. Kinds are in relation-taxonomy.md. |
| `nodes[]` | Architecture components. `{id, zone, kind, title, paths, level, evidence}` req; `sub[]`, `role`, `facts[]`, `locked`, `notes` optional. |
| `edges[]` | Typed relations between nodes. `{id, from, to, type, desc, evidence, confidence}` req; `label`, `foundBy` (`static`, `llm`, `introspection`), `async` optional. |
| `entities[]` | Stored data shapes. `{id, store, name, kind, fields}` req; `indexes`, `evidence`, `provenance` optional. `kind` is `table`, `view`, `collection` or `dataset`. `provenance` is `declared`, `observed` or `inferred`; merge sets `inferred` (no fields) on a table that SQL in the code names and nothing declares. |
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
| `sources` **req** | Array of introspections run or skipped, and why (a skipped step is recorded here, never dropped: a file database the code opens by path literal, `duckdb.connect("data/x.duckdb")` or `sqlite3.connect(...)`, whether or not the file is in the repository, is one `{type: "introspection-skipped", kind, path, status: "skipped", reason}` row when the file does not exist or no CLI or module can read it, and the reason names the missing file or the missing tool); also one row per explorer fragment and a `truncation` or `normalisation` row, naming the area and the counts, when the merge cut or fixed one; and one `derivation` row when the merge computed the cross-area layer from the prescan extracts, with the counts it derived and the links or statements it could not cite; and one `{type: "queue-unpaired", queue, node, missing, note}` row for each queue the code feeds but nothing in it works, or the reverse (`missing` is `consumer` or `producer`, `node` the queue node, `note` the cited side), so the gap is visible and nothing is added to the model for it; and one row for each thing the merge corrected or dropped in a fragment or a synthesizer return, naming the area: `clamped-evidence` or `dropped-evidence` (an evidence range cut to the file or an entry removed, with the `id` and `path`), `dropped-ref` (a reference to a node, entity or field that does not exist, with its `target`), `dropped-changed` (an element removed because its files changed and the explorer no longer reports it) and `dropped-step` (a synthesizer step or sequence that matches no step shape, with the `sequence`). |
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

An `archmap-explorer` writes exactly one JSON object per area to the fragment path its brief names
(`<work>/fragments/<area>.json`) and replies with three lines only (path, counts, tool calls); the fragment never travels
in a reply. The merge script reads the directory. It does not bounce a fragment back: it normalises common slips
(numeric or `L12-L14` evidence lines, a string `level`, a missing `level`, `paths` or `confidence`, lowercase `ops`) and
truncates to the caps below, keeping the first elements listed, so list the most structural ones first. A truncation or a
normalisation is recorded in `meta.sources` as a row with the area and the counts. Caps per fragment: 40 nodes, 80 edges,
60 entities and 80 access rows (split the area otherwise), `desc` and `role` one sentence each, no source excerpts.

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
- A subtree in `coverage` is written `dir/**`; a bare directory glob such as `src/api` matches only that literal path, not the files under it (`merge.mjs` and `diffmap.mjs` match it that way).
- `skipped` tallies what was seen and left out: `count` and short `reasons`. Never silently omit.
- Do not emit `meta`, `zones`, `sequences`, `views`, `locked` or `notes`. `merge.mjs` fills `meta` and the zones,
  the synthesizer writes sequences and views, and `locked` and `notes` belong to the user.
- Do not emit an element without evidence, and do not guess lines: cite the lines you read.
- Two areas that describe the same directory give the node the same `paths`; the merge keeps one (the first area's id)
  and rewrites the references, so a shared module needs no coordination between explorers.

## What the merge computes

From the per-area prescan slices (`merge.mjs --extracts <work>/extracts --repo .`) the merge adds, each with evidence:

- cross-area `edges[]`: an HTTP call to a route (`api`), a queue producer and its consumer each to the queue's own node
  (`queue`, `async`: the merge makes one `<name>-queue` node per queue, or uses the explorer's node of that name), an
  import (`call`), between the nodes that own the two files (the node whose `paths` match, deepest `level` first),
  `confidence: verified` on an exact match and `inferred` (said in `desc`) when an HTTP route matched through a
  wildcard segment or an import line names the module by its file name only (a call path of wildcards only makes no
  edge), `foundBy: static`; an edge the explorer already drew between the same nodes is not repeated;
- nodes and edges for the container, pipeline, infrastructure and data platform stacks, from the slices' `images`,
  `services`, `pipelines`, `jobs`, `passes`, `resources`, `iacModules`, `iacReferences`, `dbtModels`, `dbtSources` and
  `lineage` rows, each cited at the lines the extractor read and `foundBy: static`, `confidence: verified`: a compose
  service is a `service` node (`store` or `queue`, in the `data` zone, when it only runs a database or broker image;
  `paths` its build context, its Dockerfile cited too), a pipeline file a `pipeline` node and each job or stage a `job`
  node in the `delivery` zone, a Terraform or Bicep resource a `resource` node and a Terraform module a `module` node in
  the `platform` zone, a dbt model a `model` node and a dbt source a `source` node in the `data` zone. The edges are
  `depends` (a compose `depends_on`, a job's `needs`, an infrastructure reference: `from` depends on `to`), `artifact`
  (a build output handed from the job that uploads it to the one that downloads it) and `lineage` (the upstream model or
  source to the model that reads it). A node an explorer already made for the same service, pipeline, job, resource or
  model (same id or title, or the same cited block) is used as it is, never repeated; a reference to something the
  extract does not declare (a variable, a package model) makes no edge. At most 150 nodes are made per stack; the rest
  are counted in the `derivation` row;
- `access[]` rows from the SQL statements of the slices (`select` R, `insert` C, `update` U, `delete` D) for the node
  owning the file, on the entity modelling the table; from the slices' ORM models (R for the code node declaring the
  model); and from the queue producers (C) and consumers (R) where an entity models the queue;
- `relations[]` from declared foreign keys: an entity field's `fk`, and an ORM table's `fk=` in the slice
  (`kind: fk`, `cardinality: 1-n`, the field's provenance);
- one zone per spelling of a zone id, and a zone for a node that had none: the zone of the deepest slice container
  directory (a Dockerfile's or compose file's directory, not the root) holding all its paths, labelled with that
  directory, else one from its kind and its area's stacks.

In update mode an area whose fragment file is unreadable keeps its previous elements (a conflict says so), and an
`area:<id>` reference to an area with no fragment in the run resolves among the previous model's nodes of that area.
The files under the directory holding the previous model (`--out`, `docs/architecture` by default) are the map's own
output: `diffmap.mjs` never counts them as changed, so committing the artifacts makes no area affected. The update
passes the diffmap report to `merge.mjs --changed`, and inside an affected area only what the change touched differs:
a node, edge or entity whose id is in the previous model and whose evidence files (an entity's field evidence too) are
all unchanged is carried over byte-identical, whether the fragment spells it differently or leaves it out; one with
evidence in a changed file takes the fragment's version; a new id is added; one the fragment leaves out whose evidence
changed is removed with a `dropped-changed` row. Entities on a carried store keep its id and no sibling store is made;
the `derivation` row counts the carried elements (`derived.carried`). Without `--changed` an affected area is
replaced by its fragment wholesale.

What it cannot cite (a file no node owns, a table no entity models, an import line it cannot find) is counted in the
`derivation` row of `meta.sources`. It also writes `<work>/digest.json`, under 30 K characters: node ids with kind,
zone, level, title and role; the edge list; entity names and stores; access rows; the model's sequence ids; and
`drafts`, sequences derived in three kinds: one per HTTP entry point (id `draft-<name>`, with its queue hops and a response), one per queue whose producer and consumer are both known and that no HTTP draft shows (id `draft-queue-<name>`), and one per scheduled or hook entry (id `draft-pull-<name>`) (see sequences.md). The synthesizer reads the digest, never
the model or the fragments, and returns only `sequences`, `views`, `notes` and `conflicts`; merge refuses and
reports any nodes, edges, entities, access rows or relations it sends.
