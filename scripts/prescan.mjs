#!/usr/bin/env node
// prescan.mjs - the 0-token first step of /archmap:build: inventory, stacks, areas, extracts.
//
//   node scripts/prescan.mjs <repoDir> [--scope <path>] [--out <file>]
//
// Prints (or writes to --out) JSON:
//   { schemaVersion, repo, commit, stacks[], areas[{id,title,globs[],files,stacks[]}],
//     sources[{kind,path,status,reason?}], extracts{<stackId>: fragment} }
// Files come from `git ls-files -co --exclude-standard`; DB files are only listed, never opened.
// Stack extractors are plug-ins in scripts/lib/prescan/stacks/*.mjs (default export: one extractor
// or an array), each { id, detect(inventory) -> bool, extract(files, read) -> fragment }.
// The code it scans is never executed. Output is sorted and carries no timestamps, so two runs
// over the same tree are byte-identical. Exit 0 ok, 2 usage or unreadable repo.
// Node >= 18, ESM, zero npm dependencies.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInventory, byCodeUnit } from './lib/prescan/inventory.mjs';
import { detectStacks, genericRecipe, workspaceContainers } from './lib/prescan/generic.mjs';
import { partition } from './lib/prescan/partition.mjs';

export const SCHEMA_VERSION = 1;
const STACKS_DIR = fileURLToPath(new URL('./lib/prescan/stacks/', import.meta.url));

/** Load the plug-in extractors from scripts/lib/prescan/stacks (none yet is fine). */
export async function loadExtractors(dir = STACKS_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort(byCodeUnit)) {
    const mod = await import(pathToFileURL(resolve(dir, f)).href);
    out.push(...[].concat(mod.default ?? []));
  }
  return out;
}

const normaliseScope = (scope) => {
  const s = String(scope ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (s === '.' ) return '';
  if (s.startsWith('/') || s.split('/').includes('..')) throw new Error(`--scope must be a path inside the repo: ${scope}`);
  return s;
};

/**
 * Run the pre-scan over `repoDir`. `extractors` replaces the stacks/ plug-in directory (tests).
 * Throws on a missing directory or a directory git cannot list.
 */
export async function prescan(repoDir, { scope = '', extractors } = {}) {
  const root = resolve(repoDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`not a directory: ${repoDir}`);
  const sc = normaliseScope(scope);
  let inv;
  try {
    inv = buildInventory(root, { scope: sc });
  } catch (e) {
    throw new Error(`cannot list files with git in ${repoDir}: ${String(e.message).split('\n')[0]}`);
  }
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* no commits yet */
  }

  const plugins = (extractors ?? (await loadExtractors())).slice().sort((a, b) => byCodeUnit(a.id, b.id));
  const active = plugins.filter((p) => p.detect(inv));
  const stacks = [...new Set([...detectStacks(inv.files, inv.read), ...active.map((p) => p.id)])].sort(byCodeUnit);

  // Partition relative to the scope directory, then put the scope prefix back on the globs.
  const cut = sc ? sc.length + 1 : 0;
  const rel = (p) => p.slice(cut);
  const relFiles = inv.files.map(rel);
  const relRead = (p) => inv.read(sc ? `${sc}/${p}` : p);
  const pre = sc ? `${sc}/` : '';
  const areas = partition(relFiles, { containers: workspaceContainers(relFiles, relRead) }).map((a) => ({
    id: a.id,
    title: a.title,
    globs: a.globs.map((g) => pre + g),
    files: a.paths.length,
    stacks: detectStacks(a.paths, relRead),
  }));

  const extracts = { generic: genericRecipe(inv.files, inv.read) };
  for (const p of active) {
    try {
      extracts[p.id] = await p.extract(inv.files, inv.read);
    } catch (e) {
      extracts[p.id] = { error: String(e?.message ?? e) };
    }
  }
  const sorted = Object.fromEntries(Object.keys(extracts).sort(byCodeUnit).map((k) => [k, extracts[k]]));

  return {
    schemaVersion: SCHEMA_VERSION,
    repo: basename(root),
    commit,
    stacks,
    areas,
    sources: inv.sources,
    extracts: sorted,
  };
}

function parseArgs(argv) {
  const opts = { repo: null, scope: '', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope' || a === '--out') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (opts.repo === null) opts.repo = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.repo === null) throw new Error('missing <repoDir>');
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`prescan: ${e.message}\nusage: node scripts/prescan.mjs <repoDir> [--scope <path>] [--out <file>]\n`);
    return 2;
  }
  try {
    const text = JSON.stringify(await prescan(opts.repo, { scope: opts.scope }), null, 2) + '\n';
    if (opts.out) writeFileSync(opts.out, text);
    else process.stdout.write(text);
    return 0;
  } catch (e) {
    process.stderr.write(`prescan: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
