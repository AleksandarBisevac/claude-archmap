---
description: Re-render the architecture map HTML from the existing model, with no analysis and no model run. Default is the clean build in docs/architecture/.
argument-hint: "[--internal|--shared]"
allowed-tools: Bash, Read
disable-model-invocation: true
---

Script only. Run from the repository root; do not analyse code and do not edit the model.

1. `docs/architecture/architecture.model.json` must exist, else stop and say to run `/archmap:build` first.
2. If `docs/architecture/architecture.layout.json` is missing, create it first (it seeds later runs):

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/layout.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json
   ```

3. Render according to `$ARGUMENTS`:
   - none: the clean build, no issues, written to `docs/architecture/archmap.html`. Add `--theme docs/architecture/archmap.theme.json` when that file exists.

     ```sh
     node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json
     ```

   - `--internal` or `--shared`: needs `<home>/.claude/archmap/<repo-slug>/issues.json` (`<repo-slug>` is the repository
     directory name, lowercased, with anything that is not a letter, digit or `-` replaced by `-`). If it is missing,
     stop and say to run `/archmap:build --issues`. Write only under that directory, never inside the repository:

     ```sh
     node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs" docs/architecture/architecture.model.json --layout docs/architecture/architecture.layout.json --issues <home>/.claude/archmap/<repo-slug>/issues.json --mode internal --out <home>/.claude/archmap/<repo-slug>/archmap.internal.html
     ```

     For `--shared` use `--mode shared` and `--out <home>/.claude/archmap/<repo-slug>/archmap.shared.html`.

4. Report the file written and the exit code. Exit 1 means the model is invalid and nothing was written; exit 2 is a usage or unreadable input.
