import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (b1..b4) lead every title so the suite prints them first.
// The benchmark document records which comparable plugins the release-1.0.0 benchmark runs against.
// This file parses it; it never contacts the network and has no dependencies.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CANDIDATES = join(ROOT, 'skills', 'architecture-map', 'evals', 'benchmark', 'CANDIDATES.md');

const load = () => {
  assert.ok(existsSync(CANDIDATES), 'CANDIDATES.md is missing');
  return readFileSync(CANDIDATES, 'utf8');
};

// The body of the "## <title>" section, up to the next "## " heading (or the end).
function section(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${title}`.toLowerCase());
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const bullets = (body) => body.split('\n').filter((l) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(l));

// First markdown table of the body: { header: [...], rows: [[...], ...] }.
function table(body) {
  const lines = body.split('\n').map((l) => l.trim());
  const first = lines.findIndex((l) => l.startsWith('|'));
  if (first === -1) return null;
  const block = [];
  for (let i = first; i < lines.length && lines[i].startsWith('|'); i++) block.push(lines[i]);
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [head, rule, ...rows] = block;
  if (!rule || !/^\|?\s*:?-{3,}/.test(rule)) return null;
  return { header: cells(head), rows: rows.map(cells) };
}

const column = (t, name) => {
  const i = t.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  assert.ok(i !== -1, `column ${name} is missing from [${t.header.join(', ')}]`);
  return t.rows.map((r) => r[i] ?? '');
};

test('b1 CANDIDATES.md has a Selection criteria section with at least three bullets', () => {
  const body = section(load(), 'Selection criteria');
  assert.notEqual(body, null, 'no "## Selection criteria" section');
  assert.ok(bullets(body).length >= 3, `only ${bullets(body).length} bullet(s)`);
});

test('b2 the candidates table has Name, Source, Version, Install, Output and two or more rows', () => {
  const body = section(load(), 'Candidates');
  assert.notEqual(body, null, 'no "## Candidates" section');
  const t = table(body);
  assert.notEqual(t, null, 'no table in the Candidates section');
  for (const h of ['Name', 'Source', 'Version', 'Install', 'Output']) {
    assert.ok(t.header.some((c) => c.toLowerCase() === h.toLowerCase()), `column ${h} missing`);
  }
  assert.ok(t.rows.length >= 2, `only ${t.rows.length} row(s)`);
  for (const [col, cells] of ['Name', 'Version', 'Output'].map((c) => [c, column(t, c)])) {
    cells.forEach((v, i) => assert.ok(v !== '', `row ${i + 1}: empty ${col} cell`));
  }
  const names = column(t, 'Name');
  assert.equal(new Set(names).size, names.length, 'duplicate candidate names');
  column(t, 'Source').forEach((v, i) =>
    assert.match(v, /^<?https:\/\/[^\s<>]+>?$/, `row ${i + 1}: Source is not a URL: ${v}`));
  column(t, 'Install').forEach((v, i) => {
    const code = [...v.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(code.length >= 1, `row ${i + 1}: Install has no inline command`);
    assert.ok(code.some((c) => /\bclaude\b.*(plugin|--plugin-dir)/.test(c)),
      `row ${i + 1}: Install carries no claude plugin command`);
  });
});

test('b3 Considered and rejected has at least one row and each row names one of the selection criteria', () => {
  const text = load();
  const criteria = bullets(section(text, 'Selection criteria') ?? '')
    .map((l) => (l.match(/\*\*([^*]+)\*\*/) ?? [])[1])
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  assert.ok(criteria.length >= 3, 'selection criteria bullets must each start with a bold label');
  const body = section(text, 'Considered and rejected');
  assert.notEqual(body, null, 'no "## Considered and rejected" section');
  const t = table(body);
  assert.notEqual(t, null, 'no table in the rejected section');
  assert.ok(t.rows.length >= 1, 'no rejected row');
  const named = column(t, 'Criterion');
  named.forEach((v, i) =>
    assert.ok(criteria.some((c) => v.toLowerCase().includes(c)),
      `row ${i + 1}: Criterion "${v}" names none of: ${criteria.join(', ')}`));
});

test('b4 the document is public: no machine path, home directory or environment-specific location', () => {
  const text = load();
  for (const re of [/\/Users\/\S/, /\/home\/\S/, /\/private\/\S/, /\/tmp\/\S/, /[A-Za-z]:\\\\?\S/, /~\//, /\.private\b/]) {
    assert.doesNotMatch(text, re, `matches ${re}`);
  }
});

// ---- P12.2: the protocol documents (prompt.md, PROTOCOL.md, rubric.md) ----
const DIR = join(ROOT, 'skills', 'architecture-map', 'evals', 'benchmark');
const DENYLIST = join(ROOT, '.private', 'anonymise-denylist.txt');
const loadDoc = (name) => {
  const file = join(DIR, name);
  assert.ok(existsSync(file), `${name} is missing`);
  return readFileSync(file, 'utf8');
};
const denyTerms = () =>
  readFileSync(DENYLIST, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.toLowerCase());
// Reports term indexes only, never a term.
function denylistHits(text) {
  const low = text.toLowerCase();
  return denyTerms().flatMap((t, i) => (low.includes(t) ? [`term #${i + 1}`] : []));
}
const candidateNames = () =>
  column(table(section(load(), 'Candidates')), 'Name').map((n) => n.replace(/`/g, '').trim());

const REPOS = {
  A: 'a Python API with a React front end and an embedded analytical database',
  B: 'a TypeScript monorepo with a Node API, an ORM and a job queue',
  C: 'a Next.js application with an admin API',
};
const ENV_VARS = ['ARCHMAP_EVAL_REPO_A', 'ARCHMAP_EVAL_REPO_B', 'ARCHMAP_EVAL_REPO_C'];

test('b5 prompt.md names no slash command, no candidate and not this plugin, and carries the placeholder for the repository variable', () => {
  const text = loadDoc('prompt.md');
  assert.doesNotMatch(text, /(^|[\s`(])\/[A-Za-z]/, 'a slash command appears');
  for (const n of candidateNames()) {
    assert.ok(!text.toLowerCase().includes(n.toLowerCase()), `prompt.md names ${n}`);
  }
  // Word boundaries: the required sentence says "architecture-mapping", which is not the skill name.
  assert.doesNotMatch(text, /\barchmap\b/i, 'prompt.md names archmap');
  assert.doesNotMatch(text, /\barchitecture-map\b/i, 'prompt.md names architecture-map');
  assert.ok(candidateNames().length >= 2, 'no candidate names were read');
  assert.match(text, /<ENV_NAME>/, 'the <ENV_NAME> placeholder is missing');
  assert.match(text, /architecture-mapping plugin installed in this session/);
  for (const re of [/component/i, /relation/i, /entit/i, /field/i, /three/i, /sequence/i, /file reference/i, /docs\/architecture/, /summary/i]) {
    assert.match(text, re, `prompt.md lacks ${re}`);
  }
  for (const v of ENV_VARS) assert.doesNotMatch(text, new RegExp(v), 'the prompt is substituted per cell, so it names no variable');
});

