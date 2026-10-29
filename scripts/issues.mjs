#!/usr/bin/env node
// issues.mjs - the issues overlay's deterministic half (docs/design.md D2, D4, section 5 "issues file", section 9 step 6;
// mapping rules: skills/architecture-map/references/issues-catalog.md "Audit import").
//
//   node scripts/issues.mjs import-audit <audit-plan.json> --model <model.json> [--existing <issues.json>]
//                                        [--out <issues.json>] [--project <dir>]
//   node scripts/issues.mjs merge --existing <issues.json> --incoming <reviewer.json> --model <model.json>
//                                 [--anchors a,b] [--out <issues.json>] [--project <dir>]
//   node scripts/issues.mjs path [--project <dir>]
//   node scripts/issues.mjs lint <issues.json> [--json]
//
// import-audit turns the open entries of the plan's bugs[] and phases[].review.findings[] (legacy string findings
// included) into issues with source "audit", id "audit-<sourceId>" and track "<sourceId>". Each is anchored to the node
// whose paths globs (lib/glob.mjs), else whose evidence path, owns the entry's file; the most specific glob wins.
// Entries that are fixed/closed, line-level, or have no owning node (or no file) are skipped and counted. It reads
// only the plan file it is given. Re-importing is idempotent: audit-source issues of --existing are replaced by the
// fresh import (so one whose source closed disappears); issues of any other source are kept.
// merge replaces the existing issues on the listed anchors (ids of the anchored node/edge/entity/step; every anchor
// when --anchors is absent) with the incoming issues on those anchors; the rest is kept untouched.
// path prints <home>/.claude/archmap/<repo-slug>/ (SKILL.md "Output locations").
// lint checks the calibration of docs/design.md D4 (wording rules: issues-catalog.md "Calibrated wording") for builds
// that may be shared: every issue needs a non-empty summary, impact and fix (rule "empty"), and the summary, impact
// and fix of a security issue carry no internal specifics - a repo path or file name (rules "path"), a line number
// ("line"), a URL ("url"), a host name or IP ("host"), an ENV_LIKE_NAME ("env"), a credential-like token ("token").
// `detail` is internal-only and never linted. Reads only the file it is given and writes nothing. Exit 0 clean, 1 findings,
// 2 usage. --json prints {"ok", "findings": [{issue, field, rule, match}]}; otherwise one line per finding.
//
// A subcommand that writes takes --out. It REFUSES (exit 2, nothing written, no directory made) an --out inside the
// analysed project's git working tree (--project, default the cwd), and refuses (exit 1) a result that fails validate()
// of scripts/validate.mjs against --model, dangling anchors and duplicate ids included. Without --out the overlay is
// printed to stdout. Output is sorted (severity, then id) and deterministic.
// Exit 0 ok, 1 invalid result, 2 usage error or unreadable input. Node >= 18, ESM, zero npm dependencies.

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchGlob } from './lib/glob.mjs';
import { validate } from './validate.mjs';

const USAGE = [
  'usage: node scripts/issues.mjs import-audit <audit-plan.json> --model <model.json> [--existing <issues.json>] [--out <issues.json>] [--project <dir>]',
  '       node scripts/issues.mjs merge --existing <issues.json> --incoming <reviewer.json> --model <model.json> [--anchors a,b] [--out <issues.json>] [--project <dir>]',
  '       node scripts/issues.mjs path [--project <dir>]',
  '       node scripts/issues.mjs lint <issues.json> [--json]',
].join('\n');

class UsageError extends Error {}
class InvalidError extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const SEV_RANK = { high: 0, med: 1, low: 2 };
const CLOSED = new Set(['closed', 'fixed', 'resolved', 'done', 'cancelled', 'canceled', 'wontfix']);
const LINES = /^[0-9]+(?:-[0-9]+)?$/;

// ---------------------------------------------------------------------------
// audit import

const SEV_WORD = { high: 'high', medium: 'med', med: 'med', low: 'low' };
const mapSev = (s) => SEV_WORD[String(s ?? '').trim().toLowerCase()] ?? 'low';

