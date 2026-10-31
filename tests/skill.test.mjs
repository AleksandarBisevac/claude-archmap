import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// s10's guard as a function over the flow text, so s11 can show that the guard itself fails on a bad flow: every
// rule the build flow must keep, each broken rule one violation string.
function flowViolations(flow) {
  const v = [];
  const lines = flow.split('\n');
  const steps = [...flow.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  if (steps.length !== 6) v.push(`six steps, got ${JSON.stringify(steps)}`);
  const want = [/\bplan\b/i, /dispatch[^\n]*explorers/i, /\bfinish\b/i, /dispatch[^\n]*synthesizer/i, /\brender\b/i, /\breport\b/i];
  steps.forEach((s, i) => { if (want[i] && !want[i].test(s)) v.push(`step ${i + 1} is "${s}"`); });
  // the only script the build flow runs is the driver, in its three steps
  const scripts = [...new Set([...flow.matchAll(/([a-z][a-z-]*)\.mjs\b/g)].map((m) => m[1]))];
  if (JSON.stringify(scripts) !== JSON.stringify(['pipeline'])) v.push(`the build flow names a script but pipeline.mjs: ${scripts.join(', ')}`);
  for (const s of ['plan', 'finish', 'render']) {
    if (!new RegExp(`node "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/pipeline\\.mjs" ${s}\\b`).test(flow)) v.push(`pipeline.mjs ${s} is not run`);
  }
  // one message per dispatch, foreground, and no polling
  if (!/(one|a single) message/i.test(flow)) v.push('the explorers do not go out in one message');
  for (const tool of ['ScheduleWakeup', 'Monitor']) {
    if (!lines.some((l) => l.includes(tool) && /\b(never|no|not|do not)\b/i.test(l))) v.push(`${tool} is not forbidden`);
  }
  if (!lines.some((l) => /background/i.test(l) && /\b(never|no|not|do not)\b/i.test(l))) v.push('background dispatch is not forbidden');
  const asks = lines.filter((l) => /re-?ask|re-?request|re-?dispatch|send (it|them) back/i.test(l));
  if (asks.length) v.push(`a re-ask: ${asks.join(' / ')}`);
  // nothing to read during a build: no reference, script or agent file
  const read = flow.match(/references\/|\]\([^)]*\.md\)|agents\/|\b[a-z-]+\.md\b/);
  if (read) v.push(`the build flow names a file to read: ${read[0]}`);
  // the cap table and the three-line reply contract travel in SKILL.md
  for (const [what, n] of [['nodes', 40], ['edges', 80], ['entities', 60], ['access rows', 80], ['tool calls', 20], ['source reads', 12], ['areas', 8]]) {
    if (!lines.some((l) => /^\|/.test(l) && l.includes(what) && new RegExp(`\\b${n}\\b`).test(l))) v.push(`no cap table row: ${n} ${what}`);
  }
  for (const line of ['fragment: ', 'synth: ', 'counts: ', 'tool calls: ']) if (!flow.includes(line)) v.push(`no reply line ${line}`);
  if (!/three lines/i.test(flow)) v.push('the three-line reply is not stated');
  return v;
}

test('s10 the build flow names only plan, the explorer dispatch, finish, the synthesizer dispatch, render and report; forbids polling and background dispatch; carries the caps and the three-line replies; names no file to read', () => {
  assert.deepEqual(flowViolations(section('Build flow')), []);
  assert.ok(skill.split('\n').length <= 500, 'SKILL.md stays within 500 lines');
});

