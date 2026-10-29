---
description: Export the architecture model as Mermaid, PlantUML, SVG, PNG or Markdown files, with no analysis and no model run. Exports are clean, with no issues.
argument-hint: "mermaid|plantuml|svg|png|md [--view v]"
allowed-tools: Bash, Read
disable-model-invocation: true
---

Script only. Run from the repository root; do not analyse code and do not edit the model.

1. `docs/architecture/architecture.model.json` must exist, else stop and say to run `/archmap:build` first.
2. `$ARGUMENTS` is the format (`mermaid`, `plantuml`, `svg`, `png` or `md`) and an optional `--view <id>`. If it is empty, stop and list the five formats.
3. Export. Add `--layout docs/architecture/architecture.layout.json` when that file exists (the svg and png formats draw from it; the text formats ignore it):

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/export.mjs" docs/architecture/architecture.model.json $ARGUMENTS
   ```

   With the layout: `node "${CLAUDE_PLUGIN_ROOT}/scripts/export.mjs" docs/architecture/architecture.model.json $ARGUMENTS --layout docs/architecture/architecture.layout.json`.

4. Exports are clean by design: no issues, no issue ids and no issue text ever appear in them, so they are safe to commit or share. Files go to `docs/architecture/exports/`.
5. Report the files written and the exit code. Exit 1 means the model is invalid and nothing was written; exit 2 is a usage error or unreadable input (or a browser failure for png); exit 3 means no Chromium was found for png, so nothing was written: install Chrome or Chromium, or set `CHROME_PATH`.
