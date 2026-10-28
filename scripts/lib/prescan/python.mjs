// python.mjs - the python stack plug-in of prescan: static, regex/lightweight-parse extraction.
//
// extractPython(files, read) -> fragment
//   { scanned, routes[], entities[], schemas[], migrations[], sqlTables[], httpCalls[],
//     skipped{<kind>: n}, truncated{<kind>: n} }
// Routes (FastAPI/Flask decorators, Django urls), SQLAlchemy/Django entities with fields, Pydantic
// schemas, Alembic migration ops, raw SQL table names and outbound HTTP calls. Every item carries
// evidence: [{path, lines}] ("12" or "12-14"). Items are sorted by path then line; each kind is
// capped, and what the cap drops is counted in `truncated`. A recognised shape whose arguments
// cannot be resolved statically is counted in `skipped`, never guessed.
//
// The scanned code is only ever read as text: no import, no eval, no process spawn. The default
// export is the plug-in object ({ id, detect(inventory), extract(files, read) }) that
// prescan.mjs loads. Node >= 18, ESM, zero dependencies.

import { byCodeUnit } from './inventory.mjs';

export const KINDS = ['entities', 'httpCalls', 'migrations', 'routes', 'schemas', 'sqlTables'];
export const MAX_ITEMS = 300; // per kind
const MAX_FIELDS = 60; // per entity, schema or migration op
const MAX_TEXT = 200; // longest type / path / url string kept

// ---------------------------------------------------------------------------------------------
// Lexing: find string literals and comments, and produce a same-length "masked" copy of the source
// in which comments are blanked and string bodies are 'x', so structural regexes and paren matching
// never trip over text inside strings. Offsets in `masked` are offsets in the source.

function lex(src) {
  const out = src.split('');
  const strings = [];
  const n = src.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      let ps = i;
      while (ps > 0 && /[rRbBuUfF]/.test(src[ps - 1]) && i - ps < 2) ps--;
      if (ps > 0 && /[\w]/.test(src[ps - 1])) ps = i; // an identifier ending in r/b/u/f, not a prefix
      const prefix = src.slice(ps, i).toLowerCase();
      const triple = src[i + 1] === c && src[i + 2] === c;
      const q = triple ? 3 : 1;
      const bodyStart = i + q;
      let j = bodyStart;
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (triple ? src[j] === c && src[j + 1] === c && src[j + 2] === c : src[j] === c) {
          closed = true;
          break;
        }
        if (!triple && src[j] === '\n') break; // unterminated single-line string
        j++;
      }
      const bodyEnd = Math.min(j, n);
      const end = closed ? bodyEnd + q : bodyEnd;
      for (let k = bodyStart; k < bodyEnd; k++) if (src[k] !== '\n') out[k] = 'x';
      let a = ps;
      while (a > 0 && (src[a - 1] === ' ' || src[a - 1] === '\t')) a--;
      let b = end;
      while (b < n && (src[b] === ' ' || src[b] === '\t')) b++;
      strings.push({
        start: ps,
        end,
        value: src.slice(bodyStart, bodyEnd),
        prefix,
        standalone: depth === 0 && (a === 0 || src[a - 1] === '\n') && (b >= n || src[b] === '\n' || src[b] === '\r' || src[b] === '#'),
      });
      i = end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    i++;
  }
  return { masked: out.join(''), strings };
}

// One parsed file: source, masked copy, strings by start offset, line lookup, module constants.
function parseFile(path, src) {
  const { masked, strings } = lex(src);
  const strAt = new Map(strings.map((s) => [s.start, s]));
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const f = { path, src, masked, strings, strAt, lineStarts, consts: new Map() };
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
  // Module-level NAME = <string expression> constants, resolved in file order.
  for (const m of masked.matchAll(/^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=(?!=)[ \t]*/gm)) {
    const a = m.index + m[0].length;
    const v = resolveStr(f, a, logicalEnd(masked, a));
    if (v !== null) f.consts.set(m[1], v);
  }
  return f;
}