test('b6 PROTOCOL.md has the six sections, the Metrics section names every metric and the three variables are documented', () => {
  const text = loadDoc('PROTOCOL.md');
  for (const s of ['Repositories', 'Configurations', 'Metrics', 'Expectations', 'Limits', 'Evidence']) {
    const body = section(text, s);
    assert.notEqual(body, null, `no "## ${s}" section`);
    assert.ok(body.trim().length > 40, `section ${s} is empty`);
  }
  const metrics = section(text, 'Metrics').toLowerCase();
  for (const m of ['cost', 'duration', 'turns', 'context', 'pass rate', 'recall', 'rubric']) {
    assert.ok(metrics.includes(m), `Metrics does not name ${m}`);
  }
  for (const v of ENV_VARS) assert.ok(text.includes(v), `PROTOCOL.md does not name ${v}`);
  assert.ok(text.includes('<ENV_NAME>'), 'PROTOCOL.md does not document the placeholder');
  assert.match(text, /not graded/i);
});

test('b7 the repositories are described only by the three generic descriptions and no denylist term appears (skipped when the list is absent)', (t) => {
  const text = loadDoc('PROTOCOL.md');
  const body = section(text, 'Repositories');
  assert.notEqual(body, null, 'no "## Repositories" section');
  const rows = bullets(body);
  assert.equal(rows.length, 3, `expected three repository bullets, saw ${rows.length}`);
  ['A', 'B', 'C'].forEach((letter, i) => {
    assert.ok(rows[i].includes(`(${letter})`), `bullet ${i + 1} is not repository ${letter}`);
    assert.ok(rows[i].includes(REPOS[letter]), `repository ${letter} is not the generic description`);
  });
  if (!existsSync(DENYLIST)) {
    t.skip('denylist not checked: .private/anonymise-denylist.txt is absent');
    return;
  }
  for (const f of ['prompt.md', 'PROTOCOL.md', 'rubric.md']) {
    assert.deepEqual(denylistHits(loadDoc(f)), [], `${f} carries a denylist term`);
  }
});

