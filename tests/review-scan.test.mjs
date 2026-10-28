// Tests for the archmap-review skill's mechanical scan (.claude/skills/archmap-review/scripts/scan.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCAN = fileURLToPath(new URL('../.claude/skills/archmap-review/scripts/scan.mjs', import.meta.url));

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function write(dir, path, content) {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
}

// A throwaway repo with one base commit; `files` are committed on top as the head commit.
function repoWith(files, { denylist } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'archmap-scan-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  write(dir, 'README.md', '# fixture\n');
  write(dir, '.gitignore', '.private/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  if (denylist) write(dir, '.private/anonymise-denylist.txt', `# test terms\n${denylist.join('\n')}\n`);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'head');
  return dir;
}

function scan(dir) {
  return JSON.parse(execFileSync(process.execPath, [SCAN, '--repo', dir, '--base', 'HEAD~1', '--head', 'HEAD'], { encoding: 'utf8' }));
}

const rules = (out) => out.leads.map((l) => l.rule).sort();

test('rs1 flags each mechanical rule on added lines', (t) => {
  const dir = repoWith({
    'scripts/render.mjs': [
      "import fg from 'fast-glob';",
      "import fs from 'fs';",
      'const byZone = Object.groupBy(nodes, (n) => n.zone);',
      'const stamp = new Date();',
      "execSync(`git -C ${repo} ls-files`);",
      'const css = "https://fonts.googleapis.com/css2?family=Inter";',
    ].join('\n'),
    'schema/x.schema.json': '{\n  "additionalProperties": false\n}\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = scan(dir);
  assert.deepEqual(rules(out), [
    '2-deps', '2-deps', '2-node18', '3-determinism', '4-offline', '5-model-contract', '7-scanner-safety',
  ]);
  assert.equal(out.leads.find((l) => l.note.includes('fast-glob')).severity, 'high');
  assert.equal(out.leads.find((l) => l.note.includes("'fs'")).severity, 'low');
  assert.match(out.denylist, /SKIPPED/);
});

test('rs2 denylist hits are reported by index and never echo the term', (t) => {
  const dir = repoWith({ 'tests/fixtures/x.json': '{"title": "Built for Quillonia Labs"}\n' }, { denylist: ['zephyr', 'quillonia'] });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = scan(dir);
  assert.equal(out.leads.length, 1);
  assert.equal(out.leads[0].rule, '1-denylist');
  assert.match(out.leads[0].note, /term #2/);
  assert.ok(!JSON.stringify(out).toLowerCase().includes('quillonia'));
  assert.match(out.denylist, /checked \(2 terms\)/);
});

test('rs3 clean, Node-18-safe code and comments give no leads', (t) => {
  const dir = repoWith({
    'scripts/lib/ok.mjs': [
      "// node scripts/validate.mjs <model.json> uses ['from', 'to'] pairs",
      "import { readFileSync } from 'node:fs';",
      "import { validate } from '../validate.mjs';",
      "for (const side of ['from', 'to']) console.log(side);",
      "const re = /^[a-z]+$/i;",
      "const url = 'https://example.invalid/repo';",
    ].join('\n'),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(scan(dir).leads, []);
});

test('rs4 usage errors exit 2', () => {
  assert.throws(() => execFileSync(process.execPath, [SCAN], { stdio: 'pipe' }), (e) => e.status === 2);
  assert.throws(() => execFileSync(process.execPath, [SCAN, '--bogus'], { stdio: 'pipe' }), (e) => e.status === 2);
});
