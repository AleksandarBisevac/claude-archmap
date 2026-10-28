# Issues catalogue

Read this when running the issue pass (`--issues`, `/archmap:issues`). It tells the `archmap-reviewer` what to look
for in the model and how to word what it finds. The issue shape is `schema/archmap-issues.schema.json`; the
overlay is written outside the repo and never into the committed model.

## Scope: architecture-level only

An issue is something visible through structure and relations: a missing edge, an edge with the wrong
properties, a node nothing guards, an entity nothing reads, a step that trusts the wrong thing. It is not
line-level review. Do not report style, naming, a single off-by-one, a missing null check or a local refactor. If you
can only describe the problem by quoting one function body, it is not an architecture issue.

Work from the model and the fragments you were handed. Open source files only to confirm an issue you already
suspect from the model, and only at the cited lines.

## The issue record

`{id, sev, category, title, anchor, summary, impact, fix, detail?, evidence[], source, track?}`.

- `id`: stable and descriptive, for example `no-auth-gateway`. Re-running over the same anchor keeps the id.
- `sev`: `high`, `med` or `low`. Start from the pattern's default and move one step either way only for a stated reason.
- `category`: `security`, `data`, `reliability`, `performance`, `design` or `docs`.
- `anchor`: exactly one of `{node}`, `{edge}`, `{entity}` or `{step}`, naming an id that exists in the model. A step
  anchor is `"<sequenceId>:<stepIndex>"`, zero-based. Never anchor to an id you have not seen in the model.
- `evidence[]`: at least one `{path, lines}`, with `lines` as `N` or `N-M`. An issue without evidence is not filed.
- `source`: `archmap` for the reviewer's own findings, `audit` for imported ones (see the import section).
- `track`: the audit task, finding or bug id an imported issue came from. Omit for `archmap` issues.

## Calibrated wording

The overlay feeds two builds. The clean `archmap.html` is committed and may be shared; the internal build and the
overlay stay on the author's machine. So each issue has a shared-safe part and an internal part.

- `summary`, `impact` and `fix` are written to be safe in a shared build. One or two sentences each. They say what
  class of weakness exists, where in the architecture, what it allows in general terms, and what to change. They
  never contain a working recipe, a secret, a host name, a real identifier or a step-by-step way to exploit.
- `detail` is internal only. It holds the specifics: the exact parameter or route, the concrete way it is reached,
  what an attacker or a bad deploy would do, and the order to fix things in. Use it for `security` issues. For other
  categories the shared wording is normally enough and `detail` may be left out.
- Match the wording to the severity. `high` is stated plainly and early. `low` is phrased as a hardening
  suggestion, not an alarm. Do not call something critical because it sounds serious; say what is lost if it fails.
- Say "no evidence of X in the scanned code" rather than "X does not exist" when the control may live outside the
  repository (a proxy, a platform setting). Lower the severity one step when the control may exist elsewhere.

## Patterns

Each pattern gives the anchor kind, category and default severity, what to look for in the model, and
calibrated example wording. Adapt the wording; do not paste it.

### P1 No authentication at an application boundary
- **Anchor:** node
- **Category:** security
- **Severity:** high
- **Look for:** a node in an `edge` or `browser`-facing zone, or an app node that serves requests, with no `auth`
  edge into it or out of it, and whose `facts` or evidence show it trusting an upstream proxy or network position
  instead of checking identity itself.
- **Summary:** The service accepts requests without checking who sends them and relies on whatever sits in front of it.
- **Impact:** Anything that can reach the service directly, or a change to the front layer, exposes it fully.
- **Fix:** Verify identity in the service itself, or state and enforce the network restriction as part of the deployment.
- **Detail (internal only):** Name the listener, the routes that skip checks, and how a direct request would be made.

### P2 Request input reaching query identifiers, or read-write access where read-only is enough
- **Anchor:** edge
- **Category:** security
- **Severity:** high
- **Look for:** an `sql` edge whose `desc` or evidence shows a URL segment, query parameter or body field used as a
  table, column or path name without an allowlist; or an `sql` edge from a node that only reads (`access` ops `R`)
  but whose store connection is read-write.
- **Summary:** Caller-supplied text chooses what the data layer touches, or the connection can write although the feature only reads.
- **Impact:** A caller can reach data or objects the feature was never meant to expose, and a flaw in the read path can change data.
- **Fix:** Resolve identifiers through a fixed allowlist, and open a read-only connection for read-only features.
- **Detail (internal only):** Give the route, the parameter, the query builder involved, and which identifiers are reachable.

### P3 Shared data scoped by whoever triggers a bootstrap
- **Anchor:** node
- **Category:** data
- **Severity:** med
- **Look for:** a startup, sync or first-request node that uses the credentials or tenant of the triggering user
  to load data that other users then read from a shared store or cache; an `access` entry that writes shared data
  from a node reached through a per-user `auth` edge.
