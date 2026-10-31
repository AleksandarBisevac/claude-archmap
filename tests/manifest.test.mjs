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

test('mf3 the newest CHANGELOG version heading equals plugin.json\'s version, is dated, and sits below an empty Unreleased heading', () => {
  const changelog = text('CHANGELOG.md');
  const headings = versionHeadings(changelog);
  assert.ok(headings.length > 0, 'CHANGELOG.md has at least one "## [x.y.z] - YYYY-MM-DD" version heading');
  const [newest] = headings;
  assert.equal(newest.version, read('.claude-plugin/plugin.json').version, 'the newest CHANGELOG version is the version plugin.json carries');
  assert.match(newest.date ?? '', /^\d{4}-\d{2}-\d{2}$/, `the ${newest.version} heading carries its release date`);
  const unreleased = changelog.indexOf('## [Unreleased]');
  const first = changelog.indexOf(`## [${newest.version}]`);
  assert.ok(unreleased >= 0 && unreleased < first, 'the Unreleased heading sits above the newest version');
  assert.equal(changelog.slice(unreleased + '## [Unreleased]'.length, first).trim(), '', 'the Unreleased section is empty');
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
