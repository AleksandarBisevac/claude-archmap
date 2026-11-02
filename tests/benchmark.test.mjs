import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
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

// ---- P12.4: the tracked evidence of the benchmark runs (evidence/benchmark/) ----
// Each run file is `cost-profile.mjs --json --basename` exactly as printed; summary.json beside them names one per cell.
const EVALS = join(ROOT, 'skills', 'architecture-map', 'evals');
const BENCH = join(EVALS, 'evidence', 'benchmark');
const SUMMARY = join(BENCH, 'summary.json');
const EVIDENCE_NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([ABC])-([1-9]\d*)\.json$/;
const benchFiles = () => {
  assert.ok(existsSync(BENCH), 'evidence/benchmark/ is missing');
  return readdirSync(BENCH).sort();
};
const runFiles = () => benchFiles().filter((f) => f !== 'summary.json');
const loadJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const cells = () => {
  assert.ok(existsSync(SUMMARY), 'evidence/benchmark/summary.json is missing');
  const s = loadJson(SUMMARY);
  assert.ok(Array.isArray(s.cells), 'summary.json has no cells array');
  return s.cells;
};
const orchestratorRow = (profile) => (profile.byAgent ?? []).find((r) => r.agent === 'orchestrator');
const TOOLS = () => ['archmap', ...candidateNames()];

test('b15 every file under evidence/benchmark/ is summary.json or <tool>-<repo-letter>-<run>.json for a known tool, and each one is a summary cell', () => {
  const files = runFiles();
  assert.ok(files.length >= 1, 'no evidence file');
  const known = [...TOOLS(), 'archmap-issues'];
  for (const f of files) {
    const m = f.match(EVIDENCE_NAME);
    assert.ok(m, `${f} does not match <tool>-<repo-letter>-<run>.json`);
    assert.ok(known.includes(m[1]), `${f}: tool ${m[1]} is none of ${known.join(', ')}`);
  }
  const named = cells().map((c) => c.evidence);
  for (const f of files) assert.ok(named.includes(`evidence/benchmark/${f}`), `${f} is not named by any summary.json cell`);
});

test('b16 every summary.json cell names an existing evidence file for its own tool, repository and run, with an orchestrator row', () => {
  for (const c of cells()) {
    const label = `${c.tool} ${c.repo} ${c.run}`;
    assert.equal(c.evidence, `evidence/benchmark/${c.tool}-${c.repo}-${c.run}.json`, `${label}: evidence ${c.evidence}`);
    const file = join(EVALS, c.evidence);
    assert.ok(existsSync(file), `${label}: ${c.evidence} does not exist`);
    const row = orchestratorRow(loadJson(file));
    assert.ok(row, `${label}: ${c.evidence} has no orchestrator row`);
    assert.ok(row.turns >= 1, `${label}: the orchestrator row has no turn`);
  }
});

