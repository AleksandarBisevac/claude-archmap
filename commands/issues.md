---
description: Review the architecture map for architecture-level issues, optionally importing open audit findings; the overlay is written outside the repository.
argument-hint: "[--import-audit] [--profile max|balanced|economy]"
allowed-tools: Read, Grep, Glob, Bash, Agent, Write, Edit
---

Use the `architecture-map` skill and follow its issues step (build step 7) over the current model, passing the arguments
through unchanged: `$ARGUMENTS`

The skill holds the whole procedure, the evidence rules and the token rules. Do not improvise a different flow here.
