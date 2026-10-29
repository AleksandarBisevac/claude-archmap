---
description: Check whether the architecture map is behind HEAD. Script only, no analysis and no model run; exit 0 when fresh, 1 when stale.
argument-hint: ""
allowed-tools: Bash
disable-model-invocation: true
---

Script only. Run from the repository root; do not analyse code and do not edit the model.

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/staleness.mjs" --check
```

Report the line it printed and its exit code. Exit 0 means the model is fresh, 1 means it is behind HEAD (suggest
`/archmap:update`), and 2 is a usage error or a missing or unreadable model (suggest `/archmap:build` when none exists).
