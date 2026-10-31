import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (r1, r2, ...) lead every title so the suite prints them first.
// The top-level README is what a prospective user reads: the command table must be the frontmatter of
// commands/*.md, every cost, turn and context figure must be the tracked evidence profile the row cites, and the
// text must carry no machine path and no "planned" or "pre-release" wording left over from before the build worked.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const README = join(ROOT, 'README.md');
const EVALS_DIR = join(ROOT, 'skills', 'architecture-map', 'evals');
const EVIDENCE_PREFIX = 'skills/architecture-map/evals/evidence/';
const readReadme = () => readFileSync(README, 'utf8');
const readEvidence = (rel) => JSON.parse(readFileSync(join(ROOT, EVIDENCE_PREFIX, rel), 'utf8'));

// A Markdown section by its `## ` heading, up to the next `## ` heading.
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `the README has a "## ${heading}" section`);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 3);
  return end < 0 ? rest : rest.slice(0, end);
};
// Table cells, split on unescaped pipes; an escaped pipe (\|) inside a cell is a literal pipe.
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
// The rows of the first table whose header row starts with `head`, as { header, rows }.
const table = (text, head) => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`| ${head}`));
  assert.ok(at >= 0, `a table whose header starts with "${head}"`);
  const rows = [];
  for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
  return { header: cells(lines[at]), rows };
};
const column = (header, name) => {
  const i = header.findIndex((c) => c.startsWith(name));
  assert.ok(i >= 0, `a column "${name}"`);
  return i;
};

// --- r1: the command table is the frontmatter of commands/*.md ---------------------------------------------------
const frontmatter = (file) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'));
  assert.ok(m, `${file} starts with a frontmatter block`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return fm;
};
const commandsOnDisk = () => {
  const dir = join(ROOT, 'commands');
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: `/${plugin}:${f.slice(0, -3)}`, fm: frontmatter(join(dir, f)) }));
};

const checkCommandTable = (text, onDisk = commandsOnDisk()) => {
  const { header, rows } = table(section(text, 'Commands'), 'Command');
  const [cmd, args, what] = ['Command', 'Arguments', 'What it does'].map((n) => column(header, n));
  const unquote = (c) => c.replace(/^`(.*)`$/, '$1');
  assert.deepEqual(rows.map((r) => unquote(r[cmd])).sort(), onDisk.map((c) => c.name), 'one row per file of commands/, and no other');
  for (const c of onDisk) {
    const row = rows.find((r) => unquote(r[cmd]) === c.name);
    const hint = c.fm['argument-hint'] ?? '';
    assert.equal(row[args], hint === '' ? 'none' : `\`${hint}\``, `${c.name}: the arguments cell is the argument-hint of its file`);
    assert.equal(row[what], c.fm.description, `${c.name}: the description cell is the description of its file`);
  }
};

