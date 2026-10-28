import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('plugin manifest names the plugin archmap with a semver version', () => {
  const plugin = read('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'archmap');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
});

test('dev marketplace lists archmap from the repo root', () => {
  const market = read('.claude-plugin/marketplace.json');
  const entry = market.plugins.find((p) => p.name === 'archmap');
  assert.ok(entry);
  assert.equal(entry.source, './');
});
