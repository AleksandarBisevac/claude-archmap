// inventory.mjs - the file inventory behind prescan: what is in the repo, minus what is noise.
//
// Files come from `git ls-files -co --exclude-standard` (tracked + untracked-not-ignored), so
// .gitignore is honoured. Vendored/generated directories, binaries, lockfiles, minified bundles
// and files over a size cap are dropped; files under a fixtures, __fixtures__ or testdata directory, or an examples or
// samples directory below a tests one, are listed as skipped with a reason, so test data drives neither stack
// detection nor the areas. Database files are only LISTED (as `sources`); they are
// never opened here, so no rows can ever be read (build's finish step reads a schema, never rows). Node >= 18, zero dependencies.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { matchAny } from '../glob.mjs';

export const MAX_FILE_BYTES = 512 * 1024;

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target', 'coverage',
  '.venv', 'venv', 'env', '__pycache__', 'site-packages', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.gradle',
  '.idea', '.vscode', '.terraform',
]);

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'psd', 'svgz', 'pdf', 'zip', 'gz', 'tgz',
  'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war', 'whl', 'egg', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg', 'flac', 'exe', 'dll', 'so', 'dylib', 'a', 'o',
  'class', 'pyc', 'pyo', 'wasm', 'bin', 'dat', 'pkl', 'parquet', 'npy', 'onnx', 'pt', 'ckpt',
]);

const DB_KIND = new Map([
  ['sqlite', 'sqlite'], ['sqlite3', 'sqlite'], ['db', 'sqlite'], ['db3', 'sqlite'],
  ['duckdb', 'duckdb'], ['ddb', 'duckdb'],
]);

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'poetry.lock',
  'Pipfile.lock', 'uv.lock', 'Cargo.lock', 'composer.lock', 'Gemfile.lock', 'go.sum',
]);

const ext = (p) => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
};

/** 'sqlite' or 'duckdb' for a path whose extension names a file database, else null. */
export const dbKindOf = (p) => DB_KIND.get(ext(p)) ?? null;

/** Code-unit order: independent of locale, so output is identical on every machine. */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The vendored/generated directory a repo-relative path sits in, or null. */
export const skippedDirOf = (p) => p.split('/').slice(0, -1).find((s) => SKIP_DIRS.has(s)) ?? null;

// Test data: a fixtures, __fixtures__ or testdata directory at any depth holds data or a fixture repo, never the product.
// examples and samples are product names as often as test ones (a docs examples tree, a samples feature), so they are
// test data only below a tests, test, __tests__ or fixtures directory; anywhere else they are kept.
export const TEST_DATA_DIR = /^(fixtures?|__fixtures__|testdata)$/;
export const TEST_ONLY_DATA_DIR = /^(examples?|samples?)$/;
export const TESTS_DIR = /^(tests?|__tests__|fixtures?)$/;

/**
 * The test data directory a path sits in, judged on the path relative to the scan root (the root, or `scope` under
 * it): a scan whose root itself lies under a fixtures directory is not test data to itself. Returns
 * { dir, name, under } - `dir` the repo-relative path of the outermost test data directory, `name` its own segment,
 * `under` the tests directory an examples or samples one sits below (null for the others) - or null when there is none.
 */
export const testDataOf = (p, scope = '') => {
  const s = String(scope ?? '').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const cut = s && p.startsWith(`${s}/`) ? s.length + 1 : 0;
  const segs = p.slice(cut).split('/').slice(0, -1);
  let under = null;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const hit = TEST_DATA_DIR.test(seg) ? { under: null } : under && TEST_ONLY_DATA_DIR.test(seg) ? { under } : null;
    if (hit) return { dir: p.slice(0, cut) + segs.slice(0, i + 1).join('/'), name: seg, under: hit.under };
    if (!under && TESTS_DIR.test(seg)) under = seg;
  }
  return null;
};
/** The segment name of the test data directory a path sits in, or null (see testDataOf). */
export const testDataDirOf = (p, scope = '') => testDataOf(p, scope)?.name ?? null;
export const testDataReason = ({ name, under }) =>
  `inside test data directory ${name}${under ? ` below ${under}` : ''}: fixtures, __fixtures__ and testdata, and examples or samples below a tests directory, are not the product`;

