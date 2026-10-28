---
name: archmap-review
description: Code review for the archmap plugin repository. Checks a diff against the invariants that matter here and that generic review misses - a public repo that must carry no client material, zero npm dependencies on Node 18, deterministic script output, offline self-contained HTML, a backward-compatible model schema, mandatory evidence, a scanner that never executes the code it scans, and silent always-exit-0 hooks. Use it for every review in this repo - audit phase sign-off, "review my change", "is this ready to merge", "check this diff/branch/PR" - and before any commit or push of scripts/, assets/viewer/, schema/, skills/, agents/, commands/, hooks/ or tests/fixtures/, even when the user only says "look over this".
---

# archmap review

archmap is a Claude Code plugin that turns a codebase into an evidence-carrying architecture model and renders it as one
offline HTML file. Its design lives in `docs/design.md` (decisions D1-D13 are settled - do not re-argue them in a
review). Generic code review catches generic bugs; this skill adds the project rules whose violation is expensive or
irreversible here. Review the **diff**, not the whole repo.

## Procedure

1. **Find the diff.** At audit sign-off the brief names the base and head; otherwise use the branch's merge base with
   `main` (`git merge-base main HEAD`), or the staged/working changes if nothing is committed.
2. **Run the mechanical scan first** - it is read-only, takes seconds and catches what eyes miss:
   ```bash
   node .claude/skills/archmap-review/scripts/scan.mjs --base <base> [--head <head>]
   ```
   It prints JSON findings for added lines only (denylist terms by index, external URLs, non-builtin imports,
   post-Node-18 APIs, nondeterminism sources, shell-string child processes, `additionalProperties: false`). Treat each
   hit as a lead: confirm it in context, drop false positives, keep real ones with a concrete resolution.
3. **Read every changed function in full** in the head tree - not just the hunk - then walk the checklist below for the
   areas the diff touches.
4. **Report** in the format at the end. No nitpicks: style, naming taste and "could be cleaner" are not findings.

## Checklist (with the reason each rule exists)

### 1. Public repo, private client material - high
The repo is public; `.private/` (gitignored) holds a client's brief and reference app. Anything that leaks it is
permanent once pushed.
- No term from `.private/anonymise-denylist.txt` in any added line (the scan checks; it reports term indexes, so never
  print the term itself in a finding either).
- Nothing names or quotes the reference file, the client, its people, hosts, datasets or paths.
- Fixtures and examples are fully fictional, not "anonymised" versions of a real app - an app recognisable by its shape,
  domain words or internal function names is a leak even with the names swapped.
- Security wording in shareable files (issues fixtures, README, catalogue): class + consequence + fix only, no
  reproduction steps, no personal names.

### 2. Zero npm dependencies, Node >= 18 - high
Users install the plugin with no `npm install`, and CI runs Node 18/20/22.
- Imports are relative, `node:`-prefixed builtins, or the vendored `assets/viewer/elk.bundled.js`. No `package.json`
  dependencies, no `npx` at runtime.
- No API newer than Node 18 without a fallback. Common traps: `fs.glob`/`fs.promises.glob` (22), `import.meta.dirname`
  / `import.meta.filename` (20.11), `Array.prototype.toSorted/toReversed/toSpliced/with` (20), `Object.groupBy` /
  `Map.groupBy` (21), `Promise.withResolvers` (22), new `Set` methods like `union`/`intersection` (22), RegExp `v` flag
  (20), `node --test` with glob arguments (21).
- Vendored files stay byte-identical to upstream, with their licence notice and recorded hash.

### 3. Determinism - med
`update` re-renders and re-lays-out; a diff that churns on every run hides real changes and breaks stable layout (D6).
- Output of prescan, merge, layout, render and export is a pure function of its inputs: sort collections before
  writing, no `Date.now()`/`new Date()`/`Math.random()`/`crypto.randomUUID()` in output, no reliance on `readdir` or
  object-insertion order from unsorted sources, no locale-dependent `localeCompare` without a fixed locale.
- Timestamps belong only in `meta.generatedAt`, set once by the caller.

### 4. Offline, self-contained HTML - high for render and viewer
The HTML is opened from disk and shared; a network fetch leaks the model to a third party and breaks offline use.
- No `http(s)://` in `assets/viewer/` or render output except evidence links built from `meta.repoUrl` and licence
  URLs in notices. No external fonts, CDNs, `fetch`, `XMLHttpRequest`, `<link rel=preconnect>`, web workers from URLs.
- Clean mode physically contains no issue ids, titles or text; shared mode never contains `detail`; the Issues switch
  exists only in internal mode.
- Relation, zone and severity colours are fixed and semantic (D10); a theme may change fonts, chrome and accent only.

### 5. Model contract - med
Users commit `architecture.model.json`; older readers must keep reading newer files.
- Schema changes are additive. Removing or renaming a key, or tightening a type, needs a major `schemaVersion` bump.
- Readers tolerate unknown keys: no `additionalProperties: false`, no strict key whitelists in code.
- User-authored fields (`locked`, `notes`, layout `pinned`) are never overwritten by merge, update or layout.
- Schema, `validate.mjs` and `docs/design.md` section 5 agree; a field added to one but not the others is a finding.

### 6. Evidence and honesty - med
Evidence on every element is what makes the output trustworthy (design lesson 2).
- Nodes and edges carry `evidence` (`{path, lines}`); new element kinds get the same rule.
- A check that cannot run reports itself as skipped (validate without `--repo`, tests without the denylist) - a silent
  pass is a finding.
- Inferred things are marked inferred (`confidence`, `provenance`), never upgraded to verified without evidence.

### 7. Scanner safety - high
archmap scans repositories it does not control.
- prescan and extractors never `import`, `require`, `eval` or execute files from the scanned repo, and never run its
  scripts or package managers.
- Child processes use `execFile`/`spawn` with an argument array, never a shell string built from repo-controlled
  values (paths, branch names, file contents).
- DB introspection is read-only and schema-only (no row reads); a DuckDB file held by a server is copied to a temp file
  first; remote DBs only with an explicit `--db`. Temp files are cleaned up.

### 8. Hooks and commands - med
A noisy or failing SessionStart hook degrades every session of every user.
- Hooks always exit 0, print nothing unless they have one useful line, never call an LLM, and stay fast (no full scans).
- Commands call scripts as `node "${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs" $ARGUMENTS`; script-only commands set
  `disable-model-invocation: true`.
- Agents and skills follow the token rules (design section 8): explorers read excerpts and return size-capped JSON.

### 9. Tests - med
- New behaviour has a `node:test` case that would fail without the change. Tests use no network, build git repos in
  `os.tmpdir()` and clean up, and never depend on `.private/` except through a visible skip.

## Report format

Return findings as JSON in the audit reviewer's shape (the sign-off reviewer copies them into its return):

```json
{"findings": [{"id": 1, "severity": "high", "file": "scripts/render.mjs:88-91",
               "issue": "Template links an external font, so opening the HTML makes a network request (rule 4).",
               "resolution": "Drop the <link> and use the system font stack; fonts stay overridable via archmap.theme.json."}],
 "preExisting": [],
 "scan": {"ran": true, "leads": 3, "confirmed": 1}}
```

- `severity` follows the rule's level unless the context clearly lowers or raises it - say why when you change it.
- `file` is `path:line` or `path:start-end` in the head tree.
- Problems outside the changed lines go in `preExisting`.
- When used directly by a person (not at audit sign-off), follow the JSON with a short plain-language summary.
- No findings is a valid result: return `{"findings": [], ...}` and say what you checked.