test('s11 the guard in s10 can fail: a flow that reads a reference, runs another script and polls makes flowViolations report each', () => {
  const good = section('Build flow');
  assert.deepEqual(flowViolations(good), [], 'the real flow is clean, so every violation below comes from the change');
  const bad = '### 1. Plan\nRead [x](references/model-schema.md) and grep merge.mjs for the caps.\nPoll with ScheduleWakeup.\n';
  const v = flowViolations(bad);
  for (const re of [/six steps/, /names a script but pipeline\.mjs: merge/, /ScheduleWakeup is not forbidden/, /Monitor is not forbidden/, /names a file to read/, /no cap table row/]) {
    assert.ok(v.some((x) => re.test(x)), `${re} among ${JSON.stringify(v)}`);
  }
  // one broken rule in an otherwise good flow is caught on its own
  const oneBad = good.replace(/Never set `run_in_background`, never use ScheduleWakeup or Monitor/, 'Use ScheduleWakeup or Monitor');
  assert.notEqual(oneBad, good, 'the dispatch rule sentence is present to break');
  assert.ok(flowViolations(oneBad).some((x) => /ScheduleWakeup is not forbidden/.test(x)), JSON.stringify(flowViolations(oneBad)));
  const reask = `${good}\nIf a fragment is thin, re-dispatch the explorer.\n`;
  assert.ok(flowViolations(reask).some((x) => /a re-ask/.test(x)));
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

test('s14 SKILL.md says entities, relations and queue edges are generated by merge from the full extracts, the explorer reads the summary, and it stays at or under 500 lines', () => {
  const lines = skill.split('\n');
  assert.ok(lines.length <= 500, `SKILL.md has ${lines.length} lines`);
  assert.match(skill, /entities, relations and queue edges[^\n]*\b(generated|made)\b[^\n]*\bmerge(\.mjs)?\b[^\n]*\bextracts?\b/i, 'who makes them, from what');
  assert.match(skill, /summary/i, 'the explorer summary is named');
});

// P10.12: with --issues the flow is plan, explorers, finish, synthesizer, render, reviewer, issues, report - four driver
// steps and two dispatches - and an agent that has replied is never messaged again.
test('s15 the --issues flow names plan, explorers, finish, synthesizer, render, reviewer, issues and report in that order, runs pipeline.mjs issues, forbids SendMessage to a finished agent and any second ask, and stays at or under 500 lines', () => {
  const lines = skill.split('\n');
  assert.ok(lines.length <= 500, `SKILL.md has ${lines.length} lines`);
  const flowLine = lines.find((l) => /plan/i.test(l) && /explorers/i.test(l) && /finish/i.test(l) && /synthesizer/i.test(l) && /render/i.test(l) && /reviewer/i.test(l) && /\bissues\b/i.test(l) && /report/i.test(l) && /--issues/.test(l));
  assert.ok(flowLine, 'one line gives the --issues order');
  // each word is looked for after the previous one, starting after the --issues flag itself
  let from = flowLine.indexOf('--issues') + '--issues'.length;
  const order = ['plan', 'explorers', 'finish', 'synthesizer', 'render', 'reviewer', 'issues', 'report'].map((w) => {
    const n = flowLine.toLowerCase().indexOf(w, from);
    if (n >= 0) from = n + w.length;
    return n;
  });
  assert.ok(order.every((n) => n >= 0), `the order in: ${flowLine}`);
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/pipeline\.mjs" issues --work <work>/, 'pipeline.mjs issues is invoked');
  assert.ok(lines.some((l) => /SendMessage/.test(l) && /\b(never|not|no)\b/i.test(l) && /(finished|replied|completed)/i.test(l)), 'SendMessage to a finished agent is forbidden');
  assert.ok(lines.some((l) => /(asked again|second ask|ask (it|them|an agent) again|try again)/i.test(l) && /\b(never|not|no)\b/i.test(l)), 'a second ask is forbidden');
  assert.match(skill, /reviewer\.json/, 'the reviewer writes <work>/reviewer.json');
  assert.doesNotMatch(skill, /save that reply to/i, 'the orchestrator no longer writes the reviewer file');
  assert.deepEqual(lines.filter((l) => /re-?ask|re-?request|re-?dispatch|send (it|them) back/i.test(l)), [], 'the words the other guards catch stay out');
  assert.equal(lines[2].startsWith('description: Use to map or refresh the architecture of a code repository'), true);
  const fm = skill.match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.ok(fm.includes('Also runs the commands /archmap:build, /archmap:update, /archmap:issues, /archmap:render and /archmap:check.'));
});

// P10.19 (P10-R14, P10-R16, P10-R6): eval 2 spent five of its 17 turns reading script sources to learn where the
// --issues overlay goes when the caller wants it outside the repository and how to print and copy the ledger.
// SKILL.md says both in the build flow, and says what the orchestrator checks after each dispatch, now that the
// explorer and the synthesizer hold the Write tool.
test('s16 the build flow names the --issues overlay location for an output outside the repository, the exact ledger command and the copy, and the check of what changed after a dispatch', () => {
  const flow = section('Build flow').replace(/\s+/g, ' ');
  // the overlay: where the issues step writes it, and the copy to the caller's directory
  assert.match(flow, /`<home>\/\.claude\/archmap\/<repo-slug>\/issues\.json`/, 'the overlay path');
  assert.match(flow, /`files\.issues`[^.]*`files\.html`/, 'the issues step prints both paths');
  assert.match(flow, /outside the repository[^.]*\bcp\b|\bcp\b[^.]*outside the repository/i, 'an overlay asked for outside the repository is copied there');
  assert.match(flow, /cp <home>\/\.claude\/archmap\/<repo-slug>\/issues\.json <home>\/\.claude\/archmap\/<repo-slug>\/archmap\.internal\.html <dir>\//, 'the exact overlay copy');
  // the ledger: the exact command that prints it, its file, and the copy in the same call as the last driver step
  assert.ok(flow.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/pipeline.mjs" ledger --work <work>'), 'the ledger print command');
  assert.match(flow, /cp <work>\/usage\.jsonl <path>/, 'the ledger copy command');
  assert.match(flow, /same Bash call as the last driver step/i, 'which step runs the copy');
  assert.match(flow, /--usage reviewer=[^.]*same pair/i, 'after --issues the ledger command takes the issues step\'s reviewer pair');
  // the Write tool: the residual risk and the check after a dispatch
  const rules = section('Hard rules').replace(/\s+/g, ' ');
  assert.match(rules, /Write tool/, 'hard rule 1 names the Write tool');
  assert.match(rules, /frontmatter cannot (scope|limit)/i, 'the residual risk: the frontmatter cannot scope Write to one path');
  assert.match(flow, /git status --porcelain/, 'the project tree is checked after a dispatch');
  assert.match(flow, /ls <work>\/fragments/, 'the work dir is listed after the explorers');
  assert.match(flow, /only new or changed file[^.]*(fragment|synth)/i, 'the only new or changed file is the named path');
  assert.deepEqual(flowViolations(section('Build flow')), [], 'the additions keep the build flow guard clean');
  assert.ok(skill.split('\n').length <= 500, 'SKILL.md stays within 500 lines');
});

// P10-R7: the 12-turn and 80 K targets are measured, not implied by the number of steps. Each row is one orchestrator
// assistant turn of a recorded round-6 eval session (claude -p, stream-json, Opus orchestrator), as [input, output,
// cache read, cache write] tokens, the figures and nothing else; cost-profile.mjs reads them as it reads any stream.
const RECORDED_ORCHESTRATOR = {
  'eval 1 (build)': [[2, 16, 19452, 16800], [2, 16, 36252, 223], [4, 16, 36475, 247], [4, 16, 36722, 9191], [2, 58, 45913, 2602], [4, 6, 48515, 8147], [2, 16, 56662, 1232], [4, 16, 57894, 975], [2, 43, 58869, 2095], [2, 16, 60964, 480], [2, 3, 61444, 1456]],
  'eval 4 (monorepo build)': [[2, 20, 11267, 20331], [2, 16, 31598, 9287], [4, 16, 40885, 247], [4, 16, 41132, 9191], [2, 5, 50323, 2950], [4, 8, 53273, 8181], [2, 16, 61454, 1153], [4, 16, 62607, 977], [2, 41, 63584, 2176], [2, 16, 65760, 465], [2, 4, 66225, 1519]],
};
const COST_PROFILE = fileURLToPath(new URL('../scripts/cost-profile.mjs', import.meta.url));

/** cost-profile.mjs --json over a stream built from recorded orchestrator turns. */
function profileOf(turns) {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-skill-'));
  try {
    const f = join(dir, 'stream.jsonl');
    writeFileSync(f, turns.map(([input, output, read, write], i) => JSON.stringify({
      type: 'assistant', parent_tool_use_id: null,
      message: { id: `t${i + 1}`, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } },
    })).join('\n') + '\n');
    const r = spawnSync(process.execPath, [COST_PROFILE, f, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('s17 the 12-turn and 80 K targets read the orchestrator turns and max context from cost-profile.mjs over recorded sessions, and a 13-turn session fails the check', () => {
  const within = (j) => {
    const o = j.byAgent.find((a) => a.agent === 'orchestrator');
    return { turns: o.turns, maxContext: o.maxContext, ok: o.turns <= 12 && o.maxContext < 80000 };
  };
  for (const [name, turns] of Object.entries(RECORDED_ORCHESTRATOR)) {
    const got = within(profileOf(turns));
    assert.ok(got.ok, `${name}: ${got.turns} orchestrator turns, max context ${got.maxContext}`);
  }
  assert.deepEqual(within(profileOf(RECORDED_ORCHESTRATOR['eval 1 (build)'])), { turns: 11, maxContext: 62902, ok: true });
  // the same check on a session one turn over: it fails
  const over = [...RECORDED_ORCHESTRATOR['eval 1 (build)'], [2, 16, 61444, 100], [2, 16, 61544, 100]];
  assert.deepEqual(within(profileOf(over)), { turns: 13, maxContext: 62902, ok: false });
});
