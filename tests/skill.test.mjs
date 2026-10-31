import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Case ids (s1, s2, ...) lead every title so the suite prints them first.
// skills/architecture-map/SKILL.md is the entry point of the skill: it must stay small,
// link every reference, and invoke scripts through the plugin root.
const skillUrl = new URL('../skills/architecture-map/SKILL.md', import.meta.url);
const skillPath = skillUrl.pathname;
const refsDir = new URL('../skills/architecture-map/references/', import.meta.url).pathname;
const skill = readFileSync(skillUrl, 'utf8');

const frontmatter = () => {
  const m = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md starts with a --- frontmatter block');
  return m[1];
};

test('s1 SKILL.md is at most 500 lines with name: architecture-map and a non-empty description', () => {
  const lines = skill.split('\n').length;
  assert.ok(lines <= 500, `SKILL.md has ${lines} lines`);
  const fm = frontmatter();
  assert.match(fm, /^name:\s*architecture-map\s*$/m);
  const d = fm.match(/^description:\s*(.*)$/m);
  assert.ok(d && d[1].replace(/^[>|-]\s*/, '').trim().length > 20, 'description is non-empty');
});

test('s2 every file in references/ is linked from SKILL.md and every relative link resolves', () => {
  const linked = [...skill.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]);
  for (const f of readdirSync(refsDir).filter((n) => n.endsWith('.md'))) {
    assert.ok(linked.includes(`references/${f}`), `references/${f} is not linked`);
  }
  for (const l of linked.filter((l) => !/^[a-z]+:/i.test(l))) {
    assert.ok(existsSync(resolve(dirname(skillPath), l)), `broken link ${l}`);
  }
});

