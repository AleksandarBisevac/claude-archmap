import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case ids (r1, r2, ...) lead every title so the suite prints them first.
// The golden fixture (model + issues) is the render input; its layout is computed here with layout.mjs.
//
// Embedding contract the renderer is held to:
//   <script type="application/json" id="archmap-model">   the model
//   <script type="application/json" id="archmap-layout">  the layout
//   <script type="application/json" id="archmap-issues">  the issues (internal and shared only)
//   an element with id="issues-switch"                     the global Issues switch (never in clean)
//   CSS custom properties --rel-<edge type>, --zone-<zone kind>, --sev-<high|med|low> carry the fixed colours.
const CLI = fileURLToPath(new URL('../scripts/render.mjs', import.meta.url));
const GOLDEN = fileURLToPath(new URL('./fixtures/golden/', import.meta.url));
const MODEL = join(GOLDEN, 'architecture.model.json');
const ISSUES = join(GOLDEN, 'issues.json');
const model = JSON.parse(readFileSync(MODEL, 'utf8'));
const issues = JSON.parse(readFileSync(ISSUES, 'utf8'));

const clone = (x) => JSON.parse(JSON.stringify(x));
const tmp = mkdtempSync(join(tmpdir(), 'archmap-render-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

const { layoutModel } = await import('../scripts/layout.mjs');
const LAYOUT = join(tmp, 'architecture.layout.json');
const layout = await layoutModel(model);
writeFileSync(LAYOUT, JSON.stringify(layout));

// Issues with a non-empty internal detail, so "never detail" is observable.
const DETAIL = (id) => `internal-only detail text for ${id}: reproduction steps and exploit path`;
const issuesWithDetail = clone(issues);
for (const i of issuesWithDetail.issues) i.detail = DETAIL(i.id);
const ISSUES_D = join(tmp, 'issues.detail.json');
writeFileSync(ISSUES_D, JSON.stringify(issuesWithDetail));

let seq = 0;
function render(args, { expectOk = true } = {}) {
  const out = join(tmp, `out-${++seq}.html`);
  const r = spawnSync(process.execPath, [CLI, ...args, '--out', out], { encoding: 'utf8' });
  if (expectOk) {
    assert.equal(r.status, 0, `render failed (${r.status}): ${r.stderr}${r.stdout}`);
    return { html: readFileSync(out, 'utf8'), out, r };
  }
  return { html: existsSync(out) ? readFileSync(out, 'utf8') : null, out, r };
}
const renderMode = (mode, issuesPath = ISSUES_D, extra = []) =>
  render([MODEL, '--layout', LAYOUT, '--issues', issuesPath, ...(mode ? ['--mode', mode] : []), ...extra]).html;

const BLOCK = (id) => new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`);
const block = (html, id) => {
  const m = html.match(BLOCK(id));
  return m ? JSON.parse(m[1]) : undefined;
};
const withoutJsonBlocks = (html) => html.replace(/<script type="application\/json"[^>]*>[\s\S]*?<\/script>/g, '');
const stripStepIssues = (m) => {
  const c = clone(m);
  for (const s of c.sequences ?? []) for (const st of s.steps ?? []) delete st.i;
  return c;
};
const issueTexts = (iss) =>
  iss.issues.flatMap((i) => [i.id, i.title, i.summary, i.impact, i.fix, i.detail].filter((t) => typeof t === 'string' && t !== ''));

const MODES = ['clean', 'internal', 'shared'];

test('r1 every mode renders one self-contained HTML: no external script, style, font, image or fetch URL', () => {
  for (const mode of MODES) {
    const html = renderMode(mode);
    assert.match(html.slice(0, 64).toLowerCase(), /^<!doctype html>/, `${mode}: not an HTML document`);
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i, `${mode}: external <script src>`);
    assert.doesNotMatch(html, /<link\b/i, `${mode}: <link> element`);
    assert.doesNotMatch(html, /@import\b/i, `${mode}: CSS @import`);
    assert.doesNotMatch(html, /@font-face\b/i, `${mode}: @font-face`);
    assert.doesNotMatch(html, /url\(\s*['"]?\s*(?:https?:)?\/\//i, `${mode}: CSS url() to a remote resource`);
    assert.doesNotMatch(html, /\b(?:src|srcset|href)\s*=\s*['"]?\s*(?:https?:)?\/\//i, `${mode}: remote src/href attribute`);
    assert.doesNotMatch(withoutJsonBlocks(html), /\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(|new\s+WebSocket|EventSource|sendBeacon/, `${mode}: network API`);
    const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1].trim());
    assert.ok(styles.some((c) => c.length > 0), `${mode}: no inline CSS`);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/application\/json/.test(m[1]));
    assert.ok(scripts.some((m) => m[2].trim().length > 0), `${mode}: no inline viewer script`);
    // Outside the embedded data (whose evidence links may name repoUrl), template, CSS and JS carry no URL at all.
    const urls = withoutJsonBlocks(html).match(/https?:\/\/[^\s"'`)<>]+/g) ?? [];
    assert.deepEqual(urls, [], `${mode}: URLs in template, CSS or JS`);
  }
});

