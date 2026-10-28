// inventory.mjs - the file inventory behind prescan: what is in the repo, minus what is noise.
//
// Files come from `git ls-files -co --exclude-standard` (tracked + untracked-not-ignored), so
// .gitignore is honoured. Vendored/generated directories, binaries, lockfiles, minified bundles
// and files over a size cap are dropped. Database files are only LISTED (as `sources`); they are
// never opened, so no rows can ever be read here. Node >= 18, zero dependencies.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

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

/** Code-unit order: independent of locale, so output is identical on every machine. */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The vendored/generated directory a repo-relative path sits in, or null. */
export const skippedDirOf = (p) => p.split('/').slice(0, -1).find((s) => SKIP_DIRS.has(s)) ?? null;

function listGit(root, scope) {
  const args = ['ls-files', '-co', '--exclude-standard', '-z'];
  if (scope) args.push('--', scope);
  const buf = execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return buf.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Build the inventory of `root`.
 * Returns { root, files, sources, read } - `files` sorted repo-relative paths that survive every
 * filter, `sources` the DB files found (sorted), `read(rel)` a utf8 reader (null when unreadable).
 */
export function buildInventory(root, { scope = '', maxBytes = MAX_FILE_BYTES } = {}) {
  const abs = resolve(root);
  const files = [];
  const sources = [];
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
    if (kind) {
      sources.push(
        skipDir
          ? { kind, path: rel, status: 'skipped', reason: `inside vendored or generated directory ${skipDir}` }
          : { kind, path: rel, status: 'found' },
      );
      continue;
    }
    if (skipDir) continue;
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
  return { root: abs, files, sources, read };
}
