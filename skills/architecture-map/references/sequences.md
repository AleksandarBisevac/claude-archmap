# Sequences

A sequence is one end-to-end flow, drawn as a sequence diagram. Shape:
`{id, title, summary?, participants[], steps[]}`.

## Participants

`{id, label}` required; `sub`, `zone`, `node` optional. `node` points at a model node id so the viewer can link the
lane to the graph. Keep 3 to 7 participants per sequence.

## Step grammar

`steps[]` mixes three kinds of entry.

**Message** (all of `m`, `k`, `t`, `d`, `r` required):

| Key | Meaning |
|---|---|
| `m` | `[from, to]` participant ids. A self-call repeats the id. |
| `k` | Message type: an edge type word such as `api`, `sql`, `event`, `call`. |
| `t` | Short label shown on the arrow. |
| `d` | One-sentence detail shown on click. |
| `r` | Array of references (file paths with lines, or model ids) backing the step; may be empty only if the step is a pure return. |
| `ret` | Optional text of the return value or response. |
| `i` | Optional issue id this step is anchored to. |

**Fragment** `{frag, t}`, where `frag` is one of:

- `alt`: opens an alternatives block; `t` is the first condition.
- `else`: next branch of the open `alt`; `t` is its condition.
- `opt`: opens an optional block.
- `loop`: opens a repeated block.
- `end`: closes the innermost open fragment (`alt`, `opt` or `loop`).

Every `alt`, `opt` and `loop` is closed by a matching `end`.

**Note** `{note, t, tone}`: `note` is an array of participant ids the note spans, `t` the text, `tone` a style word
(for example `info` or `warn`).

## Fictional example

Participants: `web` (browser), `api`, `db`, `mailer`.

```json
{
  "id": "seq-signup",
  "title": "Sign up",
  "summary": "A visitor registers and receives a welcome mail.",
  "participants": [
    { "id": "web", "label": "Web app", "zone": "browser" },
    { "id": "api", "label": "Accounts API", "zone": "service", "node": "accounts-api" },
    { "id": "db", "label": "Accounts DB", "zone": "data", "node": "accounts-db" },
    { "id": "mailer", "label": "Mail provider", "zone": "external" }
  ],
  "steps": [
    { "m": ["web", "api"], "k": "api", "t": "POST /signup", "d": "Browser submits the form.", "r": ["web/src/signup.ts:12-30"] },
    { "frag": "alt", "t": "email is new" },
    { "m": ["api", "db"], "k": "sql", "t": "insert account", "d": "Creates the row.", "r": ["api/src/accounts.ts:40-58"], "ret": "account id" },
    { "m": ["api", "mailer"], "k": "event", "t": "send welcome", "d": "Fire and forget.", "r": ["api/src/mail.ts:5-20"] },
    { "frag": "else", "t": "email exists" },
    { "note": ["api"], "t": "Returns 409 without touching the database", "tone": "warn" },
    { "frag": "end", "t": "" },
    { "m": ["api", "web"], "k": "api", "t": "201 / 409", "d": "Result of the signup.", "r": [] }
  ]
}
```

## Drafts from the merge

`merge.mjs` writes `drafts` into `<work>/digest.json`: at most 12 sequences, taken in id order, built from the
cross-area links and access rows it computed. Three kinds:

- **One per HTTP entry point** it could follow: the client's call to the route, then each access row cited in the
  handler's file (`k: sql`, to the entity's store), then each queue hop that file starts (`k: queue`) with the
  consumer's own access rows, and last a `response` step (with `ret`) from the handler back to the caller.
- **One per queue** whose producer and consumer are both known and that no HTTP draft already shows as a hop (id
  `draft-queue-<name>`): the producer enqueues, the consumer handles the message, then the consumer's access rows.
- **One per scheduled entry**, a `cron` or `hook` link in the prescan extracts (id `draft-pull-<name>`): the trigger
  reaching its handler (`k: pull` for a schedule, `k: event` for a hook), then the handler's first access row. A
  trigger with no access row in the handler's file makes no draft.

Participants are node ids (at most 7), every message cites its `path:line` in `r`, and the id starts with `draft-`.
Because every participant carries its `node`, a kept draft can be played on the architecture graph in the viewer. A draft is a proposal: confirm its cited lines, then keep it under a plain id,
edit it (add the decision fragments, returns and notes a script cannot see) or drop it. A draft never needs a node or
edge the digest lacks; if the code shows one, report it in `conflicts`.

## Picking sequences

Choose 3 to 7 per model. Prefer flows a newcomer asks about first: the main user journey, authentication, the
primary write path to the database, one background or queue flow, and one failure or retry path. Skip flows that
repeat the same participants without a new decision. Every message `r` should cite real lines; a step you cannot
back stays out of the diagram.