function listGit(root, scope) {
  const args = ['ls-files', '-co', '--exclude-standard', '-z'];
  if (scope) args.push('--', scope);
  const buf = execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return buf.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Build the inventory of `root`.
 * Returns { root, files, sources, skipped, read } - `files` sorted repo-relative paths that survive every
 * filter, `sources` the DB files found (sorted), `skipped` the text files under a test data directory as
 * {path, reason, dir} (sorted; `dir` the test data directory, see testDataOf; they reach no stack, no area and no extract), `read(rel)` a utf8 reader (null when unreadable).
 */
export function buildInventory(root, { scope = '', maxBytes = MAX_FILE_BYTES } = {}) {
  const abs = resolve(root);
  const files = [];
  const sources = [];
  const skipped = [];
  for (const rel of [...new Set(listGit(abs, scope))].sort(byCodeUnit)) {
    let st;
    try {
      st = lstatSync(resolve(abs, rel));
    } catch {
      continue; // listed as tracked but deleted in the work tree
    }
    if (!st.isFile()) continue; // symlinks, submodule gitlinks
    const kind = DB_KIND.get(ext(rel));
    const skipDir = skippedDirOf(rel);
    const dataDir = skipDir ? null : testDataOf(rel, scope);
    if (kind) {
      sources.push(
        skipDir
          ? { kind, path: rel, status: 'skipped', reason: `inside vendored or generated directory ${skipDir}` }
          : dataDir
            ? { kind, path: rel, status: 'skipped', reason: testDataReason(dataDir) }
            : { kind, path: rel, status: 'found' },
      );
      continue;
    }
    if (skipDir) continue;
    if (dataDir) {
      skipped.push({ path: rel, reason: testDataReason(dataDir), dir: dataDir.dir });
      continue;
    }
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (BINARY_EXT.has(ext(rel)) || LOCKFILES.has(base) || /\.min\.(js|css)$/.test(base) || base.endsWith('.map')) continue;
    if (st.size > maxBytes) continue;
    files.push(rel);
  }
  const read = (rel) => {
    const p = resolve(abs, rel);
    if (!p.startsWith(abs + sep)) return null;
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  return { root: abs, files, sources, skipped, read };
}

// ---------------------------------------------------------------------------------------------
// Workspace apps and middleware modules: facts of the file list, found without running anything.

const parseJson = (text) => {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** The globs a pnpm-workspace.yaml lists under `packages:` (quotes and comments dropped; a `!` prefix is kept). */
function pnpmGlobs(text) {
  const out = [];
  let inside = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    const m = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (m) out.push(m[1]);
    else if (/^\S/.test(line)) inside = false; // the next top-level key
  }
  return out;
}

/**
 * The deployable apps of a workspace: every member of the workspace (the globs of a pnpm-workspace.yaml, of the root
 * package.json `workspaces`, or, with a turbo.json that declares none, apps/* and packages/*) that sits directly under a
 * directory named `apps` and holds a package.json. Returns [{name, dir, manifest}] sorted by dir; [] when the repo
 * declares no workspace. A `!glob` leaves members out. `files` are repo-relative, `read(path)` returns text or null.
 */
export function workspaceApps(files, read) {
  const globs = [];
  if (files.includes('package.json')) {
    const ws = parseJson(read('package.json') ?? '')?.workspaces;
    for (const g of Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : []) if (typeof g === 'string') globs.push(g);
  }
  if (files.includes('pnpm-workspace.yaml')) globs.push(...pnpmGlobs(read('pnpm-workspace.yaml')));
  if (globs.length === 0 && files.includes('turbo.json')) globs.push('apps/*', 'packages/*');
  if (globs.length === 0) return [];
  const clean = (g) => g.replace(/^\.\//, '').replace(/\/+$/, '');
  const include = globs.filter((g) => !g.startsWith('!')).map(clean);
  const exclude = globs.filter((g) => g.startsWith('!')).map((g) => clean(g.slice(1)));
  const apps = [];
  for (const f of files) {
    if (!f.endsWith('/package.json')) continue;
    const dir = f.slice(0, -'/package.json'.length);
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    if (parent.slice(parent.lastIndexOf('/') + 1) !== 'apps') continue;
    if (!matchAny(include, dir) || matchAny(exclude, dir)) continue;
    const name = parseJson(read(f) ?? '')?.name;
    apps.push({ name: typeof name === 'string' && name ? name : dir.slice(dir.lastIndexOf('/') + 1), dir, manifest: f });
  }
  return apps.sort((a, b) => byCodeUnit(a.dir, b.dir));
}

const MIDDLEWARE_WORD = /^(middlewares?|guards?|interceptors?)$/;
const MIDDLEWARE_DIR = /^(middlewares|middleware|guards|interceptors)$/;
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py']);

/**
 * The middleware modules of a file list, sorted: a directory named middleware, middlewares, guards or interceptors is one
 * module (the directory), and a code file whose name says so (`middleware.ts`, `auth.middleware.ts`, `roles.guard.ts`,
 * `audit.interceptor.ts`) outside such a directory is one module (the file). Tests and type declarations are not modules.
 */
export function middlewareModules(files) {
  const out = new Set();
  for (const f of files) {
    if (!CODE_EXT.has(ext(f)) || /\.(?:spec|test)\.|\.d\.[cm]?ts$/.test(f)) continue;
    const segs = f.split('/');
    const at = segs.slice(0, -1).findIndex((s) => MIDDLEWARE_DIR.test(s));
    if (at !== -1) {
      out.add(segs.slice(0, at + 1).join('/'));
      continue;
    }
    const parts = segs[segs.length - 1].split('.').slice(0, -1);
    if (parts.some((p) => MIDDLEWARE_WORD.test(p))) out.add(f);
  }
  return [...out].sort(byCodeUnit);
}

/**
 * The middleware list of an area: the modules of the file list joined with the middleware a stack plug-in names in
 * code (`named`, {name, file}), each as `<file>:<name>`. A named middleware stands in for the bare file entry of its
 * own file (one node per middleware, not one more for the file that holds them); a directory entry stays. Sorted,
 * without repeats.
 */
export function joinMiddleware(modules, named) {
  const rows = (named ?? []).filter((m) => m && typeof m.file === 'string' && typeof m.name === 'string');
  const files = new Set(rows.map((m) => m.file));
  const out = new Set((modules ?? []).filter((m) => !files.has(m)));
  for (const m of rows) out.add(`${m.file}:${m.name}`);
  return [...out].sort(byCodeUnit);
}
