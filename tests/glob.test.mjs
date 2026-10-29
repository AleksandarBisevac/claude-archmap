import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob, matchAny, globToRegExp } from '../scripts/lib/glob.mjs';

// Case ids (g1, g2, ...) lead every title so the suite prints them first.

test('g1 double-star crosses directory separators and **/ also matches zero directories', () => {
  assert.ok(matchGlob('**', 'a'));
  assert.ok(matchGlob('**', 'a/b/c.js'));
  assert.ok(matchGlob('**/x.js', 'x.js'));
  assert.ok(matchGlob('**/x.js', 'a/b/x.js'));
  assert.ok(!matchGlob('**/x.js', 'a/b/y.js'));
  assert.ok(matchGlob('src/**/x.js', 'src/x.js'));
  assert.ok(matchGlob('src/**/x.js', 'src/a/b/x.js'));
  assert.ok(!matchGlob('src/**/x.js', 'lib/a/x.js'));
  assert.ok(matchGlob('src/**.js', 'src/a/b.js'));
});

test('g2 single star stays inside one path segment', () => {
  assert.ok(matchGlob('*', 'README.md'));
  assert.ok(!matchGlob('*', 'docs/README.md'));
  assert.ok(matchGlob('src/*', 'src/a.js'));
  assert.ok(!matchGlob('src/*', 'src/a/b.js'));
  assert.ok(matchGlob('src/*.js', 'src/a.js'));
  assert.ok(!matchGlob('src/*.js', 'src/a.ts'));
  assert.ok(matchGlob('src/a*', 'src/a'));
  assert.ok(matchGlob('*', '.gitignore'));
});

test('g3 question mark matches exactly one non-separator character', () => {
  assert.ok(matchGlob('a?.js', 'ab.js'));
  assert.ok(!matchGlob('a?.js', 'a.js'));
  assert.ok(!matchGlob('a?.js', 'abc.js'));
  assert.ok(!matchGlob('a?b', 'a/b'));
});

test('g4 dir/** owns the whole subtree but not the directory name, a sibling prefix or a parent', () => {
  assert.ok(matchGlob('api/**', 'api/a.js'));
  assert.ok(matchGlob('api/**', 'api/x/y/z.js'));
  assert.ok(!matchGlob('api/**', 'api'));
  assert.ok(!matchGlob('api/**', 'api2/a.js'));
  assert.ok(!matchGlob('api/**', 'web/api/a.js'));
  assert.ok(matchGlob('apps/web/**', 'apps/web/src/main.ts'));
});

test('g5 literals match exactly; regex metacharacters are escaped; ./ prefixes and backslashes are normalised', () => {
  assert.ok(matchGlob('a.b', 'a.b'));
  assert.ok(!matchGlob('a.b', 'axb'));
  assert.ok(matchGlob('a+(b)[c].js', 'a+(b)[c].js'));
  assert.ok(!matchGlob('a+(b)[c].js', 'abbc.js'));
  assert.ok(matchGlob('./api/**', 'api/a.js'));
  assert.ok(matchGlob('api/**', './api/a.js'));
  assert.ok(matchGlob('api/**', 'api\\a.js'));
  assert.ok(!matchGlob('', 'a'));
});

test('g6 matchAny is true when any glob matches, false for an empty or missing list; globToRegExp returns a RegExp', () => {
  assert.ok(matchAny(['web/**', 'api/**'], 'api/a.js'));
  assert.ok(!matchAny(['web/**'], 'api/a.js'));
  assert.ok(!matchAny([], 'api/a.js'));
  assert.ok(!matchAny(undefined, 'api/a.js'));
  assert.ok(globToRegExp('a/**') instanceof RegExp);
});
