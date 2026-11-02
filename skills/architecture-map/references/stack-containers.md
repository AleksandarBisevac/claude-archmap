# Stack reference: containers

Covers Dockerfiles and Docker Compose files. Prescan detects it from file names alone (`Dockerfile`, `Dockerfile.*`,
`*.Dockerfile`, `compose*.y(a)ml`, `docker-compose*.y(a)ml`) and runs `scripts/lib/prescan/containers.mjs`
(also `stacks/containers.mjs`). The output is `extracts.containers`. The scanned files are only ever read as text; never
run `docker`, `docker compose`, a build or a container, and never start the stack to see what it does.

## What prescan already extracts

All items carry `evidence: [{path, lines}]`, sorted by path then line, capped per kind (see `truncated`).

| Kind | What it holds |
|---|---|
| `services` | One item per compose service: `image` or `build` (`context` and `dockerfile`, repo-relative), `ports` (`host`, `container`, `protocol`), `volumes` (`source:target[:mode]`), `dependsOn` (service names), `envKeys` (variable names only, from `environment` and from the `env_file` files the repo holds). Evidence is the service block. |
| `dockerfiles` | One item per Dockerfile, read from its final stage: `base` image, `stages` count, exposed `ports` (`port`, `protocol`), `command` (ENTRYPOINT then CMD words) and `entrypoint`, the file that command runs (`server.js`, `docker-entrypoint.sh`, a jar), else null. Evidence is the final stage. |
| `skipped`, `truncated` | Services that are a YAML alias or hold a `<<:` merge, Dockerfiles without a `FROM`, and items dropped by the cap. |

Values are never extracted: an environment entry is a name, never what it is set to, and `${VARIABLE}` text in an
image, port or path stays as written.

## What you must still read yourself

1. **Nodes.** Each compose service that you run yourself (`build:`) is a `service` node; a service that only pulls an
   `image:` of a database, cache or broker (`postgres`, `mysql`, `redis`, `rabbitmq`, `kafka`, `minio`) is a `store` or
   `queue` node, in a `data` zone. A reverse proxy (`nginx`, `traefik`, `caddy`) in front is an `edge` zone node. Do not
   emit a node per Dockerfile: a Dockerfile describes how a node is built, so cite it as evidence of the `service` node
   its compose `build.dockerfile` points at (the `dockerfile` path joins the two). A Dockerfile no compose service
   builds is a deploy unit of its own: one `service` node, `paths` the directory holding it.
2. **Edges.** `dependsOn` is start order, not a call. The merge script already draws each one as a `depends` edge
   (`confidence: verified` as a declared fact, cited at the compose line), so do not repeat it. Add the edge that says
   what the service really talks to: read the service's code or config (the `*_URL` and `*_HOST`
   variable names in `envKeys`, then the code that reads them) and type that edge
   from it (`sql` to a database service, `cache` to redis, `queue` to a broker, `api` to another service). Use
   `confidence: inferred` when only `dependsOn` or an `envKeys` name suggests the link, and `verified` when you read the
   client call. `ports` tell you who is reachable from outside: a `host` mapping means the service is published to the
   machine (an `edge` or a user-facing entry), a `container`-only entry stays on the compose network.
3. **Volumes.** A named volume (`pgdata:/var/lib/...`) is the data directory of the store that mounts it, which is
   evidence for a `persist` edge or for the store node; a bind mount of source code (`./api:/srv`) is a dev setup, not an
   architecture fact. Read `volumes:` at the top of the compose file only to confirm a name is a volume.
4. **Overrides and profiles.** `compose.override.yml`, `docker-compose.prod.yml` and `profiles:` change which services
   run and how. Prescan lists every file's services separately; a service in an override file repeats a base service by
   name. Read the override to see what it changes, name the base service once, and say in `notes` which file is the
   production one if the repo says so (a README or CI file). Services behind a merge key or alias are counted in
   `skipped`: read those blocks yourself.
5. **Entrypoints and what they start.** `entrypoint` is the file the container runs first: read it (a few lines) when it
   is a shell script, since it often migrates, waits for a dependency or picks the real process. A `command` with no
   `entrypoint` file (`uvicorn app.main:app`, `nginx -g`) is still the start command: cite the Dockerfile line.
6. **Environment.** Keep `envKeys` as names. When a name tells you a dependency (`DATABASE_URL`, `REDIS_HOST`,
   `STRIPE_API_KEY`), cite the compose line that declares it and the code line that reads it; never write a value, and
   never open a `.env` file that holds real secrets (read `.env.example` for the name list only).

## Fictional example

`docker-compose.yml:14-27` declares `api` with `build: ./api`, port `8000:8000` and `dependsOn: ['db']`; `db` runs
`postgres:16-alpine`. `api/Dockerfile:1-8` exposes 8000 and runs `docker-entrypoint.sh`. You emit a `service` node `api`
(evidence the compose block and the Dockerfile range) and a `store` node `db` in a `data` zone, read
`api/app/db.py:5` and find the engine built from `DATABASE_URL`, and emit `api -> db` of type `sql` with
`confidence: verified`, citing the compose `environment` line and `db.py:5`.