test('s3 scripts are invoked via ${CLAUDE_PLUGIN_ROOT}/scripts/ and never by a bare path', () => {
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/pipeline\.mjs"/);
  for (const s of ['validate', 'render']) {
    assert.ok(skill.includes(`\${CLAUDE_PLUGIN_ROOT}/scripts/${s}.mjs`), `${s}.mjs invoked via plugin root`);
  }
  const bare = skill.split('\n').filter((l) => /\bnode\s+(?!"\$\{CLAUDE_PLUGIN_ROOT\})\S*scripts\//.test(l));
  assert.deepEqual(bare, []);
});

test('s4 the three agents and the three profiles are mentioned', () => {
  for (const a of ['archmap-explorer', 'archmap-synthesizer', 'archmap-reviewer']) assert.ok(skill.includes(a), a);
  for (const p of ['max', 'balanced', 'economy']) assert.match(skill, new RegExp(`\\b${p}\\b`), p);
});

test('s5 SKILL.md does not let the synthesizer or reviewer write architecture.model.json; the orchestrator merges the returned JSON and validates', () => {
  const lines = skill.split('\n');
  const writeVerb = /\b(edits?|writes?|writing|rewrites?|updates?|saves?)\b/i;
  const claims = lines.filter((l) => {
    if (!/synthesizer|reviewer/i.test(l)) return false;
    if (/\b(never|not|no|without|only the orchestrat\w*)\b/i.test(l)) return false;
    return writeVerb.test(l) && l.includes('architecture.model.json');
  });
  assert.deepEqual(claims, [], 'a line claims an agent writes architecture.model.json');
  const rows = lines.filter((l) => /^\|.*(archmap-synthesizer|archmap-reviewer)/.test(l));
  assert.ok(rows.length >= 2, 'agent table rows for synthesizer and reviewer');
  assert.deepEqual(rows.filter((l) => /updated model/i.test(l)), [], 'no table row says an agent outputs the updated model');
  const synth = rows.find((l) => l.includes('archmap-synthesizer'));
  assert.match(synth, /JSON/, 'synthesizer row says it returns JSON');
  assert.match(skill, /orchestrat\w*[^\n]*\bmerg\w*[^\n]*\bvalidate/i, 'orchestrator merges the returned object and runs validate');
  assert.match(skill, /only the orchestrat\w*[^\n]*(writes?|edits?)[^\n]*architecture\.model\.json/i, 'only the orchestrator writes the model');
});

test('s7 SKILL.md names merge, diffmap and usage as what the driver runs (none marked not yet built), the update flow drives them, the orchestrator never calls usage.mjs, and export.mjs is invoked', () => {
  const lines = skill.split('\n');
  for (const s of ['merge', 'diffmap', 'usage']) {
    assert.ok(skill.includes(`${s}.mjs`), `${s}.mjs is named`);
    const stale = lines.filter((l) => l.includes(`${s}.mjs`) && /not yet built/i.test(l));
    assert.deepEqual(stale, [], `${s}.mjs is still marked not yet built`);
  }
  assert.match(skill, /pipeline\.mjs" plan [^\n]*--update/, 'the update flow runs the driver with --update');
  assert.match(skill, /diffmap\.mjs[^\n]*--areas|--areas[^\n]*diffmap/i, 'the update merge is limited to the areas diffmap names');
  assert.doesNotMatch(skill, /usage\.mjs"\s+add\b/, 'the orchestrator never records a ledger row itself');
  assert.match(skill, /--usage <area>=<tokens>/, 'explorer tokens reach the ledger through finish --usage');
  assert.match(skill, /fragments/, 'merge reads the fragments dir');
  assert.ok(skill.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/export.mjs"'), 'export.mjs invoked via plugin root');
  assert.deepEqual(lines.filter((l) => l.includes('export.mjs') && /not yet built/i.test(l)), [], 'export.mjs is no longer marked not yet built');
});

// s6 (P4-R2): the claim scan must not be fooled by a stale line that says "agents" instead of a
// role name, nor by a stray negation word elsewhere in the line. Only the specific allowed
// phrasings are removed before a line is judged.
const staleClaims = (lines) => {
  const agentWord = /\bagents?\b|synthesizer|reviewer|explorer/i;
  // a write verb followed by the model, or the model followed by a passive write ("is written by")
  const verb = '(?:edits?|writes?|writing|rewrites?|updates?|saves?)';
  const model = '(?:architecture\\.model\\.json|the model\\b)';
  const claim = new RegExp(`\\b${verb}\\b[^|]*?${model}|${model}[^|]*?\\b(?:written|edited|updated|saved|rewritten)\\b`, 'i');
  const allowed = [
    /only the orchestrat\w*\s+(?:writes?|edits?)\s+(?:the model|`?architecture\.model\.json`?)/gi,
    /\bno write tools\b/gi,
    /\b(?:never|do not|does not|cannot|must not)\s+(?:write|edit|rewrite|update|save)\b/gi,
  ];
  return lines.filter((l) => {
    if (!agentWord.test(l)) return false;
    let rest = l;
    for (const re of allowed) rest = rest.replace(re, ' ');
    return claim.test(rest);
  });
};

test('s6 the claim scan catches an "agents write the model" line and a negation-laced one, and SKILL.md has none', () => {
  const stale = [
    'Agents write the model and the orchestrator only validates it.',
    'The agent edits architecture.model.json directly.',
    'the synthesizer writes the model, no review needed',
    'The reviewer updates the model; the orchestrator does not check it.',
    'The model is written by the synthesizer agent.',
  ];
  assert.deepEqual(staleClaims(stale), stale, 'every stale phrasing is flagged');
  const fine = [
    '1. **Only the orchestrator writes the model.** Agents have no write tools for it and return JSON; scripts write HTML,',
    'Agents never write architecture.model.json; they return JSON.',
    'Writing or updating `sequences[]` (the synthesizer, step 5 of build).',
    '| `archmap-reviewer` | Opus | The model and the issues catalogue | One JSON object; you write it as `issues.json` |',
  ];
  assert.deepEqual(staleClaims(fine), [], 'the allowed phrasing is not flagged');
  assert.deepEqual(staleClaims(skill.split('\n')), [], 'SKILL.md carries no line that says an agent writes the model');
});

test('s8 SKILL.md invokes staleness.mjs and issues.mjs (import-audit, merge, lint, path), no longer marks them not yet built, and no longer marks export.mjs', () => {
  const lines = skill.split('\n');
  for (const s of ['staleness', 'issues']) {
    assert.ok(skill.includes(`\${CLAUDE_PLUGIN_ROOT}/scripts/${s}.mjs`), `${s}.mjs named via plugin root`);
    assert.deepEqual(lines.filter((l) => l.includes(`${s}.mjs`) && /not yet built/i.test(l)), [], `${s}.mjs is still marked not yet built`);
  }
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/staleness\.mjs" --check/, 'staleness --check invoked');
  for (const sub of ['import-audit', 'merge', 'lint', 'path']) {
    assert.match(skill, new RegExp(`node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/issues\\.mjs" ${sub}\\b`), `issues.mjs ${sub} invoked`);
  }
  assert.match(skill, /before any `--mode shared` render[^\n]*\n?[^\n]*lint/i, 'lint is required before a shared render');
  assert.match(skill, /--publish` of a shared build/, 'lint is required before publishing a shared build');
  assert.match(skill, /SessionStart/, 'the SessionStart hook is described');
  assert.ok(lines.some((l) => l.includes('${CLAUDE_PLUGIN_ROOT}/scripts/export.mjs')), 'export.mjs invoked via ${CLAUDE_PLUGIN_ROOT}');
  assert.deepEqual(lines.filter((l) => l.includes('export.mjs') && /not yet built/i.test(l)), [], 'export.mjs is not marked not yet built');
  assert.ok(lines.length <= 500, 'SKILL.md stays within 500 lines');
});

test('s9 SKILL.md has no re-ask path, states the three-line explorer reply and the fragment and extract paths, and stays within 500 lines', () => {
  const lines = skill.split('\n');
  assert.ok(lines.length <= 500, `SKILL.md has ${lines.length} lines`);
  assert.deepEqual(lines.filter((l) => /re-?ask|re-?request|re-?dispatch/i.test(l)), [], 'no line sends an explorer back for another try');
  assert.match(skill, /three lines/i, 'the explorer reply is three lines');
  assert.match(skill, /<work>\/extracts\/<area>\.json/, 'the extract the explorer reads');
  assert.match(skill, /<work>\/fragments\/<area>\.json/, 'the fragment the explorer writes');
  assert.match(skill, /truncat/i, 'merge truncates instead of bouncing a fragment');
  assert.equal(lines[2], 'description: Use to map or refresh the architecture of a code repository: which components or services exist, what calls what, what each reads or writes in databases, queues and external APIs, and how requests and background jobs flow. Trigger on requests for C4 or container diagrams, architecture or onboarding docs (including Confluence pages), mapping an inherited or multi-service monorepo, updating an existing architecture doc after code changes, and system-level checks such as auth boundaries, shared state or cross-service coupling. Output is evidence-cited with an offline HTML viewer. Do not use for explaining a single file, reviewing a PR, writing ADRs, API specs, slide decks or refactors. Also runs the commands /archmap:build, /archmap:update, /archmap:issues, /archmap:render and /archmap:check.', 'frontmatter description (line 3) is untouched');
});

// s10 (P10.4): the build flow is the driver. The orchestrating session reads SKILL.md once and then runs three
// driver steps and two dispatch messages; everything else (prescan, merge, validate, layout, render, the ledger)
// happens inside scripts/pipeline.mjs.
const section = (heading) => {
  const start = skill.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `SKILL.md has a "## ${heading}" section`);
  const rest = skill.slice(start + 1);
  const end = rest.indexOf('\n## ', 4);
  return end < 0 ? rest : rest.slice(0, end);
};

test('s10 the build flow names only plan, the explorer dispatch, finish, the synthesizer dispatch, render and report; forbids polling and background dispatch; carries the caps and the three-line replies; names no file to read', () => {
  const flow = section('Build flow');
  const steps = [...flow.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.equal(steps.length, 6, `six steps, got ${JSON.stringify(steps)}`);
  const want = [/\bplan\b/i, /dispatch[^\n]*explorers/i, /\bfinish\b/i, /dispatch[^\n]*synthesizer/i, /\brender\b/i, /\breport\b/i];
  steps.forEach((s, i) => assert.match(s, want[i], `step ${i + 1} is "${s}"`));
  // the only script the build flow runs is the driver, in its three steps
  const scripts = [...flow.matchAll(/([a-z][a-z-]*)\.mjs\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(scripts)], ['pipeline'], 'the build flow names no script but pipeline.mjs');
  for (const s of ['plan', 'finish', 'render']) {
    assert.match(flow, new RegExp(`node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/pipeline\\.mjs" ${s}\\b`), `pipeline.mjs ${s}`);
  }
  // one message per dispatch, foreground, and no polling
  assert.match(flow, /(one|a single) message/i, 'the explorers go out in one message');
  for (const tool of ['ScheduleWakeup', 'Monitor']) {
    assert.ok(flow.split('\n').some((l) => l.includes(tool) && /\b(never|no|not|do not)\b/i.test(l)), `${tool} is forbidden`);
  }
  assert.ok(flow.split('\n').some((l) => /background/i.test(l) && /\b(never|no|not|do not)\b/i.test(l)), 'background dispatch is forbidden');
  assert.deepEqual(flow.split('\n').filter((l) => /re-?ask|re-?request|re-?dispatch|send (it|them) back/i.test(l)), [], 'no re-ask');
  // nothing to read during a build: no reference, script or agent file
  assert.doesNotMatch(flow, /references\/|\]\([^)]*\.md\)|agents\/|\b[a-z-]+\.md\b/, 'the build flow names no file to read');
  // the cap table and the three-line reply contract travel in SKILL.md
  for (const [what, n] of [['nodes', 40], ['edges', 80], ['entities', 60], ['access rows', 80], ['tool calls', 20], ['source reads', 12], ['areas', 8]]) {
    assert.ok(flow.split('\n').some((l) => /^\|/.test(l) && l.includes(what) && new RegExp(`\\b${n}\\b`).test(l)), `cap table row: ${n} ${what}`);
  }
  for (const line of ['fragment: ', 'synth: ', 'counts: ', 'tool calls: ']) assert.ok(flow.includes(line), `reply line ${line}`);
  assert.match(flow, /three lines/i);
  // the turn count the flow implies: the skill load, one turn per step, within the 12-turn target
  assert.ok(1 + steps.length <= 12, `${1 + steps.length} orchestrator turns`);
  assert.ok(skill.split('\n').length <= 500, 'SKILL.md stays within 500 lines');
});

test('s11 the guard in s10 can fail: a flow that greps a reference or polls is caught', () => {
  const bad = '### 1. Plan\nRead [x](references/model-schema.md) and grep merge.mjs for the caps.\nPoll with ScheduleWakeup.\n';
  assert.match(bad, /references\/|\]\([^)]*\.md\)|agents\/|\b[a-z-]+\.md\b/);
  assert.deepEqual([...new Set([...bad.matchAll(/([a-z][a-z-]*)\.mjs\b/g)].map((m) => m[1]))], ['merge']);
  assert.ok(!bad.split('\n').some((l) => l.includes('ScheduleWakeup') && /\b(never|no|not|do not)\b/i.test(l)));
});

// s12 (P10.7): the explorer runs at medium effort, and the build flow carries the work-dir rule.
test('s12 the agents table and the profile table say the explorer runs at medium effort; SKILL.md stays within 500 lines', () => {
  const row = skill.split('\n').find((l) => /^\|\s*`archmap-explorer`/.test(l) && /Sonnet/.test(l));
  assert.ok(row, 'the agents table has an explorer row');
  assert.match(row, /medium effort/i, row);
  assert.doesNotMatch(row, /low effort/i);
  const profile = skill.split('\n').find((l) => /^\|\s*`balanced`/.test(l));
  assert.ok(profile, 'the profile table has a balanced row');
  const cells = profile.split('|').map((c) => c.trim());
  assert.match(cells[2], /Sonnet \(medium\)/, `balanced explorer cell: ${cells[2]}`);
  assert.doesNotMatch(skill, /Sonnet \(low\)/);
  assert.match(skill, /coverage floor/i, 'the explorer row or flow names the coverage floor');
  assert.ok(skill.split('\n').length <= 500, 'SKILL.md stays within 500 lines');
});

test('s13 the build flow tells the caller to leave --work off, why subagents must be able to write there, and that the ledger is copied to where the caller asked after render', () => {
  const flow = section('Build flow').replace(/\s+/g, ' ');
  assert.match(flow, /Leave `--work` off/, 'leave --work off');
  assert.match(flow, /<OS temp dir>\/archmap\/<hash of the repo path>/, 'the default work dir');
  assert.match(flow, /subagents must be able to write their fragments under the work dir/i);
  assert.match(flow, /denies a subagent a Write outside the project and the OS temp dir/i);
  assert.match(flow, /never point `--work` at another directory, a symlink or a non-ignored directory in the repo/i);
  assert.match(flow, /ledger is copied to where the caller asked after render/i, 'the ledger is copied after render');
});
