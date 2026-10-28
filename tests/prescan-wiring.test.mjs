import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (pw1..pw4) lead every title so the suite prints them first.
// The real prescan CLI, with its default plug-in loader (scripts/lib/prescan/stacks/*.mjs), run on
// each fixture repo must emit that stack's extract. No `extractors` override anywhere.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRESCAN = join(ROOT, 'scripts', 'prescan.mjs');
const LIB = join(ROOT, 'scripts', 'lib', 'prescan');
const REPOS = join(ROOT, 'tests', 'fixtures', 'repos');

const cli = (repo) => {
  const r = spawnSync(process.execPath, [PRESCAN, join(REPOS, repo)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const total = (frag) =>
  Object.values(frag)
    .filter(Array.isArray)
    .reduce((n, items) => n + items.length, 0);

const CASES = [
  ['pw1', 'python-api', 'python', 'python.mjs'],
  ['pw2', 'ts-web', 'ts-frontend', 'ts-frontend.mjs'],
  ['pw3', 'node-api', 'node-backend', 'node-backend.mjs'],
];

for (const [id, repo, stack, file] of CASES) {
  test(`${id} the CLI on ${repo} emits the ${stack} extract (default loader finds the plug-in)`, () => {
    const out = cli(repo);
    const frag = out.extracts[stack];
    assert.ok(frag, `no extracts.${stack} in ${Object.keys(out.extracts)}`);
    assert.equal(frag.error, undefined);
    assert.ok(total(frag) >= 1, `${stack} fragment has no items`);
    assert.ok(out.stacks.includes(stack), `stacks lists ${stack}: ${out.stacks}`);
  });
}

test('pw4 each stacks/ file is a one-line re-export of the plug-in one directory up, same object', async () => {
  for (const [, , , file] of CASES) {
    const shim = join(LIB, 'stacks', file);
    assert.ok(existsSync(shim), `${file} missing in stacks/`);
    assert.equal(readFileSync(shim, 'utf8').trim(), `export { default } from '../${file}';`);
    const [a, b] = await Promise.all([import(pathToFileURL(shim).href), import(pathToFileURL(join(LIB, file)).href)]);
    assert.equal(a.default, b.default);
  }
});