test('r2 clean mode (also the default) contains no issue id, title or text from the issues and no Issues switch', () => {
  const explicit = renderMode('clean');
  const byDefault = renderMode(undefined);
  for (const [label, html] of [['--mode clean', explicit], ['default mode', byDefault]]) {
    for (const t of issueTexts(issuesWithDetail)) assert.ok(!html.includes(t), `${label}: carries issue text ${JSON.stringify(t)}`);
    assert.doesNotMatch(html, /id="archmap-issues"/, `${label}: embeds an issues block`);
    assert.doesNotMatch(html, /id=["']issues-switch["']/, `${label}: carries the Issues switch`);
    const m = block(html, 'archmap-model');
    for (const s of m.sequences) for (const st of s.steps) assert.equal(st.i, undefined, `${label}: step in ${s.id} keeps issue ${st.i}`);
  }
  assert.equal(explicit, byDefault, 'the default mode is not clean');
});

test('r3 internal mode embeds the full issues (with detail) and the global Issues switch', () => {
  const html = renderMode('internal');
  assert.deepEqual(block(html, 'archmap-issues'), issuesWithDetail);
  assert.match(html, /id=["']issues-switch["']/, 'no Issues switch');
  for (const i of issuesWithDetail.issues) assert.ok(html.includes(DETAIL(i.id)), `detail of ${i.id} missing`);
});

test('r4 shared mode embeds summary, impact and fix for every issue but never the detail, and no Issues switch', () => {
  const html = renderMode('shared');
  const emb = block(html, 'archmap-issues');
  assert.ok(emb, 'shared mode embeds no issues');
  assert.equal(emb.issues.length, issuesWithDetail.issues.length);
  for (const src of issuesWithDetail.issues) {
    const got = emb.issues.find((i) => i.id === src.id);
    assert.ok(got, `${src.id} missing`);
    for (const k of ['sev', 'category', 'title', 'anchor', 'summary', 'impact', 'fix']) assert.deepEqual(got[k], src[k], `${src.id}.${k}`);
    assert.ok(!('detail' in got), `${src.id} keeps a detail key`);
    assert.ok(!html.includes(src.detail), `${src.id}: detail text present in the HTML`);
  }
  assert.doesNotMatch(html, /id=["']issues-switch["']/, 'the Issues switch is internal-only');
});

test('r5 the embedded model and layout JSON round-trip (clean drops only step issue refs), even with markup in strings', () => {
  const internal = renderMode('internal');
  assert.deepEqual(block(internal, 'archmap-model'), model, 'internal model differs');
  assert.deepEqual(block(internal, 'archmap-layout'), layout, 'layout differs');
  assert.deepEqual(block(renderMode('clean'), 'archmap-model'), stripStepIssues(model), 'clean model differs beyond step.i');
  assert.deepEqual(block(renderMode('shared'), 'archmap-model'), model, 'shared model differs');

  const hostile = clone(model);
  const EVIL = '</script><script>window.__pwned=1</script><!-- & \u2028 \u2029';
  hostile.nodes[0].title = EVIL;
  hostile.meta.project = `Demo ${EVIL}`;
  const HM = join(tmp, 'hostile.model.json');
  writeFileSync(HM, JSON.stringify(hostile));
  const html = render([HM, '--layout', LAYOUT]).html;
  assert.deepEqual(block(html, 'archmap-model'), stripStepIssues(hostile), 'hostile model does not round-trip');
  assert.ok(!html.includes('<script>window.__pwned'), 'a model string broke out of its script block');
  assert.ok(!html.includes('<!-- &'), 'a model string opened an HTML comment');
});

test('r6 a theme changes fonts, chrome and accent only, never relation, zone or severity colours', () => {
  const fixedVars = (html) =>
    (html.match(/--(?:rel|zone|sev)-[a-z0-9-]+\s*:\s*[^;}]+/gi) ?? []).map((d) => d.replace(/\s+/g, ' ').trim());
  const base = renderMode('internal');
  const baseVars = fixedVars(base);
  for (const t of new Set(model.edges.map((e) => e.type))) assert.match(base, new RegExp(`--rel-${t}\\s*:`), `no --rel-${t}`);
  for (const k of new Set(model.zones.map((z) => z.kind))) assert.match(base, new RegExp(`--zone-${k}\\s*:`), `no --zone-${k}`);
  for (const s of ['high', 'med', 'low']) assert.match(base, new RegExp(`--sev-${s}\\s*:`), `no --sev-${s}`);

  const theme = {
    fonts: { sans: 'Themed Sans Probe, sans-serif', mono: 'Themed Mono Probe, monospace' },
    chrome: { bg: '#010203', surface: '#040506', text: '#070809', muted: '#0a0b0c', border: '#0d0e0f' },
    accent: '#123abc',
    // Not in the theme contract: must be ignored, not applied.
    relations: { api: '#ff00ff' },
    zones: { service: '#ff00ff' },
    severity: { high: '#ff00ff' },
    '--rel-api': '#ff00ff',
  };
  const TH = join(tmp, 'archmap.theme.json');
  writeFileSync(TH, JSON.stringify(theme));
  const themed = renderMode('internal', ISSUES_D, ['--theme', TH]);
  for (const v of [theme.fonts.sans, theme.fonts.mono, ...Object.values(theme.chrome), theme.accent]) {
    assert.ok(themed.includes(v), `theme value ${v} not applied`);
  }
  assert.ok(!themed.toLowerCase().includes('#ff00ff'), 'an out-of-contract theme key reached the output');
  assert.deepEqual(fixedVars(themed), baseVars, 'relation, zone or severity colours changed under a theme');
  assert.ok(baseVars.length > 0);
});

test('r7 inputs are validated first: an invalid model, issues or theme is refused and nothing is written', () => {
  const bad = clone(model);
  bad.edges[0].to = 'no-such-node';
  const BM = join(tmp, 'bad.model.json');
  writeFileSync(BM, JSON.stringify(bad));
  const a = render([BM, '--layout', LAYOUT], { expectOk: false });
  assert.equal(a.r.status, 1, `invalid model: exit ${a.r.status}`);
  assert.equal(a.html, null, 'output written for an invalid model');

  const badIssues = clone(issues);
  badIssues.issues[0].anchor = { node: 'no-such-node' };
  const BI = join(tmp, 'bad.issues.json');
  writeFileSync(BI, JSON.stringify(badIssues));
  const b = render([MODEL, '--layout', LAYOUT, '--issues', BI, '--mode', 'internal'], { expectOk: false });
  assert.equal(b.r.status, 1, `invalid issues: exit ${b.r.status}`);
  assert.equal(b.html, null, 'output written for invalid issues');

  const BT = join(tmp, 'bad.theme.json');
  writeFileSync(BT, JSON.stringify({ accent: 'red; } body { display:none' }));
  const c = render([MODEL, '--layout', LAYOUT, '--theme', BT], { expectOk: false });
  assert.equal(c.r.status, 1, `invalid theme: exit ${c.r.status}`);
  assert.equal(c.html, null, 'output written for an invalid theme');
  // The schema only asks chrome and fonts for a non-empty string: a value that would break out of its CSS declaration is refused too.
  for (const evil of [{ chrome: { bg: '#fff; } body { display:none' } }, { fonts: { sans: 'x</style><script>1</script>' } }]) {
    writeFileSync(BT, JSON.stringify(evil));
    const r = render([MODEL, '--layout', LAYOUT, '--theme', BT], { expectOk: false });
    assert.equal(r.r.status, 1, `theme ${JSON.stringify(evil)}: exit ${r.r.status}`);
    assert.equal(r.html, null, 'output written for a CSS-breaking theme value');
  }

  const d = render([MODEL, '--layout', LAYOUT, '--mode', 'public'], { expectOk: false });
  assert.equal(d.r.status, 2, `unknown mode: exit ${d.r.status}`);
  const e = render([MODEL, '--layout', LAYOUT, '--mode', 'internal'], { expectOk: false });
  assert.equal(e.r.status, 2, `internal without --issues: exit ${e.r.status}`);
});

test('r8 rendering is deterministic: the same inputs give byte-identical HTML', () => {
  for (const mode of MODES) assert.equal(renderMode(mode), renderMode(mode), `${mode} differs between runs`);
});
