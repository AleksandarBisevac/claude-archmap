#!/usr/bin/env node
// diffmap.mjs - maps the files changed since the model was built onto the model (docs/design.md §6 update step 1).
//
//   node scripts/diffmap.mjs <model.json> [--repo <dir>] [--since <sha>] [--json]
//
// Changes are `git diff --name-status` from meta.commit (or --since) to HEAD, renames split into a delete plus an
// add, plus untracked files that are not ignored. Uncommitted edits to tracked files are not seen. Each file is
// mapped to areas (meta.coverage globs), nodes (their `paths` globs, or an evidence path equal to the file) and
// entities (evidence paths, fields included). Dependents are the nodes one edge away from an affected node (either
// direction) that are not affected themselves; sequences are listed when a participant or a step reference is an
// affected node. `uncovered` lists new files that no area owns.
//
// Report: {base, head, behind, files, areas, nodes, dependents, entities, sequences, uncovered}, all sorted.
// Exit 0 ok (also when nothing is affected), 2 usage error, unreadable model, unknown base commit or not a git
// repo. git runs through execFileSync, never a shell. Node >= 18, ESM, zero dependencies.

import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { matchAny } from './lib/glob.mjs';

const USAGE = 'usage: node scripts/diffmap.mjs <model.json> [--repo <dir>] [--since <sha>] [--json]';

class UsageError extends Error {}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (set) => [...set].sort(byCodeUnit);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Pure mapping of changed files onto a model.
 * @param {object} model a parsed architecture model (unknown keys tolerated)
 * @param {{base?: string|null, head?: string|null, behind?: number, files?: {status: string, path: string}[]}} changes
 *   status "A" marks a new file (an untracked file is "A" too); "D", "M" and the rest count as existing
 */
export function diffmap(model, changes = {}) {
  const files = arr(changes.files).filter((f) => f && typeof f.path === 'string');
  const paths = new Set(files.map((f) => f.path));
  const added = new Set(files.filter((f) => f.status === 'A').map((f) => f.path));

  const coverage = model?.meta?.coverage && typeof model.meta.coverage === 'object' ? model.meta.coverage : {};
  const areas = new Set();
  const uncovered = new Set();
  for (const p of paths) {
    let owned = false;
    for (const [area, globs] of Object.entries(coverage)) {
      if (matchAny(arr(globs), p)) { areas.add(area); owned = true; }
    }
    if (!owned && added.has(p)) uncovered.add(p);
  }

  const evidenceHit = (list) => arr(list).some((e) => e && paths.has(e.path));
  const nodes = new Set();
  for (const n of arr(model?.nodes)) {
    if (!n || typeof n.id !== 'string') continue;
    if ([...paths].some((p) => matchAny(arr(n.paths), p)) || evidenceHit(n.evidence)) nodes.add(n.id);
  }

  const entities = new Set();
  for (const e of arr(model?.entities)) {
    if (!e || typeof e.id !== 'string') continue;
    if (evidenceHit(e.evidence) || arr(e.fields).some((f) => f && evidenceHit(f.evidence))) entities.add(e.id);
  }

  const dependents = new Set();
  for (const e of arr(model?.edges)) {
    if (!e) continue;
    if (nodes.has(e.from) && !nodes.has(e.to) && typeof e.to === 'string') dependents.add(e.to);
    if (nodes.has(e.to) && !nodes.has(e.from) && typeof e.from === 'string') dependents.add(e.from);
  }

  const sequences = new Set();
  for (const s of arr(model?.sequences)) {
    if (!s || typeof s.id !== 'string') continue;
    const touched = arr(s.participants).some((p) => p && nodes.has(p.node ?? p.id));
    const stepRefs = arr(s.steps).flatMap((st) => (st ? [...arr(st.m), ...arr(st.r), ...arr(st.note)] : []));
    if (touched || stepRefs.some((r) => nodes.has(r))) sequences.add(s.id);
  }

  return {
    base: changes.base ?? null,
    head: changes.head ?? null,
    behind: changes.behind ?? 0,
    files: sorted(paths),
    areas: sorted(areas),
    nodes: sorted(nodes),
    dependents: sorted(dependents),
    entities: sorted(entities),
    sequences: sorted(sequences),
    uncovered: sorted(uncovered),
  };
}