// A defect with no architectural reading: skipped and counted, never forced into the catalogue.
const LINE_LEVEL = /\b(off-by-one|typos?|naming|rename|renaming|style|stylistic|lint|linting|whitespace|formatting|nits?|unused (?:variable|import|param\w*|function)|null check|missing null|console\.log)\b/i;

// First match wins. The order puts the narrow readings (docs, data) before the broad ones.
const CATEGORIES = [
  ['security', /\b(auth\w*|tokens?|sessions?|secrets?|passwords?|credentials?|inject\w*|csrf|xss|permissions?|encrypt\w*|tls|cors|sanitiz\w*|exploit\w*|vulnerab\w*)\b/i],
  ['docs', /\b(readme|docs?|documentation|guide|diagrams?|describes?)\b/i],
  ['data', /\b(database|schema|migrations?|sql|quer(?:y|ies)|tables?|index(?:es)?|transactions?|cache[sd]?|entit(?:y|ies)|persist\w*|storage)\b/i],
  ['reliability', /\b(retry|retries|timeouts?|crash\w*|fail\w*|race|queues?|hang\w*|stuck|idempot\w*|rollback)\b/i],
  ['performance', /\b(slow|latency|n\+1|throughput|memory|scal\w*|performance|polling|blocking)\b/i],
];
const categoryOf = (text) => (CATEGORIES.find(([, re]) => re.test(text)) ?? ['design'])[0];

const firstSentence = (text, max) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?:\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s;
};

const PATH_TOKEN = /^((?:[\w@.-]+\/)+[\w@.-]*|[\w@-][\w@.-]*\.[A-Za-z0-9]+)(?::(\d+(?:-\d+)?))?$/;

/** Split `path` or `path:lines` into {path, lines?}; null when it is not a path. */
function splitFile(s) {
  const m = PATH_TOKEN.exec(String(s ?? '').trim());
  return m ? { path: m[1], lines: m[2] } : null;
}

/** A legacy string finding: `[sev] path:lines - text`, `path:lines - [sev] text` or plain text. */
function parseLegacy(str) {
  let rest = String(str).trim();
  let sev;
  const tag = () => {
    const m = /^\[(high|medium|med|low)\]\s*/i.exec(rest);
    if (m) { sev = sev ?? m[1]; rest = rest.slice(m[0].length); }
    return Boolean(m);
  };
  tag();
  let file = null;
  const tok = /^(\S+)\s*/.exec(rest);
  if (tok) {
    const cand = splitFile(tok[1].replace(/[:,;]+$/, ''));
    if (cand) { file = cand; rest = rest.slice(tok[0].length); }
  }
  rest = rest.replace(/^[-:–—]+\s*/, '');
  tag();
  return { sev, file, text: rest.trim() };
}

