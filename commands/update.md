---
description: Refresh the architecture map after code changes - re-analyses only the areas git says changed, keeps locked nodes, notes and pinned positions.
argument-hint: "[--issues] [--profile max|balanced|economy] [--since sha]"
allowed-tools: Read, Grep, Glob, Bash, Agent, Write, Edit
---

Use the `architecture-map` skill and follow its update flow for this repository, passing the arguments through
unchanged: `$ARGUMENTS`

The skill holds the whole procedure, the evidence rules and the token rules. Do not improvise a different flow here:
the update is the same driver, `node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs"` plan with `--update` (it maps the
changed files with diffmap), then finish and render, with one foreground dispatch message after plan and one after
finish. Never poll, ScheduleWakeup or Monitor during the update.
