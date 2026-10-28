# Relation taxonomy

Closed vocabularies come from `schema/archmap-model.schema.json`. Pick the most specific value; when two fit,
choose the one the code itself names.

## Edge types

| Type | Use when |
|---|---|
| `api` | A client calls a service over HTTP, RPC or GraphQL (fetch, axios, a generated client, a route handler). |
| `static` | Static assets or bundles are served or loaded (CDN, file server, build output). |
| `auth` | Identity or token flow: login, session check, token verification, OAuth callback. |
| `pull` | A consumer periodically fetches or polls from a source (cron sync, polling loop, scheduled import). |
| `sql` | A node runs SQL or ORM queries against a relational or file database. |
| `cache` | A node reads or writes a cache or key-value store used for speed, not as the source of truth. |
| `persist` | A node writes durable non-SQL state: files, blobs, object storage, document stores. |
| `call` | In-process or same-service function or module call that crosses a node boundary. |
| `link` | A navigational or reference link with no data flow (UI route link, docs reference). |
| `deploy` | Build and release flow: CI to registry, image to platform, infrastructure to runtime. |
| `event` | Publish or subscribe on an event bus, webhook or emitter, where the sender does not wait. |
| `queue` | Work enqueued for a worker (job queue, task broker). The producer and the consumer each get an edge to the queue node. |

Optional edge fields: `label` (short text on the line), `desc` (one sentence, required), `foundBy`
(`static` from a deterministic scan, `llm` from reading, `introspection` from a live schema), and `async`.

## Confidence

- `verified`: the evidence lines show the call, query or declaration directly.
- `inferred`: concluded from naming, config or convention; the evidence points at the best supporting lines.
- `external`: the other end is outside the repository; the evidence shows only this side.

Never mark `verified` on a guess. Downgrade instead.

## async

`async: true` when the sender does not wait for a result: `event` and `queue` edges nearly always, `api` edges
that fire and forget, webhooks. Leave it out for synchronous calls.

## Zone kinds

A zone groups nodes into a trust or deployment region. `parent` nests a zone; `outside: true` marks a region the
project does not control.

| Kind | Use for |
|---|---|
| `browser` | Code running in the user's browser or app (SPA, mobile client). |
| `edge` | CDN, gateway, reverse proxy, edge functions in front of services. |
| `service` | Your own backend processes and workers. |
| `data` | Databases, caches, object stores, queues you operate. |
| `external` | Third-party systems and APIs (set `outside: true`). |
| `platform` | Runtime infrastructure: cluster, cloud account, orchestration. |
| `delivery` | CI/CD, registries, release pipelines. |

## Node kinds

`node.kind` is an open string in the schema; prefer these so the viewer styles them consistently, and add a new
kind only when none fits.

| Kind | Use for |
|---|---|
| `app` | A deployable application or client (web app, mobile app, CLI). |
| `module` | A cohesive code module or package inside an app. |
| `route-group` | A set of routes or controllers sharing a prefix or purpose. |
| `service` | A backend service, API server or long-running process. |
| `store` | A database, cache or file store (entities attach to it through `entity.store`). |
| `queue` | A message queue or broker topic. |
| `job` | A scheduled or background job or worker. |
| `external` | A third-party system. |

Level guide: 1 is system context, 2 is containers (apps, services, stores), 3 is components inside a container.
