// generic.mjs - stack detection and the stack-independent "generic recipe" for prescan.
//
// detectStacks(files, read) names the v1 stacks present in a file list; genericRecipe() lists the
// hints any stack gets: entry points, top-level dirs, Dockerfiles/compose files, CI files.
// Pure functions of (files, read): sorted output, no timestamps. Node >= 18, zero dependencies.

import { byCodeUnit } from './inventory.mjs';

export const STACK_IDS = ['node-backend', 'python', 'ts-frontend'];

const FRONTEND_DEPS = new Set([
  'react', 'react-dom', 'vue', 'svelte', '@angular/core', 'solid-js', 'preact', 'next', 'nuxt', 'vite',
  '@sveltejs/kit', 'astro', 'lit', '@remix-run/react',
]);
const BACKEND_DEPS = new Set([
  'express', 'fastify', 'koa', '@nestjs/core', 'hono', '@hapi/hapi', 'restify', 'prisma', '@prisma/client',
  'typeorm', 'sequelize', 'drizzle-orm', 'knex', 'mongoose',
]);
const FRONTEND_EXT = new Set(['tsx', 'jsx', 'vue', 'svelte']);
const PY_MANIFEST = /^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements[^/]*\.txt)$/;

const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const extOf = (p) => {
  const b = baseOf(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
};

/** Parse a package.json; null when unreadable or not an object. */
export function readPackageJson(read, path) {
  try {
    const v = JSON.parse(read(path));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const depNames = (pkg) =>
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });

/** Sorted stack ids present in `files` (repo-relative paths); manifests are read through `read`. */
export function detectStacks(files, read) {
  const found = new Set();
  for (const f of files) {
    const base = baseOf(f);
    const e = extOf(f);
    if (e === 'py' || PY_MANIFEST.test(base)) found.add('python');
    if (FRONTEND_EXT.has(e)) found.add('ts-frontend');
    if (base === 'package.json') {
      const pkg = readPackageJson(read, f);
      if (!pkg) continue;
      const deps = depNames(pkg);
      if (deps.some((d) => FRONTEND_DEPS.has(d))) found.add('ts-frontend');
      if (deps.some((d) => BACKEND_DEPS.has(d))) found.add('node-backend');
    }
  }
  return [...found].sort(byCodeUnit);
}

/**
 * Workspace container dirs ("packages", "apps/js", ...) declared by the root package.json
 * `workspaces` or pnpm-workspace.yaml. Only the part before the first glob segment is kept.
 */
export function workspaceContainers(files, read) {
  const globs = [];
  if (files.includes('package.json')) {
    const ws = readPackageJson(read, 'package.json')?.workspaces;
    const list = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
    for (const g of list) if (typeof g === 'string') globs.push(g);
  }
  if (files.includes('pnpm-workspace.yaml')) {
    for (const m of (read('pnpm-workspace.yaml') ?? '').matchAll(/^\s*-\s*['"]?([^'"#\s]+)['"]?/gm)) globs.push(m[1]);
  }
  const out = new Set();
  for (const g of globs) {
    const parts = g.replace(/^\.\//, '').split('/');
    const i = parts.findIndex((s) => /[*?{[]/.test(s));
    const prefix = (i === -1 ? parts.slice(0, -1) : parts.slice(0, i)).join('/');
    if (prefix) out.add(prefix);
  }
  return [...out].sort(byCodeUnit);
}

const ENTRY_BASENAMES = new Set([
  'main.py', 'app.py', 'manage.py', 'wsgi.py', 'asgi.py', '__main__.py', 'server.py', 'run.py',
  'index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.tsx', 'index.jsx', 'main.js', 'main.ts',
  'main.tsx', 'main.jsx', 'server.js', 'server.ts', 'app.js', 'app.ts', 'cli.js', 'cli.mjs', 'cli.ts',
  'main.go', 'main.rs', 'index.html',
]);
const TEST_SEGMENT = /^(tests?|__tests__|spec|specs|e2e|fixtures?|examples?|docs?)$/;
const MAX_ENTRY_DEPTH = 4; // directories above the file

const isDockerfile = (b) => /^Dockerfile(\..+)?$/.test(b) || /\.Dockerfile$/.test(b);
const isCompose = (b) => /^(docker-)?compose([.-][^/]+)?\.ya?ml$/.test(b);
const isCi = (p) =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) ||
  /^\.circleci\/config\.yml$/.test(p) ||
  /(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml|\.travis\.yml|bitbucket-pipelines\.yml)$/.test(p);
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|Pipfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle)$/;

/** Hints that apply to any stack, from the file list alone (plus package.json main/bin). */
export function genericRecipe(files, read) {
  const entry = new Set();
  for (const f of files) {
    const segs = f.split('/');
    if (segs.length - 1 > MAX_ENTRY_DEPTH || segs.slice(0, -1).some((s) => TEST_SEGMENT.test(s))) continue;
    if (ENTRY_BASENAMES.has(segs[segs.length - 1])) entry.add(f);
  }
  for (const f of files) {
    if (baseOf(f) !== 'package.json') continue;
    const pkg = readPackageJson(read, f);
    if (!pkg) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
    const targets = [pkg.main, ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {}))];
    for (const t of targets) {
      if (typeof t !== 'string') continue;
      const p = (dir + t.replace(/^\.\//, '')).replace(/\/{2,}/g, '/');
      if (files.includes(p)) entry.add(p);
    }
  }
  return {
    entryPoints: [...entry].sort(byCodeUnit),
    topLevelDirs: [...new Set(files.filter((f) => f.includes('/')).map((f) => f.slice(0, f.indexOf('/'))))].sort(byCodeUnit),
    containers: files.filter((f) => isDockerfile(baseOf(f)) || isCompose(baseOf(f))).sort(byCodeUnit),
    ci: files.filter(isCi).sort(byCodeUnit),
    manifests: files.filter((f) => MANIFEST.test(f)).sort(byCodeUnit),
  };
}