test('b17 no evidence file carries a home-directory path component or a denylist term (denylist skipped when absent)', (t) => {
  const home = homedir();
  for (const f of benchFiles()) {
    const text = readFileSync(join(BENCH, f), 'utf8');
    for (const re of [/\/Users\/\S/, /\/home\/\S/, /\/private\/\S/, /\/tmp\/\S/, /\/root\//, /[A-Za-z]:\\\\?\S/, /~\//, /\.private\b/]) {
      assert.doesNotMatch(text, re, `${f} matches ${re}`);
    }
    if (home && home !== '/') assert.ok(!text.includes(home), `${f} carries the home directory`);
  }
  if (!existsSync(DENYLIST)) {
    t.skip('denylist not checked: .private/anonymise-denylist.txt is absent');
    return;
  }
  for (const f of benchFiles()) assert.deepEqual(denylistHits(readFileSync(join(BENCH, f), 'utf8')), [], `${f} carries a denylist term`);
});

test('b18 summary.json has 13 cells: each of the four tools once on A, B and C, and one archmap-issues cell on A with a recall', () => {
  const all = cells();
  assert.equal(all.length, 13, `expected 13 cells, saw ${all.length}`);
  const compared = all.filter((c) => c.tool !== 'archmap-issues');
  const tools = TOOLS();
  assert.equal(tools.length, 4, `expected this plugin and three candidates, saw ${tools.join(', ')}`);
  assert.deepEqual(
    compared.map((c) => `${c.tool}/${c.repo}`).sort(),
    tools.flatMap((t) => ['A', 'B', 'C'].map((r) => `${t}/${r}`)).sort(),
  );
  for (const c of compared) assert.equal(c.recall, undefined, `${c.tool} ${c.repo}: recall belongs to the issues cell only`);
  const issues = all.filter((c) => c.tool === 'archmap-issues');
  assert.equal(issues.length, 1, 'one archmap-issues cell');
  assert.equal(issues[0].repo, 'A');
  assert.equal(typeof issues[0].recall, 'number');
  assert.ok(issues[0].recall >= 0 && issues[0].recall <= 1, `recall ${issues[0].recall}`);
});

test('b19 each cell\'s costUsd is its evidence file\'s total.costUsd to the cent, and its orchestratorTurns and maxContext are the orchestrator row\'s', () => {
  for (const c of cells()) {
    const label = `${c.tool} ${c.repo} ${c.run}`;
    const profile = loadJson(join(EVALS, c.evidence));
    assert.equal(c.costUsd, Math.round(profile.total.costUsd * 100) / 100, `${label}: costUsd`);
    const row = orchestratorRow(profile);
    assert.equal(c.orchestratorTurns, row.turns, `${label}: orchestratorTurns`);
    assert.equal(c.maxContext, row.maxContext, `${label}: maxContext`);
  }
});

test('b20 PROTOCOL.md has a Runs section naming the Claude Code version, the model, v1.0.0 and each candidate\'s version and commit, and every profile\'s rates.date is the rate table date it states', () => {
  const body = section(loadDoc('PROTOCOL.md'), 'Runs');
  assert.notEqual(body, null, 'no "## Runs" section');
  assert.match(body, /Claude Code \d+\.\d+\.\d+/, 'no Claude Code version');
  assert.match(body, /`opus`/, 'no orchestrator model');
  assert.match(body, /\bv1\.0\.0\b/, 'no plugin version');
  const t = table(section(load(), 'Candidates'));
  column(t, 'Name').forEach((raw, i) => {
    const name = raw.replace(/`/g, '').trim();
    const version = column(t, 'Version')[i];
    const semver = version.match(/\b\d+\.\d+\.\d+\b/)[0];
    const commit = version.match(/commit ([0-9a-f]{7})/)[1];
    assert.ok(body.includes(name), `Runs does not name ${name}`);
    assert.match(body, new RegExp(`${name.replace(/-/g, '\\-')}\\W[^\\n]*?${semver.replace(/\./g, '\\.')}`), `Runs does not give ${name} ${semver}`);
    assert.ok(body.includes(commit), `Runs does not give ${name}'s commit ${commit}`);
  });
  const m = body.match(/rate table[^\n]*?(\d{4}-\d{2}-\d{2})/i);
  assert.ok(m, 'Runs states no rate table date');
  for (const f of runFiles()) assert.equal(loadJson(join(BENCH, f)).rates?.date, m[1], `${f}: rates.date`);
});

// ---- P12.5: the benchmark report (BENCHMARK.md) ----
// Every figure of its tables is derived from evidence/benchmark/: the cost from the named profile's total.costUsd, the
// turns and the context from its orchestrator row, the seconds, expectations, rubric and recall from summary.json. The
// check reads a report text, a profile reader and the summary cells, so b23 can feed it a tampered copy of any of them.
const REPORT = join(EVALS, 'BENCHMARK.md');
const loadReport = () => {
  assert.ok(existsSync(REPORT), 'BENCHMARK.md is missing');
  return readFileSync(REPORT, 'utf8');
};
const readBench = (rel) => loadJson(join(EVALS, rel));
// The table of the body whose header row starts with `| <head>`, as { header, rows } (null when there is none).
function tableAt(body, head) {
  const lines = body.split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => l.startsWith(`| ${head}`));
  return at === -1 ? null : table(lines.slice(at).join('\n'));
}
const colOf = (t, name) => {
  const i = t.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  assert.ok(i !== -1, `column ${name} is missing from [${t.header.join(', ')}]`);
  return i;
};
const unquote = (s) => s.replace(/`/g, '').trim();
// Prose is wrapped, so a phrase is matched on the text with every run of whitespace made one space.
const flat = (s) => s.replace(/\s+/g, ' ');
const usdOf = (n) => `${(Math.round(n * 100) / 100).toFixed(2)} USD`;
const kOf = (n) => `${(n / 1000).toFixed(1)} K`;
const cellKey = (tool, repo, run) => `${tool}/${repo}/${run}`;
const rubricOf = (r) => `${r.total} (${r.coverage}, ${r.relations}, ${r.flows}, ${r.readability})`;

const checkReport = (text, read = readBench, all = cells()) => {
  const byKey = new Map(all.map((c) => [cellKey(c.tool, c.repo, String(c.run)), c]));
  const compared = all.filter((c) => c.tool !== 'archmap-issues');

  // the evidence table: one row per summary.json cell, naming the file that cell names
  const how = section(text, 'How each number was produced');
  assert.notEqual(how, null, 'no "## How each number was produced" section');
  const ev = tableAt(how, 'Tool | Repository | Run | Evidence');
  assert.ok(ev, 'no evidence table (Tool | Repository | Run | Evidence) in How each number was produced');
  const evidenceOf = new Map();
  for (const r of ev.rows) {
    const id = cellKey(unquote(r[colOf(ev, 'Tool')]), r[colOf(ev, 'Repository')], r[colOf(ev, 'Run')]);
    const c = byKey.get(id);
    assert.ok(c, `evidence row ${id} is no summary.json cell`);
    assert.ok(!evidenceOf.has(id), `evidence row ${id} appears twice`);
    const f = unquote(r[colOf(ev, 'Evidence')]);
    assert.equal(f, c.evidence, `${id}: the evidence file is the one summary.json names`);
    assert.ok(existsSync(join(EVALS, f)), `${id}: ${f} exists`);
    evidenceOf.set(id, f);
  }
  assert.deepEqual([...evidenceOf.keys()].sort(), [...byKey.keys()].sort(), 'the evidence table names every summary.json cell once');
  assert.ok(how.includes('node scripts/cost-profile.mjs <stream.jsonl> --json --basename'), 'the cost-profile command is named');
  assert.ok(how.includes('run-candidate.sh'), 'the run script is named');
  for (const e of ['key components', 'flows', 'file references', 'artifact on disk', 'exit status']) {
    assert.ok(flat(how).toLowerCase().includes(e), `the expectation "${e}" is named`);
  }
  const date = flat(how).match(/rate table dated (\d{4}-\d{2}-\d{2})/)?.[1];
  assert.ok(date, 'How each number was produced states the rate table date');
  for (const f of evidenceOf.values()) assert.equal(read(f).rates?.date, date, `${f}: priced at the rate table dated ${date}`);

  // the result table: one row per compared cell
  const res = section(text, 'Results');
  assert.notEqual(res, null, 'no "## Results" section');
  assert.match(flat(res), /provisional/i, 'the Results caption says the rubric scores are provisional');
  assert.match(flat(res), /owner confirms or replaces/i, 'the Results caption says the owner confirms or replaces them');
  const rt = tableAt(res, 'Tool | Repository | Run | Cost');
  assert.ok(rt, 'no result table (Tool | Repository | Run | Cost ...)');
  const at = (n) => colOf(rt, n);
  const seen = [];
  for (const r of rt.rows) {
    const id = cellKey(unquote(r[at('Tool')]), r[at('Repository')], r[at('Run')]);
    const c = byKey.get(id);
    assert.ok(c && c.tool !== 'archmap-issues', `result row ${id} is a compared summary.json cell`);
    seen.push(id);
    const f = evidenceOf.get(id);
    const p = read(f);
    const o = orchestratorRow(p);
    assert.equal(r[at('Cost')], usdOf(p.total.costUsd), `${id}: the cost is total.costUsd of ${f} rounded to two decimals (${p.total.costUsd})`);
    assert.equal(r[at('Orchestrator turns')], String(o.turns), `${id}: the turns are the orchestrator row of ${f}`);
    assert.equal(r[at('Max context')], kOf(o.maxContext), `${id}: the max context is the orchestrator maxContext of ${f}`);
    assert.equal(r[at('Seconds')], String(c.seconds), `${id}: the seconds are summary.json's`);
    assert.match(r[at('Expectations')], new RegExp(`^${c.passed}/${c.graded}(\\s|$)`), `${id}: the expectations are summary.json's ${c.passed}/${c.graded}`);
    assert.equal(r[at('Rubric')], rubricOf(c.rubric), `${id}: the rubric is summary.json's`);
  }
  assert.deepEqual([...seen].sort(), compared.map((c) => cellKey(c.tool, c.repo, String(c.run))).sort(), 'one result row per compared cell');

  // the per-tool totals: the sum of the three profiles' total.costUsd, rounded once
  const tt = tableAt(res, 'Tool | Cost over A, B and C');
  assert.ok(tt, 'no totals table (Tool | Cost over A, B and C)');
  assert.deepEqual(tt.rows.map((r) => unquote(r[0])), [...new Set(compared.map((c) => c.tool))], 'one totals row per tool, in summary.json order');
  for (const r of tt.rows) {
    const tool = unquote(r[0]);
    const sum = compared.filter((c) => c.tool === tool).reduce((s, c) => s + read(c.evidence).total.costUsd, 0);
    assert.equal(r[1], usdOf(sum), `${tool}: the total over A, B and C is the sum of its profiles' total.costUsd (${sum})`);
  }

  // the issues-overlay row, outside the comparison
  const it = tableAt(res, 'Tool | Repository | Run | Recall');
  assert.ok(it, 'no issue-recall table (Tool | Repository | Run | Recall ...)');
  assert.equal(it.rows.length, 1, 'one issue-recall row');
  const [ir] = it.rows;
  const iid = cellKey(unquote(ir[colOf(it, 'Tool')]), ir[colOf(it, 'Repository')], ir[colOf(it, 'Run')]);
  const ic = byKey.get(iid);
  assert.ok(ic && ic.tool === 'archmap-issues', `the issue-recall row ${iid} is the archmap-issues cell`);
  const ip = read(evidenceOf.get(iid));
  assert.equal(ir[colOf(it, 'Recall')], String(ic.recall), `${iid}: the recall is summary.json's`);
  assert.equal(ir[colOf(it, 'Issues reported')], String(ic.issuesReported), `${iid}: the issues reported are summary.json's`);
  assert.equal(ir[colOf(it, 'Cost')], usdOf(ip.total.costUsd), `${iid}: the cost is total.costUsd of ${evidenceOf.get(iid)}`);
  assert.equal(ir[colOf(it, 'Orchestrator turns')], String(orchestratorRow(ip).turns), `${iid}: the turns are the orchestrator row of ${evidenceOf.get(iid)}`);
  assert.match(flat(res), /outside the comparison/i, 'the issue-recall row is marked outside the comparison');

  // the configuration table: each tool once, with its pinned version and the orchestrator model
  const conf = section(text, 'Configurations');
  assert.notEqual(conf, null, 'no "## Configurations" section');
  const ct = tableAt(conf, 'Tool | Version | Install | Orchestrator model');
  assert.ok(ct, 'no configuration table (Tool | Version | Install | Orchestrator model)');
  assert.deepEqual(ct.rows.map((r) => unquote(r[0])), TOOLS(), 'one configuration row per tool');
  const cand = table(section(load(), 'Candidates'));
  for (const r of ct.rows) {
    const name = unquote(r[0]);
    assert.equal(unquote(r[colOf(ct, 'Orchestrator model')]), 'opus', `${name}: the orchestrator model is opus`);
    const version = r[colOf(ct, 'Version')];
    if (name === 'archmap') {
      assert.match(version, /\b1\.0\.0\b/, 'archmap: version 1.0.0');
      continue;
    }
    const pinned = column(cand, 'Version')[column(cand, 'Name').map(unquote).indexOf(name)];
    assert.ok(version.includes(pinned.match(/\b\d+\.\d+\.\d+\b/)[0]), `${name}: the version CANDIDATES.md pins`);
    assert.ok(version.includes(pinned.match(/commit ([0-9a-f]{7})/)[1]), `${name}: the commit CANDIDATES.md pins`);
  }

  // the limits
  const limits = section(text, 'Limits');
  assert.notEqual(limits, null, 'no "## Limits" section');
  for (const re of [/one run per cell/i, /list price/i, /private/i, /provisional/i, /owner confirms or replaces/i, /run 2/i, /owner/i]) {
    assert.match(flat(limits), re, `the limits say ${re}`);
  }
};

