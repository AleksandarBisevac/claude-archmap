// node-backend.mjs - the node-backend stack plug-in of prescan: static, regex/lightweight-parse extraction.
//
// extractNodeBackend(files, read) -> fragment
//   { scanned, routes[], entities[], openapi[], queues[], skipped{<kind>: n}, truncated{<kind>: n} }
// Routes (NestJS controllers, Express and Hono routers, with router mounts resolved), ORM entities
// (Prisma models, TypeORM entities, Drizzle tables) with fields, PK/FK and relations, OpenAPI
// documents (YAML or JSON) and BullMQ queues with their producers and workers. Every item carries
// evidence: [{path, lines}] ("12" or "12-14"). Items are sorted by path then line; each kind is
// capped, and what the cap drops is counted in `truncated`. A recognised shape whose arguments
// cannot be resolved statically (a computed path, a variable queue name) is counted in `skipped`,
// never guessed. Only string literals and single-literal constants are resolved.
//
// The scanned code is only ever read as text: no import, no eval, no process spawn. The default
// export is the plug-in object ({ id, detect(inventory), extract(files, read) }) that
// prescan.mjs loads. Node >= 18, ESM, zero dependencies.

import { byCodeUnit } from './inventory.mjs';
import { detectStacks } from './generic.mjs';

export const KINDS = ['entities', 'openapi', 'queues', 'routes'];
export const MAX_ITEMS = 300; // per kind
const MAX_FIELDS = 60; // per entity
const MAX_NESTED = 100; // producers / workers per queue, operations per OpenAPI document
const MAX_TEXT = 200; // longest type / path / url string kept

const CODE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const SKIP_CODE_RE = /\.d\.[cm]?ts$|\.(?:spec|test)\.[cm]?[jt]sx?$/;
const OPENAPI_RE = /(?:^|\/)(?:openapi|swagger)[^/]*\.(?:ya?ml|json)$/i;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
const ID = '[A-Za-z_$][\\w$]*';

const clip = (s) => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : s);

// ---------------------------------------------------------------------------------------------
// Lexing: blank comments and find string literals. `clean` keeps strings (comments blanked),
// `masked` also turns string bodies into 'x', so structural regexes and bracket matching never trip
// over text inside strings. Offsets are the same in src, clean and masked.

function lex(src) {
  const clean = src.split('');
  const masked = src.split('');
  const strAt = new Map();
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (src[k] !== '\n' && src[k] !== '\r') clean[k] = masked[k] = ' ';
  };
  const fill = (a, b) => {
    for (let k = a; k < b; k++) if (src[k] !== '\n' && src[k] !== '\r') masked[k] = 'x';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const bodyEnd = Math.min(j, n);
      const closed = src[bodyEnd] === c;
      fill(i + 1, bodyEnd);
      const end = closed ? bodyEnd + 1 : bodyEnd;
      strAt.set(i, { start: i, end, value: src.slice(i + 1, bodyEnd), tpl: false, closed });
      i = end;
    } else if (c === '`') {
      let j = i + 1;
      let expr = false;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '$' && src[j + 1] === '{') {
          expr = true;
          let depth = 0;
          while (j < n) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}' && --depth === 0) break;
            j++;
          }
          j++;
        } else j++;
      }
      const bodyEnd = Math.min(j, n);
      fill(i + 1, bodyEnd);
      const end = src[bodyEnd] === '`' ? bodyEnd + 1 : bodyEnd;
      strAt.set(i, { start: i, end, value: src.slice(i + 1, bodyEnd), tpl: expr, closed: src[bodyEnd] === '`' });
      i = end;
    } else i++;
  }
  return { clean: clean.join(''), masked: masked.join(''), strAt };
}

/** Index of the bracket matching the opener at `open` in masked text, or -1. */
function matchClose(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level comma-separated pieces between a and b, trimmed: [{a, b}] (empty pieces dropped). */
function splitTop(masked, a, b) {
  const out = [];
  let depth = 0;
  let s = a;
  const push = (e) => {
    let x = s;
    let y = e;
    while (x < y && /\s/.test(masked[x])) x++;
    while (y > x && /\s/.test(masked[y - 1])) y--;
    if (y > x) out.push({ a: x, b: y });
  };
  for (let i = a; i < b; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      push(i);
      s = i + 1;
    }
  }
  push(b);
  return out;
}

// One parsed code file.
function parseCode(path, src) {
  const { clean, masked, strAt } = lex(src);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const f = { path, src, clean, masked, strAt, consts: new Map(), imports: new Map(), routers: new Map(), queueVars: new Map(), defaultExport: null };
  f.lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  // NAME = '<one literal>' constants: the literal must be the whole initializer.
  for (const m of masked.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n]+)?=\\s*(?=['"\`])`, 'g'))) {
    const s = strAt.get(m.index + m[0].length);
    if (s && s.closed && !s.tpl && /^[ \t]*(?:;|,|\)|\r?\n|$)/.test(masked.slice(s.end, s.end + 40))) f.consts.set(m[1], s.value);
  }
  for (const m of clean.matchAll(new RegExp(`\\bimport\\s+(?:type\\s+)?(?:(${ID})\\s*,?\\s*)?(?:\\{([^}]*)\\})?\\s*from\\s*(['"])([^'"\\n]+)\\3`, 'g'))) {
    if (m[1]) f.imports.set(m[1], { spec: m[4], name: 'default' });
    for (const part of (m[2] ?? '').split(',')) {
      const p = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (p) f.imports.set(p[2] ?? p[1], { spec: m[4], name: p[1] });
    }
  }
  const d = new RegExp(`\\bexport\\s+default\\s+(${ID})\\s*;?\\s*$`, 'm').exec(masked);
  if (d) f.defaultExport = d[1];
  return f;
}

