#!/usr/bin/env node
// validate.mjs - validate an archmap model (and optionally its issues overlay).
//
//   node scripts/validate.mjs <model.json> [--issues <issues.json>] [--repo <dir>] [--json]
//
// Checks: (1) JSON Schema, (2) referential integrity and duplicate ids,
// (3) with --repo, every evidence {path, lines} exists at meta.commit.
// Exit 0 valid, 1 findings, 2 usage or unreadable input.
// Node >= 18, ESM, zero npm dependencies.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSchema } from './lib/jsonschema.mjs';

const loadSchema = (name) =>
  JSON.parse(readFileSync(new URL(`../schema/archmap-${name}.schema.json`, import.meta.url), 'utf8'));

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const escapeToken = (t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1');
const LINES = /^([0-9]+)(?:-([0-9]+))?$/;

/**
 * Validate a model (and optional issues overlay) in memory.
 * @param {object} model parsed architecture.model.json
 * @param {{issues?: object, repo?: string}} [opts] repo = a git working copy to check evidence against
 * @returns {{ok: boolean, findings: {code: string, pointer: string, message: string}[], evidence: 'checked'|'skipped'}}
 */
export function validate(model, { issues, repo } = {}) {
  const findings = [];
  const add = (code, pointer, message) => findings.push({ code, pointer, message });

  // 1. schema
  for (const e of validateSchema(loadSchema('model'), model)) add('schema', e.pointer, e.message);
  if (issues !== undefined) {
    for (const e of validateSchema(loadSchema('issues'), issues)) add('schema', e.pointer, e.message);
  }

  // 2. referential integrity (best effort on schema-invalid input)
  checkIntegrity(model, issues, add);

  // 3. evidence
  const sources = [{ root: model, base: '' }];
  if (issues !== undefined) sources.push({ root: issues, base: '' });
  const refs = [];
  for (const s of sources) collectEvidence(s.root, s.base, refs, s === sources[0] ? 'model' : 'issues');
  for (const r of refs) checkLinesShape(r, add);
  let evidence = 'skipped';
  if (repo !== undefined) {
    evidence = 'checked';
    checkEvidenceAtCommit(model, refs, repo, add);
  }

  return { ok: findings.length === 0, findings, evidence };
}

// ---------------------------------------------------------------------------
// referential integrity

function checkIntegrity(model, issues, add) {
  if (!isObj(model)) return;
  const ids = (arr) => new Set(list(arr).filter(isObj).map((x) => x.id).filter((x) => typeof x === 'string'));

  const dupes = (arr, base) => {
    const seen = new Set();
    list(arr).forEach((x, i) => {
      if (!isObj(x) || typeof x.id !== 'string') return;
      if (seen.has(x.id)) add('duplicate-id', `${base}/${i}/id`, `duplicate id "${x.id}"`);
      seen.add(x.id);
    });
  };
  const ref = (set, value, pointer, what) => {
    if (typeof value === 'string' && !set.has(value)) add('dangling-ref', pointer, `${what} "${value}" does not exist`);
  };

  const zones = ids(model.zones);
  const nodes = ids(model.nodes);
  const edges = ids(model.edges);
  const entities = ids(model.entities);
  const fieldsOf = new Map();
  for (const e of list(model.entities).filter(isObj)) {
    fieldsOf.set(e.id, new Set(list(e.fields).filter(isObj).map((f) => f.name)));
  }
  const fieldRef = (entity, field, pointer) => {
    if (typeof entity !== 'string' || typeof field !== 'string') return;
    if (!entities.has(entity)) return add('dangling-ref', `${pointer}/entity`, `entity "${entity}" does not exist`);
    if (!fieldsOf.get(entity)?.has(field)) {
      add('dangling-ref', `${pointer}/field`, `entity "${entity}" has no field "${field}"`);
    }
  };

  for (const k of ['zones', 'nodes', 'edges', 'entities', 'sequences', 'views']) dupes(model[k], `/${k}`);

  list(model.zones).forEach((z, i) => {
    if (isObj(z) && z.parent !== undefined) ref(zones, z.parent, `/zones/${i}/parent`, 'zone');
  });
  list(model.nodes).forEach((n, i) => isObj(n) && ref(zones, n.zone, `/nodes/${i}/zone`, 'zone'));
  list(model.edges).forEach((e, i) => {
    if (!isObj(e)) return;
    ref(nodes, e.from, `/edges/${i}/from`, 'node');
    ref(nodes, e.to, `/edges/${i}/to`, 'node');
  });
  list(model.entities).forEach((e, i) => {
    if (!isObj(e)) return;
    ref(nodes, e.store, `/entities/${i}/store`, 'node');
    const seen = new Set();
    list(e.fields).forEach((f, j) => {
      if (!isObj(f)) return;
      if (typeof f.name === 'string') {
        if (seen.has(f.name)) add('duplicate-id', `/entities/${i}/fields/${j}/name`, `duplicate field "${f.name}"`);
        seen.add(f.name);
      }
      if (isObj(f.fk)) fieldRef(f.fk.entity, f.fk.field, `/entities/${i}/fields/${j}/fk`);
    });
  });
  list(model.relations).forEach((r, i) => {
    if (!isObj(r)) return;
    for (const side of ['from', 'to']) {
      if (isObj(r[side])) fieldRef(r[side].entity, r[side].field, `/relations/${i}/${side}`);
    }
  });
  list(model.access).forEach((a, i) => {
    if (!isObj(a)) return;
    ref(nodes, a.node, `/access/${i}/node`, 'node');
    ref(entities, a.entity, `/access/${i}/entity`, 'entity');
  });

  const issueIds = issues === undefined ? null : ids(isObj(issues) ? issues.issues : []);
  const stepCounts = new Map();
  list(model.sequences).forEach((s, i) => {
    if (!isObj(s)) return;
    stepCounts.set(s.id, list(s.steps).length);
    dupes(s.participants, `/sequences/${i}/participants`);
    const parts = ids(s.participants);
    list(s.participants).forEach((p, j) => {
      if (isObj(p) && p.node !== undefined) ref(nodes, p.node, `/sequences/${i}/participants/${j}/node`, 'node');
      if (isObj(p) && p.zone !== undefined) ref(zones, p.zone, `/sequences/${i}/participants/${j}/zone`, 'zone');
    });
    list(s.steps).forEach((st, j) => {
      if (!isObj(st)) return;
      const base = `/sequences/${i}/steps/${j}`;
      list(st.m).forEach((id, k) => ref(parts, id, `${base}/m/${k}`, 'participant'));
      list(st.note).forEach((id, k) => ref(parts, id, `${base}/note/${k}`, 'participant'));
      if (issueIds && st.i !== undefined) ref(issueIds, st.i, `${base}/i`, 'issue');
    });
  });

  list(model.views).forEach((v, i) => {
    if (!isObj(v)) return;
    list(v.nodes).forEach((id, j) => ref(nodes, id, `/views/${i}/nodes/${j}`, 'node'));
    list(v.zones).forEach((id, j) => ref(zones, id, `/views/${i}/zones/${j}`, 'zone'));
  });

  if (isObj(issues)) {
    dupes(issues.issues, '/issues');
    list(issues.issues).forEach((is, i) => {
      if (!isObj(is) || !isObj(is.anchor)) return;
      const a = is.anchor;
      const p = `/issues/${i}/anchor`;
      if (a.node !== undefined) ref(nodes, a.node, p, 'node');
      else if (a.edge !== undefined) ref(edges, a.edge, p, 'edge');
      else if (a.entity !== undefined) ref(entities, a.entity, p, 'entity');
      else if (typeof a.step === 'string') {
        const cut = a.step.lastIndexOf(':');
        const seq = a.step.slice(0, cut);
        const idx = a.step.slice(cut + 1);
        const ok = cut > 0 && /^[0-9]+$/.test(idx) && stepCounts.has(seq) && Number(idx) < stepCounts.get(seq);
        if (!ok) add('dangling-ref', p, `step "${a.step}" is not "<sequenceId>:<stepIndex>" of an existing step`);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// evidence

// Every {path, lines} object found under an "evidence" array, with its pointer.
function collectEvidence(node, pointer, out, owner) {
  if (Array.isArray(node)) {
    node.forEach((x, i) => collectEvidence(x, `${pointer}/${i}`, out, owner));
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      const p = `${pointer}/${escapeToken(k)}`;
      if (k === 'evidence' && Array.isArray(v)) {
        v.forEach((e, i) => {
          if (isObj(e) && typeof e.path === 'string' && typeof e.lines === 'string') {
            out.push({ pointer: `${p}/${i}`, path: e.path, lines: e.lines, owner });
          }
        });
      } else collectEvidence(v, p, out, owner);
    }
  }
}

// The schema pattern only proves "digits[-digits]"; ranges must also be 1-based and ordered.
function checkLinesShape(r, add) {
  const m = LINES.exec(r.lines);
  if (!m) return; // already a schema finding
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1 || end < start) {
    add('evidence-lines-malformed', `${r.pointer}/lines`, `lines "${r.lines}" must be 1-based with start <= end`);
  }
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

/** Throws when `repo` is not a git working copy or git is unavailable. */
export function assertGitRepo(repo) {
  try {
    git(repo, ['rev-parse', '--git-dir']);
  } catch {
    throw new Error(`not a git repository (or git is unavailable): ${repo}`);
  }
}

function checkEvidenceAtCommit(model, refs, repo, add) {
  assertGitRepo(repo);
  const commit = isObj(model?.meta) && typeof model.meta.commit === 'string' ? model.meta.commit : '';
  let known = false;
  if (commit && !commit.startsWith('-')) {
    try {
      git(repo, ['cat-file', '-e', `${commit}^{commit}`]);
      known = true;
    } catch { /* reported below */ }
  }
  if (!known) {
    add('commit-missing', '/meta/commit', `commit "${commit}" does not exist in ${repo}; evidence not checked`);
    return;
  }
  const fileLines = new Map(); // path -> line count, or null when absent at the commit
  const countLines = (path) => {
    if (fileLines.has(path)) return fileLines.get(path);
    let n = null;
    try {
      git(repo, ['cat-file', '-e', `${commit}:${path}`]);
      const text = git(repo, ['cat-file', 'blob', `${commit}:${path}`]); // fails for a directory
      n = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch { /* absent */ }
    fileLines.set(path, n);
    return n;
  };
  for (const r of refs) {
    const total = countLines(r.path);
    if (total === null) {
      add('evidence-path-missing', `${r.pointer}/path`, `"${r.path}" is not a file at ${commit.slice(0, 12)}`);
      continue;
    }
    const m = LINES.exec(r.lines);
    if (!m) continue;
    const end = m[2] === undefined ? Number(m[1]) : Number(m[2]);
    if (Number(m[1]) >= 1 && end >= Number(m[1]) && end > total) {
      add('evidence-lines-out-of-range', `${r.pointer}/lines`, `lines ${r.lines} but "${r.path}" has ${total} lines at ${commit.slice(0, 12)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = 'usage: node scripts/validate.mjs <model.json> [--issues <issues.json>] [--repo <dir>] [--json]';

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { model: undefined, issues: undefined, repo: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--issues' || a === '--repo') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (o.model === undefined) o.model = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!o.help && o.model === undefined) throw new UsageError('missing <model.json>');
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
  let opts;
  let result;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      console.log(USAGE);
      return 0;
    }
    const model = readJson(opts.model, 'model');
    const issues = opts.issues === undefined ? undefined : readJson(opts.issues, 'issues file');
    if (opts.repo !== undefined) {
      let isDir = false;
      try { isDir = statSync(opts.repo).isDirectory(); } catch { /* not a dir */ }
      if (!isDir) throw new UsageError(`--repo ${opts.repo} is not a directory`);
      try { assertGitRepo(opts.repo); } catch (e) { throw new UsageError(e.message); }
    }
    result = validate(model, { issues, repo: opts.repo });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`validate: ${e.message}\n${USAGE}`);
    return 2;
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const f of result.findings) console.log(`${f.code}  ${f.pointer || '/'}  ${f.message}`);
    console.log(
      result.evidence === 'skipped'
        ? 'evidence: skipped (no --repo given; evidence paths and line ranges were NOT checked)'
        : 'evidence: checked at meta.commit',
    );
    console.log(result.ok ? 'OK: no findings' : `FAIL: ${result.findings.length} finding(s)`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
