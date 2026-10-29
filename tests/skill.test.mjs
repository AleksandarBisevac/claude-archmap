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
  assert.match(skill, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/prescan\.mjs"/);
  for (const s of ['validate', 'layout', 'render']) {
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
