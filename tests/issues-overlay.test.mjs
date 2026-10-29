import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (o1, o2, ...) lead every title so the suite prints them first.
// o1-o3: `issues.mjs lint` (docs/design.md D4 calibration, wording rules in references/issues-catalog.md).
// o4-o7: the overlay chain end to end with a fictional model and a fictional reviewer return:
//   issues.mjs merge -> validate.mjs --issues -> render.mjs clean / internal / shared.
const SCRIPT = (n) => fileURLToPath(new URL(`../scripts/${n}.mjs`, import.meta.url));
const FIX = (n) => fileURLToPath(new URL(`./fixtures/issues/${n}`, import.meta.url));
const MODEL = FIX('model.json');
const RETURN = FIX('reviewer-return.json');
const model = JSON.parse(readFileSync(MODEL, 'utf8'));
const returned = JSON.parse(readFileSync(RETURN, 'utf8'));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
const root = realpathSync(mkdtempSync(join(tmpdir(), 'archmap-overlay-')));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
let n = 0;
const tmp = () => { const d = join(root, `t${++n}`); mkdirSync(d); return d; };
const cli = (script, args, cwd) => {
  const r = spawnSync(process.execPath, [SCRIPT(script), ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const writeJson = (dir, name, obj) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(obj)); return p; };
const clone = (x) => JSON.parse(JSON.stringify(x));
const base = (id, extra = {}) => ({
  id, sev: 'high', category: 'security', title: id, anchor: { node: 'n-auth' },
  summary: 'The module accepts requests without checking who sends them.',
  impact: 'Anything that can reach it directly is exposed.',
  fix: 'Verify identity in the module itself.',
  evidence: [{ path: 'src/auth/login.js', lines: '30-41' }], source: 'archmap', ...extra,
});
const lintJson = (issues) => {
  const dir = tmp();
  const f = writeJson(dir, 'issues.json', { issues });
  const r = cli('issues', ['lint', f, '--json'], dir);
  return { ...r, json: r.out.trim() ? JSON.parse(r.out) : undefined };
};
const rulesFor = (res, id, field) => res.json.findings.filter((f) => f.issue === id && (!field || f.field === field)).map((f) => f.rule);

test('o1 lint flags a security summary carrying an evidence path, a file name, a line number, a URL and an ENV_NAME', () => {
  const res = lintJson([
    base('bad-path', { summary: 'The check in src/auth/login.js is missing.' }),
    base('bad-name', { impact: 'login.js trusts the caller.' }),
    base('bad-line', { fix: 'See line 31 and fix the check.' }),
    base('bad-range', { summary: 'The check at lines 30-41 is missing.' }),
    base('bad-url', { summary: 'Details at https://wiki.example.test/auth explain it.' }),
    base('bad-env', { impact: 'The fallback of SESSION_SECRET is a constant.' }),
    base('bad-host', { fix: 'Block access from 10.2.3.4 and from db01.corp.example.test.' }),
    base('bad-token', { summary: 'The key sk-abcdef0123456789abcdef0123 is embedded.' }),
  ]);
  assert.equal(res.status, 1, res.err);
  assert.equal(rulesFor(res, 'bad-path', 'summary').includes('path'), true);
  assert.equal(rulesFor(res, 'bad-name', 'impact').includes('path'), true);
  assert.equal(rulesFor(res, 'bad-line', 'fix').includes('line'), true);
  assert.equal(rulesFor(res, 'bad-range', 'summary').includes('line'), true);
  assert.equal(rulesFor(res, 'bad-url', 'summary').includes('url'), true);
  assert.equal(rulesFor(res, 'bad-env', 'impact').includes('env'), true);
  assert.equal(rulesFor(res, 'bad-host', 'fix').includes('host'), true);
  assert.equal(rulesFor(res, 'bad-token', 'summary').includes('token'), true);
});

test('o2 lint passes a calibrated security issue, ignores detail, and holds non-security issues only to non-empty wording', () => {
  const dir = tmp();
  const f = writeJson(dir, 'issues.json', { issues: [
    base('calibrated', { detail: 'src/auth/login.js line 31 reads SESSION_SECRET; https://wiki.example.test/a 10.2.3.4' }),
    base('design-with-path', { category: 'design', summary: 'The state in src/index.js is shared.' }),
  ] });
  const r = cli('issues', ['lint', f], dir);
  assert.equal(r.status, 0, r.out + r.err);
  const j = JSON.parse(cli('issues', ['lint', f, '--json'], dir).out);
  assert.deepEqual(j.findings, []);
  // generic prose with capitals and numbers is not an ENV name or a line number
  const prose = lintJson([base('prose', { summary: 'The HTTP API and the SQL layer handle 3 requests per second.', fix: 'Add an API_KEY-free check in step 2.' })]);
  assert.deepEqual(prose.json.findings.map((x) => x.rule).filter((x) => x !== 'env'), []);
});

test('o3 lint requires non-empty summary, impact and fix on every issue; an unreadable file is a usage error', () => {
  const res = lintJson([
    base('e-sum', { category: 'design', summary: '' }),
    base('e-imp', { category: 'docs', impact: '   ' }),
    base('e-fix', { fix: '' }),
    base('e-none', { category: 'data', summary: 'x', impact: 'y', fix: 'z' }),
  ]);
  assert.equal(res.status, 1, res.err);
  assert.deepEqual(rulesFor(res, 'e-sum', 'summary'), ['empty']);
  assert.deepEqual(rulesFor(res, 'e-imp', 'impact'), ['empty']);
  assert.deepEqual(rulesFor(res, 'e-fix', 'fix'), ['empty']);
  assert.deepEqual(rulesFor(res, 'e-none'), []);
  const dir = tmp();
  assert.equal(cli('issues', ['lint', join(dir, 'nope.json')], dir).status, 2);
  assert.equal(cli('issues', ['lint'], dir).status, 2);
});

// ---- the chain -------------------------------------------------------------------------------------------------
const { layoutModel } = await import('../scripts/layout.mjs');
const proj = join(root, 'chain-repo'); // the analysed repo; nothing issue-related may land in it
mkdirSync(proj);
execFileSync('git', ['init', '-q'], { cwd: proj, env: GIT_ENV });
writeFileSync(join(proj, 'a.txt'), 'x\n');
const out = tmp(); // outside the repo
const EXISTING = writeJson(out, 'existing.json', { schemaVersion: '1.0', issues: [] });
const OVERLAY = join(out, 'issues.json');
const LAYOUT = writeJson(out, 'layout.json', await layoutModel(model));
const merged = cli('issues', ['merge', '--existing', EXISTING, '--incoming', RETURN, '--model', MODEL, '--out', OVERLAY], proj);
const overlay = existsSync(OVERLAY) ? JSON.parse(readFileSync(OVERLAY, 'utf8')) : { issues: [] };
const renderTo = (mode, name) => {
  const dest = join(out, name);
  const args = [MODEL, '--layout', LAYOUT, ...(mode === 'clean' ? [] : ['--issues', OVERLAY, '--mode', mode]), '--out', dest];
  const r = cli('render', args, proj);
  assert.equal(r.status, 0, `${mode}: ${r.err}`);
  return readFileSync(dest, 'utf8');
};
const texts = (i, fields) => fields.map((k) => i[k]).filter((t) => typeof t === 'string' && t !== '');

test('o4 merge of the reviewer return writes the overlay outside the repo, and it validates against the model and lints clean', () => {
  assert.equal(merged.status, 0, merged.err);
  assert.deepEqual(overlay.issues.map((i) => i.id).sort(), returned.issues.map((i) => i.id).sort());
  const v = cli('validate', [MODEL, '--issues', OVERLAY], proj);
  assert.equal(v.status, 0, v.out + v.err);
  const l = cli('issues', ['lint', OVERLAY], proj);
  assert.equal(l.status, 0, l.out + l.err);
  assert.deepEqual(readdirSync(proj).sort(), ['.git', 'a.txt']);
});

test('o5 the clean render contains no issue id, title, summary, impact, fix or detail and no Issues switch', () => {
  assert.ok(overlay.issues.length > 0);
  const html = renderTo('clean', 'clean.html');
  for (const i of overlay.issues) {
    for (const t of texts(i, ['id', 'title', 'summary', 'impact', 'fix', 'detail'])) {
      assert.ok(!html.includes(t), `clean build carries ${JSON.stringify(t)}`);
    }
  }
  assert.doesNotMatch(html, /id="archmap-issues"/);
  assert.doesNotMatch(html, /id=["']issues-switch["']/);
  assert.doesNotMatch(html, /ZQDETAIL/);
});

test('o6 the shared render carries summary, impact and fix of every issue, never the detail, and no Issues switch', () => {
  const html = renderTo('shared', 'shared.html');
  for (const i of overlay.issues) {
    for (const t of texts(i, ['summary', 'impact', 'fix'])) assert.ok(html.includes(t), `shared build lacks ${JSON.stringify(t)}`);
  }
  assert.doesNotMatch(html, /ZQDETAIL/);
  for (const i of overlay.issues) if (i.detail) assert.ok(!html.includes(i.detail), 'shared build carries a detail');
  assert.doesNotMatch(html, /id=["']issues-switch["']/);
});

test('o7 the internal render carries the detail and the Issues switch; internal and shared builds refuse to render without --out', () => {
  const html = renderTo('internal', 'internal.html');
  for (const i of overlay.issues) if (i.detail) assert.ok(html.includes(i.detail.slice(0, 20)), 'internal build lacks a detail');
  assert.match(html, /ZQDETAIL-1/);
  assert.match(html, /id=["']issues-switch["']/);
  const before = readdirSync(proj).sort();
  for (const mode of ['internal', 'shared']) {
    const r = cli('render', [MODEL, '--layout', LAYOUT, '--issues', OVERLAY, '--mode', mode], proj);
    assert.equal(r.status, 2, `${mode}: ${r.err}`);
    assert.deepEqual(readdirSync(proj).sort(), before, `${mode}: wrote into the repo`);
  }
});
