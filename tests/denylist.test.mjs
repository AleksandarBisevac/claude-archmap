import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Case ids (d1, d2) lead every title so the suite prints them first.
// Repo-wide net behind tests/golden.test.mjs's own check: the repo is public, so no tracked file
// may carry a term from the private denylist. Terms are read at runtime and NEVER printed or inlined;
// failures name the file and the term's index only.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DENYLIST = join(ROOT, '.private', 'anonymise-denylist.txt');
// docs/design.md names a public data platform as a v1.1 roadmap item.
const EXEMPT = new Set(['docs/design.md']);

const parseTerms = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.toLowerCase());

const isBinary = (buf) => buf.includes(0);

// Returns ["<file>: term #<index>", ...] (index is 1-based among the active terms).
function scan(files, terms, read) {
  const hits = [];
  for (const file of files) {
    if (EXEMPT.has(file)) continue;
    const buf = read(file);
    if (buf === null || isBinary(buf)) continue;
    const text = buf.toString('utf8').toLowerCase();
    terms.forEach((term, i) => {
      if (text.includes(term)) hits.push(`${file}: term #${i + 1}`);
    });
  }
  return hits;
}

test('d1 no git-tracked file except docs/design.md contains a denylist term (reported by file and term index only; skipped visibly when the list is absent)', (t) => {
  if (!existsSync(DENYLIST)) {
    t.skip('denylist not checked: .private/anonymise-denylist.txt is absent');
    return;
  }
  const terms = parseTerms(readFileSync(DENYLIST, 'utf8'));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
  // Deleted paths, symlinks to directories and submodule gitlinks are not readable files: skip them.
  const read = (f) => {
    try {
      return statSync(join(ROOT, f)).isFile() ? readFileSync(join(ROOT, f)) : null;
    } catch {
      return null;
    }
  };
  const hits = scan(files, terms, read);
  assert.deepEqual(hits, [], `denylist hits (file: term index):\n${hits.join('\n')}`);
});

test('d2 the scanner is case-insensitive, skips binaries and the exempt file, skips comments, and prints an index not the term', () => {
  const secret = 'Zq9-Sample-Term';
  const terms = parseTerms(`# comment\n\n${secret}\n`);
  assert.deepEqual(terms, [secret.toLowerCase()]);
  const files = {
    'a.txt': Buffer.from(`prefix ${secret.toUpperCase()} suffix`),
    'b.bin': Buffer.concat([Buffer.from([0]), Buffer.from(secret)]),
    'docs/design.md': Buffer.from(secret),
    'c.txt': Buffer.from('clean'),
    'gone.txt': null,
  };
  const hits = scan(Object.keys(files), terms, (f) => files[f]);
  assert.deepEqual(hits, ['a.txt: term #1']);
  assert.ok(!hits.join('').toLowerCase().includes(secret.toLowerCase()));
});
