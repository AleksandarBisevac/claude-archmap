#!/usr/bin/env node
// render.mjs - build the self-contained archmap HTML from a model and its layout.
//
//   node scripts/render.mjs <model.json> --layout <layout.json> [--issues <issues.json>]
//                           [--theme <theme.json>] [--mode clean|internal|shared] [--out <file>]
//
// Inlines assets/viewer/template.html, viewer.css and viewer.js with the model, the layout and (per
// mode) the issues into ONE offline HTML file: no external script, style, font or fetch.
//
//   clean    (default) physically contains no issues: no issues block, no Issues switch or section,
//            and the model's step issue refs (steps[].i) are dropped. Safe to commit.
//   internal the full issues, detail included, and the global Issues switch. Keep it outside the repo.
//   shared   the issues without their internal `detail` (summary, impact and fix stay); no Issues switch.
//
// Inputs are validated first (validate.mjs for model + issues, the theme schema for the theme, plus a
// shape check of the layout); an invalid input is refused and nothing is written. The theme sets
// fonts, chrome and accent only; relation, zone and severity colours are fixed (design D10).
// Output is deterministic: the same inputs give byte-identical HTML.
//
// --out defaults to archmap.html beside the model for clean; internal and shared need an explicit
// --out, so an issues build is never dropped into the analysed repo by accident.
// Exit 0 ok, 1 an input is invalid (nothing is written), 2 usage or unreadable input.
// Node >= 18, ESM, zero npm dependencies.

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from './validate.mjs';
import { validateSchema } from './lib/jsonschema.mjs';

export const MODES = ['clean', 'internal', 'shared'];

const asset = (name) => readFileSync(new URL(`../assets/viewer/${name}`, import.meta.url), 'utf8');
const loadSchema = (name) =>
  JSON.parse(readFileSync(new URL(`../schema/archmap-${name}.schema.json`, import.meta.url), 'utf8'));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// public API

/**
 * Validate the render inputs. Returns findings as strings; empty means renderable.
 * @param {{model: object, layout: object, issues?: object, theme?: object}} inputs
 * @returns {string[]}
 */
export function checkInputs({ model, layout, issues, theme }) {
  const out = [];
  const v = validate(model, issues === undefined ? {} : { issues });
  for (const f of v.findings) out.push(`${f.code}  ${f.pointer || '/'}  ${f.message}`);
  for (const f of checkLayout(layout)) out.push(`layout  ${f}`);
  if (theme !== undefined) for (const f of checkTheme(theme)) out.push(`theme  ${f}`);
  return out;
}

/**
 * Render the HTML. Inputs are assumed valid (see checkInputs; the CLI checks first).
 * @param {{model: object, layout: object, issues?: object, theme?: object, mode?: 'clean'|'internal'|'shared'}} inputs
 * @returns {string} the complete HTML document
 */