function logicalEnd(masked, from) {
  let depth = 0;
  let i = from;
  while (i < masked.length) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0) break;
    i++;
  }
  return i;
}

/** Index of the ")" matching the "(" at `open` in masked text, or -1. */
function matchParen(masked, open) {
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

const callArgs = (f, open) => {
  const close = matchParen(f.masked, open);
  return close === -1 ? null : { close, args: splitTop(f.masked, open + 1, close) };
};

const text = (f, p) => f.src.slice(p.a, p.b).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const kwOf = (f, p) => /^([A-Za-z_]\w*)\s*=(?!=)/.exec(f.masked.slice(p.a, p.b));
const isPositional = (f, p) => !kwOf(f, p) && !f.masked.startsWith('*', p.a);
const kwArg = (f, args, name) => {
  for (const p of args) {
    const m = kwOf(f, p);
    if (m && m[1] === name) return { a: p.a + m[0].length, b: p.b };
  }
  return null;
};

/**
 * Resolve a string expression between a and b: a literal, a module constant, or a "+" chain of
 * those. null when anything else (f-strings, calls, subscripts) appears.
 */
function resolveStr(f, a, b) {
  const m = f.masked;
  const pieces = [];
  let depth = 0;
  let s = a;
  for (let i = a; i < b; i++) {
    const c = m[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '+' && depth === 0) {
      pieces.push([s, i]);
      s = i + 1;
    }
  }
  pieces.push([s, b]);
  let out = '';
  for (let [x, y] of pieces) {
    while (x < y && /\s/.test(m[x])) x++;
    while (y > x && /\s/.test(m[y - 1])) y--;
    if (y <= x) return null;
    const lit = f.strAt.get(x);
    if (lit) {
      if (lit.end !== y || lit.prefix.includes('f') || lit.prefix.includes('b')) return null;
      out += lit.value;
    } else {
      const id = f.src.slice(x, y);
      if (!/^[A-Za-z_]\w*$/.test(id) || !f.consts.has(id)) return null;
      out += f.consts.get(id);
    }
  }
  return out;
}

const resolveArg = (f, p) => (p ? resolveStr(f, p.a, p.b) : null);
const isTrue = (f, p) => !!p && f.masked.slice(p.a, p.b).trim() === 'True';
const clip = (s) => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : s);

const evidence = (f, a, b) => {
  const x = f.lineOf(a);
  const y = f.lineOf(Math.max(a, b - 1));
  return [{ path: f.path, lines: y > x ? `${x}-${y}` : `${x}` }];
};

// ---------------------------------------------------------------------------------------------
// Classes: top-level `class Name(bases):` with their bodies.

function classesOf(f) {
  const out = [];
  const re = /^class[ \t]+(\w+)[ \t]*(?:\(([^)\n]*)\))?[ \t]*:/gm;
  const heads = [...f.masked.matchAll(re)];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    const bodyStart = h.index + h[0].length;
    const next = /^\S/gm;
    next.lastIndex = bodyStart;
    let nm = next.exec(f.masked);
    const bodyEnd = nm ? nm.index : f.masked.length;
    out.push({
      name: h[1],
      bases: (h[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      start: h.index,
      bodyStart,
      bodyEnd,
      end: Math.max(bodyStart, bodyEnd - (f.masked.slice(bodyStart, bodyEnd).match(/\s*$/)?.[0].length ?? 0)),
    });
  }
  return out;
}

const lastSeg = (s) => s.slice(s.lastIndexOf('.') + 1);

/** Class-level statements of a body: lines at the body's own indentation matching `re` (masked). */
function bodyMatches(f, cls, re) {
  const body = f.masked.slice(cls.bodyStart, cls.bodyEnd);
  const first = /^([ \t]+)\S/m.exec(body);
  if (!first) return [];
  const indent = first[1];
  const out = [];
  for (const m of body.matchAll(re)) {
    if (m[1] !== indent) continue;
    out.push({ m, off: cls.bodyStart + m.index });
  }
  return out;
}

