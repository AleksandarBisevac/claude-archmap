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

// ---------------------------------------------------------------------------------------------
// P10.2: facts every explorer used to rediscover with Grep. All of it is regex over text (the scanned
// code is never run): environment variables and config keys read (names only, never values or
// defaults), SDK constructors and base URLs, and the import graph between files.

const PY_FILE = /\.py$/;
const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const NOT_RUNTIME = /(^|\/)(__tests__|tests?|specs?|e2e|fixtures?)\/|\.(?:test|spec)\.[^/]+$|\.d\.ts$/;
const ENV_EXAMPLE = /(^|\/)\.env(?:\.[\w-]+)*\.(?:example|sample|template|defaults)$|(^|\/)\.env\.(?:example|sample|template)$/;
const ident = '[A-Za-z_][\\w]*';

const PY_ENV = [
  new RegExp(`\\bos\\.environ\\s*\\[\\s*['"](${ident})['"]\\s*\\]`, 'g'),
  new RegExp(`\\bos\\.environ\\.(?:get|setdefault|pop)\\s*\\(\\s*['"](${ident})['"]`, 'g'),
  new RegExp(`\\bos\\.getenv\\s*\\(\\s*['"](${ident})['"]`, 'g'),
  new RegExp(`(?<![\\w.])(?:environ(?:\\.get)?\\s*[\\[(]|getenv\\s*\\()\\s*['"](${ident})['"]`, 'g'),
  /(?<![\w.])(?:env(?:\.\w+)?|config)\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
];
const JS_ENV = [
  new RegExp(`\\bprocess\\.env\\.(${ident})`, 'g'),
  new RegExp(`\\bprocess\\.env\\s*\\[\\s*['"](${ident})['"]\\s*\\]`, 'g'),
  new RegExp(`\\bimport\\.meta\\.env\\.(${ident})`, 'g'),
  new RegExp(`\\bDeno\\.env\\.get\\s*\\(\\s*['"](${ident})['"]`, 'g'),
  /\b(?:configService|config|this\.config|this\.configService)\.get(?:OrThrow)?\s*(?:<[^>()]*>)?\s*\(\s*['"]([\w.:-]+)['"]/g,
];
const JS_ENV_DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g;
const SKIP_ENV = new Set(['NODE_ENV']);

/** Non-comment lines of the files `accept` lets through: [{path, n, text}]. */
function* codeLines(files, read, accept, comment) {
  for (const path of files) {
    if (!accept(path)) continue;
    const src = read(path);
    if (typeof src !== 'string') continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trimStart();
      if (t.startsWith(comment) || (comment === '//' && (t.startsWith('*') || t.startsWith('/*')))) continue;
      yield { path, n: i + 1, text: lines[i] };
    }
  }
}

const ev = (path, n) => [{ path, lines: String(n) }];

/**
 * Environment variables and config keys read: [{name, evidence}] for python ('py') or js/ts ('js').
 * Only names: no default and no value is kept. `.env.example`-style files list their keys too.
 */
export function scanEnvKeys(files, read, lang) {
  const py = lang === 'py';
  const rules = py ? PY_ENV : JS_ENV;
  const out = [];
  const seen = new Set();
  const add = (name, path, n) => {
    const k = `${name}\0${path}\0${n}`;
    if (SKIP_ENV.has(name) || seen.has(k)) return;
    seen.add(k);
    out.push({ name, evidence: ev(path, n) });
  };
  for (const { path, n, text } of codeLines(files, read, (p) => (py ? PY_FILE : JS_FILE).test(p) && !NOT_RUNTIME.test(p), py ? '#' : '//')) {
    for (const re of rules) for (const m of text.matchAll(re)) add(m[1], path, n);
    if (!py) {
      for (const m of text.matchAll(JS_ENV_DESTRUCTURE)) {
        for (const part of m[1].split(',')) {
          const name = part.split('=')[0].split(':')[0].trim();
          if (new RegExp(`^${ident}$`).test(name)) add(name, path, n);
        }
      }
    }
  }
  for (const path of files.filter((p) => ENV_EXAMPLE.test(p))) {
    (read(path) ?? '').split('\n').forEach((line, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/.exec(line);
      if (m) add(m[1], path, i + 1);
    });
  }
  return out.sort((a, b) => byCodeUnit(a.evidence[0].path, b.evidence[0].path) || Number(a.evidence[0].lines) - Number(b.evidence[0].lines));
}

const JS_CLIENT_CLASS = /(?:Client|SDK)$|^(?:Redis|IORedis|Pool|Kafka|Sequelize|Stripe|OpenAI|Anthropic|Twilio|Resend|S3|SQS|SNS|DynamoDB|Firestore|Storage|Pusher)$/;
const PY_CLIENT = new RegExp(
  '(?<![\\w.])(boto3\\.(?:client|resource)|(?:redis\\.)?(?:Redis|StrictRedis)(?:\\.from_url)?|redis\\.from_url|' +
    '(?:httpx|aiohttp|requests)\\.(?:Async)?(?:Client|Session|ClientSession)|' +
    '(?:psycopg2|psycopg|asyncpg|pymysql|sqlite3)\\.(?:connect|create_pool)|create_(?:async_)?engine|MongoClient|Celery|' +
    'Kafka(?:Producer|Consumer)|[A-Z]\\w*Client)\\s*\\(',
  'g',
);
const URL_CONST = /(?<![\w.])([A-Za-z_][\w]*)\s*[:=]\s*(['"`])(https?:\/\/[^'"`\s]+)\2/g;
const cleanUrl = (u) => u.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '');
const envOf = (text, py) => {
  const m = py
    ? /os\.environ(?:\.get)?\s*[\[(]\s*['"](\w+)['"]|os\.getenv\s*\(\s*['"](\w+)['"]/.exec(text)
    : /process\.env\.(\w+)|process\.env\s*\[\s*['"](\w+)['"]\s*\]/.exec(text);
  const name = m && (m[1] ?? m[2]);
  return name ? `env:${name}` : null;
};

/**
 * SDK and connection constructors plus base-URL constants: [{client, kind: 'sdk'|'baseUrl', target, evidence}].
 * `target` is `env:NAME` or a credential-free URL literal, else null. A secret value is never copied.
 */
export function scanClients(files, read, lang) {
  const py = lang === 'py';
  const out = [];
  for (const { path, n, text } of codeLines(files, read, (p) => (py ? PY_FILE : JS_FILE).test(p) && !NOT_RUNTIME.test(p), py ? '#' : '//')) {
    const t = text.trimStart();
    if (/^(?:class|def|async def|function|export (?:default )?(?:class|function))\b/.test(t)) continue;
    const rules = py
      ? [...text.matchAll(PY_CLIENT)].map((m) => ({ name: m[1], at: m.index + m[0].length }))
      : [...text.matchAll(/\bnew\s+([A-Z][\w$]*)\s*\(/g)].filter((m) => JS_CLIENT_CLASS.test(m[1])).map((m) => ({ name: m[1], at: m.index + m[0].length }));
    for (const r of rules) {
      const rest = text.slice(r.at);
      let name = r.name;
      if (py && /^boto3\./.test(name)) {
        const svc = /^\s*['"]([\w-]+)['"]/.exec(rest);
        if (svc) name = `${name}(${svc[1]})`;
      }
      const lit = /['"`](https?:\/\/[^'"`\s]+)['"`]/.exec(rest);
      out.push({ client: name, kind: 'sdk', target: envOf(rest, py) ?? (lit ? cleanUrl(lit[1]) : null), evidence: ev(path, n) });
    }
    for (const m of text.matchAll(URL_CONST)) {
      if (/url|uri|host|endpoint|base/i.test(m[1])) out.push({ client: m[1], kind: 'baseUrl', target: cleanUrl(m[3]), evidence: ev(path, n) });
    }
  }
  return out.sort((a, b) => byCodeUnit(a.evidence[0].path, b.evidence[0].path) || Number(a.evidence[0].lines) - Number(b.evidence[0].lines));
}

// --- import graph -----------------------------------------------------------------------------

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (...parts) => {
  const out = [];
  for (const seg of parts.join('/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
};
const ancestors = (p) => {
  const segs = dirOf(p) === '' ? [] : dirOf(p).split('/');
  const out = [];
  for (let i = segs.length; i >= 0; i--) out.push(segs.slice(0, i).join('/'));
  return out;
};
const commonDepth = (a, b) => {
  const x = a.split('/');
  const y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
};

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json'];
function jsFileFor(set, base) {
  if (base === '') return null;
  const stripped = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  const tries = [base, ...JS_EXTS.map((e) => base + e), ...JS_EXTS.map((e) => `${base}/index${e}`)];
  if (stripped !== base) tries.push(...JS_EXTS.map((e) => stripped + e));
  return tries.find((t) => set.has(t)) ?? null;
}

function resolveJs(set, packages, from, spec) {
  if (spec.startsWith('.')) return jsFileFor(set, joinPath(dirOf(from), spec));
  if (/^[@~]\//.test(spec)) {
    const rest = spec.slice(2);
    for (const a of ancestors(from)) {
      const hit = jsFileFor(set, joinPath(a, 'src', rest)) ?? jsFileFor(set, joinPath(a, rest));
      if (hit) return hit;
    }
    return null;
  }
  const name = [...packages.keys()].filter((k) => spec === k || spec.startsWith(`${k}/`)).sort((a, b) => b.length - a.length)[0];
  if (name === undefined) return null;
  const { dir, main } = packages.get(name);
  const rest = spec.slice(name.length + 1);
  if (rest) return jsFileFor(set, joinPath(dir, rest)) ?? jsFileFor(set, joinPath(dir, 'src', rest));
  return (main && jsFileFor(set, joinPath(dir, main))) || jsFileFor(set, joinPath(dir, 'src/index')) || jsFileFor(set, joinPath(dir, 'index'));
}

function pyIndex(files) {
  const index = new Map();
  for (const f of files.filter((p) => PY_FILE.test(p))) {
    let m = f.slice(0, -3);
    if (m.endsWith('/__init__')) m = m.slice(0, -9);
    else if (m === '__init__') continue;
    const segs = m.split('/');
    for (let k = 1; k <= segs.length; k++) {
      const key = segs.slice(-k).join('.');
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ file: f, dir: dirOf(m) });
    }
  }
  return index;
}

function resolvePy(index, from, dotted) {
  const cands = index.get(dotted);
  if (!cands) return null;
  const single = !dotted.includes('.');
  const fromDir = dirOf(from);
  const usable = single ? cands.filter((c) => fromDir === c.dir || fromDir.startsWith(c.dir === '' ? '' : `${c.dir}/`) || c.dir === '') : cands;
  if (usable.length === 0) return null;
  return usable.slice().sort((a, b) => commonDepth(b.file, from) - commonDepth(a.file, from) || byCodeUnit(a.file, b.file))[0].file;
}

/** File-level import edges as sorted unique "from > to" strings; only edges between files of the repo. */
export function importEdges(files, read) {
  const set = new Set(files);
  const edges = new Set();
  const add = (from, to) => {
    if (to && to !== from) edges.add(`${from} > ${to}`);
  };

  const packages = new Map();
  for (const f of files.filter((p) => baseOf(p) === 'package.json')) {
    const pkg = readPackageJson(read, f);
    if (pkg && typeof pkg.name === 'string') packages.set(pkg.name, { dir: dirOf(f), main: typeof pkg.main === 'string' ? pkg.main : null });
  }
  const index = pyIndex(files);

  for (const from of files) {
    if (NOT_RUNTIME.test(from) && !PY_FILE.test(from)) continue;
    const isPy = PY_FILE.test(from);
    if (!isPy && !JS_FILE.test(from)) continue;
    const src = read(from);
    if (typeof src !== 'string') continue;
    if (!isPy) {
      const specs = new Set();
      for (const re of [/\bfrom\s+['"]([^'"\n]+)['"]/g, /\bimport\s+['"]([^'"\n]+)['"]/g, /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g]) {
        for (const m of src.matchAll(re)) specs.add(m[1]);
      }
      for (const spec of specs) add(from, resolveJs(set, packages, from, spec));
      continue;
    }
    for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
      const dots = m[1].length;
      const mod = m[2];
      const names = m[3].replace(/[()]/g, ' ').replace(/#[^\n]*/g, ' ').split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((s) => /^\w+$/.test(s));
      if (dots > 0) {
        let base = dirOf(from);
        for (let i = 1; i < dots; i++) base = dirOf(base);
        const modPath = joinPath(base, mod.replace(/\./g, '/'));
        const asFile = (p) => [`${p}.py`, `${p}/__init__.py`].find((t) => set.has(t)) ?? null;
        let moduleUsed = false;
        for (const n of names) {
          const sub = asFile(joinPath(modPath, n));
          if (sub) add(from, sub);
          else moduleUsed = true;
        }
        if (moduleUsed || names.length === 0) add(from, mod ? asFile(modPath) : (set.has(joinPath(base, '__init__.py')) ? joinPath(base, '__init__.py') : null));
      } else {
        let moduleUsed = false;
        for (const n of names) {
          const sub = resolvePy(index, from, `${mod}.${n}`);
          if (sub) add(from, sub);
          else moduleUsed = true;
        }
        if (moduleUsed || names.length === 0) add(from, resolvePy(index, from, mod));
      }
    }
    for (const m of src.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0].trim();
        if (/^[\w.]+$/.test(mod)) add(from, resolvePy(index, from, mod));
      }
    }
  }
  return [...edges].sort(byCodeUnit);
}