export function renderHtml({ model, layout, issues, theme, mode = 'clean' }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (mode !== 'clean' && issues === undefined) throw new Error(`mode ${mode} needs issues`);
  const withIssues = mode !== 'clean';
  const embeddedModel = withIssues ? model : stripIssueRefs(model);
  const blocks = [jsonBlock('archmap-model', embeddedModel), jsonBlock('archmap-layout', layout)];
  if (withIssues) blocks.push(jsonBlock('archmap-issues', issuesFor(issues, mode)));

  let template = asset('template.html');
  // Marked template regions: <!--ISSUES--> (issue section and nav, internal + shared) and <!--SWITCH-->
  // (the global Issues switch, internal only). A region is unwrapped where its mode keeps it, else cut out.
  template = region(template, 'ISSUES', withIssues);
  template = region(template, 'SWITCH', mode === 'internal');
  const parts = {
    TITLE: escapeHtml(projectTitle(model)),
    CSS: asset('viewer.css').trimEnd(),
    THEME: theme === undefined ? '' : themeStyle(theme),
    MODE: mode,
    DATA: blocks.join('\n'),
    JS: neutraliseScriptEnd(asset('viewer.js').trimEnd()),
  };
  // One pass: substituted text is never re-scanned, so data that looks like a placeholder stays data.
  return template.replace(/\{\{([A-Z]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(parts, k) ? parts[k] : m));
}

/** The issues as embedded for a mode: internal keeps everything, shared drops the internal detail. */
export function issuesFor(issues, mode) {
  if (mode === 'internal') return issues;
  if (mode === 'shared') {
    const c = clone(issues);
    for (const i of Array.isArray(c.issues) ? c.issues : []) if (isObj(i)) delete i.detail;
    return c;
  }
  throw new Error(`mode ${mode} embeds no issues`);
}

/** The model with every issue reference removed (sequence steps' `i`): what a clean build embeds. */
export function stripIssueRefs(model) {
  const c = clone(model);
  for (const s of Array.isArray(c.sequences) ? c.sequences : []) {
    for (const st of Array.isArray(s?.steps) ? s.steps : []) if (isObj(st)) delete st.i;
  }
  return c;
}

// ---------------------------------------------------------------------------
// embedding

// JSON inside <script type="application/json">: escaping <, > and & keeps any string from closing the
// block or opening a comment; U+2028/2029 are escaped for old parsers. JSON.parse reads it back unchanged.
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');
function jsonText(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(LS, '\\u2028')
    .replace(PS, '\\u2029');
}
const region = (text, name, keep) =>
  keep
    ? text.replace(new RegExp(`<!--/?${name}-->\\n?`, 'g'), '')
    : text.replace(new RegExp(`<!--${name}-->[\\s\\S]*?<!--/${name}-->\\n?`, 'g'), '');
const jsonBlock = (id, value) => `<script type="application/json" id="${id}">${jsonText(value)}</script>`;
const neutraliseScriptEnd = (js) => js.replace(/<\/(script)/gi, '<\\/$1');
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const projectTitle = (model) =>
  `${isObj(model?.meta) && typeof model.meta.project === 'string' && model.meta.project ? model.meta.project : 'Architecture'} · architecture map`;

// ---------------------------------------------------------------------------
// theme: fonts, chrome and accent only

const CHROME_VARS = { bg: '--bg', surface: '--surface', text: '--fg', muted: '--muted', border: '--line' };
// A value is written into a CSS declaration: nothing that could end it, open a block or leave <style>.
const UNSAFE_CSS = /[;{}<>\\\r\n]|\/\*|\*\//;

function checkTheme(theme) {
  const out = validateSchema(loadSchema('theme'), theme).map((e) => `${e.pointer || '/'}  ${e.message}`);
  if (out.length) return out;
  const values = [
    ...Object.entries(theme.fonts ?? {}).map(([k, v]) => [`/fonts/${k}`, v]),
    ...Object.entries(theme.chrome ?? {}).map(([k, v]) => [`/chrome/${k}`, v]),
  ];
  for (const [p, v] of values) {
    if (typeof v === 'string' && UNSAFE_CSS.test(v)) out.push(`${p}  value may not contain ; { } < > \\, a comment or a line break`);
  }
  return out;
}

// Declarations only for keys the theme contract names; anything else in the file is ignored.
// The selector outranks both the light :root rule and the dark-scheme rules, so chrome applies in both.
function themeStyle(theme) {
  const decl = [];
  const fonts = isObj(theme.fonts) ? theme.fonts : {};
  if (typeof fonts.sans === 'string') decl.push(`--font-body:${fonts.sans}`, `--font-display:${fonts.sans}`);
  if (typeof fonts.mono === 'string') decl.push(`--font-mono:${fonts.mono}`);
  const chrome = isObj(theme.chrome) ? theme.chrome : {};
  for (const [k, v] of Object.entries(CHROME_VARS)) if (typeof chrome[k] === 'string') decl.push(`${v}:${chrome[k]}`);
  if (typeof theme.accent === 'string') decl.push(`--accent:${theme.accent}`);
  if (!decl.length) return '';
  return `<style id="archmap-theme">\n:root:root:root{${decl.join(';')}}\n</style>`;
}

// ---------------------------------------------------------------------------
// layout shape (written by layout.mjs)

function checkLayout(layout) {
  if (!isObj(layout)) return ['is not an object'];
  if (layout.schemaVersion !== 1) return [`schemaVersion ${JSON.stringify(layout.schemaVersion)} is not 1`];
  if (!isObj(layout.graph)) return ['has no graph'];
  const out = [];
  for (const key of ['nodes', 'zones']) {
    const m = layout.graph[key];
    if (!isObj(m)) { out.push(`graph.${key} is not an object`); continue; }
    for (const [id, r] of Object.entries(m)) {
      if (!isObj(r) || !['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))) {
        out.push(`graph.${key}.${id} lacks finite x, y, w, h`);
      }
    }
  }
  if (layout.graph.edges !== undefined && !isObj(layout.graph.edges)) out.push('graph.edges is not an object');
  return out;
}

/** Model nodes the layout does not place (a layout older than the model): warned about, not drawn. */
export function unplacedNodes(model, layout) {
  const placed = isObj(layout?.graph?.nodes) ? layout.graph.nodes : {};
  return (Array.isArray(model?.nodes) ? model.nodes : []).map((n) => n?.id).filter((id) => !(id in placed));
}

// ---------------------------------------------------------------------------
// CLI

const USAGE =
  'usage: node scripts/render.mjs <model.json> --layout <layout.json> [--issues <issues.json>] ' +
  '[--theme <theme.json>] [--mode clean|internal|shared] [--out <file>]';

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { model: undefined, layout: undefined, issues: undefined, theme: undefined, mode: 'clean', out: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (['--layout', '--issues', '--theme', '--mode', '--out'].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (o.model === undefined) o.model = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (o.help) return o;
  if (o.model === undefined) throw new UsageError('missing <model.json>');
  if (o.layout === undefined) throw new UsageError('missing --layout <layout.json> (run scripts/layout.mjs first)');
  if (!MODES.includes(o.mode)) throw new UsageError(`--mode must be one of ${MODES.join(', ')}, not ${o.mode}`);
  if (o.mode !== 'clean' && o.issues === undefined) throw new UsageError(`--mode ${o.mode} needs --issues <issues.json>`);
  if (o.mode !== 'clean' && o.out === undefined) {
    throw new UsageError(`--mode ${o.mode} needs an explicit --out (issue builds stay outside the analysed repo)`);
  }
  return o;
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what} ${path} is not valid JSON: ${e.message}`);
  }
}

function main(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      console.log(USAGE);
      return 0;
    }
    const model = readJson(opts.model, 'model');
    const layout = readJson(opts.layout, 'layout file');
    const issues = opts.issues === undefined ? undefined : readJson(opts.issues, 'issues file');
    const theme = opts.theme === undefined ? undefined : readJson(opts.theme, 'theme file');
    const findings = checkInputs({ model, layout, issues, theme });
    if (findings.length) {
      for (const f of findings) console.log(f);
      console.log(`FAIL: ${findings.length} finding(s); nothing rendered`);
      return 1;
    }
    const missing = unplacedNodes(model, layout);
    if (missing.length) {
      console.error(`render: ${missing.length} node(s) have no position in the layout and are not drawn: ${missing.join(', ')}; re-run layout.mjs`);
    }
    const html = renderHtml({ model, layout, issues, theme, mode: opts.mode });
    const target = opts.out ?? join(dirname(opts.model), 'archmap.html');
    writeFileSync(target, html);
    console.log(`OK: ${opts.mode} render written to ${target} (${Buffer.byteLength(html)} bytes)`);
    return 0;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`render: ${e.message}\n${USAGE}`);
    return 2;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