- **Summary:** Shared data is loaded under one user's identity, so what everyone sees depends on who happened to start it.
- **Impact:** Users can see data they should not, or miss data they should see, and the result changes between restarts.
- **Fix:** Load shared data with a service identity, and keep per-user data keyed by the user.

### P4 Readiness inferred from an early side effect
- **Anchor:** step
- **Category:** reliability
- **Severity:** med
- **Look for:** a sequence step where a caller decides "ready" or "done" because a file, row or flag exists, when the
  producing node creates that marker before the work finishes; a `pull` or poll loop whose exit condition is that marker.
- **Summary:** Readiness is read from a marker that is created before the work behind it is complete.
- **Impact:** Consumers start early and see partial or empty results, and the failure only shows under load or after a crash.
- **Fix:** Create the marker last, atomically, or expose an explicit status that the producer sets on completion.

### P5 Background work with no failure handling
- **Anchor:** node
- **Category:** reliability
- **Severity:** med
- **Look for:** a `job` or worker node, or an `async` edge into a `queue`, with no failure path in the model or its
  sequences: no retry, dead-letter or error state, and a status flag set at start and cleared only on success.
- **Summary:** Background work has no defined outcome on failure, so a flag or state can stay stuck.
- **Impact:** A single failure leaves the feature permanently "in progress" until someone intervenes by hand.
- **Fix:** Record failure explicitly, clear the flag in every exit path, and add a bounded retry with a visible final state.

### P6 Retry that handles the wrong failure
- **Anchor:** edge
- **Category:** reliability
- **Severity:** low
- **Look for:** an edge to an `external` node or a store whose evidence shows a retry or fallback that catches a broad or
  unrelated error class, so the real failure of that dependency is not what triggers it.
- **Summary:** The retry around this dependency is tied to an error class that does not match how the dependency fails.
- **Impact:** Real outages are not retried, while unrelated errors are retried or swallowed.
- **Fix:** Retry only the failures the dependency actually raises, with a limit and a back-off.

### P7 Cache reset without data reset, or invalidation in another process
- **Anchor:** edge
- **Category:** data
- **Severity:** med
- **Look for:** a `cache` edge whose invalidation is triggered from a different node or process than the one holding
  the cache; a "refresh" action in the UI whose `api` edge clears caches but never re-pulls the source.
- **Summary:** The action meant to refresh data clears a cache, or clears it in a different process, without reloading the data.
- **Impact:** Users believe the data is current while they still see the old copy.
- **Fix:** Invalidate where the cache lives, and have refresh reload the source, or rename the action to what it does.

### P8 Unauthenticated administrative endpoints and credentials in the process environment
- **Anchor:** node
- **Category:** security
- **Severity:** high
- **Look for:** a node with admin, debug, metrics or maintenance routes in the same listener as public routes and no `auth`
  edge; or secrets read at startup from environment variables of a long-running process that also runs request code
  or spawns child processes.
- **Summary:** Administrative functions are reachable without a separate check, or secrets sit where every part of the process can read them.
- **Impact:** Anyone who reaches the listener can use the admin functions, and a flaw anywhere in the process can expose the secrets.
- **Fix:** Put admin routes behind their own authentication and network boundary, and load secrets from a secret store with the narrowest scope.
- **Detail (internal only):** List the routes and the variable names, and say which child processes inherit them. Lower to `med` if only the secrets half applies.

### P9 Process-global state that blocks scaling
- **Anchor:** node
- **Category:** performance
- **Severity:** med
- **Look for:** a service node whose `facts` or evidence show module-level caches, in-memory sessions, singleton connections
  or local-disk state that later requests depend on, in a deployment view that runs, or must run, several instances.
- **Summary:** The service keeps state in its own process that later requests depend on.
- **Impact:** A second instance gives different answers, so the service cannot be scaled out or restarted safely.
- **Fix:** Move shared state into a store or cache node, and keep the service itself stateless.

### P10 Chatty or unbounded data pull
- **Anchor:** edge
- **Category:** performance
- **Severity:** low
- **Look for:** an `api` or `sql` edge from a client or service that, per user action, fetches whole collections,
  fans out one call per item, or polls on a short interval with no `async` or `cache` edge in between.
- **Summary:** One user action causes a large or repeated data transfer along this edge.
- **Impact:** Latency and load grow with data size, and the cost shows up first on the shared store.
- **Fix:** Add pagination or a summary endpoint, batch the calls, or cache the result.

### P11 Dead data: pulled but never read, or declared but never loaded
- **Anchor:** entity
- **Category:** data
- **Severity:** low
- **Look for:** an entity with writes in `access` (or a `pull` edge feeding it) and no reader; or an entity declared in
  code or schema that no `access` entry and no sequence ever touches.
- **Summary:** This dataset is fetched and stored, or declared, without anything using it.
- **Impact:** It costs storage, sync time and attention, and it misleads readers about what the system depends on.
- **Fix:** Remove the pull or the declaration, or record the consumer that is missing.

