# Stack reference: iac

Covers infrastructure as code: Terraform (`*.tf`) and Bicep (`*.bicep`). Prescan detects it from file names alone and
runs `scripts/lib/prescan/iac.mjs` (also `stacks/iac.mjs`). The output is `extracts.iac`. The scanned files are only ever
read as text; never run `terraform` (`init`, `plan`, `apply`, `console`), `tofu`, `az`, `bicep` or a provider, and never
open `*.tfvars`, `*.tfstate`, `*.bicepparam` or `.terraform/`: they hold values and state, and prescan does not read them
either.

## What prescan already extracts

All items carry `evidence: [{path, lines}]`, sorted by path then line, capped per kind (see `truncated`). `kind` is
`terraform` or `bicep`. `scope` is where an address is unique: the directory of a `.tf` file (a Terraform module is a
directory) or the Bicep file itself.

| Kind | What it holds |
|---|---|
| `resources` | One item per Terraform `resource` and `data` block and per Bicep `resource` statement: `mode` (`managed`, `data`, or `existing` for a Bicep `existing` resource), `type` (`aws_subnet`, or `Microsoft.Storage/storageAccounts` without its `@api-version`), `name`, `address` (`aws_subnet.app`, `data.aws_ami.base`, or the Bicep symbolic name) and `scope`. Evidence is the block or statement. |
| `modules` | One item per Terraform `module` block and Bicep `module` statement: `name`, `address` (`module.name`, or the symbolic name), `source` as written, `target` the repo-relative directory (Terraform) or file (Bicep) a local source points at, else null (a registry or remote source), `scope`. Evidence is the block. |
| `variables`, `outputs` | Terraform `variable` and `output` blocks, Bicep `param` and `output` statements: `name` and `scope` only. No default, type, description, value or expression is extracted. |
| `references` | The edges between resources and modules read from the expressions of a resource or module block: `from`, `to` (addresses in the same `scope`), `via` and `attributes`. `via` is `attribute` (`aws_vpc.main.id`, `module.database.endpoint`, `storage.name`), `depends_on` (Terraform `depends_on`, Bicep `dependsOn`) or `parent` (Bicep `parent:`). `attributes` are the names read right after the address. Evidence is one entry per line that holds the reference. |
| `skipped`, `truncated` | Blocks that never close (the block and the rest of its file are not read), and items dropped by the cap. |

A reference is kept only when its target is declared in the same scope, so a name from another directory or from a
provider is never guessed. Comments, string text and heredoc text hold no reference; `${ }` interpolations do.

## What you must still read yourself

1. **Nodes.** The merge script already makes a level-3 node for every resource and module, networks, subnets, security
   groups and IAM roles included, so do not emit one per block. Add only the grouped system-level nodes: a compute
   resource (`aws_instance`, `Microsoft.Web/sites`, a container app or
   cluster) is a `service` node, a database, cache, bucket or storage account (`aws_db_instance`, `aws_s3_bucket`,
   `Microsoft.Storage/storageAccounts`, `Microsoft.Sql/servers`) a `store` node, a queue or topic (`aws_sqs_queue`,
   `Microsoft.ServiceBus/namespaces`) a `queue` node, in a `data` zone when they hold data and an `edge` zone when they
   sit in front (load balancer, CDN). Plumbing goes in `notes`. Cite the exact block of any resource or module
   you stand for, so `find()` reuses your node and merge makes no twin.
2. **Edges.** `references` are wiring, not traffic. The merge script draws each one between the resource and module
   nodes it makes as a `depends` edge (the referencing block depends on the referenced one), cited at the lines that
   hold the reference, so do not repeat them. A `parent` edge or a subnet or security group an instance attaches
   to is containment, not a call: do not draw it as `calls`. An attribute that carries a connection target (an
   endpoint, a queue URL, a bucket name, a storage `id` passed to an app setting) is evidence that the consumer talks to
   the producer: read the block to see what the value is used for, type the edge from that, and use `confidence:
   inferred` unless the code that consumes the setting is found and cited as well. `depends_on` is order, always
   `inferred`.
3. **Modules.** A `module` is a group, not a resource. Follow `target` into the directory or file it names (it is a
   scope of its own with its own resources, variables and outputs) when the module is on the path you are tracing, and
   cite both sides. A remote source (`null` target, a registry or git address) is outside the checkout; name it in
   `notes` and do not invent its contents. A module's variables are its inputs and its outputs the values it hands
   back: the `references` that read `module.name.output` show who uses them.
4. **Environments and counts.** `count`, `for_each` and Bicep loops (`[for ...]`) make one block stand for several
   resources; name the node once. A Terraform workspace, a `*.tfvars` file or a Bicep parameter file picks the
   environment and is outside prescan: say in `notes` that the sizing and the environment names live outside the
   checkout instead of reading them.
5. **Expressions prescan does not follow.** Expressions of outputs, locals and variables are not read, a reference
   through `local.x` is not followed, and `data` sources that look something up by name (a `data "aws_ssm_parameter"`)
   say that the thing exists elsewhere. Read the block when the path you trace goes through one.
6. **Secrets and state.** Never write a password, key, token, connection string, subscription or account id, and never
   open state or variable files. `var.db_password` and `@secure()` parameters are names; cite the line, keep the name
   only if it explains a link.

## Fictional example

`terraform/main.tf:10-15` is `aws_vpc.main`, `:17-20` the `aws_subnet.app` that reads `aws_vpc.main.id` at `:18`, and
`:28-38` the `aws_instance.web`, which reads `aws_subnet.app.id` at `:31`, the `database` module's `endpoint` at `:33`
and lists `module.database` in `depends_on` at `:36`. `terraform/modules.tf:1-5` is `module.database`, whose `target` is
`terraform/modules/database`. You emit a `service` node for the instance (citing `:28-38`) and a `store` node for what the `database`
module builds (its directory shows the resources), with an edge from the first to the second typed from what the
instance does with the endpoint, `confidence: inferred` unless the start-up code that reads it is cited as well, citing
`terraform/main.tf:33` and `terraform/modules.tf:1-5`. The network resources go in the `notes` of the service node.

In `bicep/main.bicep` the `exports` container (`:22-33`) has `parent: blobService` at `:23` and `blobService`
(`:16-19`) has `parent: storage` at `:17`: that chain is one storage account, so a single `store` node cites `:7-14`
and the other two stay the merge's resource nodes.