const stripSa = (s) => s.replace(/^(?:sa|sqlalchemy|types|sqltypes)\./, '');

/** Column facts from the args of Column(...) / mapped_column(...) / sa.Column(...). */
function columnFacts(f, args, annotation) {
  let name = null;
  let type = null;
  let fk = null;
  const pos = args.filter((p) => isPositional(f, p));
  for (const p of pos) {
    const lit = f.strAt.get(p.a);
    if (lit && lit.end === p.b) {
      if (name === null) name = lit.value;
      continue;
    }
    const call = /^(?:[\w.]+\.)?ForeignKey\s*\(/.exec(f.masked.slice(p.a, p.b));
    if (call) {
      const inner = callArgs(f, p.a + call[0].length - 1);
      fk = inner ? resolveArg(f, inner.args[0]) : null;
      continue;
    }
    if (type === null) type = stripSa(text(f, p));
  }
  if (annotation) {
    const mm = /^(?:\w+\.)?Mapped\[(.*)\]$/.exec(annotation.trim());
    type = mm ? mm[1].trim() : annotation.trim();
  }
  const pk = isTrue(f, kwArg(f, args, 'primary_key'));
  return { name, type: clip(type), pk, fk: clip(fk) };
}

// ---------------------------------------------------------------------------------------------
// Extractors. Each pushes items {…, evidence} into `acc` and counts what it cannot resolve.

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function extractRoutes(f, acc) {
  const m = f.masked;
  // Receivers: app = FastAPI(), router = APIRouter(prefix=), app = Flask(), bp = Blueprint(url_prefix=).
  const recv = new Map();
  const recvRe = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:\w+\.)?(FastAPI|APIRouter|Flask|Blueprint)[ \t]*\(/gm;
  for (const r of m.matchAll(recvRe)) {
    const call = callArgs(f, r.index + r[0].length - 1);
    if (!call) continue;
    const kind = r[2];
    const framework = kind === 'FastAPI' || kind === 'APIRouter' ? 'fastapi' : 'flask';
    const pk = kind === 'APIRouter' ? 'prefix' : kind === 'Blueprint' ? 'url_prefix' : null;
    let prefix = '';
    if (pk) {
      const p = kwArg(f, call.args, pk);
      prefix = p ? resolveArg(f, p) : '';
    }
    recv.set(r[1], { framework, prefix });
  }

  const decRe = /^([ \t]*)@([A-Za-z_]\w*)\.(get|post|put|patch|delete|head|options|route|api_route)[ \t]*\(/gm;
  for (const d of m.matchAll(decRe)) {
    const open = d.index + d[0].length - 1;
    const call = callArgs(f, open);
    if (!call) continue;
    const info = recv.get(d[2]);
    const first = call.args[0] && !kwOf(f, call.args[0]) ? call.args[0] : kwArg(f, call.args, 'path');
    const route = first ? resolveArg(f, first) : null;
    if (!info) {
      // Unknown receiver: only a literal URL path makes this look like a route we failed to place.
      const lit = first && f.strAt.get(first.a);
      if (lit && lit.value.startsWith('/')) acc.skipped.routes++;
      continue;
    }
    if (route === null || info.prefix === null) {
      acc.skipped.routes++;
      continue;
    }
    let methods;
    if (d[3] === 'route' || d[3] === 'api_route') {
      const mk = kwArg(f, call.args, 'methods');
      if (!mk) methods = ['GET'];
      else {
        methods = f.strings.filter((s) => s.start >= mk.a && s.end <= mk.b).map((s) => s.value.toUpperCase());
        if (!methods.length) {
          acc.skipped.routes++;
          continue;
        }
      }
    } else methods = [d[3].toUpperCase()];
    const defRe = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm;
    defRe.lastIndex = call.close;
    const dm = defRe.exec(m);
    const url = joinUrl(info.prefix, route);
    const endAt = dm ? dm.index + dm[0].length : call.close + 1;
    for (const method of [...new Set(methods)]) {
      acc.routes.push({
        framework: info.framework,
        method,
        url: clip(url),
        handler: dm ? dm[1] : null,
        evidence: evidence(f, d.index + d[1].length, endAt),
      });
    }
  }

  // Django url configuration: path()/re_path()/url() inside a module that defines urlpatterns.
  if (/\burlpatterns\b/.test(m)) {
    for (const d of m.matchAll(/(?<![\w.])(path|re_path|url)[ \t]*\(/g)) {
      const open = d.index + d[0].length - 1;
      const call = callArgs(f, open);
      if (!call || !call.args.length) continue;
      const pattern = resolveArg(f, call.args[0]);
      const second = call.args[1];
      const handlerText = second ? f.masked.slice(second.a, second.b) : '';
      if (pattern === null || /^include\s*\(/.test(handlerText)) {
        acc.skipped.routes++;
        continue;
      }
      const regex = d[1] !== 'path';
      let handler = second ? f.src.slice(second.a, second.b).replace(/\.as_view\(\)$/, '') : null;
      if (handler !== null && !/^[\w.]+$/.test(handler)) handler = null;
      acc.routes.push({
        framework: 'django',
        method: 'ANY',
        url: clip(regex || pattern.startsWith('/') ? pattern : `/${pattern}`),
        handler,
        evidence: evidence(f, d.index, call.close + 1),
      });
    }
  }
}

function joinUrl(prefix, route) {
  if (!prefix) return route || '/';
  const p = prefix.replace(/\/+$/, '');
  if (!route) return p || '/';
  return p + (route.startsWith('/') ? route : `/${route}`);
}

function sqlalchemyEntity(f, cls) {
  const tn = bodyMatches(f, cls, /^([ \t]+)__tablename__[ \t]*(?::[^=\n]+)?=(?!=)[ \t]*(.*)$/gm)[0];
  if (!tn) return null;
  const a = tn.off + tn.m[0].indexOf(tn.m[2], tn.m[1].length);
  return { table: resolveStr(f, a, a + tn.m[2].length) };
}

function extractEntitiesAndSchemas(parsed, acc) {
  // Class index across the repo, so inheritance can be followed between files.
  const all = [];
  for (const f of parsed) for (const cls of classesOf(f)) all.push({ f, cls });
  const closure = (isRoot) => {
    const names = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const { cls } of all) {
        if (names.has(cls.name)) continue;
        if (cls.bases.some((b) => isRoot(lastSeg(b)) || names.has(lastSeg(b)))) {
          names.add(cls.name);
          grew = true;
        }
      }
    }
    return names;
  };
  const pydantic = closure((b) => b === 'BaseModel');
  const django = closure((b) => b === 'Model');

  for (const { f, cls } of all) {
    const ev = evidence(f, cls.start, cls.end);
    if (pydantic.has(cls.name)) {
      const fields = bodyMatches(f, cls, /^([ \t]+)([A-Za-z_]\w*)[ \t]*:[ \t]*([^=\n]+?)[ \t]*(?:=[^\n]*)?$/gm)
        .filter(({ m }) => !m[2].startsWith('model_') && !/^ClassVar\b/.test(m[3]))
        .map(({ m, off }) => {
          const a = off + m[0].indexOf(m[3], m[1].length + m[2].length);
          return { name: m[2], type: clip(f.src.slice(a, a + m[3].length).replace(/\s+/g, ' ')) };
        });
      acc.schemas.push({ name: cls.name, bases: cls.bases.map(clip), fields: fields.slice(0, MAX_FIELDS), evidence: ev });
      continue;
    }
    if (django.has(cls.name)) {
      // db_table sits in the nested `class Meta:`, one level deeper than the fields.
      const dbTable = /^([ \t]+)db_table[ \t]*=(?!=)[ \t]*(.*)$/m.exec(f.masked.slice(cls.bodyStart, cls.bodyEnd));
      let table = null;
      if (dbTable) {
        const a = cls.bodyStart + dbTable.index + dbTable[0].indexOf(dbTable[2], dbTable[1].length);
        table = resolveStr(f, a, a + dbTable[2].length);
      }
      const fields = [];
      for (const { m, off } of bodyMatches(f, cls, /^([ \t]+)(\w+)[ \t]*=(?!=)[ \t]*(?:\w+\.)*(\w+Field|ForeignKey)[ \t]*\(/gm)) {
        if (m[3] === 'ManyToManyField') continue; // a join table, not a column
        const call = callArgs(f, off + m[0].length - 1);
        if (!call) continue;
        let fk = null;
        if (m[3] === 'ForeignKey' || m[3] === 'OneToOneField') {
          const tgt = call.args[0];
          fk = tgt ? clip(resolveArg(f, tgt) ?? text(f, tgt)) : null;
        }
        fields.push({ name: m[2], type: m[3], pk: isTrue(f, kwArg(f, call.args, 'primary_key')), fk });
      }
      acc.entities.push({ framework: 'django', name: cls.name, table: clip(table), fields: fields.slice(0, MAX_FIELDS), evidence: ev });
      continue;
    }
    const sa = sqlalchemyEntity(f, cls);
    if (sa) {
      if (sa.table === null) {
        acc.skipped.entities++;
        continue;
      }
      const fields = [];
      const re = /^([ \t]+)([A-Za-z_]\w*)[ \t]*(?::[ \t]*([^=\n]+?))?[ \t]*=(?!=)[ \t]*(?:\w+\.)*(Column|mapped_column)[ \t]*\(/gm;
      for (const { m, off } of bodyMatches(f, cls, re)) {
        const call = callArgs(f, off + m[0].length - 1);
        if (!call) continue;
        let annotation = null;
        if (m[3]) {
          const a = off + m[0].indexOf(m[3], m[1].length + m[2].length);
          annotation = f.src.slice(a, a + m[3].length);
        }
        const c = columnFacts(f, call.args, annotation);
        fields.push({ name: m[2], type: c.type, pk: c.pk, fk: c.fk });
      }
      acc.entities.push({ framework: 'sqlalchemy', name: cls.name, table: clip(sa.table), fields: fields.slice(0, MAX_FIELDS), evidence: ev });
    }
  }
}

const MIGRATION_TABLE_ARG = {
  create_table: 0, drop_table: 0, rename_table: 0, add_column: 0, drop_column: 0, alter_column: 0,
  batch_alter_table: 0, bulk_insert: 0, create_index: 1, drop_index: 1, create_foreign_key: 1,
  drop_constraint: 1, create_unique_constraint: 1, create_primary_key: 1, create_check_constraint: 1,
  execute: null,
};

function extractMigrations(f, acc) {
  if (!/\bfrom\s+alembic\s+import\s+[^\n]*\bop\b|\bimport\s+alembic\b|\balembic\.op\b/.test(f.masked)) return;
  const rev = (name) => {
    const m = new RegExp(`^${name}\\b[^=\\n]*=(?!=)[ \\t]*`, 'm').exec(f.masked);
    if (!m) return undefined;
    const a = m.index + m[0].length;
    const b = logicalEnd(f.masked, a);
    if (f.masked.slice(a, b).trim() === 'None') return null;
    return resolveStr(f, a, b) ?? undefined;
  };
  const revision = rev('revision') ?? null;
  const downRevision = rev('down_revision') ?? null;
  const defs = [...f.masked.matchAll(/^(?:async[ \t]+)?def[ \t]+(upgrade|downgrade)\b/gm)].map((d) => ({ at: d.index, name: d[1] }));
  for (const d of f.masked.matchAll(/(?<![\w.])op\.(\w+)[ \t]*\(/g)) {
    const name = d[1];
    const call = callArgs(f, d.index + d[0].length - 1);
    if (!call) continue;
    if (!(name in MIGRATION_TABLE_ARG)) {
      acc.skipped.migrations++;
      continue;
    }
    let table = null;
    const ti = MIGRATION_TABLE_ARG[name];
    if (ti !== null) {
      const pos = call.args.filter((p) => isPositional(f, p));
      const tArg = pos[ti] ?? kwArg(f, call.args, 'table_name');
      table = resolveArg(f, tArg);
      if (table === null) {
        acc.skipped.migrations++;
        continue;
      }
    }
    const pos = call.args.filter((p) => isPositional(f, p));
    const item = {
      op: name,
      table: clip(table),
      revision,
      down_revision: downRevision,
      direction: defs.filter((x) => x.at < d.index).pop()?.name ?? null,
    };
    const columns = [];
    const colCall = (p) => {
      const cm = /^(?:[\w.]+\.)?Column[ \t]*\(/.exec(f.masked.slice(p.a, p.b));
      if (!cm) return null;
      const inner = callArgs(f, p.a + cm[0].length - 1);
      return inner ? columnFacts(f, inner.args, null) : null;
    };
    if (name === 'create_table') {
      for (const p of pos.slice(1)) {
        const c = colCall(p);
        if (c && c.name) columns.push(c);
      }
    } else if (name === 'add_column') {
      const c = pos[1] ? colCall(pos[1]) : null;
      if (c && c.name) columns.push(c);
    } else if (name === 'drop_column' || name === 'alter_column') {
      const cn = resolveArg(f, pos[1]);
      if (cn) columns.push({ name: cn, type: null, pk: false, fk: null });
    } else if (name === 'create_index' || name === 'drop_index' || name.endsWith('_constraint') || name.startsWith('create_')) {
      const nm = resolveArg(f, pos[0]);
      if (nm) item.name = clip(nm);
    }
    if (columns.length) item.columns = columns.slice(0, MAX_FIELDS);
    item.evidence = evidence(f, d.index, call.close + 1);
    acc.migrations.push(item);
  }
}

// Raw SQL inside string literals. A string must read as a statement; a docstring that merely
// starts with "Select ..." is a standalone expression statement and is ignored.
const SQL_KEYWORDS = new Set(['select', 'lateral', 'only', 'if', 'not', 'exists', 'values', 'set', 'where', 'unnest', 'table', 'temp', 'temporary']);

function extractSql(f, acc) {
  for (const s of f.strings) {
    if (s.standalone || s.prefix.includes('b')) continue;
    const body = s.value;
    const verb = /^\s*(select|with|insert|update|delete|create|alter|drop|truncate|replace|merge)\b/i.exec(body)?.[1]?.toLowerCase();
    if (!verb) continue;
    const shaped =
      verb === 'select' || verb === 'with' ? /\bfrom\s+[\w"`{[]/i.test(body)
      : verb === 'update' ? /^\s*update\s+[\w."`{]+\s+set\b/i.test(body)
      : verb === 'insert' ? /^\s*insert\s+(?:or\s+\w+\s+)?into\s/i.test(body)
      : verb === 'delete' ? /^\s*delete\s+from\s/i.test(body)
      : verb === 'create' || verb === 'alter' || verb === 'drop' || verb === 'truncate' ? /\btable\b|^\s*truncate\s/i.test(body)
      : true;
    if (!shaped) continue;
    const ev = evidence(f, s.start, s.end);
    const seen = new Set();
    let firstFrom = true;
    const re = /\b(from|join|into|update|table)\s+(?:if\s+(?:not\s+)?exists\s+)?(\{|[A-Za-z_"`][\w."`$]*)/gi;
    for (const m of body.matchAll(re)) {
      const kw = m[1].toLowerCase();
      const tableRaw = m[2];
      if (kw === 'update' && verb !== 'update') continue;
      if (kw === 'table' && !['create', 'alter', 'drop', 'truncate'].includes(verb)) continue;
      if (kw === 'into' && verb !== 'insert') continue;
      if (tableRaw === '{') {
        acc.skipped.sqlTables++;
        continue;
      }
      const table = tableRaw.replace(/["`]/g, '');
      if (SQL_KEYWORDS.has(table.toLowerCase())) continue;
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
      acc.sqlTables.push({ table: clip(table), op, evidence: ev });
    }
  }
}

// Outbound HTTP: requests / httpx module calls, sessions and clients created in the same file,
// and urllib's urlopen.
function extractHttp(f, acc) {
  const m = f.masked;
  const clients = new Map(); // variable -> client family
  const fam = (s) => (s.startsWith('requests') ? 'requests' : s.startsWith('httpx') ? 'httpx' : 'aiohttp');
  const mk = '(requests\\.Session|httpx\\.(?:Async)?Client|aiohttp\\.ClientSession)';
  for (const r of m.matchAll(new RegExp(`^[ \\t]*([A-Za-z_]\\w*)[ \\t]*=[ \\t]*${mk}[ \\t]*\\(`, 'gm'))) clients.set(r[1], fam(r[2]));
  for (const r of m.matchAll(new RegExp(`\\bwith[ \\t]+${mk}[ \\t]*\\([^)]*\\)[ \\t]+as[ \\t]+([A-Za-z_]\\w*)`, 'g'))) clients.set(r[2], fam(r[1]));
  const emit = (client, methodRaw, urlArg, d, close) => {
    const url = urlArg ? resolveArg(f, urlArg) : null;
    const method = methodRaw ? methodRaw.toUpperCase() : null;
    if (url === null || !method) {
      acc.skipped.httpCalls++;
      return;
    }
    acc.httpCalls.push({ client, method, url: clip(url), evidence: evidence(f, d.index, close + 1) });
  };
  const re = /(?<![\w.])([A-Za-z_]\w*)\.(get|post|put|patch|delete|head|options|request)[ \t]*\(/g;
  for (const d of m.matchAll(re)) {
    const client = d[1] === 'requests' || d[1] === 'httpx' ? d[1] : clients.get(d[1]);
    if (!client) continue; // an unknown receiver (cache.get(...)) is not a guess we make
    const call = callArgs(f, d.index + d[0].length - 1);
    if (!call) continue;
    const pos = call.args.filter((p) => isPositional(f, p));
    if (d[2] === 'request') {
      const lit = pos[0] && f.strAt.get(pos[0].a);
      emit(client, lit ? lit.value : null, pos[1] ?? kwArg(f, call.args, 'url'), d, call.close);
    } else emit(client, d[2], pos[0] ?? kwArg(f, call.args, 'url'), d, call.close);
  }
  if (/\burllib\b/.test(m)) {
    for (const d of m.matchAll(/(?<![\w])(?:urllib\.request\.)?urlopen[ \t]*\(/g)) {
      const call = callArgs(f, d.index + d[0].length - 1);
      if (!call) continue;
      const pos = call.args.filter((p) => isPositional(f, p));
      const hasData = pos.length > 1 || !!kwArg(f, call.args, 'data');
      emit('urllib', hasData ? 'POST' : 'GET', pos[0] ?? kwArg(f, call.args, 'url'), d, call.close);
    }
  }
}

const lineNo = (item) => Number(item.evidence[0].lines.split('-')[0]);

/** Extract the python fragment from `files` (repo-relative paths), reading them through `read`. */
export function extractPython(files, read) {
  const acc = { skipped: Object.fromEntries(KINDS.map((k) => [k, 0])) };
  for (const k of KINDS) acc[k] = [];
  const parsed = [];
  for (const path of files.filter((p) => /\.py$/.test(p)).slice().sort(byCodeUnit)) {
    const src = read(path);
    if (typeof src !== 'string') continue;
    parsed.push(parseFile(path, src));
  }
  for (const f of parsed) {
    extractRoutes(f, acc);
    extractMigrations(f, acc);
    extractSql(f, acc);
    extractHttp(f, acc);
  }
  extractEntitiesAndSchemas(parsed, acc);

  const truncated = {};
  const out = { scanned: parsed.length };
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
  id: 'python',
  detect: (inventory) => inventory.files.some((p) => /\.py$/.test(p)),
  extract: extractPython,
};

export default plugin;