### P12 Ungated production deploy
- **Anchor:** node
- **Category:** reliability
- **Severity:** high
- **Look for:** a `delivery`-zone node with a `deploy` edge to a production platform node and no approval, test or
  environment gate in its `facts` or evidence; a deploy triggered directly by a push to the main branch.
- **Summary:** Changes reach production from the delivery pipeline without a gate in between.
- **Impact:** A bad commit goes live automatically, with no checkpoint and no easy stop.
- **Fix:** Add a required check or approval before the production step, and a documented rollback.

### P13 Mutable references in the delivery chain
- **Anchor:** edge
- **Category:** security
- **Severity:** med
- **Look for:** a `deploy` edge into a reusable pipeline workflow, action or image referenced by branch name or
  floating tag instead of a pinned version or digest; a base image that is past end of life (`low` for the image alone).
- **Summary:** The pipeline pulls a component by a name that can change, or builds on a base that no longer gets fixes.
- **Impact:** The next build can silently run different code, and known flaws in the base stay unpatched.
- **Fix:** Pin by digest or version and update on a schedule, and move to a supported base image.
- **Detail (internal only):** List the references, the owners of the upstream sources, and which of them run with deploy credentials.

### P14 Dependency cycle or a node that everything crosses
- **Anchor:** node
- **Category:** design
- **Severity:** low
- **Look for:** a cycle among `call` edges between modules; a node with edges from most other nodes and many `access`
  entries, so every feature passes through it.
- **Summary:** These modules depend on each other in a loop, or one module sits under almost every flow.
- **Impact:** Changes there ripple everywhere, and parts cannot be built, tested or deployed on their own.
- **Fix:** Break the loop with an interface owned by one side, and split the hub by responsibility.

### P15 Documentation describing a different system
- **Anchor:** node
- **Category:** docs
- **Severity:** low
- **Look for:** a node whose `evidence` is a README, design note or diagram text naming components, stores or flows that
  the model does not contain (or the reverse), found while reconciling docs with code.
- **Summary:** The written description of this part does not match what the code does.
- **Impact:** New readers and reviewers form the wrong picture, and decisions are made on it.
- **Fix:** Update the document to match the code, or remove it and point to the generated map.

## Choosing the anchor

Anchor to the smallest element that carries the problem: an `entity` for a dataset, an `edge` for how two things talk,
a `step` when the order of a flow is the problem, a `node` when the component as a whole is. If an issue spans several
elements, anchor to the one a fix would change and list the others in `detail` or as extra evidence.

## Audit import

When `docs/audit/audit-plan.json` exists and the run asks for it (`--import-audit`), turn its open findings into
issues with `source: "audit"`. This is mapping, not re-review: do not rewrite the finding's substance.

Inputs:

- `bugs[]`: `{id, title, status, severity, description, files?}`. Import entries whose status is not closed or fixed.
- `phases[].review.findings[]`: usually `{id, severity, file, issue, resolution?, status}` where `file` is
  `path` or `path:lines`. Import `open` and `carried` findings; skip `fixed` or `resolved` ones.
- Legacy string findings: an older manifest may hold plain strings in `findings[]`, often `path:lines - text` or just text.
  Treat the string as the `issue` text, take a leading `path:lines` if there is one, and give it the id
  `<phaseId>-<index>`. Read a leading `[high]`, `[med]` or `[low]` tag as severity; with none, use `low`.

Mapping:

- `id`: `audit-` plus the source id. `track`: the source id. `source`: `audit`.
- `sev`: `high` stays `high`, `medium` or `med` becomes `med`, `low` stays `low`, anything else becomes `low`.
- `category`: pick from the text using the six categories; if it reads as a line-level defect with no architectural
  reading, skip it and list it in the import report instead of forcing it into the catalogue.
- `anchor`: find the node whose `paths[]` globs match the finding's file or files; use that node. If an edge or entity
  fits better by name, use it. If nothing matches, skip the entry and report it as unanchored. Never invent an id.
- `evidence`: `file` split into `path` and `lines`. If the finding has a path without lines, open the file and cite the
  most relevant line. If it has no path at all, skip and report it.
- `title`, `summary`, `impact`, `fix`: condense the audit text. `summary`, `impact` and `fix` follow the calibration rules
  above. `detail` carries any internal specifics from the audit text.

Re-importing keeps ids stable, so an issue already present is updated in place and one whose source is now closed is
dropped. Print counts: imported, skipped as fixed, skipped as unanchored, skipped as line-level.

## Before filing

- Every issue has an anchor id that exists, at least one evidence entry, and `source` set.
- Every `security` issue has shared-safe `summary`, `impact` and `fix`, with specifics only in `detail`.
- Nothing names a real organisation, person, host, secret or local path. Examples in the overlay use the project's
  own node and entity ids and nothing else.
- Run `node scripts/validate.mjs <model> --issues <issues.json>`; fix every finding before the overlay is used.