/** Node ids that own `path`, best first: the longest literal glob prefix, then the deeper level, then the id. */
function ownerOf(nodes, path) {
  const hits = [];
  for (const n of nodes) {
    if (!isObj(n) || typeof n.id !== 'string') continue;
    let spec = -1;
    for (const g of list(n.paths)) {
      if (typeof g === 'string' && matchGlob(g, path)) {
        const lit = g.replace(/^(\.\/)+/, '').search(/[*?]/);
        spec = Math.max(spec, lit === -1 ? 10000 : lit);
      }
    }
    if (spec === -1 && list(n.evidence).some((e) => isObj(e) && e.path === path)) spec = 0;
    if (spec >= 0) hits.push({ id: n.id, spec, level: Number(n.level) || 0 });
  }
  hits.sort((a, b) => b.spec - a.spec || b.level - a.level || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits[0]?.id ?? null;
}

/**
 * Map the open entries of an audit plan to issues. Pure: reads nothing but its arguments.
 * @returns {{issues: object[], counts: {imported: number, skippedFixed: number, skippedUnanchored: number, skippedLineLevel: number}}}
 */
export function importAudit(plan, model) {
  const nodes = list(model?.nodes);
  const counts = { imported: 0, skippedFixed: 0, skippedUnanchored: 0, skippedLineLevel: 0 };
  const issues = [];
  const entries = [];

  for (const b of list(plan?.bugs)) {
    if (!isObj(b) || b.id == null) continue;
    const files = (Array.isArray(b.files) ? b.files : [b.file]).map(splitFile).filter(Boolean);
    entries.push({
      id: String(b.id), closed: CLOSED.has(String(b.status ?? 'open').toLowerCase()), sev: b.severity, files,
      title: String(b.title ?? '').trim(), text: [b.title, b.description].filter(Boolean).join('. '), body: String(b.description ?? ''),
      fix: b.expected ?? b.resolution,
    });
  }
  for (const ph of list(plan?.phases)) {
    const findings = list(ph?.review?.findings);
    findings.forEach((f, i) => {
      if (typeof f === 'string') {
        const p = parseLegacy(f);
        entries.push({ id: `${ph.id}-${i}`, closed: false, sev: p.sev, files: p.file ? [p.file] : [], title: firstSentence(p.text, 90), text: p.text, body: p.text });
      } else if (isObj(f) && f.id != null) {
        const files = (Array.isArray(f.files) ? f.files : [f.file]).map(splitFile).filter(Boolean);
        const text = String(f.issue ?? f.title ?? '');
        entries.push({
          id: String(f.id), closed: CLOSED.has(String(f.status ?? 'open').toLowerCase()), sev: f.severity, files,
          title: firstSentence(text, 90), text, body: text, fix: f.resolution,
        });
      }
    });
  }

  for (const e of entries) {
    if (e.closed) { counts.skippedFixed++; continue; }
    if (LINE_LEVEL.test(e.text)) { counts.skippedLineLevel++; continue; }
    let node = null;
    for (const f of e.files) { node = ownerOf(nodes, f.path); if (node) break; }
    if (!node) { counts.skippedUnanchored++; continue; }
    const category = categoryOf(e.text);
    const title = e.title || firstSentence(e.text, 90);
    const sev = mapSev(e.sev);
    const issue = {
      id: `audit-${e.id}`,
      sev,
      category,
      title,
      anchor: { node },
      // Security specifics stay in `detail` (internal only); the shared-safe fields carry only the headline.
      summary: category === 'security' ? title : firstSentence(e.text, 240),
      impact: `Tracked by the audit as ${sev} severity; see the audit entry ${e.id}.`,
      fix: e.fix ? firstSentence(e.fix, 240) : `See the audit entry ${e.id}.`,
      evidence: e.files.map((f) => ({ path: f.path, lines: f.lines && LINES.test(f.lines) ? f.lines : '1' })),
      source: 'audit',
      track: e.id,
    };
    if (e.text) issue.detail = e.text;
    issues.push(issue);
    counts.imported++;
  }
  return { issues, counts };
}

// ---------------------------------------------------------------------------
// merge

const anchorId = (issue) => {
  const a = issue?.anchor;
  return isObj(a) ? a.node ?? a.edge ?? a.entity ?? a.step : undefined;
};

/** Order: severity (high first), then id by code point. */
export function sortIssues(issues) {
  return [...issues].sort((a, b) =>
    (SEV_RANK[a.sev] ?? 3) - (SEV_RANK[b.sev] ?? 3) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Replace the issues on `anchors` (all when null) by the incoming ones on them; keep the rest. */
export function mergeIssues(existing, incoming, anchors = null) {
  const on = (i) => anchors === null || anchors.has(anchorId(i));
  return sortIssues([...existing.filter((i) => !on(i)), ...incoming.filter(on)]);
}

// ---------------------------------------------------------------------------
// where things live

function gitRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** realpath of the nearest existing ancestor, plus the part that does not exist yet. */
function realish(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    tail.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync(cur), ...tail);
}

/** `<repo-slug>`: the repository directory name, lowercased, anything but a letter, digit or `-` replaced by `-`. */
export function repoSlug(project) {
  const dir = realish(project);
  return basename(gitRoot(dir) ?? dir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** `<home>/.claude/archmap/<repo-slug>/` */
export function outputDir(project) {
  return `${join(homedir(), '.claude', 'archmap', repoSlug(project))}/`;
}

/** Throws UsageError when `out` is inside the git working tree of `project`. A project outside git has none. */
function assertOutsideRepo(out, project) {
  const proj = realish(project);
  const root = gitRoot(proj);
  if (!root) return;
  const rel = relative(realish(root), realish(out));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new UsageError(`refusing to write ${out}: it is inside the working tree of ${root}; the overlay lives outside the repo (see "path")`);
  }
}

// ---------------------------------------------------------------------------
// CLI

function readJsonFile(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${what} ${path} is not valid JSON`);
  }
}

function issuesOf(doc, what) {
  if (!isObj(doc) || !Array.isArray(doc.issues)) throw new UsageError(`${what} has no issues[] array`);
  return doc.issues;
}

const VALUE_FLAGS = new Set(['--model', '--existing', '--incoming', '--anchors', '--out', '--project']);

function parseArgs(argv) {
  const o = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--json') o.json = true;
    else if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      o.flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else o.positional.push(a);
  }
  return o;
}

/** Validate the overlay against the model and write it (or print it). Returns the exit code. */
function emit(model, issues, o, summary) {
  const file = { schemaVersion: '1.0', issues };
  const ids = new Set();
  for (const i of issues) {
    if (ids.has(i.id)) throw new InvalidError(`duplicate issue id "${i.id}"`);
    ids.add(i.id);
  }
  const v = validate(model, { issues: file });
  if (!v.ok) {
    throw new InvalidError(v.findings.map((f) => `${f.code} ${f.pointer} ${f.message}`).join('\n'));
  }
  const text = `${JSON.stringify(file, null, 2)}\n`;
  if (o.flags.out === undefined) {
    process.stdout.write(text);
    if (summary) process.stderr.write(`${summary}\n`);
    return 0;
  }
  mkdirSync(dirname(resolve(o.flags.out)), { recursive: true });
  writeFileSync(resolve(o.flags.out), text);
  process.stdout.write(`${summary ? `${summary}\n` : ''}wrote ${o.flags.out} (${issues.length} issues)\n`);
  return 0;
}

function importCmd(o) {
  const planPath = o.positional[1];
  if (!planPath || !o.flags.model) throw new UsageError('import-audit needs <audit-plan.json> and --model');
  const project = o.flags.project ?? process.cwd();
  if (o.flags.out !== undefined) assertOutsideRepo(o.flags.out, project);
  const plan = readJsonFile(planPath, 'audit plan');
  const model = readJsonFile(o.flags.model, 'model');
  const kept = o.flags.existing
    ? issuesOf(readJsonFile(o.flags.existing, 'existing overlay'), 'existing overlay').filter((i) => i?.source !== 'audit')
    : [];
  const { issues, counts } = importAudit(plan, model);
  const summary = `imported ${counts.imported}, skipped-fixed ${counts.skippedFixed}, skipped-unanchored ${counts.skippedUnanchored}, skipped-line-level ${counts.skippedLineLevel}`;
  return emit(model, sortIssues([...kept, ...issues]), o, summary);
}

function mergeCmd(o) {
  const { existing, incoming, model: modelPath } = o.flags;
  if (!existing || !incoming || !modelPath) throw new UsageError('merge needs --existing, --incoming and --model');
  const project = o.flags.project ?? process.cwd();
  if (o.flags.out !== undefined) assertOutsideRepo(o.flags.out, project);
  const model = readJsonFile(modelPath, 'model');
  const have = issuesOf(readJsonFile(existing, 'existing overlay'), 'existing overlay');
  const inc = issuesOf(readJsonFile(incoming, 'incoming overlay'), 'incoming overlay');
  const anchors = o.flags.anchors === undefined ? null : new Set(o.flags.anchors.split(',').map((s) => s.trim()).filter(Boolean));
  return emit(model, mergeIssues(have, inc, anchors), o, '');
}

// ---------------------------------------------------------------------------
// lint: the shared-build calibration (design D4)

const WORDING_FIELDS = ['summary', 'impact', 'fix'];
const TLDS = 'com|net|org|io|dev|local|internal|test|example|corp|lan|intranet|cloud|app|co|ai|biz|info|xyz';
// [rule, pattern]: each is searched in the text of a security issue's summary, impact and fix.
const SPECIFICS = [
  ['url', /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/i],
  ['path', /(?:^|[\s("'`])\.{0,2}\/?(?:[\w@.-]+\/)+[\w@.-]*\.[A-Za-z0-9]{1,8}\b/],
  ['line', /\blines?\s*(?:no\.?\s*)?[:#]?\s*\d+|\bL\d+(?:-L?\d+)?\b|[\w)\]]:\d+(?:-\d+)?\b/i],
  ['host', new RegExp(`\\b(?:\\d{1,3}(?:\\.\\d{1,3}){3}|localhost|(?:[a-z0-9-]+\\.)+(?:${TLDS}))\\b`, 'i')],
  ['env', /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/],
  ['token', /\b(?:(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})(?![\w-])|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i],
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Findings for one issue: [{issue, field, rule, match}] in field then rule order. */
export function lintIssue(issue) {
  const id = typeof issue?.id === 'string' ? issue.id : '(no id)';
  const findings = [];
  for (const field of WORDING_FIELDS) {
    const text = issue?.[field];
    if (typeof text !== 'string' || text.trim() === '') {
      findings.push({ issue: id, field, rule: 'empty', match: '' });
      continue;
    }
    if (issue.category !== 'security') continue;
    const hits = [];
    for (const [rule, re] of SPECIFICS) {
      const m = text.match(re);
      if (m) hits.push({ rule, match: m[0].trim() });
    }
    // paths and file names named by this issue's own evidence, however they are written in prose
    for (const ev of list(issue.evidence)) {
      const p = isObj(ev) && typeof ev.path === 'string' ? ev.path : '';
      if (!p) continue;
      for (const needle of new Set([p, basename(p)])) {
        if (needle && new RegExp(`(?<![\\w.-])${escapeRe(needle)}(?![\\w-])`).test(text) && !hits.some((h) => h.rule === 'path')) {
          hits.push({ rule: 'path', match: needle });
        }
      }
    }
    for (const h of hits) findings.push({ issue: id, field, rule: h.rule, match: h.match });
  }
  return findings;
}

function lintCmd(o) {
  const file = o.positional[1];
  if (!file) throw new UsageError('lint needs <issues.json>');
  const findings = issuesOf(readJsonFile(file, 'issues file'), 'issues file').flatMap(lintIssue);
  if (o.json) process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`);
  else if (findings.length === 0) process.stdout.write('lint: ok\n');
  else process.stdout.write(`${findings.map((f) => `${f.issue} ${f.field} ${f.rule}${f.match ? `: ${f.match}` : ''}`).join('\n')}\n`);
  return findings.length === 0 ? 0 : 1;
}

/** @returns {Promise<number>} the exit code */
export async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
    if (o.help) { console.log(USAGE); return 0; }
    switch (o.positional[0]) {
      case 'import-audit': return importCmd(o);
      case 'merge': return mergeCmd(o);
      case 'lint': return lintCmd(o);
      case 'path':
        process.stdout.write(`${outputDir(o.flags.project ?? process.cwd())}\n`);
        return 0;
      default: throw new UsageError(o.positional[0] ? `unknown subcommand ${o.positional[0]}` : 'no subcommand');
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`issues.mjs: ${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof InvalidError) {
      console.error(`issues.mjs: the result is not a valid overlay for the model; nothing written\n${e.message}`);
      return 1;
    }
    throw e;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exit(code); }, (e) => {
    console.error(`issues.mjs: ${e?.message ?? e}`);
    process.exit(2);
  });
}