const evidence = (f, a, b) => {
  const x = f.lineOf(a);
  const y = f.lineOf(Math.max(a, b - 1));
  return [{ path: f.path, lines: y > x ? `${x}-${y}` : `${x}` }];
};

const normPath = (p) => {
  const out = [];
  for (const s of p.split('/')) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
};

/** Resolve a relative import specifier to a parsed file path, or null. */
function resolveModule(ctx, from, spec) {
  if (!spec.startsWith('.')) return null;
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const base = normPath(`${dir}/${spec}`);
  const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
  const cands = [base, ...exts.map((e) => `${stem}.${e}`), ...exts.map((e) => `${base}.${e}`), ...exts.map((e) => `${base}/index.${e}`)];
  return cands.find((c) => ctx.byPath.has(c)) ?? null;
}

/** The file and the exported/declared name an identifier refers to: local, or imported from a relative module. */
function origin(ctx, f, ident) {
  const imp = f.imports.get(ident);
  if (!imp) return { file: f, name: ident };
  const target = resolveModule(ctx, f.path, imp.spec);
  if (!target) return null;
  const tf = ctx.byPath.get(target);
  const name = imp.name === 'default' ? tf.defaultExport : imp.name;
  return name ? { file: tf, name } : null;
}

/** A string literal, or an identifier naming a single-literal constant (local or imported), between a and b; else null. */
function strValue(ctx, f, a, b) {
  let x = a;
  let y = b;
  while (x < y && /\s/.test(f.masked[x])) x++;
  while (y > x && /\s/.test(f.masked[y - 1])) y--;
  const lit = f.strAt.get(x);
  if (lit) return lit.closed && !lit.tpl && lit.end === y ? lit.value : null;
  const id = f.masked.slice(x, y);
  if (!new RegExp(`^${ID}$`).test(id)) return null;
  const o = origin(ctx, f, id);
  return o && o.file.consts.has(o.name) ? o.file.consts.get(o.name) : null;
}