test('b21 every cost, seconds, turn, context, expectations, rubric, total and recall cell of BENCHMARK.md equals the evidence file it names or summary.json', () => {
  checkReport(loadReport());
});

test('b22 BENCHMARK.md is public: no machine path, home directory or denylist term (denylist skipped when absent)', (t) => {
  const text = loadReport();
  for (const re of [/\/Users\/\S/, /\/home\/\S/, /\/private\/\S/, /\/tmp\/\S/, /[A-Za-z]:\\\\?\S/, /~\//, /\.private\b/]) {
    assert.doesNotMatch(text, re, `matches ${re}`);
  }
  if (!existsSync(DENYLIST)) {
    t.skip('denylist not checked: .private/anonymise-denylist.txt is absent');
    return;
  }
  assert.deepEqual(denylistHits(text), [], 'BENCHMARK.md carries a denylist term');
});

test('b23 the report check fails on a tampered cost, seconds, turn, context, expectations, rubric, total, recall, evidence or date cell, a dropped row or caveat, and a tampered profile or summary', () => {
  const text = loadReport();
  checkReport(text); // the unbroken text passes, so each failure below is the edit's
  const lines = text.split('\n');
  const row = (re) => {
    const l = lines.find((x) => re.test(x));
    assert.ok(l, `a row matching ${re}`);
    return l;
  };
  const swap = (from, to) => {
    assert.ok(text.includes(from), `the report carries ${from}`);
    return text.replace(from, to);
  };
  const split = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const tamper = (line, head, name, to) => {
    const t = tableAt(text, head);
    const c = split(line);
    c[colOf(t, name)] = to;
    return swap(line, `| ${c.join(' | ')} |`);
  };
  const RES = 'Tool | Repository | Run | Cost';
  const a = row(/^\| `archmap` \| A \| 1 \| \d/);
  assert.throws(() => checkReport(tamper(a, RES, 'Cost', '9.99 USD')), /total\.costUsd/, 'cost');
  assert.throws(() => checkReport(tamper(a, RES, 'Seconds', '239')), /seconds are summary/, 'seconds');
  assert.throws(() => checkReport(tamper(a, RES, 'Orchestrator turns', '24')), /orchestrator row/, 'turns');
  assert.throws(() => checkReport(tamper(a, RES, 'Max context', '85.2 K')), /maxContext/, 'context');
  assert.throws(() => checkReport(tamper(a, RES, 'Expectations', '4/5')), /expectations are summary/, 'expectations');
  assert.throws(() => checkReport(tamper(a, RES, 'Rubric', '19 (5, 4, 4, 5)')), /rubric is summary/, 'rubric');
  assert.throws(() => checkReport(swap(`${a}\n`, '')), /one result row per compared cell/, 'a dropped row');
  const total = row(/^\| `archmap` \| \d+\.\d\d USD \|$/);
  assert.throws(() => checkReport(tamper(total, 'Tool | Cost over A, B and C', 'Cost over A, B and C', '4.42 USD')), /sum of its profiles/, 'total');
  const issues = row(/^\| `archmap-issues` \| A \| 1 \|/);
  const ISS = 'Tool | Repository | Run | Recall';
  assert.throws(() => checkReport(tamper(issues, ISS, 'Recall', '0.9')), /recall is summary/, 'recall');
  assert.throws(() => checkReport(tamper(issues, ISS, 'Issues reported', '22')), /issues reported/, 'issues reported');
  assert.throws(() => checkReport(tamper(issues, ISS, 'Cost', '2.39 USD')), /total\.costUsd/, 'issues cost');
  const evRow = row(/^\| `draw-c4` \| B \| 1 \| `evidence\//);
  assert.throws(() => checkReport(swap(evRow, evRow.replace('draw-c4-B-1.json', 'draw-c4-A-1.json'))), /the one summary\.json names/, 'evidence file');
  assert.throws(() => checkReport(swap(`${evRow}\n`, '')), /names every summary\.json cell once/, 'a dropped evidence row');
  assert.throws(() => checkReport(text.replace(/rate\s+table\s+dated\s+\d{4}-\d{2}-\d{2}/, 'rate table dated 2026-01-01')), /rate table dated 2026-01-01/, 'date');
  assert.throws(() => checkReport(text.replace(/owner\s+confirms\s+or\s+replaces/gi, 'owner reads')), /owner confirms or replaces/, 'the provisional caveat');
  assert.throws(() => checkReport(text.replace(/outside\s+the\s+comparison/gi, 'below')), /outside the comparison/, 'the outside-the-comparison mark');
  // the same report against a profile that drifted from its transcript, or a summary with another figure
  const bump = (mutate) => (rel) => {
    const j = readBench(rel);
    if (rel === 'evidence/benchmark/oh-my-mermaid-B-1.json') mutate(j);
    return j;
  };
  assert.throws(() => checkReport(text, bump((j) => { j.total.costUsd += 0.01; })), /total\.costUsd/, 'a tampered profile cost');
  assert.throws(() => checkReport(text, bump((j) => { orchestratorRow(j).turns += 1; })), /orchestrator row/, 'a tampered profile turn count');
  assert.throws(() => checkReport(text, bump((j) => { orchestratorRow(j).maxContext += 100; })), /maxContext/, 'a tampered profile context');
  const summary = (mutate) => {
    const all = JSON.parse(JSON.stringify(cells()));
    mutate(all.find((c) => c.tool === 'cc-codemaps' && c.repo === 'B'));
    return all;
  };
  assert.throws(() => checkReport(text, readBench, summary((c) => { c.seconds += 1; })), /seconds are summary/, 'a tampered summary duration');
  assert.throws(() => checkReport(text, readBench, summary((c) => { c.passed -= 1; })), /expectations are summary/, 'a tampered summary grade');
  assert.throws(() => checkReport(text, readBench, summary((c) => { c.rubric.flows -= 1; })), /rubric is summary/, 'a tampered summary rubric');
});