// --- r2: every cost figure is the evidence profile its row cites ------------------------------------------------
const orchestratorOf = (j) => j.byAgent.find((a) => a.agent === 'orchestrator');
const usd = (j) => (Math.round(j.total.costUsd * 100) / 100).toFixed(2);
const kTokens = (j) => (orchestratorOf(j).maxContext / 1000).toFixed(1);
// One file gives one figure; several give "low to high" (or the one figure when they agree).
const span = (values, unit) => {
  const sorted = [...values].sort((a, b) => Number(a) - Number(b));
  const [lo, hi] = [sorted[0], sorted[sorted.length - 1]];
  return `${lo === hi ? lo : `${lo} to ${hi}`}${unit}`;
};
// "with skill `a.json`, `b.json`; baseline `c.json`; before `d.json`" -> { 'with skill': [...], baseline: [...], before: [...] }
const citations = (cell) => {
  const out = {};
  for (const part of cell.split(';')) {
    const m = /^\s*(with skill|baseline|before)\s+(.*)$/.exec(part);
    assert.ok(m, `the evidence cell part "${part.trim()}" starts with "with skill", "baseline" or "before"`);
    out[m[1]] = [...m[2].matchAll(/`([^`]+\.json)`/g)].map((x) => x[1]);
    assert.ok(out[m[1]].length >= 1, `"${m[1]}" cites at least one file`);
  }
  return out;
};
const expectationCounts = () =>
  Object.fromEntries(
    JSON.parse(readFileSync(join(EVALS_DIR, 'evals.json'), 'utf8')).evals.map((e) => [String(e.id), (e.expectations ?? e.assertions).length]),
  );

const checkCostTable = (text, read = readEvidence, expectations = expectationCounts()) => {
  const costs = section(text, 'What a build costs');
  assert.ok(costs.includes(EVIDENCE_PREFIX), `the section says the cited files are under ${EVIDENCE_PREFIX}`);
  const { header, rows } = table(costs, 'Eval');
  const at = Object.fromEntries(
    ['Eval', 'With skill', 'Baseline, no skill', 'Orchestrator turns', 'Orchestrator max context', 'Before', 'Result', 'Evidence'].map((n) => [n, column(header, n)]),
  );
  const evalRows = rows.filter((r) => /^\d\b/.test(r[at.Eval]));
  assert.deepEqual(evalRows.map((r) => r[at.Eval].match(/^\d/)[0]), ['1', '2', '3', '4', '5'], 'one row per eval, 1 to 5, in order');
  const selfRows = rows.filter((r) => /^self-build\b/.test(r[at.Eval]));
  assert.equal(selfRows.length, 1, 'the self-build row');
  const cited = new Set();
  for (const r of [...evalRows, ...selfRows]) {
    const id = r[at.Eval];
    const self = selfRows.includes(r);
    const ev = citations(r[at.Evidence]);
    for (const f of Object.values(ev).flat()) {
      assert.ok(existsSync(join(ROOT, EVIDENCE_PREFIX, f)), `${id}: the cited ${f} exists`);
      cited.add(f);
    }
    const e = self ? 'self' : id.match(/^\d/)[0];
    const name = (f, iteration, config) => new RegExp(`^iteration-${iteration}/${e}-${config}-skill-\\d+\\.json$`).test(f);
    const withSkill = ev['with skill'] ?? [];
    assert.ok(withSkill.length >= 1 && withSkill.every((f) => name(f, 2, 'with')), `${id}: "with skill" cites iteration-2 with-skill runs of this eval`);
    const js = withSkill.map(read);
    assert.equal(r[at['With skill']], span(js.map(usd), ' USD'), `${id}: the with-skill cost is total.costUsd of ${withSkill.join(', ')}`);
    assert.equal(r[at['Orchestrator turns']], span(js.map((j) => String(orchestratorOf(j).turns)), ''), `${id}: the turns are the orchestrator row of ${withSkill.join(', ')}`);
    assert.equal(r[at['Orchestrator max context']], span(js.map(kTokens), ' K'), `${id}: the max context is the orchestrator maxContext of ${withSkill.join(', ')}`);
    if (self) {
      assert.equal(ev.baseline, undefined, 'the self-build has no baseline run');
      assert.equal(r[at['Baseline, no skill']], '-');
      assert.equal(r[at.Before], '-');
    } else {
      assert.ok(ev.baseline?.length === 1 && name(ev.baseline[0], '[12]', 'without'), `${id}: "baseline" cites one without-skill run of this eval`);
      assert.equal(r[at['Baseline, no skill']], `${usd(read(ev.baseline[0]))} USD`, `${id}: the baseline is total.costUsd of ${ev.baseline[0]}`);
      assert.ok(ev.before?.length === 1 && name(ev.before[0], 1, 'with'), `${id}: "before" cites the iteration-1 with-skill run of this eval`);
      const b = read(ev.before[0]);
      assert.equal(r[at.Before], `${usd(b)} USD, ${orchestratorOf(b).turns} turns, ${kTokens(b)} K`, `${id}: the before cell is cost, turns and max context of ${ev.before[0]}`);
      const grades = [...r[at.Result].matchAll(/(\d+)\/(\d+)/g)];
      assert.ok(grades.length >= 1, `${id}: the result cell carries a grade`);
      for (const g of grades) assert.equal(Number(g[2]), expectations[e], `${id}: a grade is out of the ${expectations[e]} expectations of eval ${e} in evals.json`);
    }
  }
  // the rate table every cited profile was priced at is the date the README states
  const date = text.match(/rate table dated (\d{4}-\d{2}-\d{2})/)?.[1];
  assert.ok(date, 'the README states the date of the rate table');
  for (const f of cited) assert.equal(read(f).rates.date, date, `${f} was priced at the rate table dated ${date}`);
};

// --- r3: no machine path and no planned or pre-release wording -----------------------------------------------------
// An absolute (/x, C:\), home-relative (~/) or parent-relative (../) path, as tests/evals.test.mjs detects it.
const PATH_LIKE = new RegExp(
  [
    '(^|[\\s"\'`(=:])~[\\/\\\\]',
    '[A-Za-z]:[\\\\/]',
    '(^|[\\s"\'`(=:])\\/[A-Za-z.][\\w.-]*\\/',
    '(^|[\\s"\'`(=:])\\/(tmp|etc|var|opt|usr|mnt|private|home|Users)\\b',
    '\\.\\.[\\/\\\\]',
  ].join('|'),
  'm',
);
const STALE_WORDING = /\bplanned\b|\bpre-?release\b|release candidate|not usable yet|coming soon/i;
const pluginVersion = () => JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const checkWording = (text, version = pluginVersion()) => {
  const path = text.match(PATH_LIKE);
  assert.equal(path, null, `no machine path in the README${path ? `: "${text.slice(Math.max(0, path.index - 20), path.index + 30)}"` : ''}`);
  const stale = text.match(STALE_WORDING);
  assert.equal(stale, null, `no planned or pre-release wording in the README${stale ? `: "${stale[0]}"` : ''}`);
  const status = section(text, 'Status');
  assert.match(status, /\breleased\b/i, 'the status says the plugin is released');
  assert.ok(new RegExp(`\\bversion ${version.replace(/\./g, '\\.')}\\b`, 'i').test(status), `the status names version ${version}, the version plugin.json carries`);
  assert.ok(status.includes('](CHANGELOG.md)'), 'the status links CHANGELOG.md');
  assert.match(status, /six commands/i, 'the status keeps the sentence about the six commands');
  assert.match(status, /test suite/i, 'the status keeps the tests');
  assert.match(status, /evals/i, 'the status keeps the evals');
};