function git(repo, args) {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    if (e.code === 'ENOENT') throw new UsageError('git is not installed or not on PATH');
    const msg = String(e.stderr || e.message).trim().split('\n')[0];
    throw new UsageError(`git ${args[0]} failed in ${repo}: ${msg}`);
  }
}

/** Read the changes between `base` and HEAD (plus untracked files) in `repo`: the `changes` argument of diffmap(). */
export function readGitChanges(repo, base) {
  try {
    git(repo, ['rev-parse', '--git-dir']);
  } catch (e) {
    if (e instanceof UsageError && /not installed/.test(e.message)) throw e;
    throw new UsageError(`${repo} is not a git repository`);
  }
  if (typeof base !== 'string' || base === '' || base.startsWith('-')) throw new UsageError(`invalid base commit "${base}"`);
  let baseSha;
  try {
    baseSha = git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).trim();
  } catch {
    throw new UsageError(`unknown base commit ${base}`);
  }
  let head;
  try {
    head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
  } catch {
    throw new UsageError(`${repo} has no commits`);
  }
  const behind = Number(git(repo, ['rev-list', '--count', `${baseSha}..${head}`]).trim());
  const files = [];
  const tok = git(repo, ['diff', '--name-status', '-z', '--no-renames', '--relative', baseSha, head]).split('\0');
  for (let i = 0; i + 1 < tok.length; i += 2) files.push({ status: tok[i][0], path: tok[i + 1] });
  for (const p of git(repo, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0')) if (p) files.push({ status: 'A', path: p });
  return { base: baseSha, head, behind, files };
}

function parseArgs(argv) {
  const o = { model: undefined, repo: process.cwd(), since: undefined, json: false, help: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--repo' || a === '--since') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else pos.push(a);
  }
  if (o.help) return o;
  if (pos.length === 0) throw new UsageError('missing <model.json>');
  if (pos.length > 1) throw new UsageError(`unexpected argument ${pos[1]}`);
  o.model = pos[0];
  return o;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const short = (sha) => (sha ? sha.slice(0, 7) : '?');

export function renderSummary(r) {
  const head = `diffmap: ${short(r.base)}..${short(r.head)}, ${plural(r.behind, 'commit')} behind, ${plural(r.files.length, 'changed file')}`;
  const touched = r.areas.length + r.nodes.length + r.entities.length + r.sequences.length + r.uncovered.length;
  if (!touched) return `${head}\nnothing affected\n`;
  const list = (v) => (v.length > 8 ? `${v.slice(0, 8).join(', ')}, +${v.length - 8} more` : v.join(', '));
  const lines = [head];
  for (const k of ['areas', 'nodes', 'dependents', 'entities', 'sequences', 'uncovered']) {
    if (r[k].length) lines.push(`${k} (${r[k].length}): ${list(r[k])}`);
  }
  return lines.join('\n') + '\n';
}

function main(argv) {
  try {
    const o = parseArgs(argv);
    if (o.help) {
      console.log(USAGE);
      return 0;
    }
    let model;
    try {
      model = JSON.parse(readFileSync(o.model, 'utf8'));
    } catch (e) {
      throw new UsageError(`cannot read model ${o.model}: ${e.code ?? e.message}`);
    }
    const base = o.since ?? model?.meta?.commit;
    if (!base) throw new UsageError('the model has no meta.commit; pass --since <sha>');
    const result = diffmap(model, readGitChanges(o.repo, base));
    process.stdout.write(o.json ? JSON.stringify(result, null, 2) + '\n' : renderSummary(result));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`diffmap.mjs: ${e.message}`);
      return 2;
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
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
