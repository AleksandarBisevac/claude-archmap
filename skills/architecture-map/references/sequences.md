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

## Picking sequences

Choose 3 to 7 per model. Prefer flows a newcomer asks about first: the main user journey, authentication, the
primary write path to the database, one background or queue flow, and one failure or retry path. Skip flows that
repeat the same participants without a new decision. Every message `r` should cite real lines; a step you cannot
back stays out of the diagram.
