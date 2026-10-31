// generic.mjs - stack detection and the stack-independent "generic recipe" for prescan.
//
// detectStacks(files, read) names the v1 stacks present in a file list; genericRecipe() lists the
// hints any stack gets: entry points, top-level dirs, Dockerfiles/compose files, CI files.
// Pure functions of (files, read): sorted output, no timestamps. Node >= 18, zero dependencies.

import { byCodeUnit, dbKindOf } from './inventory.mjs';

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
  const recipe = {
    entryPoints: [...entry].sort(byCodeUnit),
    topLevelDirs: [...new Set(files.filter((f) => f.includes('/')).map((f) => f.slice(0, f.indexOf('/'))))].sort(byCodeUnit),
    containers: files.filter((f) => isDockerfile(baseOf(f)) || isCompose(baseOf(f))).sort(byCodeUnit),
    ci: files.filter(isCi).sort(byCodeUnit),
    manifests: files.filter((f) => MANIFEST.test(f)).sort(byCodeUnit),
  };
  // file databases opened by js or ts code (the python ones are the python extractor's `stores`)
  const stores = scanDatabases(files, read, 'js').rows;
  if (stores.length) recipe.stores = stores;
  return recipe;
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

// --- file databases opened by path ------------------------------------------------------------

const PY_DB = /(?<![\w.])(duckdb|sqlite3)\.connect\s*\(\s*(?:database\s*=\s*)?/g;
const JS_DB = /\bnew\s+(?:(duckdb|sqlite3)\.(?:cached\.)?)?Database\s*\(\s*|\b(DuckDBInstance)\.(?:create|fromCache)\s*\(\s*/g;
const PATH_LITERAL = /^(['"`])([^'"`\n$\\]*)\1\s*[,)]/;
const IN_MEMORY = (p) => p === '' || p === ':memory:' || p.startsWith('file::memory:');

/**
 * File databases a program opens by path literal: duckdb.connect(<path>) and sqlite3.connect(<path>) in python,
 * new duckdb.Database(<path>), new sqlite3.Database(<path>), new Database(<path>) (kind from the extension) and
 * DuckDBInstance.create(<path>) in js/ts. The file is not looked for: DuckDB and SQLite create theirs at runtime,
 * so a path the repository does not hold is still a database the program uses.
 * Returns { rows: [{library, kind, name, path, evidence}], skipped }; `skipped` counts calls whose path is not a
 * literal. An in-memory database is not a file and gives neither. A path is never resolved or guessed.
 */
export function scanDatabases(files, read, lang) {
  const py = lang === 'py';
  const rows = [];
  let skipped = 0;
  for (const path of files) {
    if (!(py ? PY_FILE : JS_FILE).test(path) || NOT_RUNTIME.test(path)) continue;
    const src = read(path);
    if (typeof src !== 'string') continue;
    for (const m of src.matchAll(py ? PY_DB : JS_DB)) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      const head = src.slice(lineStart, m.index).trimStart();
      if (head.startsWith(py ? '#' : '//') || head.startsWith('*') || head.startsWith('/*')) continue;
      const receiver = m[1] ?? (m[2] ? 'duckdb' : null);
      const lit = PATH_LITERAL.exec(src.slice(m.index + m[0].length, m.index + m[0].length + 400));
      const n = src.slice(0, m.index).split('\n').length;
      if (!lit) {
        // `new Database(x)` names no engine on its own: only a call that does is counted
        if (receiver && !/^\s*[)]/.test(src.slice(m.index + m[0].length))) skipped++;
        continue;
      }
      const target = lit[2];
      if (IN_MEMORY(target)) continue;
      const kind = receiver ? (receiver === 'duckdb' ? 'duckdb' : 'sqlite') : dbKindOf(target);
      if (!kind) continue;
      const clean = target.replace(/^(?:\.\/)+/, '');
      rows.push({ library: kind === 'duckdb' ? 'duckdb' : 'sqlite3', kind, name: baseOf(clean), path: clean, evidence: ev(path, n) });
    }
  }
  rows.sort((a, b) => byCodeUnit(a.evidence[0].path, b.evidence[0].path) || Number(a.evidence[0].lines) - Number(b.evidence[0].lines));
  return { rows, skipped };
}

// --- SQL in string literals -------------------------------------------------------------------

const MAX_COLUMNS = 200; // per CREATE TABLE: the extract is the full record, this is a ceiling against a pathological file
const MAX_SQL_TEXT = 200;
const SQL_VERB = /^\s*(select|with|insert|update|delete|create|alter|drop|truncate|replace|merge)\b/i;
const SQL_TABLE_REF = /\b(from|join|into|update|table)\s+(?:if\s+(?:not\s+)?exists\s+)?(\{|[A-Za-z_"`][\w."`$]*)/gi;
const SQL_NOT_TABLE = new Set(['select', 'lateral', 'only', 'if', 'not', 'exists', 'values', 'set', 'where', 'unnest', 'table', 'temp', 'temporary']);
// prose that starts like a statement ("Select an option from the menu"): a table is never one of these
const PROSE_WORDS = new Set(['the', 'a', 'an', 'your', 'this', 'that', 'these', 'those', 'each', 'every', 'all', 'any', 'one', 'its', 'our', 'my']);
const unquote = (s) => s.replace(/^["`[]|["`\]]$/g, '');
// a name a statement defines for itself (WITH [RECURSIVE] name [(cols)] AS [[NOT] MATERIALIZED] (, ", name AS ("): not a table
const CTE_NAME = /(?:\bwith\s+(?:recursive\s+)?|,\s*)("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*(?:\([^()]*\)\s*)?as(?:\s+(?:not\s+)?materialized)?\s*\(/gi;
// the calls whose FROM separates arguments (EXTRACT(year FROM d), SUBSTRING(s FROM 2), TRIM(BOTH FROM s), OVERLAY(...))
const FROM_ARGUMENT_CALLS = new Set(['extract', 'substring', 'trim', 'overlay']);

/** The offset of the `)` closing the `(` at `open` in `st`, quotes respected; `st.length` when it never closes. */
function closingParen(st, open) {
  let depth = 0;
  let q = null;
  for (let j = open; j < st.length; j++) {
    const c = st[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return st.length;
}

/** The CTEs `st` defines: lowercased name -> the offset where each definition of it ends (its body's `)`). */
function cteEnds(st) {
  const ends = new Map();
  if (!/\bwith\b/i.test(st)) return ends;
  for (const m of st.matchAll(CTE_NAME)) {
    const name = m[1].replace(/["`]/g, '').toLowerCase();
    if (!ends.has(name)) ends.set(name, []);
    ends.get(name).push(closingParen(st, m.index + m[0].length - 1));
  }
  return ends;
}

/**
 * Does the name at offset `at` of a statement read the CTE rather than the table of that name? Only once a
 * definition of it has ended before `at`: inside the CTE's own body (WITH orders AS (SELECT * FROM orders ...)) and
 * in an earlier sibling's body the name is still the table. Under WITH RECURSIVE every CTE of the list is in scope
 * from the start (a self-reference, a forward one), so there the name is always the CTE.
 */
function readsCte(ends, recursive, name, at) {
  const list = ends.get(name);
  return Boolean(list) && (recursive || list.some((close) => close < at));
}

/**
 * Offsets of the `from` keywords of `st` whose innermost open parenthesis is a call to EXTRACT, SUBSTRING, TRIM or
 * OVERLAY: there FROM separates arguments, it opens no table position. A subquery inside such a call opens a
 * parenthesis of its own, so its FROM still counts.
 */
function argumentFroms(st) {
  const out = new Set();
  const stack = [];
  let q = null;
  for (let i = 0; i < st.length; i++) {
    const c = st[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') stack.push(FROM_ARGUMENT_CALLS.has(/([A-Za-z_]\w*)\s*$/.exec(st.slice(Math.max(0, i - 40), i))?.[1].toLowerCase()));
    else if (c === ')') stack.pop();
    else if (stack.at(-1) && (c === 'f' || c === 'F') && !/\w/.test(st[i - 1] ?? '') && /^from(?!\w)/i.test(st.slice(i, i + 5))) out.add(i);
  }
  return out;
}

/** `text` with SQL comments (-- to the end of the line, and block comments) blanked, same length, quotes respected. */
function blankSqlComments(text) {
  const out = text.split('');
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
      i--;
    }
  }
  return out.join('');
}

/** Offsets [a, b) of the statements of `text` (comments already blanked): cut at a semicolon outside quotes and parentheses. */
function splitSql(text) {
  const cuts = [];
  let q = null;
  let depth = 0;
  let from = 0;
  const push = (to) => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) cuts.push({ a, b });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      push(i);
      from = i + 1;
    }
  }
  push(text.length);
  return cuts;
}

/** Split `s` at top-level commas (outside quotes and parentheses). */
function splitTopLevel(s) {
  const out = [];
  let q = null;
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

const COLUMN_STOP = /^(?:not|null|primary|references|default|unique|check|constraint|generated|collate|autoincrement|auto_increment|identity|comment|on|as)$/i;
const TABLE_ITEM = /^(?:constraint\s+\S+\s+)?(primary\s+key|foreign\s+key|unique|check|key|index|exclude|fulltext|spatial|period)\b/i;
const REFERENCES = /\breferences\s+("[^"]+"|`[^`]+`|[\w$.]+)\s*(?:\(\s*("[^"]+"|`[^`]+`|[\w$]+)\s*\))?/i;
const nameList = (s) => splitTopLevel(s).map((x) => unquote(x.replace(/\s+(?:asc|desc)\s*$/i, '').trim()));

/**
 * The columns a CREATE TABLE statement declares, from the "(" at `open` in `st`: [{name, type, pk, fk}] with fk
 * "<table>.<column>" (or just the table) from REFERENCES, a table-level PRIMARY KEY (...) and FOREIGN KEY (...)
 * applied to the columns they name. null when no parenthesis follows (CREATE TABLE x AS SELECT ...).
 */
function sqlColumns(st, open) {
  let i = open;
  while (i < st.length && /\s/.test(st[i])) i++;
  if (st[i] !== '(') return null;
  let q = null;
  let depth = 0;
  let close = -1;
  for (let j = i; j < st.length; j++) {
    const c = st[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) {
      close = j;
      break;
    }
  }
  if (close < 0) return null;
  const columns = [];
  const tableLevel = [];
  for (const item of splitTopLevel(st.slice(i + 1, close))) {
    const t = TABLE_ITEM.exec(item);
    if (t) {
      tableLevel.push({ kind: t[1].toLowerCase().replace(/\s+/g, ' '), item });
      continue;
    }
    const m = /^("[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)\s*([\s\S]*)$/.exec(item);
    if (!m) continue;
    const rest = m[2];
    const type = [];
    for (const tok of rest.match(/[A-Za-z_][\w.]*(?:\s*\([^)]*\))?|\S/g) ?? []) {
      if (!/^[A-Za-z_]/.test(tok) || COLUMN_STOP.test(tok.replace(/\s*\(.*$/s, ''))) break;
      type.push(tok);
    }
    const ref = REFERENCES.exec(rest);
    columns.push({
      name: unquote(m[1]),
      type: type.join(' ').slice(0, MAX_SQL_TEXT),
      pk: /\bprimary\s+key\b/i.test(rest),
      fk: ref ? (ref[2] ? `${unquote(ref[1])}.${unquote(ref[2])}` : unquote(ref[1])) : null,
    });
  }
  const byName = (n) => columns.find((c) => c.name.toLowerCase() === n.toLowerCase());
  for (const { kind, item } of tableLevel) {
    const cols = /\(([^)]*)\)/.exec(item);
    if (!cols) continue;
    if (kind === 'primary key') for (const n of nameList(cols[1])) if (byName(n)) byName(n).pk = true;
    if (kind === 'foreign key') {
      const ref = /\breferences\s+("[^"]+"|`[^`]+`|[\w$.]+)\s*(?:\(([^)]*)\))?/i.exec(item);
      if (!ref) continue;
      const targets = ref[2] ? nameList(ref[2]) : [];
      nameList(cols[1]).forEach((n, k) => {
        if (byName(n)) byName(n).fk = targets[k] ? `${unquote(ref[1])}.${targets[k]}` : unquote(ref[1]);
      });
    }
  }
  return columns.slice(0, MAX_COLUMNS);
}

/** Does `st` (a statement that starts with `verb`) read as SQL? `strict` is for code that also holds prose (js, ts). */
function readsAsSql(verb, st, strict) {
  if (verb === 'select' || verb === 'with') {
    if (!/\bfrom\s+[\w"`{[]/i.test(st)) return false;
    if (!strict) return true;
    // "Select an option from the menu" is a label: SQL has a select list that is not one bare word, an uppercase
    // SELECT ... FROM, or another clause
    return /\bSELECT\b[\s\S]*\bFROM\b/.test(st) || /[*,(.]/.test(/^\s*(?:select|with)\b([\s\S]*?)\bfrom\b/i.exec(st)?.[1] ?? '') ||
      /\b(?:where|join|group\s+by|order\s+by|limit|having|union)\b/i.test(st);
  }
  if (verb === 'update') return /^\s*update\s+[\w."`{]+\s+set\b/i.test(st);
  if (verb === 'insert') return /^\s*insert\s+(?:or\s+\w+\s+)?into\s/i.test(st);
  if (verb === 'delete') return /^\s*delete\s+from\s/i.test(st);
  if (verb === 'create' || verb === 'alter' || verb === 'drop' || verb === 'truncate') return /\btable\b|^\s*truncate\s/i.test(st);
  return !strict;
}

/**
 * The statements in one string body: { statements: [{ a, b, refs: [{ table, op, columns? }] }], skipped }.
 * `a` and `b` are the statement's offsets in `body` (leading and trailing blanks and comments excluded); `op` is
 * select (FROM, JOIN), insert, update, delete or ddl (CREATE, ALTER, DROP, TRUNCATE TABLE); a CREATE TABLE ... (...)
 * carries its `columns`. A table position holding a placeholder ({name}, ${name}, audit_{name}) is counted in
 * `skipped`, never guessed. One row per table and op in a statement. A CTE the statement defines, the FROM inside
 * EXTRACT/SUBSTRING/TRIM/OVERLAY and IS [NOT] DISTINCT FROM name no table and give no row. A CTE that shadows a
 * table (WITH orders AS (SELECT * FROM orders WHERE open) ... FROM orders) keeps the ref inside its own body, which
 * reads the real table, and drops the refs after its definition ends (see readsCte).
 */
export function sqlStatements(body, { strict = false } = {}) {
  const text = blankSqlComments(body);
  const statements = [];
  let skipped = 0;
  for (const { a, b } of splitSql(text)) {
    const st = text.slice(a, b);
    const verb = SQL_VERB.exec(st)?.[1]?.toLowerCase();
    if (!verb || !readsAsSql(verb, st, strict)) continue;
    const refs = [];
    const seen = new Set();
    const ctes = cteEnds(st);
    const recursive = /\bwith\s+recursive\b/i.test(st);
    const argFroms = argumentFroms(st);
    let firstFrom = true;
    for (const m of st.matchAll(SQL_TABLE_REF)) {
      const kw = m[1].toLowerCase();
      const tableRaw = m[2];
      if (kw === 'update' && verb !== 'update') continue;
      if (kw === 'table' && !['create', 'alter', 'drop', 'truncate'].includes(verb)) continue;
      if (kw === 'into' && verb !== 'insert') continue;
      // FROM as an argument separator, or in IS [NOT] DISTINCT FROM: no table position at all
      if (kw === 'from' && (argFroms.has(m.index) || /\bdistinct\s+$/i.test(st.slice(Math.max(0, m.index - 20), m.index)))) continue;
      const end = m.index + m[0].length;
      if (tableRaw === '{' || st[end] === '{') {
        skipped++;
        continue;
      }
      const table = tableRaw.replace(/["`]/g, '');
      if (SQL_NOT_TABLE.has(table.toLowerCase()) || (strict && PROSE_WORDS.has(table.toLowerCase()))) continue;
      if (kw !== 'table' && readsCte(ctes, recursive, table.toLowerCase(), m.index)) continue; // the statement's own CTE, not a table
      let op;
      if (kw === 'join') op = 'select';
      else if (kw === 'from') {
        op = verb === 'delete' && firstFrom ? 'delete' : 'select';
        firstFrom = false;
      } else if (kw === 'into') op = 'insert';
      else if (kw === 'update') op = 'update';
      else op = 'ddl';
      const key = `${table}\0${op}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ref = { table: table.slice(0, MAX_SQL_TEXT), op };
      if (op === 'ddl' && verb === 'create') {
        const columns = sqlColumns(st, end);
        if (columns !== null) ref.columns = columns;
      }
      refs.push(ref);
    }
    if (refs.length) statements.push({ a, b, refs });
  }
  return { statements, skipped };
}

/**
 * SQL in the string and template literals of js/ts files: { rows: [{table, op, columns?, evidence}], skipped }.
 * A `${...}` inside a template is a placeholder (a table position holding one is counted in `skipped`). Comments are
 * skipped; prose that starts like a statement is not SQL. The code is read as text, never run.
 */
export function scanJsSql(files, read) {
  const rows = [];
  let skipped = 0;
  for (const path of files) {
    if (!JS_FILE.test(path) || NOT_RUNTIME.test(path)) continue;
    const src = read(path);
    if (typeof src !== 'string' || !/\b(?:select|insert|update|delete|create|alter|drop|truncate|with)\b/i.test(src)) continue;
    const lineAt = lineLookup(src);
    for (const lit of jsStrings(src)) {
      const { statements, skipped: n } = sqlStatements(lit.body, { strict: true });
      skipped += n;
      for (const st of statements) {
        const x = lineAt(lit.start + st.a);
        const y = lineAt(lit.start + st.b - 1);
        for (const r of st.refs) rows.push({ ...r, evidence: [{ path, lines: y > x ? `${x}-${y}` : `${x}` }] });
      }
    }
  }
  rows.sort((a, b) => byCodeUnit(a.evidence[0].path, b.evidence[0].path) || Number(a.evidence[0].lines.split('-')[0]) - Number(b.evidence[0].lines.split('-')[0]));
  return { rows, skipped };
}

/** offset -> 1-based line number. */
function lineLookup(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * The string literals of js/ts source: [{start, body}], `start` the offset of the body in `src`. Comments are skipped;
 * in a template literal a `${...}` is blanked to `{` plus spaces (same length, newlines kept) so offsets stay exact.
 */
function jsStrings(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] === c) out.push({ start: i + 1, body: src.slice(i + 1, j) });
      i = Math.max(j + 1, i + 1);
    } else if (c === '`') {
      let j = i + 1;
      let body = '';
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') {
          body += '  ';
          j += 2;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 0;
          let k = j + 1;
          for (; k < n; k++) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}' && --depth === 0) break;
          }
          body += '{' + src.slice(j + 1, k + 1).replace(/[^\n]/g, ' ');
          j = k + 1;
        } else body += src[j++];
      }
      out.push({ start: i + 1, body });
      i = j + 1;
    } else i++;
  }
  return out;
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