test('b8 rubric.md has four axes, each with five levels numbered 1 to 5', () => {
  const text = loadDoc('rubric.md');
  const axes = text.split(/\r?\n/).filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, ''));
  assert.equal(axes.length, 4, `expected four axes, saw ${axes.length}`);
  for (const [i, re] of [/coverage/i, /correctness/i, /usefulness/i, /readability/i].entries()) {
    assert.match(axes[i], re, `axis ${i + 1} is "${axes[i]}"`);
  }
  for (const a of axes) {
    const lv = bullets(section(text, a));
    assert.equal(lv.length, 5, `${a}: ${lv.length} level(s)`);
    lv.forEach((l, i) => assert.match(l, new RegExp(`^\\s*${5 - i}\\.\\s+\\S`), `${a}: level line ${i + 1} should start "${5 - i}."`));
  }
});

test('b9 the protocol documents are public: no machine path, home directory or drive path', () => {
  for (const f of ['prompt.md', 'PROTOCOL.md', 'rubric.md']) {
    const text = loadDoc(f);
    for (const re of [/\/Users\/\S/, /\/home\/\S/, /\/private\/\S/, /\/tmp\/\S/, /[A-Za-z]:\\\\?\S/, /~\//]) {
      assert.doesNotMatch(text, re, `${f} matches ${re}`);
    }
  }
});

// ---- P12.3: the run script for one benchmark cell (run-candidate.sh) ----
// The behaviour cases run it against a stub `claude` put on PATH through --path-prepend, so no session is started.
const SCRIPT = join(DIR, 'run-candidate.sh');
// The environment of the caller, minus any configuration directory of its own, plus `env` (a null value unsets).
function runScript(args, env = {}) {
  const e = { ...process.env, ...env };
  delete e.CLAUDE_CONFIG_DIR;
  for (const [k, v] of Object.entries(env)) if (v === null) delete e[k];
  return spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: e });
}

// A stub claude: `plugin ...` subcommands are logged and answered; a session records its argv (NUL-separated) and its
// environment into the run directory, prints one stream line and exits 3.
const STUB = `#!/bin/sh
if [ "$1" = plugin ]; then
  printf '%s\\n' "$*" >> "$CLAUDE_CONFIG_DIR/../plugin-calls.txt"
  if [ "$2" = list ]; then printf '[{"id":"other@m","version":"9.9.9"},{"id":"mapper@mkt","version":"1.2.3"}]\\n'; fi
  exit 0
fi
for a in "$@"; do printf '%s\\0' "$a"; done > ../argv.bin
printf '{"type":"system","cwd":"%s","repo":"%s","claudecode":"%s","config":"%s"}\\n' "$PWD" "$ARCHMAP_EVAL_REPO_A" "\${CLAUDECODE-unset}" "\${CLAUDE_CONFIG_DIR-unset}"
printf '{"type":"result","subtype":"success","is_error":false,"duration_ms":1000}\\n'
echo "stub stderr" >&2
exit 3
`;
function cell() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-bench-')));
  const run = join(base, 'cell', 'run');
  mkdirSync(join(run, 'repo'), { recursive: true });
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), STUB);
  chmodSync(join(bin, 'claude'), 0o755);
  const prompt = join(base, 'prompt.md');
  const text = "Map the repository in <ENV_NAME>.\nIt's the one <ENV_NAME> names; \"quote\" $HOME `x`.\n";
  writeFileSync(prompt, text);
  return { base, run, bin, prompt, text };
}
const readArgv = (run) => readFileSync(join(run, 'argv.bin'), 'utf8').split('\0').slice(0, -1);
const HEADLESS = ['--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--permission-mode', 'auto', '--permission-prompts', 'none'];

