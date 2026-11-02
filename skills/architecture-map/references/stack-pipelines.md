# Stack reference: pipelines

Covers GitHub Actions workflows and Azure Pipelines. Prescan detects it from file names alone
(`.github/workflows/*.y(a)ml`, `azure-pipelines*.y(a)ml`, `*.pipeline.y(a)ml`) and runs
`scripts/lib/prescan/pipelines.mjs` (also `stacks/pipelines.mjs`). The output is `extracts.pipelines`. The scanned
files are only ever read as text; never run `gh`, `act`, `az`, an agent or a workflow, and never trigger a run to see
what it does.

## What prescan already extracts

All items carry `evidence: [{path, lines}]`, sorted by path then line, capped per kind (see `truncated`).

| Kind | What it holds |
|---|---|
| `pipelines` | One item per workflow or pipeline file: `kind` (`github-actions` or `azure-pipelines`), `name` (the workflow's `name:`, else the file name) and `triggers`: the `on:` events of a workflow, or `trigger`, `pr` and `schedule` for an Azure pipeline that sets them (`none` is not a trigger). Evidence is the whole file body. |
| `jobs` | One item per GitHub job and per Azure stage and job: `pipeline` (the file), `kind` (`job` or `stage`), `id`, `stage` (the stage an Azure job sits in, else null) and `needs` (GitHub `needs:`, Azure `dependsOn:`). Evidence is the job or stage block. |
| `artifacts` | One item per step that uploads or downloads a build artefact: `actions/upload-artifact` and `download-artifact`, `PublishPipelineArtifact`, `PublishBuildArtifacts`, `DownloadPipelineArtifact`, `DownloadBuildArtifacts` and the `publish:` / `download:` shorthands. Fields `name`, `direction` (`upload` or `download`), `job`, `pipeline`. Evidence is the step. |
| `passes` | One item per upload read by a download of the same name in another job of the same file: `name`, `from` and `to` (job ids), `pipeline`. Evidence is two entries, the upload step and the download step. |
| `deployTargets` | The deploy targets named as string literals: `environment` (a job's `environment:`) and `app` (the `app-name` of `azure/webapps-deploy` and `azure/functions-action`, the `service` of `deploy-cloudrun`, the `appName` of the Azure web app and function tasks). Fields `name`, `kind`, `job`, `pipeline`. Evidence is the value's line. A value built from an expression (`${{ }}`, `$( )`) is not a literal and is left out. |
| `skipped`, `truncated` | Pipeline files with no jobs, stages or steps, `template:` references (not resolved), and items dropped by the cap. |

## What you must still read yourself

1. **Nodes.** A pipeline is not an architecture node by itself. The things it builds and deploys are: an Azure
   `deployTargets` app or a workflow's `environment` is the runtime of a `service` node you already found in the code,
   and a pipeline that ships it is evidence for the deploy edge or for `notes`, not a node of its own. Emit a node for
   a pipeline only when the pipeline is the system (a data or release pipeline whose jobs are the steps of the
   product): then one `service` node per stage or job that does work, in a `data` zone, citing the job block.
2. **Edges.** `passes` is a real hand-off (the download runs on what the upload produced) and is the best evidence a
   pipeline gives. The merge script draws it as an `artifact` edge from the producing job to the consuming one, citing
   the upload and the download lines, and draws `needs` and `dependsOn` as `depends` edges (the job depends on what it
   needs): do not repeat either. Draw an edge of your own only for what the extract cannot say, typed from what the
   artefact is (a build output the next job packages, or data the next job reads). `needs` and `dependsOn` are order,
   not a data flow: they are `confidence: inferred` for any edge you draw from them. A job with an `environment` and no artefact is a deploy, so the edge is from the code unit
   it builds to the runtime the environment names; read the build and deploy steps (`run:`, `script:`, `with:`) to see
   which unit that is.
3. **What a deploy target really is.** An `environment` is a name, often with approval rules that live in the
   hosting service and not in the repo; say in `notes` that the rule is outside the checkout. An `app` name is the
   deployed web app or function: match it to the service whose code the build step packages (`package:`, `path:`,
   `working-directory:`).
4. **Triggers.** `triggers` tell you when it runs: `schedule` means a batch or periodic job (worth a note when it
   feeds data), `workflow_dispatch` a manual run, `push` and `pr` the ordinary build. A
   `workflow_call` or `resources:` pipeline is called by another: read the caller.
5. **Templates and reusable workflows.** `template:` steps and `uses: ./.github/workflows/x.yml` jobs stand for steps
   prescan did not read: open the referenced file when the job is on the path you are tracing, and cite it. Matrix
   jobs (`strategy.matrix`) run the same steps several times; name the job once.
6. **Secrets and variables.** Never write a secret, token or variable value, and never open files that hold them.
   `${{ secrets.NAME }}` and `$(VariableName)` are names; cite the line, keep the name only if it explains a link.

## Fictional example

`.github/workflows/release.yml:9-17` is the `build` job; it uploads `dist` at `:14-17`. `:19-26` is the `test` job and
`:28-39` the `deploy` job, which downloads `dist` at `:33-35`, names `environment: production` at `:31` and deploys
`app-name: 'fleet-web-prod'` at `:38`. `passes` holds `dist` from `build` to `deploy`. You find the web service whose
code `dist` is built from, and emit an edge from it to the `fleet-web-prod` runtime node, typed from what the deploy
step does, `confidence: inferred` unless a README or the step names the service, citing `release.yml:14-17` and
`release.yml:33-35`.