// --- r4: what a build delivers carries the self-build counts of the evals README, and the method section ------------
// The committed map is the repository's own docs/architecture/: the README links its viewer, and the counts it states
// are those of the committed model and of the evals README's committed-map row.
const VIEWER = 'docs/architecture/archmap.html';
const readCommittedModel = () => JSON.parse(readFileSync(join(ROOT, 'docs', 'architecture', 'architecture.model.json'), 'utf8'));
const checkDeliversAndMethod = (text, evalsReadme = readFileSync(join(EVALS_DIR, 'README.md'), 'utf8'), model = readCommittedModel()) => {
  const delivers = section(text, 'What a build delivers');
  for (const w of ['file:line', 'confidence', 'provenance', 'CRUD', 'sequence', 'view', 'offline', 'issues overlay', 'staleness']) {
    assert.match(delivers, new RegExp(w, 'i'), `"What a build delivers" names ${w}`);
  }
  assert.ok(delivers.includes(`](${VIEWER})`), `"What a build delivers" links the committed viewer ${VIEWER}`);
  assert.ok(existsSync(join(ROOT, VIEWER)), `the committed viewer ${VIEWER} exists`);
  const theirs = table(evalsReadme, 'Build | Evidence');
  const ours = table(delivers, 'Nodes');
  const committed = theirs.rows.filter((r) => r[0].startsWith('self-build') && /the committed map/.test(r[0]));
  assert.ok(committed.length === 1 && ours.rows.length === 1, 'one self-build count row on each side: the committed map');
  const [self] = committed;
  for (const name of ours.header) {
    assert.equal(ours.rows[0][column(ours.header, name)], self[column(theirs.header, name)], `the self-build ${name} count is the evals README's`);
    assert.equal(ours.rows[0][column(ours.header, name)], String(model[name.toLowerCase()].length), `the self-build ${name} count is the committed model's`);
  }
  // the cost table's self-build row is the committed map's, citing the profile the evals README row names
  const costSelf = table(section(text, 'What a build costs'), 'Eval').rows.find((r) => r[0].startsWith('self-build'));
  assert.match(costSelf?.[0] ?? '', /the committed map/, 'the cost table self-build row is the committed map');
  const profile = self[column(theirs.header, 'Evidence')].match(/`evidence\/([^`]+\.json)`/)?.[1];
  assert.ok(profile && costSelf.at(-1).includes(`\`${profile}\``), `the cost table self-build row cites ${profile}, the committed map's profile`);
  const how = section(text, 'How these numbers were measured');
  for (const s of ['scripts/cost-profile.mjs', '--json --basename', 'stream-json', 'evals.json', 'score-recall.mjs', 'skills/architecture-map/evals/README.md', EVIDENCE_PREFIX, 'node --test']) {
    assert.ok(how.includes(s), `the method section names ${s}`);
  }
  // the stated test count is a lower bound of the top-level test() cases the suite holds
  const stated = how.match(/more than (\d+) test cases/)?.[1];
  assert.ok(stated, 'the method section states the test count as "more than N test cases"');
  const testsDir = join(ROOT, 'tests');
  const count = readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .reduce((n, f) => n + (readFileSync(join(testsDir, f), 'utf8').match(/^\s*test\(/gm) ?? []).length, 0);
  assert.ok(count > Number(stated), `the suite holds ${count} test cases, more than the ${stated} stated`);
};

test('r1 the README command table has one row per commands/*.md, with its argument-hint and description verbatim', () => {
  checkCommandTable(readReadme());
});

test('r2 every cost, baseline, turn, context and before figure of the README cost table equals the evidence profile its row cites', () => {
  checkCostTable(readReadme());
});