test('b10 run-candidate.sh parses under sh -n and has a POSIX sh shebang', () => {
  assert.ok(existsSync(SCRIPT), 'run-candidate.sh is missing');
  assert.match(readFileSync(SCRIPT, 'utf8'), /^#!\/bin\/sh\n/);
  const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('b11 without arguments, or with a wrong mode, it prints the usage and exits 2', () => {
  const r = runScript([]);
  assert.equal(r.status, 2);
  const usage = r.stderr;
  assert.match(usage, /usage: run-candidate\.sh <run-dir> <ENV_NAME> <prompt-file> \(--plugin-dir <dir> \| --plugin <name@marketplace> --marketplace <url-or-path>\)/);
  for (const o of ['--model <model>', '--path-prepend <dir>', '-- <extra claude args>']) assert.ok(usage.includes(o), `usage names ${o}`);
  assert.equal(r.stdout, '');
  const c = cell();
  for (const args of [
    [c.run, 'ARCHMAP_EVAL_REPO_A', c.prompt],
    [c.run, 'ARCHMAP_EVAL_REPO_A', c.prompt, '--plugin-dir', c.base, '--plugin', 'mapper@mkt', '--marketplace', c.base],
    [c.run, 'ARCHMAP_EVAL_REPO_A', c.prompt, '--plugin', 'mapper@mkt'],
    [c.run, 'NOT-A-NAME', c.prompt, '--plugin-dir', c.base],
    [c.run, 'ARCHMAP_EVAL_REPO_A', join(c.base, 'missing.md'), '--plugin-dir', c.base],
    [join(c.base, 'nowhere'), 'ARCHMAP_EVAL_REPO_A', c.prompt, '--plugin-dir', c.base],
    [c.run, 'ARCHMAP_EVAL_REPO_A', c.prompt, '--plugin-dir', c.base, '--wat'],
  ]) {
    const e = runScript(args, { PATH: `${c.bin}:${process.env.PATH}` });
    assert.equal(e.status, 2, args.join(' '));
    assert.match(e.stderr, /usage: run-candidate\.sh/, args.join(' '));
  }
  assert.ok(!existsSync(join(c.run, 'argv.bin')), 'no session ran on a usage error');
});

test('b12 run-candidate.sh carries no absolute home path, no denylist term and no CLAUDECODE outside env -u (denylist skipped when absent)', (t) => {
  const text = readFileSync(SCRIPT, 'utf8');
  for (const re of [/\/Users\/\S/, /\/home\/\S/, /\/private\/\S/, /~\//, /[A-Za-z]:\\\\?\S/, /\.private\b/]) {
    assert.doesNotMatch(text, re, `matches ${re}`);
  }
  assert.match(text, /env -u CLAUDECODE/);
  assert.doesNotMatch(text.replaceAll('env -u CLAUDECODE', ''), /CLAUDECODE/, 'CLAUDECODE appears outside env -u');
  if (!existsSync(DENYLIST)) {
    t.skip('denylist not checked: .private/anonymise-denylist.txt is absent');
    return;
  }
  assert.deepEqual(denylistHits(text), [], 'run-candidate.sh carries a denylist term');
});

test('b13 --plugin-dir: the session runs from <run-dir>/repo with the variable set, CLAUDECODE unset, the prompt substituted, the flags in order, and every file lands in <run-dir>', () => {
  const c = cell();
  const plugin = join(c.base, 'clone');
  mkdirSync(plugin);
  const r = runScript(
    [c.run, 'ARCHMAP_EVAL_REPO_A', c.prompt, '--plugin-dir', plugin, '--model', 'opus', '--path-prepend', c.bin, '--', '--max-turns', '5'],
    { CLAUDECODE: '1', ARCHMAP_EVAL_REPO_A: '' },
  );
  assert.equal(r.status, 3, `the session's exit status is the script's: ${r.stderr}`);
  assert.equal(readFileSync(join(c.run, 'exit-code'), 'utf8').trim(), '3');
  assert.equal(readFileSync(join(c.run, 'stderr.log'), 'utf8').trim(), 'stub stderr');
  const lines = readFileSync(join(c.run, 'stream.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  const repo = join(c.run, 'repo');
  assert.deepEqual([realpathSync(lines[0].cwd), lines[0].repo, lines[0].claudecode, lines[0].config], [repo, repo, 'unset', 'unset']);
  const expectedPrompt = c.text.replaceAll('<ENV_NAME>', 'ARCHMAP_EVAL_REPO_A').replace(/\n+$/, '');
  assert.deepEqual(readArgv(c.run), ['-p', expectedPrompt, '--plugin-dir', plugin, '--model', 'opus', ...HEADLESS, '--max-turns', '5']);
  const timing = JSON.parse(readFileSync(join(c.run, 'timing.json'), 'utf8'));
  assert.deepEqual(Object.keys(timing).sort(), ['finished', 'started', 'total_duration_seconds']);
  for (const v of Object.values(timing)) assert.equal(typeof v, 'number');
  assert.equal(timing.total_duration_seconds, timing.finished - timing.started);
  assert.ok(timing.total_duration_seconds >= 0 && timing.started > 1.7e9);
  const command = readFileSync(join(c.run, 'command.txt'), 'utf8');
  assert.ok(command.includes('env -u CLAUDECODE claude -p'), command);
  assert.ok(command.includes(c.prompt), 'the prompt is recorded by its file path');
  assert.ok(!command.includes('Map the repository'), 'the prompt text is redacted');
  for (const a of ['--plugin-dir', plugin, '--model', 'opus', '--setting-sources', '--max-turns', 'ARCHMAP_EVAL_REPO_A=', c.bin]) assert.ok(command.includes(a), `command.txt records ${a}`);
  assert.deepEqual(readdirSync(join(c.base, 'cell')), ['run'], 'nothing is written beside <run-dir>');
  assert.deepEqual(readdirSync(c.run).sort(), ['argv.bin', 'command.txt', 'exit-code', 'repo', 'stderr.log', 'stream.jsonl', 'timing.json']);
  assert.deepEqual(readdirSync(repo), [], 'nothing is written into the repository copy in --plugin-dir mode');
});

test('b14 --plugin: installs into an isolated CLAUDE_CONFIG_DIR under <run-dir>/config, records the installed version, warns about the login, and runs the session there without --plugin-dir', () => {
  const c = cell();
  // --path-prepend reaches the session only, so the install commands find the stub through the caller's PATH here.
  const r = runScript([c.run, 'ARCHMAP_EVAL_REPO_A', c.prompt, '--plugin', 'mapper@mkt', '--marketplace', 'owner/repo'], { CLAUDECODE: '1', PATH: `${c.bin}:${process.env.PATH}` });
  assert.equal(r.status, 3, r.stderr);
  const config = join(c.run, 'config');
  const calls = readFileSync(join(c.run, 'plugin-calls.txt'), 'utf8').trim().split('\n');
  assert.equal(calls[0], 'plugin marketplace add owner/repo --scope project');
  assert.equal(calls[1], 'plugin install mapper@mkt --scope project');
  assert.match(calls[2], /^plugin list --json/);
  assert.equal(readFileSync(join(c.run, 'plugin-version.txt'), 'utf8').trim(), '1.2.3');
  assert.match(r.stderr, /log(ged)? in once/i);
  assert.ok(r.stderr.includes(`CLAUDE_CONFIG_DIR=${config}`) && r.stderr.includes('/login'), r.stderr);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'the warning is one line');
  const [line] = readFileSync(join(c.run, 'stream.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([line.config, line.claudecode], [config, 'unset']);
  const argv = readArgv(c.run);
  assert.ok(!argv.includes('--plugin-dir'));
  assert.deepEqual(argv.slice(2), HEADLESS);
  assert.ok(readFileSync(join(c.run, 'command.txt'), 'utf8').includes(`CLAUDE_CONFIG_DIR=`));
  assert.deepEqual(readdirSync(join(c.base, 'cell')), ['run'], 'nothing is written beside <run-dir>');
});