/** Range of the value of `key` in an object literal piece {a, b} (the braces included), or null. */
function objProp(f, piece, key) {
  if (!piece || f.masked[piece.a] !== '{') return null;
  for (const p of splitTop(f.masked, piece.a + 1, piece.b - 1)) {
    const m = /^\s*(?:['"]([\w$-]+)['"]|([\w$]+))\s*:\s*/.exec(f.clean.slice(p.a, p.b));
    if (m && (m[1] ?? m[2]) === key) return { a: p.a + m[0].length, b: p.b };
  }
  return null;
}

const callAt = (f, open) => {
  const close = matchClose(f.masked, open);
  return close < 0 ? null : { open, close, args: splitTop(f.masked, open + 1, close) };
};
const textOf = (f, p) => f.clean.slice(p.a, p.b).replace(/\s+/g, ' ').trim();
const identText = (f, p) => {
  const t = p ? textOf(f, p) : '';
  return /^[A-Za-z_$][\w$.]*$/.test(t) ? t : null;
};

/** Join URL parts into one absolute path: no doubled slashes, no trailing slash except the root. */
function joinUrl(...parts) {
  const u = '/' + parts.join('/').replace(/\/+/g, '/').replace(/^\//, '');
  return clip(u.length > 1 ? u.replace(/\/$/, '') : u);
}

// ---------------------------------------------------------------------------------------------
// Routes: Express / Hono routers and mounts.

const ROUTER_RE = new RegExp(
  `\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n]+)?=\\s*(?:(?<!new\\s+)(?<![\\w$.])(express\\s*\\(|(?:express\\s*\\.\\s*)?Router\\s*\\()|(new\\s+Hono\\b))`,
  'g',
);

function collectRouters(f) {
  for (const m of f.masked.matchAll(ROUTER_RE)) f.routers.set(m[1], m[3] ? 'hono' : 'express');
}

function extractRouterRoutes(ctx, f, acc, found, mounts) {
  if (f.routers.size === 0) return;
  const re = new RegExp(`(?<![\\w$.])(${ID})\\s*\\.\\s*(get|post|put|patch|delete|options|head|all|on|use|route)\\s*\\(`, 'g');
  for (const d of f.masked.matchAll(re)) {
    const framework = f.routers.get(d[1]);
    if (!framework) continue; // an unknown receiver (cache.get(...)) is not a guess we make
    const call = callAt(f, d.index + d[0].length - 1);
    if (!call) continue;
    const { args } = call;
    const key = `${f.path}#${d[1]}`;
    const ev = evidence(f, d.index, call.close + 1);
    const verb = d[2];
    const mountOf = (prefix, ident) => {
      const o = origin(ctx, f, ident);
      if (o && o.file.routers.has(o.name)) mounts.push({ parent: key, child: `${o.file.path}#${o.name}`, prefix });
    };
    if (verb === 'use' || (verb === 'route' && framework === 'hono')) {
      if (verb === 'use' && framework !== 'express') continue;
      const idArg = identText(f, args[args.length - 1]);
      if (!idArg || idArg.includes('.')) continue;
      if (args.length === 1 && verb === 'use') mountOf('', idArg);
      else if (args.length === 2) {
        const prefix = strValue(ctx, f, args[0].a, args[0].b);
        if (prefix !== null && prefix.startsWith('/')) mountOf(prefix, idArg);
      }
      continue;
    }
    if (verb === 'route') {
      if (args.length === 1) acc.skipped.routes++; // express route(path).get(...) chains are not followed
      continue;
    }
    if (verb === 'on') {
      if (framework !== 'hono' || args.length < 2) continue;
      const mArg = args[0];
      const methods = f.masked[mArg.a] === '[' ? splitTop(f.masked, mArg.a + 1, mArg.b - 1).map((p) => strValue(ctx, f, p.a, p.b)) : [strValue(ctx, f, mArg.a, mArg.b)];
      const url = strValue(ctx, f, args[1].a, args[1].b);
      if (url === null || methods.length === 0 || methods.some((x) => x === null)) {
        acc.skipped.routes++;
        continue;
      }
      if (!/^[/*]/.test(url)) continue;
      for (const method of methods) found.push({ f, key, framework, method: method.toUpperCase(), sub: url, handler: identText(f, args[args.length - 1]), ev });
      continue;
    }
    if (args.length < 2) continue; // app.get('setting') is not a route
    const url = strValue(ctx, f, args[0].a, args[0].b);
    if (url === null) {
      acc.skipped.routes++;
      continue;
    }
    if (!/^[/*]/.test(url)) continue;
    found.push({ f, key, framework, method: verb === 'all' ? 'ANY' : verb.toUpperCase(), sub: url, handler: identText(f, args[args.length - 1]), ev });
  }
}

function prefixesOf(key, mounts, seen = new Set()) {
  const own = mounts.filter((m) => m.child === key);
  if (own.length === 0 || seen.has(key)) return [''];
  const out = new Set();
  for (const m of own) for (const p of prefixesOf(m.parent, mounts, new Set([...seen, key]))) out.add(joinUrl(p, m.prefix).replace(/^\/$/, ''));
  return [...out].sort(byCodeUnit);
}

// ---------------------------------------------------------------------------------------------
// Class bodies: NestJS controllers and TypeORM entities.

/** The class that follows the decorator ending at `from`: { name, a, b } (body between braces), or null. */
function classAfter(f, from) {
  const m = f.masked;
  let i = from;
  for (;;) {
    while (i < m.length && /\s/.test(m[i])) i++;
    if (m[i] !== '@') break;
    const id = new RegExp(`@${ID}(?:\\.${ID})*`, 'y');
    id.lastIndex = i;
    const r = id.exec(m);
    if (!r) return null;
    i += r[0].length;
    let k = i;
    while (/\s/.test(m[k] ?? '')) k++;
    if (m[k] === '(') {
      const c = matchClose(m, k);
      if (c < 0) return null;
      i = c + 1;
    }
  }
  const head = new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${ID})`, 'y');
  head.lastIndex = i;
  const h = head.exec(m);
  if (!h) return null;
  const open = m.indexOf('{', i + h[0].length);
  if (open < 0) return null;
  const close = matchClose(m, open);
  return close < 0 ? null : { name: h[1], a: open + 1, b: close, start: i, end: close + 1 };
}

/** Decorated members of a class body: [{ name, nameOffset, decos: [{ name, start, args:[{a,b}], end }] }]. */
function classMembers(f, a, b) {
  const m = f.masked;
  const out = [];
  let decos = [];
  let depth = 0;
  let i = a;
  while (i < b) {
    const c = m[i];
    if (depth === 0 && c === '@') {
      const r = new RegExp(`@(${ID})`, 'y');
      r.lastIndex = i;
      const mm = r.exec(m);
      if (!mm) {
        i++;
        continue;
      }
      let k = i + mm[0].length;
      let end = k;
      let args = [];
      while (/\s/.test(m[k] ?? '')) k++;
      if (m[k] === '(') {
        const close = matchClose(m, k);
        if (close < 0) break;
        args = splitTop(m, k + 1, close);
        end = close + 1;
      }
      decos.push({ name: mm[1], start: i, args, end });
      i = end;
      continue;
    }
    if (depth === 0 && decos.length && /[A-Za-z_$]/.test(c)) {
      const r = new RegExp(`((?:(?:public|private|protected|static|async|readonly|override|abstract|declare)\\s+)*)(${ID})`, 'y');
      r.lastIndex = i;
      const mm = r.exec(m);
      out.push({ name: mm[2], nameOffset: i + mm[1].length, after: i + mm[0].length, decos });
      decos = [];
      i += mm[0].length;
      continue;
    }
    if (depth === 0 && decos.length && !/\s/.test(c)) decos = [];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    i++;
  }
  return out;
}

const NEST_VERBS = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Options: 'OPTIONS', Head: 'HEAD', All: 'ANY' };

function extractNestRoutes(ctx, f, acc, nest) {
  for (const d of f.masked.matchAll(/@Controller\b\s*(?=\()/g)) {
    const open = d.index + d[0].length;
    const call = callAt(f, open);
    if (!call) continue;
    const cls = classAfter(f, call.close + 1);
    if (!cls) continue;
    let base = '';
    const a0 = call.args[0];
    if (a0) {
      if (f.masked[a0.a] === '{') {
        const pv = objProp(f, a0, 'path');
        base = pv ? strValue(ctx, f, pv.a, pv.b) : '';
      } else base = strValue(ctx, f, a0.a, a0.b);
    }
    for (const mem of classMembers(f, cls.a, cls.b)) {
      const deco = mem.decos.find((x) => NEST_VERBS[x.name]);
      if (!deco) continue;
      const ev = evidence(f, deco.start, mem.nameOffset + mem.name.length);
      let subs = [''];
      const p0 = deco.args[0];
      if (p0) {
        if (f.masked[p0.a] === '[') {
          const parts = splitTop(f.masked, p0.a + 1, p0.b - 1).map((p) => strValue(ctx, f, p.a, p.b));
          subs = parts.length > 0 && parts.every((x) => x !== null) ? parts : null;
        } else {
          const v = strValue(ctx, f, p0.a, p0.b);
          subs = v === null ? null : [v];
        }
      }
      if (base === null || subs === null) {
        acc.skipped.routes++;
        continue;
      }
      for (const sub of subs) nest.push({ f, framework: 'nestjs', method: NEST_VERBS[deco.name], sub: joinUrl(base, sub), handler: mem.name, ev });
    }
  }
}

function globalPrefix(ctx) {
  const values = new Set();
  let unresolved = false;
  for (const f of ctx.files) {
    for (const d of f.masked.matchAll(/\.\s*setGlobalPrefix\s*(?=\()/g)) {
      const call = callAt(f, d.index + d[0].length);
      const v = call && call.args[0] ? strValue(ctx, f, call.args[0].a, call.args[0].b) : null;
      if (v === null) unresolved = true;
      else values.add(v);
    }
  }
  return values.size === 1 && !unresolved ? [...values][0] : '';
}

// ---------------------------------------------------------------------------------------------
// Entities.

/** Optional-property type text after a class member name: "string", or null when there is none. */
function memberType(f, mem) {
  const m = f.masked;
  const r = /\s*[?!]?\s*:\s*/y;
  r.lastIndex = mem.after;
  const h = r.exec(m);
  if (!h) return null;
  let depth = 0;
  let i = mem.after + h[0].length;
  const start = i;
  while (i < m.length) {
    const c = m[i];
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && (c === ';' || c === '=' || c === '\n' || c === ',')) break;
    i++;
  }
  const t = f.clean.slice(start, i).replace(/\s+/g, ' ').trim();
  return t ? clip(t) : null;
}

const TO_COLUMN = new Set(['Column', 'PrimaryColumn', 'PrimaryGeneratedColumn', 'CreateDateColumn', 'UpdateDateColumn', 'DeleteDateColumn', 'VersionColumn', 'ObjectIdColumn']);
const TO_RELATION = { OneToMany: 'many', ManyToOne: 'one', OneToOne: 'one', ManyToMany: 'many' };

function extractTypeorm(ctx, f, acc) {
  for (const d of f.masked.matchAll(/@Entity\b\s*(?=\()/g)) {
    const call = callAt(f, d.index + d[0].length);
    if (!call) continue;
    const cls = classAfter(f, call.close + 1);
    if (!cls) continue;
    let table = null;
    const a0 = call.args[0];
    if (a0) {
      if (f.masked[a0.a] === '{') {
        const nv = objProp(f, a0, 'name');
        table = nv ? strValue(ctx, f, nv.a, nv.b) : null;
      } else table = strValue(ctx, f, a0.a, a0.b);
    }
    const fields = [];
    const relations = [];
    const joins = [];
    for (const mem of classMembers(f, cls.a, cls.b)) {
      if (/^\s*\(/.test(f.masked.slice(mem.after, mem.after + 40))) continue; // a decorated method
      const colDeco = mem.decos.find((x) => TO_COLUMN.has(x.name));
      const relDeco = mem.decos.find((x) => TO_RELATION[x.name]);
      if (relDeco) {
        let target = null;
        const t0 = relDeco.args[0];
        if (t0) {
          const arrow = /^\(?\s*[\w$]*\s*\)?\s*=>\s*\(?\s*([A-Za-z_$][\w$]*)/.exec(f.clean.slice(t0.a, t0.b));
          target = arrow ? arrow[1] : strValue(ctx, f, t0.a, t0.b);
        }
        const jc = mem.decos.find((x) => x.name === 'JoinColumn');
        let via = null;
        if (jc && jc.args[0]) {
          const nv = objProp(f, jc.args[0], 'name');
          via = nv ? strValue(ctx, f, nv.a, nv.b) : null;
        }
        relations.push({ field: mem.name, kind: TO_RELATION[relDeco.name], target, via: clip(via) });
        if (via && target && TO_RELATION[relDeco.name] === 'one') joins.push({ column: via, target });
      } else if (colDeco) {
        let column = mem.name;
        for (const arg of colDeco.args) {
          const nv = objProp(f, arg, 'name');
          const v = nv ? strValue(ctx, f, nv.a, nv.b) : null;
          if (v) column = v;
        }
        fields.push({ name: mem.name, type: memberType(f, mem), pk: colDeco.name.startsWith('Primary'), fk: null, column });
      }
    }
    for (const j of joins) for (const fl of fields) if (fl.column === j.column) fl.fk = j.target;
    acc.entities.push({
      orm: 'typeorm',
      name: cls.name,
      table: clip(table),
      fields: fields.slice(0, MAX_FIELDS).map(({ column, ...rest }) => rest),
      relations: relations.slice(0, MAX_FIELDS),
      evidence: evidence(f, d.index, cls.end),
    });
  }
}

function extractDrizzle(ctx, f, acc, drizzle) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n]+)?=\\s*(?:pg|mysql|sqlite|singlestore)Table\\s*(?=\\()`, 'g');
  for (const d of f.masked.matchAll(re)) {
    const call = callAt(f, d.index + d[0].length);
    if (!call) continue;
    const table = call.args[0] ? strValue(ctx, f, call.args[0].a, call.args[0].b) : null;
    const cols = call.args[1];
    if (table === null || !cols || f.masked[cols.a] !== '{') {
      acc.skipped.entities++;
      continue;
    }
    const fields = [];
    for (const p of splitTop(f.masked, cols.a + 1, cols.b - 1)) {
      const k = /^\s*(?:['"]([\w$-]+)['"]|([\w$]+))\s*:\s*/.exec(f.clean.slice(p.a, p.b));
      if (!k) continue;
      const vStart = p.a + k[0].length;
      const t = new RegExp(`^(${ID})\\s*\\(`).exec(f.masked.slice(vStart, p.b));
      if (!t) continue;
      const chain = f.masked.slice(vStart, p.b);
      const ref = /\.\s*references\s*\(/.exec(chain);
      let fk = null;
      if (ref) {
        const rc = callAt(f, vStart + ref.index + ref[0].length - 1);
        const tgt = rc && rc.args[0] ? new RegExp(`=>\\s*\\(?\\s*(${ID})\\s*\\.\\s*(${ID})`).exec(f.clean.slice(rc.args[0].a, rc.args[0].b)) : null;
        if (tgt) fk = clip(`${tgt[1]}.${tgt[2]}`);
      }
      fields.push({ name: k[1] ?? k[2], type: t[1], pk: /\.\s*primaryKey\s*\(/.test(chain), fk });
    }
    const item = { orm: 'drizzle', name: d[1], table: clip(table), fields: fields.slice(0, MAX_FIELDS), relations: [], evidence: evidence(f, d.index, call.close + 1) };
    acc.entities.push(item);
    drizzle.push({ f, item });
  }
}

function drizzleRelations(ctx, f, drizzle) {
  for (const d of f.masked.matchAll(/(?<![\w$.])relations\s*(?=\()/g)) {
    const call = callAt(f, d.index + d[0].length);
    if (!call || call.args.length < 2) continue;
    const owner = identText(f, call.args[0]);
    const mine = drizzle.filter((e) => e.item.name === owner);
    const ent = mine.find((e) => e.f === f) ?? (mine.length === 1 ? mine[0] : null);
    if (!ent) continue;
    const cb = call.args[1];
    const arrow = f.masked.indexOf('=>', cb.a);
    if (arrow < 0 || arrow >= cb.b) continue;
    let o = arrow + 2;
    while (o < cb.b && /[\s(]/.test(f.masked[o])) o++;
    if (f.masked[o] !== '{') continue;
    const oc = matchClose(f.masked, o);
    if (oc < 0) continue;
    for (const p of splitTop(f.masked, o + 1, oc)) {
      const k = /^\s*([\w$]+)\s*:\s*/.exec(f.clean.slice(p.a, p.b));
      if (!k) continue;
      const vs = p.a + k[0].length;
      const kind = /^(one|many)\s*\(/.exec(f.masked.slice(vs, p.b));
      if (!kind) continue;
      const rc = callAt(f, vs + kind[0].length - 1);
      if (!rc || !rc.args[0]) continue;
      let via = null;
      const fieldsArg = rc.args[1] && rc.args[1].b > rc.args[1].a ? objProp(f, rc.args[1], 'fields') : null;
      if (fieldsArg && f.masked[fieldsArg.a] === '[') {
        const cols = splitTop(f.masked, fieldsArg.a + 1, fieldsArg.b - 1).map((c) => textOf(f, c).replace(/^[\w$]+\./, ''));
        via = cols.length ? cols.join(',') : null;
      }
      ent.item.relations.push({ field: k[1], kind: kind[1], target: identText(f, rc.args[0]), via: clip(via) });
    }
  }
}

function extractPrisma(path, src, acc) {
  const lines = src.split('\n');
  const stripped = lines.map((l) => l.replace(/\/\/.*$/, '').replace(/\r$/, ''));
  const models = new Set();
  const enums = new Set();
  for (const l of stripped) {
    const m = /^\s*(model|enum)\s+(\w+)\s*\{/.exec(l);
    if (m) (m[1] === 'model' ? models : enums).add(m[2]);
  }
  for (let i = 0; i < stripped.length; i++) {
    const h = /^\s*model\s+(\w+)\s*\{/.exec(stripped[i]);
    if (!h) continue;
    let j = i + 1;
    while (j < stripped.length && !/^\s*\}/.test(stripped[j])) j++;
    if (j >= stripped.length) {
      acc.skipped.entities++;
      continue;
    }
    const fields = [];
    const relations = [];
    const fkOf = new Map();
    let table = h[1];
    const compositeIds = new Set();
    for (let k = i + 1; k < j; k++) {
      const line = stripped[k];
      const map = /@@map\s*\(\s*["']([^"']+)["']/.exec(line);
      if (map) table = map[1];
      const comp = /@@id\s*\(\s*\[([^\]]*)\]/.exec(line);
      if (comp) for (const c of comp[1].split(',')) compositeIds.add(c.trim());
      if (/^\s*@@/.test(line)) continue;
      const fm = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?(?:\s+(.*))?$/.exec(line);
      if (!fm) continue;
      const [, name, base, list, opt, rest = ''] = fm;
      if (models.has(base) && !enums.has(base)) {
        const rel = /@relation\s*\(([^)]*)\)/.exec(rest);
        const fl = rel ? /fields:\s*\[([^\]]*)\]/.exec(rel[1]) : null;
        const rf = rel ? /references:\s*\[([^\]]*)\]/.exec(rel[1]) : null;
        const own = fl ? fl[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
        const refs = rf ? rf[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
        own.forEach((col, n) => fkOf.set(col, refs[n] ? `${base}.${refs[n]}` : null));
        relations.push({ field: name, kind: list ? 'many' : 'one', target: base, via: own.length ? own.join(',') : null });
      } else {
        fields.push({ name, type: clip(`${base}${list ?? ''}${opt ?? ''}`), pk: /@id\b/.test(rest), fk: null });
      }
    }
    for (const fl of fields) {
      if (compositeIds.has(fl.name)) fl.pk = true;
      fl.fk = fkOf.get(fl.name) ?? null;
    }
    acc.entities.push({
      orm: 'prisma',
      name: h[1],
      table: clip(table),
      fields: fields.slice(0, MAX_FIELDS),
      relations: relations.slice(0, MAX_FIELDS),
      evidence: [{ path, lines: j > i ? `${i + 1}-${j + 1}` : `${i + 1}` }],
    });
    i = j;
  }
}

// ---------------------------------------------------------------------------------------------
// OpenAPI documents.

const scalar = (s) => {
  const t = String(s).replace(/\s+#.*$/, '').trim();
  const q = /^(['"])(.*)\1$/.exec(t);
  return q ? q[2] : t;
};

function openapiYaml(path, src, acc) {
  const rows = [];
  src.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(#.*)?$/.test(line)) return;
    rows.push({ n: i + 1, indent: line.length - line.trimStart().length, text: line.trim() });
  });
  const blockEnd = (i) => {
    let j = i + 1;
    while (j < rows.length && rows[j].indent > rows[i].indent) j++;
    return j; // exclusive
  };
  const top = (key) => rows.findIndex((r) => r.indent === 0 && r.text.startsWith(`${key}:`));
  const specIdx = [top('openapi'), top('swagger')].find((x) => x >= 0);
  if (specIdx === undefined) return acc.skipped.openapi++;
  const direct = (from, to, indent) => rows.slice(from, to).filter((r) => r.indent === indent);
  const childIndent = (i, j) => (j > i + 1 ? rows[i + 1].indent : -1);

  const doc = { title: null, version: null, specVersion: scalar(rows[specIdx].text.slice(rows[specIdx].text.indexOf(':') + 1)), servers: [], operations: [], schemas: [] };
  const info = top('info');
  if (info >= 0) {
    const end = blockEnd(info);
    for (const r of direct(info + 1, end, childIndent(info, end))) {
      const m = /^(title|version):\s*(.*)$/.exec(r.text);
      if (m) doc[m[1]] = clip(scalar(m[2]));
    }
  }
  const servers = top('servers');
  if (servers >= 0) {
    for (const r of rows.slice(servers + 1, blockEnd(servers))) {
      const m = /^(?:-\s*)?url:\s*(.+)$/.exec(r.text);
      if (m) doc.servers.push(clip(scalar(m[1])));
    }
  }
  const paths = top('paths');
  if (paths >= 0) {
    const pEnd = blockEnd(paths);
    for (let i = paths + 1; i < pEnd; i++) {
      if (rows[i].indent !== childIndent(paths, pEnd)) continue;
      const pm = /^(['"]?)(\/[^'"]*|\*)\1:\s*$/.exec(rows[i].text);
      if (!pm) continue;
      const iEnd = blockEnd(i);
      const mi = childIndent(i, iEnd);
      for (let j = i + 1; j < iEnd; j++) {
        if (rows[j].indent !== mi) continue;
        const mm = /^(\w+):/.exec(rows[j].text);
        if (!mm || !HTTP_METHODS.includes(mm[1].toLowerCase())) continue;
        const oEnd = blockEnd(j);
        let operationId = null;
        for (const r of direct(j + 1, oEnd, childIndent(j, oEnd))) {
          const om = /^operationId:\s*(.+)$/.exec(r.text);
          if (om) operationId = clip(scalar(om[1]));
        }
        const last = rows[oEnd - 1].n;
        doc.operations.push({ method: mm[1].toUpperCase(), url: clip(pm[2]), operationId, evidence: [{ path, lines: last > rows[j].n ? `${rows[j].n}-${last}` : `${rows[j].n}` }] });
      }
    }
  }
  const names = new Set();
  for (const [parent, child] of [['components', 'schemas'], [null, 'definitions']]) {
    const p = parent ? top(parent) : 0;
    const from = parent ? (p >= 0 ? p + 1 : -1) : 0;
    if (from < 0) continue;
    const to = parent ? blockEnd(p) : rows.length;
    const baseIndent = parent ? (childIndent(p, to)) : 0;
    const s = rows.findIndex((r, idx) => idx >= from && idx < to && r.indent === baseIndent && r.text === `${child}:`);
    if (s < 0) continue;
    const sEnd = blockEnd(s);
    for (const r of direct(s + 1, sEnd, childIndent(s, sEnd))) {
      const m = /^(['"]?)([^'"\s:]+)\1:/.exec(r.text);
      if (m) names.add(clip(m[2]));
    }
  }
  doc.schemas = [...names].sort(byCodeUnit);
  return finishDoc(path, doc, rows.length ? rows[rows.length - 1].n : 1, acc);
}

function openapiJson(path, src, acc) {
  let j;
  try {
    j = JSON.parse(src);
  } catch {
    return acc.skipped.openapi++;
  }
  const spec = j && typeof j === 'object' ? j.openapi ?? j.swagger : undefined;
  if (typeof spec !== 'string') return acc.skipped.openapi++;
  const lineAt = (off) => src.slice(0, off).split('\n').length;
  const doc = {
    title: clip(j.info?.title ?? null),
    version: clip(j.info?.version ?? null),
    specVersion: spec,
    servers: Array.isArray(j.servers) ? j.servers.map((s) => clip(s?.url)).filter((u) => typeof u === 'string') : [],
    operations: [],
    schemas: Object.keys(j.components?.schemas ?? j.definitions ?? {}).sort(byCodeUnit).map(clip),
  };
  let from = Math.max(0, src.indexOf('"paths"'));
  for (const url of Object.keys(j.paths ?? {})) {
    const at = src.indexOf(JSON.stringify(url), from);
    if (at >= 0) from = at;
    for (const method of Object.keys(j.paths[url] ?? {})) {
      if (!HTTP_METHODS.includes(method.toLowerCase())) continue;
      const m = new RegExp(`"${method}"\\s*:`).exec(src.slice(from));
      const line = lineAt(m ? from + m.index : from);
      const id = j.paths[url][method]?.operationId;
      doc.operations.push({ method: method.toUpperCase(), url: clip(url), operationId: typeof id === 'string' ? clip(id) : null, evidence: [{ path, lines: `${line}` }] });
    }
  }
  return finishDoc(path, doc, src.replace(/\s+$/, '').split('\n').length, acc);
}

function finishDoc(path, doc, lastLine, acc) {
  const dropped = Math.max(0, doc.operations.length - MAX_NESTED);
  const item = { ...doc, operations: doc.operations.slice(0, MAX_NESTED), evidence: [{ path, lines: lastLine > 1 ? `1-${lastLine}` : '1' }] };
  if (dropped) item.truncated = dropped;
  acc.openapi.push(item);
}

// ---------------------------------------------------------------------------------------------
// BullMQ queues.

function extractQueues(ctx, acc) {
  const queues = new Map(); // name -> item
  const get = (name) => {
    if (!queues.has(name)) queues.set(name, { name: clip(name), decl: [], producers: [], workers: [] });
    return queues.get(name);
  };
  const generic = '(?:<[^>()]*>)?';
  for (const f of ctx.files) {
    const re = new RegExp(`(?:\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n]+)?=\\s*)?\\bnew\\s+Queue\\s*${generic}\\s*(?=\\()`, 'g');
    for (const d of f.masked.matchAll(re)) {
      const call = callAt(f, d.index + d[0].length);
      if (!call) continue;
      const name = call.args[0] ? strValue(ctx, f, call.args[0].a, call.args[0].b) : null;
      if (name === null) {
        acc.skipped.queues++;
        continue;
      }
      if (d[1]) f.queueVars.set(d[1], name);
      get(name).decl.push({ f, ev: evidence(f, d.index, call.close + 1) });
    }
  }
  for (const f of ctx.files) {
    const wre = new RegExp(`\\bnew\\s+Worker\\s*${generic}\\s*(?=\\()`, 'g');
    for (const d of f.masked.matchAll(wre)) {
      const call = callAt(f, d.index + d[0].length);
      if (!call) continue;
      const name = call.args[0] ? strValue(ctx, f, call.args[0].a, call.args[0].b) : null;
      if (name === null) {
        acc.skipped.queues++;
        continue;
      }
      const cv = call.args[2] ? objProp(f, call.args[2], 'concurrency') : null;
      const num = cv ? /^\d+$/.exec(textOf(f, cv)) : null;
      get(name).workers.push({ handler: identText(f, call.args[1]), concurrency: num ? Number(num[0]) : null, evidence: evidence(f, d.index, call.close + 1) });
    }
    const pre = new RegExp(`(?<![\\w$.])(${ID})\\s*\\.\\s*(addBulk|add)\\s*(?=\\()`, 'g');
    for (const d of f.masked.matchAll(pre)) {
      const o = origin(ctx, f, d[1]);
      const qname = o ? o.file.queueVars.get(o.name) : undefined;
      if (qname === undefined) continue; // not a known queue: no guess
      const call = callAt(f, d.index + d[0].length);
      if (!call || !call.args[0]) continue;
      let job = null;
      if (d[2] === 'add') {
        job = strValue(ctx, f, call.args[0].a, call.args[0].b);
        if (job === null) {
          acc.skipped.queues++;
          continue;
        }
      }
      get(qname).producers.push({ job: clip(job), evidence: evidence(f, d.index, call.close + 1) });
    }
  }
  const keyOf = (e) => [e.path, Number(e.lines.split('-')[0])];
  const cmp = (a, b) => {
    const [pa, la] = keyOf(a.evidence[0]);
    const [pb, lb] = keyOf(b.evidence[0]);
    return byCodeUnit(pa, pb) || la - lb;
  };
  for (const q of queues.values()) {
    q.decl.sort((a, b) => cmp({ evidence: a.ev }, { evidence: b.ev }));
    q.producers.sort(cmp);
    q.workers.sort(cmp);
    const dropped = Math.max(0, q.producers.length - MAX_NESTED) + Math.max(0, q.workers.length - MAX_NESTED);
    const item = {
      name: q.name,
      producers: q.producers.slice(0, MAX_NESTED),
      workers: q.workers.slice(0, MAX_NESTED),
      evidence: q.decl.length ? q.decl[0].ev : [(q.workers[0] ?? q.producers[0]).evidence[0]],
    };
    if (dropped) item.truncated = dropped;
    acc.queues.push(item);
  }
}

// ---------------------------------------------------------------------------------------------

const lineNo = (item) => Number(item.evidence[0].lines.split('-')[0]);

/** Extract the node-backend fragment from `files` (repo-relative paths), reading them through `read`. */
export function extractNodeBackend(files, read) {
  const acc = { skipped: Object.fromEntries(KINDS.map((k) => [k, 0])) };
  for (const k of KINDS) acc[k] = [];
  const sorted = files.slice().sort(byCodeUnit);
  const ctx = { files: [], byPath: new Map() };
  let scanned = 0;
  for (const path of sorted) {
    if (CODE_RE.test(path) && !SKIP_CODE_RE.test(path)) {
      const src = read(path);
      if (typeof src !== 'string') continue;
      const f = parseCode(path, src);
      ctx.files.push(f);
      ctx.byPath.set(path, f);
      scanned++;
    } else if (/\.prisma$/.test(path)) {
      const src = read(path);
      if (typeof src !== 'string') continue;
      scanned++;
      extractPrisma(path, src, acc);
    } else if (OPENAPI_RE.test(path)) {
      const src = read(path);
      if (typeof src !== 'string') continue;
      scanned++;
      if (/\.json$/i.test(path)) openapiJson(path, src, acc);
      else openapiYaml(path, src, acc);
    }
  }

  for (const f of ctx.files) collectRouters(f);
  const found = [];
  const mounts = [];
  const nest = [];
  const drizzle = [];
  for (const f of ctx.files) {
    extractRouterRoutes(ctx, f, acc, found, mounts);
    extractNestRoutes(ctx, f, acc, nest);
    extractTypeorm(ctx, f, acc);
    extractDrizzle(ctx, f, acc, drizzle);
  }
  for (const f of ctx.files) drizzleRelations(ctx, f, drizzle);

  const prefix = globalPrefix(ctx);
  for (const r of nest) acc.routes.push({ framework: r.framework, method: r.method, url: joinUrl(prefix, r.sub), handler: r.handler, evidence: r.ev });
  for (const r of found) {
    for (const p of prefixesOf(r.key, mounts)) acc.routes.push({ framework: r.framework, method: r.method, url: joinUrl(p, r.sub), handler: r.handler, evidence: r.ev });
  }
  extractQueues(ctx, acc);

  const truncated = {};
  const out = { scanned };
  for (const k of KINDS) {
    // Array.prototype.sort is stable, so items on one line keep their discovery order.
    const items = acc[k].slice().sort((a, b) => byCodeUnit(a.evidence[0].path, b.evidence[0].path) || lineNo(a) - lineNo(b));
    truncated[k] = Math.max(0, items.length - MAX_ITEMS);
    out[k] = items.slice(0, MAX_ITEMS);
  }
  out.skipped = acc.skipped;
  out.truncated = truncated;
  return Object.fromEntries(Object.keys(out).sort(byCodeUnit).map((k) => [k, out[k]]));
}

const plugin = {
  id: 'node-backend',
  detect: (inventory) => detectStacks(inventory.files, inventory.read ?? (() => null)).includes('node-backend'),
  extract: extractNodeBackend,
};

export default plugin;
