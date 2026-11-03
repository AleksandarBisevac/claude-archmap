import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const read = (p) => JSON.parse(text(p));

// The `## [x.y.z] - YYYY-MM-DD` headings of a Keep a Changelog file, newest first as written.
const versionHeadings = (changelog) =>
  [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/gm)].map((m) => ({ version: m[1], date: m[2] }));

test('plugin manifest names the plugin archmap with a semver version', () => {
  const plugin = read('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'archmap');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test('mf3 the newest CHANGELOG version heading equals plugin.json\'s version, is dated, and sits below an Unreleased heading that holds only change entries', () => {
  const changelog = text('CHANGELOG.md');
  const headings = versionHeadings(changelog);
  assert.ok(headings.length > 0, 'CHANGELOG.md has at least one "## [x.y.z] - YYYY-MM-DD" version heading');
  const [newest] = headings;
  assert.equal(newest.version, read('.claude-plugin/plugin.json').version, 'the newest CHANGELOG version is the version plugin.json carries');
  assert.match(newest.date ?? '', /^\d{4}-\d{2}-\d{2}$/, `the ${newest.version} heading carries its release date`);
  const unreleased = changelog.indexOf('## [Unreleased]');
  const first = changelog.indexOf(`## [${newest.version}]`);
  assert.ok(unreleased >= 0 && unreleased < first, 'the Unreleased heading sits above the newest version');
  // After a release the Unreleased section collects the next entries (Keep a Changelog): `###` kinds and list items only.
  const pending = changelog.slice(unreleased + '## [Unreleased]'.length, first).split('\n').filter((l) => l.trim() !== '');
  for (const l of pending) assert.match(l, /^(### \S|- \S|\s+\S)/, `the Unreleased section holds only change entries: "${l}"`);
});

test('mf4 the CHANGELOG version check fails on a heading that differs from the plugin version and passes on a matching pair', () => {
  const doc = (v) => `# Changelog\n\n## [Unreleased]\n\n## [${v}] - 2026-11-01\n\n### Added\n- x\n\n## [0.0.1] - 2026-01-01\n`;
  assert.deepEqual(versionHeadings(doc('1.0.0')).map((h) => h.version), ['1.0.0', '0.0.1'], 'headings are read newest first');
  assert.equal(versionHeadings(doc('1.0.0'))[0].version, '1.0.0', 'the pair 1.0.0/1.0.0 matches');
  assert.notEqual(versionHeadings(doc('0.9.0'))[0].version, '1.0.0', 'a 0.9.0 heading does not match 1.0.0');
  assert.deepEqual(versionHeadings('## [Unreleased]\n\n### Added\n- x\n'), [], 'an Unreleased-only changelog has no version heading');
});

test('dev marketplace lists archmap from the repo root', () => {
  const market = read('.claude-plugin/marketplace.json');
  const entry = market.plugins.find((p) => p.name === 'archmap');
  assert.ok(entry);
  assert.equal(entry.source, './');
});

// The comparisons the release-entry cases make, as pure functions so a case can prove they bite on a bad pair.
const sameText = (a, b) => a === b;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const preRelease = (s) => /pre-?release/i.test(s);

const devEntry = () => read('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'archmap');
const releaseEntry = () => read('docs/release/marketplace-entry.json');

test('mf5 the release entry has the published shape, its description equals the dev marketplace\'s and neither says pre-release', () => {
  const entry = releaseEntry();
  assert.equal(entry.name, 'archmap');
  assert.deepEqual(entry.source, { source: 'github', repo: 'AleksandarBisevac/claude-archmap' });
  assert.equal(entry.category, 'documentation');
  assert.equal(entry.strict, true);
  assert.equal(entry.homepage, read('.claude-plugin/plugin.json').homepage);
  assert.equal(typeof entry.description, 'string');
  assert.ok(entry.description.length > 0, 'the release entry has a description');
  assert.ok(sameText(entry.description, devEntry().description), 'the release entry description equals the dev marketplace description word for word');
  assert.ok(!preRelease(entry.description), 'the release entry description carries no pre-release note');
  assert.ok(!preRelease(devEntry().description), 'the dev marketplace description carries no pre-release note');
});

test('mf6 the release entry\'s tags equal plugin.json\'s keywords, crud-matrix included', () => {
  const { keywords } = read('.claude-plugin/plugin.json');
  const { tags } = releaseEntry();
  assert.ok(Array.isArray(tags));
  assert.ok(tags.includes('crud-matrix'), 'crud-matrix is a tag');
  assert.ok(sameList(tags, keywords), 'the tags equal the keywords, in order');
});

test('mf7 the release-entry comparisons fail on a differing description, a differing tag list and a pre-release note', () => {
  assert.ok(sameText('a b', 'a b'));
  assert.ok(!sameText('a b', 'a  b'), 'a one-space difference is a difference');
  assert.ok(!sameText('Maps architecture.', 'Maps architecture. Pre-release.'), 'a trailing note is a difference');
  assert.ok(sameList(['a', 'b'], ['a', 'b']));
  assert.ok(!sameList(['a'], ['a', 'crud-matrix']), 'a missing tag is a difference');
  assert.ok(!sameList(['a', 'b'], ['a', 'c']), 'a different tag is a difference');
  assert.ok(preRelease('Maps architecture. Pre-release: 0.9.0.'));
  assert.ok(preRelease('a prerelease build'));
  assert.ok(!preRelease('The first release.'));
});

// The self-build counts the 1.0.0 entry states for the committed map, read from the entry and from the model.
const countsIn = (entry) => {
  const m = entry.match(/(\d+) nodes, (\d+) edges, (\d+) entit(?:y|ies), (\d+) sequences and (\d+) views/);
  return m && m.slice(1).map(Number);
};

test('mf5 the CHANGELOG 1.0.0 entry records the counts of the map it shipped with, and the newest version entry (1.1.0, under an empty Unreleased section) the counts of the committed map', () => {
  const changelog = text('CHANGELOG.md');
  const entry = (heading) => {
    const start = changelog.indexOf(heading);
    assert.ok(start >= 0, `CHANGELOG.md has a ${heading} entry`);
    const next = changelog.indexOf('\n## [', start + 1);
    return changelog.slice(start, next < 0 ? undefined : next);
  };
  // 1.0.0 shipped with the map updated at 63d7495; the committed map has moved on since, so the released entry is a record
  assert.deepEqual(countsIn(entry('## [1.0.0]')), [34, 23, 1, 4, 5], 'the 1.0.0 entry states the counts of the map it shipped with');
  // 1.1.0 holds what was Unreleased: the Unreleased heading above it is empty, and the newest version entry carries the committed map's counts
  assert.equal(entry('## [Unreleased]').replace('## [Unreleased]', '').trim(), '', 'the Unreleased section holds nothing after the 1.1.0 release');
  const newest = versionHeadings(changelog)[0];
  assert.equal(newest.version, '1.1.0', 'the newest CHANGELOG version entry is 1.1.0');
  const stated = countsIn(entry(`## [${newest.version}]`));
  assert.ok(stated, 'the newest version entry states "N nodes, N edges, N entity, N sequences and N views"');
  const model = read('docs/architecture/architecture.model.json');
  const actual = [model.nodes, model.edges, model.entities, model.sequences, model.views].map((a) => a.length);
  assert.deepEqual(stated, actual, 'the counts in the newest version entry equal the committed model');
  assert.deepEqual(countsIn('30 nodes, 18 edges, 1 entity, 4 sequences and 5 views'), [30, 18, 1, 4, 5], 'the reader parses a stale entry, which then differs from the model');
});