test('r3 the README carries no machine path and no planned, pre-release or not-usable-yet wording, and its status is released, with the version plugin.json carries and a CHANGELOG link', () => {
  checkWording(readReadme());
});

test('r4 what a build delivers names the model contents with the self-build counts of the evals README, and the method section names the scripts, the evidence directory and the test count', () => {
  checkDeliversAndMethod(readReadme());
});

test('r5 the README checks fail on a missing or altered command row, a tampered cost, turn, context, baseline or before figure, a wrong grade, a machine path and planned wording', () => {
  const text = readReadme();
  // the unbroken text passes, so each failure below is the edit's
  checkCommandTable(text);
  checkCostTable(text);
  checkWording(text);
  checkDeliversAndMethod(text);
  const swap = (from, to) => {
    assert.ok(text.includes(from), `the README carries ${from}`);
    return text.replace(from, to);
  };
  const lines = text.split('\n');
  const row = (re) => {
    const l = lines.find((x) => re.test(x));
    assert.ok(l, `a row matching ${re}`);
    return l;
  };
  // commands: a dropped row, an altered description, an altered hint
  const build = row(/^\| `\/archmap:build` \|/);
  assert.throws(() => checkCommandTable(swap(`${build}\n`, '')), /one row per file/);
  assert.throws(() => checkCommandTable(swap(build, build.replace('Build the', 'Make the'))), /description cell/);
  assert.throws(() => checkCommandTable(swap(build, build.replace('--publish', '--push'))), /arguments cell/);
  // costs: a with-skill cost, a baseline, a turn count, a context, a before figure, a grade, a cited file
  const one = row(/^\| 1 \(/);
  const c = cells(one);
  const tamper = (i, to) => {
    const next = [...c];
    next[i] = to;
    return swap(one, `| ${next.join(' | ')} |`);
  };
  const { header } = table(section(text, 'What a build costs'), 'Eval');
  assert.throws(() => checkCostTable(tamper(column(header, 'With skill'), '1.17 USD')), /with-skill cost/);
  assert.throws(() => checkCostTable(tamper(column(header, 'Baseline, no skill'), '1.56 USD')), /baseline is/);
  assert.throws(() => checkCostTable(tamper(column(header, 'Orchestrator turns'), '10')), /turns are/);
  assert.throws(() => checkCostTable(tamper(column(header, 'Orchestrator max context'), '61.0 K')), /max context/);
  assert.throws(() => checkCostTable(tamper(column(header, 'Before'), '13.78 USD, 37 turns, 278.9 K')), /before cell/);
  assert.throws(() => checkCostTable(tamper(column(header, 'Result'), '7/8 expectations')), /expectations of eval 1/);
  assert.throws(() => checkCostTable(tamper(column(header, 'Evidence'), c[column(header, 'Evidence')].replace('1-with-skill-1.json`;', '1-with-skill-9.json`;'))), /exists/);
  // a tampered profile behind an unchanged README
  const inflated = (rel) => {
    const j = readEvidence(rel);
    if (rel === 'iteration-2/4-with-skill-1.json') j.total.costUsd += 0.05;
    return j;
  };
  assert.throws(() => checkCostTable(text, inflated), /with-skill cost/);
  // wording: a machine path, planned wording, a dropped status
  assert.throws(() => checkWording(`${text}\nSee /Users/someone/checkout/README.md.\n`), /machine path/);
  assert.throws(() => checkWording(`${text}\nThe export command is planned.\n`), /planned or pre-release/);
  assert.throws(() => checkWording(swap('](CHANGELOG.md)', ']')), /links CHANGELOG/);
  assert.throws(() => checkWording(text, '9.9.9'), /names version 9\.9\.9/);
  assert.throws(() => checkWording(`${text}\nThis is a release candidate.\n`), /planned or pre-release/);
  // delivers: an altered self-build count
  const counts = row(/^\| \d+ \| \d+ \| \d+ \| \d+ \| \d+ \|$/);
  assert.throws(() => checkDeliversAndMethod(swap(counts, counts.replace(/^\| \d+/, '| 99'))), /self-build Nodes count/);
  // delivers: a dropped viewer link, a committed model that moved on from the counts, a cost row citing another run
  assert.throws(() => checkDeliversAndMethod(swap('](docs/architecture/archmap.html)', ']')), /links the committed viewer/);
  const grown = readCommittedModel();
  grown.nodes.push({ id: 'extra' });
  assert.throws(() => checkDeliversAndMethod(text, undefined, grown), /Nodes count is the committed model's/);
  assert.throws(() => checkDeliversAndMethod(swap('`iteration-2/self-with-skill-2.json`', '`iteration-2/self-with-skill-1.json`')), /committed map's profile/);
});
