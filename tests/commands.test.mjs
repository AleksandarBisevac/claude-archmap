import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (c1, c2, ...) lead every title so the suite prints them first.
// The plugin commands are specified in docs/design.md section 4 (conventions) and section 6 (flows).
// P5.4 ships build, update and render; P6.4 adds check and issues; P7.6 adds export.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMANDS = ['build', 'update', 'render'];

function load(name) {
  const file = join(ROOT, 'commands', `${name}.md`);
  assert.ok(existsSync(file), `commands/${name}.md exists`);
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${name}.md starts with a --- frontmatter block`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: m[2] };
}

test('c1 build, update and render each carry description, argument-hint and allowed-tools frontmatter', () => {
  for (const name of COMMANDS) {
    const { fm } = load(name);
    for (const key of ['description', 'argument-hint', 'allowed-tools']) {
      assert.ok(fm[key] && fm[key].length > 0, `${name}.md has a non-empty ${key}`);
    }
    assert.ok(fm.description.length > 20, `${name}.md description says something`);
  }
});

test('c2 the argument hints name the design.md flags', () => {
  const hint = (n) => load(n).fm['argument-hint'];
  for (const f of ['--issues', '--profile', '--db', '--scope', '--publish']) assert.ok(hint('build').includes(f), `build ${f}`);
  for (const f of ['--issues', '--profile', '--since']) assert.ok(hint('update').includes(f), `update ${f}`);
  for (const f of ['--internal', '--shared']) assert.ok(hint('render').includes(f), `render ${f}`);
});

test('c3 render.md is script-only: disable-model-invocation: true and it runs render.mjs; build and update do not set it', () => {
  const r = load('render');
  assert.equal(r.fm['disable-model-invocation'], 'true');
  assert.ok(r.body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs"'), 'render.md runs render.mjs via the plugin root');
  assert.ok(r.body.includes('layout.mjs'), 'render.md lays out first when the layout file is missing');
  assert.ok(r.body.includes('.claude/archmap/'), 'internal and shared write under <home>/.claude/archmap/<repo-slug>/');
  for (const name of ['build', 'update']) assert.notEqual(load(name).fm['disable-model-invocation'], 'true', `${name} needs the model`);
});

test('c4 build and update are thin: they hand off to the architecture-map skill with $ARGUMENTS and do not restate the flow', () => {
  for (const [name, flow] of [['build', 'build'], ['update', 'update']]) {
    const { body } = load(name);
    assert.ok(body.includes('architecture-map'), `${name}.md names the skill`);
    assert.ok(body.includes('$ARGUMENTS'), `${name}.md passes $ARGUMENTS`);
    assert.match(body, new RegExp(`\\b${flow}\\b`, 'i'));
    assert.ok(body.split('\n').filter((l) => l.trim()).length <= 15, `${name}.md body stays short`);
    assert.doesNotMatch(body, /prescan\.mjs|merge\.mjs|synthesizer|explorer/i, `${name}.md does not restate the flow`);
  }
});

test('c5 every ${CLAUDE_PLUGIN_ROOT}/scripts/<x>.mjs a command or SKILL.md names exists, unless SKILL.md marks it not yet built', () => {
  const pluginRef = /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z][a-z-]*)\.mjs/g;
  const exists = (x) => existsSync(join(ROOT, 'scripts', `${x}.mjs`));
  for (const name of COMMANDS) {
    const { body } = load(name);
    for (const m of body.matchAll(pluginRef)) assert.ok(exists(m[1]), `commands/${name}.md names scripts/${m[1]}.mjs which does not exist`);
  }
  const skill = readFileSync(join(ROOT, 'skills/architecture-map/SKILL.md'), 'utf8');
  const paragraphs = skill.split(/\n\s*\n/);
  for (const para of paragraphs) {
    for (const m of para.matchAll(/(?<![\w/.-])(?:\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/|scripts\/)?([a-z][a-z-]*)\.mjs\b/g)) {
      if (exists(m[1])) continue;
      assert.match(para, /not yet built/i, `SKILL.md names ${m[1]}.mjs, which does not exist, without marking it not yet built`);
    }
  }
});

test('c6 the guard in c5 can fail: a missing script without the marker is flagged', () => {
  const para = 'Run `${CLAUDE_PLUGIN_ROOT}/scripts/nope.mjs` now.';
  const missing = [...para.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z][a-z-]*)\.mjs/g)].map((m) => m[1]).filter((x) => !existsSync(join(ROOT, 'scripts', `${x}.mjs`)));
  assert.deepEqual(missing, ['nope']);
});

test('c7 check.md and issues.md carry description, argument-hint and allowed-tools; check.md is script-only and runs staleness.mjs --check; issues.md hands off to the skill', () => {
  for (const name of ['check', 'issues']) {
    const { fm } = load(name);
    for (const key of ['description', 'argument-hint', 'allowed-tools']) {
      assert.ok(fm[key] && fm[key].length > 0, `${name}.md has a non-empty ${key}`);
    }
    assert.ok(fm.description.length > 20, `${name}.md description says something`);
  }
  const c = load('check');
  assert.equal(c.fm['disable-model-invocation'], 'true');
  assert.ok(c.body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/staleness.mjs" --check'), 'check.md runs staleness.mjs --check via the plugin root');
  assert.match(c.body, /exit code/i, 'check.md reports the exit code');
  const i = load('issues');
  assert.notEqual(i.fm['disable-model-invocation'], 'true', 'issues needs the model');
  for (const f of ['--import-audit', '--profile']) assert.ok(i.fm['argument-hint'].includes(f), `issues ${f}`);
  assert.ok(i.body.includes('architecture-map') && i.body.includes('$ARGUMENTS') && /\bissues\b/i.test(i.body), 'issues.md hands off to the skill with $ARGUMENTS');
  assert.ok(i.body.split('\n').filter((l) => l.trim()).length <= 15, 'issues.md body stays short');
  assert.doesNotMatch(i.body, /prescan\.mjs|merge\.mjs|synthesizer|explorer/i, 'issues.md does not restate the flow');
});

test('c8 the plugin-root script references of check.md and issues.md exist', () => {
  for (const name of ['check', 'issues']) {
    const { body } = load(name);
    for (const m of body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z][a-z-]*)\.mjs/g)) {
      assert.ok(existsSync(join(ROOT, 'scripts', `${m[1]}.mjs`)), `commands/${name}.md names scripts/${m[1]}.mjs which does not exist`);
    }
  }
});

test('c9 export.md is script-only: frontmatter keys, runs export.mjs via the plugin root, names all five formats and exit codes 1, 2 and 3', () => {
  const { fm, body } = load('export');
  for (const key of ['description', 'argument-hint', 'allowed-tools']) {
    assert.ok(fm[key] && fm[key].length > 0, `export.md has a non-empty ${key}`);
  }
  assert.ok(fm.description.length > 20, 'export.md description says something');
  assert.equal(fm['disable-model-invocation'], 'true');
  assert.ok(fm['allowed-tools'].includes('Bash') && fm['allowed-tools'].includes('Read'), 'export.md allows Bash and Read');
  for (const f of ['mermaid', 'plantuml', 'svg', 'png', 'md', '--view']) assert.ok(fm['argument-hint'].includes(f), `export argument-hint names ${f}`);
  assert.ok(body.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/export.mjs" docs/architecture/architecture.model.json'), 'export.md runs export.mjs via the plugin root');
  assert.ok(body.includes('$ARGUMENTS'), 'export.md passes $ARGUMENTS');
  assert.ok(body.includes('--layout docs/architecture/architecture.layout.json'), 'export.md passes the layout when it exists');
  assert.ok(body.includes('/archmap:build'), 'export.md says to run /archmap:build when the model is missing');
  for (const f of ['mermaid', 'plantuml', 'svg', 'png', 'md']) assert.match(body, new RegExp(`\\b${f}\\b`), `export.md names ${f}`);
  for (const code of ['1', '2', '3']) assert.match(body, new RegExp(`[Ee]xit ${code}\\b`), `export.md explains exit ${code}`);
  assert.match(body, /CHROME_PATH|Chromium/, 'exit 3 is explained as no Chromium');
  assert.match(body, /clean/i, 'export.md says exports are clean');
  assert.match(body, /no issues/i, 'export.md says exports carry no issues');
  for (const m of body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z][a-z-]*)\.mjs/g)) {
    assert.ok(existsSync(join(ROOT, 'scripts', `${m[1]}.mjs`)), `export.md names scripts/${m[1]}.mjs which does not exist`);
  }
});
