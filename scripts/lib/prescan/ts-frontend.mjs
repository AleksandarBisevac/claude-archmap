// ts-frontend.mjs - the ts-frontend stack plug-in of prescan: static, regex/lightweight-parse extraction.
//
// extractTsFrontend(files, read) -> fragment
//   { scanned, routes[], stores[], apiCalls[], skipped{<kind>: n}, truncated{<kind>: n} }
// routes   React Router (JSX <Route> and data-router objects), Next.js app/ and pages/ dirs (page files,
//          route handlers, pages/api), React Navigation <X.Screen> entries
// stores   Redux Toolkit slices, Zustand stores, RTK Query endpoints, React Query keys (useQuery/useMutation)
// apiCalls fetch, axios (direct and axios.create instances) and RTK Query endpoints, with method and path
// Every item carries evidence: [{path, lines}] ("12" or "12-14"). Items are sorted by path then line; each
// kind is capped, and what the cap drops is counted in `truncated`. A recognised shape whose arguments
// cannot be resolved statically is counted in `skipped`, never guessed.
//
// Next.js app/ and pages/ count only in a package (nearest package.json) that depends on `next`; src/app
// and src/pages count only when the package root has no app/ respectively pages/ of its own.
//
// The scanned code is only ever read as text: no import, no eval, no process spawn. The default export is
// the plug-in object ({ id, detect(inventory), extract(files, read) }) that prescan.mjs loads.
// Node >= 18, ESM, zero dependencies.

import { byCodeUnit } from './inventory.mjs';
import { detectStacks } from './generic.mjs';

export const KINDS = ['apiCalls', 'routes', 'stores'];
export const MAX_ITEMS = 300; // per kind
const MAX_TEXT = 200; // longest name / path / url string kept
const MAX_NAMES = 60; // longest list of action / state names kept

const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const NOT_SOURCE = /\.d\.ts$|\.(?:test|spec)\.[a-z]+$/;
const ID = '[A-Za-z_$][\\w$]*';
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------------------------------------
// Lexing: comments blanked, string and template bodies replaced by 'x' in a same-length "masked" copy,
// so structural regexes and bracket matching never trip over text inside strings or comments.

function scanTemplate(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\') j += 2;
    else if (c === '`') return j + 1;
    else if (c === '$' && src[j + 1] === '{') j = scanInterpolation(src, j + 2);
    else j++;
  }
  return n;
}

function scanInterpolation(src, from) {
  const n = src.length;
  let depth = 1;
  let j = from;
  while (j < n) {
    const c = src[j];
    if (c === '`') j = scanTemplate(src, j);
    else if (c === '"' || c === "'") {
      j++;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j++;
    } else if (c === '{') {
      depth++;
      j++;
    } else if (c === '}') {
      depth--;
      j++;
      if (depth === 0) return j;
    } else j++;
  }
  return n;
}

function lex(src) {
  const out = src.split('');
  const strings = [];
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (src[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const j = e === -1 ? n : e + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === c) {
          closed = true;
          break;
        } else if (src[j] === '\n') break; // unterminated single-line string
        else j++;
      }
      const bodyEnd = Math.min(j, n);
      for (let k = i + 1; k < bodyEnd; k++) if (src[k] !== '\n') out[k] = 'x';
      const end = closed ? bodyEnd + 1 : bodyEnd;
      strings.push({ start: i, end, value: src.slice(i + 1, bodyEnd), quote: c });
      i = end;
    } else if (c === '`') {
      const end = scanTemplate(src, i);
      const bodyEnd = src[end - 1] === '`' && end - 1 > i ? end - 1 : end;
      for (let k = i + 1; k < bodyEnd; k++) if (src[k] !== '\n') out[k] = 'x';
      strings.push({ start: i, end, value: src.slice(i + 1, bodyEnd), quote: '`' });
      i = end;
    } else i++;
  }
  return { masked: out.join(''), strings };
}

const OPEN = '([{';
const CLOSE = ')]}';

/** Index of the bracket matching the one at `open` in masked text, or -1. */
function matchBracket(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
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
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      push(i);
      s = i + 1;
    }
  }
  push(b);
  return out;
}

// One parsed file: source, masked copy, strings by start offset, line lookup, imports, constants.
function parseFile(path, src) {
  const lexed = lex(src);
  const strings = lexed.strings;
  // Commas inside generic arguments before a call ("build.query<A, B>(") are not argument separators.
  const masked = lexed.masked.replace(/[\w$\])]\s*<[^<>(){};]*(?:<[^<>(){};]*>[^<>(){};]*)*>(?=\s*\()/g, (g) => g.replace(/,/g, ' '));
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const f = { path, src, masked, strings, strAt: new Map(strings.map((s) => [s.start, s])), consts: new Map(), specs: new Set(), names: new Set() };
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
  f.lines = (a, b) => {
    const la = f.lineOf(a);
    const lb = f.lineOf(Math.max(a, b - 1));
    return la === lb ? `${la}` : `${la}-${lb}`;
  };
  f.ev = (a, b) => [{ path, lines: f.lines(a, b) }];
  for (const m of src.matchAll(/\b(?:from|import)\s*['"]([^'"\n]+)['"]/g)) f.specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s+([^;'"]*?)\s+from\s*['"]/g)) for (const w of m[1].match(/[A-Za-z_$][\w$]*/g) ?? []) f.names.add(w);
  // Module-level const NAME = <string expression>, resolved in file order.
  for (const m of masked.matchAll(new RegExp(`^(?:export\\s+)?const\\s+(${ID})\\s*(?::[^=\\n]+)?=(?![=>])\\s*`, 'gm'))) {
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
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if ((c === '\n' || c === ';') && depth <= 0) break;
    i++;
  }
  return i;
}

const hasSpec = (f, re) => [...f.specs].some((s) => re.test(s));

const CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** A template body with ${ident} / ${a.b} interpolations -> string with {ident} placeholders; null otherwise. */
function resolveTemplate(f, body) {
  let bad = false;
  const out = body.replace(/\$\{([^}]*)\}/g, (_, expr) => {
    const e = expr.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(e) && f.consts.has(e)) return f.consts.get(e);
    if (CHAIN.test(e)) return `{${e}}`;
    bad = true;
    return '';
  });
  return bad || out.includes('${') ? null : out;
}

/** Resolve a string expression between a and b: literals, templates, module constants and "+" chains of them. */
function resolveStr(f, a, b) {
  const m = f.masked;
  const pieces = [];
  let depth = 0;
  let s = a;
  for (let i = a; i < b; i++) {
    const c = m[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
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
    if (x >= y) return null;
    const lit = f.strAt.get(x);
    if (lit && lit.end === y) {
      const v = lit.quote === '`' ? resolveTemplate(f, lit.value) : lit.value;
      if (v === null) return null;
      out += v;
      continue;
    }
    const name = f.src.slice(x, y);
    if (/^[A-Za-z_$][\w$]*$/.test(name) && f.consts.has(name)) {
      out += f.consts.get(name);
      continue;
    }
    return null;
  }
  return out;
}

const joinUrl = (base, u) => (/^https?:\/\//.test(u) || !base ? u : `${base.replace(/\/+$/, '')}/${u.replace(/^\/+/, '')}`);
const validUrl = (u) => (typeof u === 'string' && /^(?:\/|https?:\/\/)/.test(u) ? u.slice(0, MAX_TEXT) : null);

/** Properties of the object literal opening at `open`: [{key, kind, a, b, pa, pb}]; a..b is the value. */
function propsOf(f, open) {
  const close = matchBracket(f.masked, open);
  if (close === -1 || f.masked[open] !== '{') return [];
  const out = [];
  for (const p of splitTop(f.masked, open + 1, close)) {
    const text = f.src.slice(p.a, p.b);
    let m;
    if (text.startsWith('...')) out.push({ key: null, kind: 'spread', a: p.a, b: p.b, pa: p.a, pb: p.b });
    else if ((m = new RegExp(`^(?:(${ID})|'([^']*)'|"([^"]*)")\\s*:(?!:)\\s*`).exec(text))) {
      out.push({ key: m[1] ?? m[2] ?? m[3], kind: 'value', a: p.a + m[0].length, b: p.b, pa: p.a, pb: p.b });
    } else if ((m = new RegExp(`^(?:async\\s+)?(?:get\\s+|set\\s+)?\\*?\\s*(${ID})\\s*(?:<[^()]*>)?\\(`).exec(text))) {
      out.push({ key: m[1], kind: 'method', a: p.a, b: p.b, pa: p.a, pb: p.b });
    } else if ((m = new RegExp(`^(${ID})$`).exec(text))) {
      out.push({ key: m[1], kind: 'shorthand', a: p.a, b: p.b, pa: p.a, pb: p.b });
    }
  }
  return out;
}

const prop = (props, key) => props.find((p) => p.key === key);

/** Open-bracket index of a call's "(" -> {close, args}; null when unbalanced. */
const callArgs = (f, open) => {
  const close = matchBracket(f.masked, open);
  return close === -1 ? null : { close, args: splitTop(f.masked, open + 1, close) };
};

/** Value of a quoted-string-only expression between a and b, or null. */
const litStr = (f, a, b) => {
  const s = f.strAt.get(a);
  return s && s.end === b && s.quote !== '`' ? s.value : null;
};

/** Top-level attributes of a JSX tag whose name ends at `from` and whose ">" is at `to`. */
function attrsOf(f, from, to) {
  const m = f.masked;
  const out = new Map();
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(m[i])) i++;
    const nm = /^[A-Za-z_$][\w$:.-]*/.exec(m.slice(i, to));
    if (!nm) {
      i++;
      continue;
    }
    i += nm[0].length;
    let j = i;
    while (j < to && /\s/.test(m[j])) j++;
    if (m[j] !== '=') {
      out.set(nm[0], { kind: 'bool' });
      continue;
    }
    j++;
    while (j < to && /\s/.test(m[j])) j++;
    const s = f.strAt.get(j);
    if (s) {
      out.set(nm[0], { kind: 'str', a: j, b: s.end });
      i = s.end;
    } else if (m[j] === '{') {
      const close = matchBracket(m, j);
      if (close === -1) break;
      out.set(nm[0], { kind: 'expr', a: j + 1, b: close });
      i = close + 1;
    } else break;
  }
  return out;
}

/** Index of the ">" ending the JSX opening tag that starts at `from` (after the tag name), or -1. */
function tagEnd(m, from) {
  let depth = 0;
  for (let i = from; i < m.length; i++) {
    const c = m[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

/** A JSX attribute that should hold a string: {ok, value}. ok=false when present but not resolvable. */
function attrStr(f, attr) {
  if (!attr) return { ok: true, value: null };
  if (attr.kind === 'str') return { ok: true, value: f.strAt.get(attr.a).value };
  if (attr.kind === 'expr') {
    const v = resolveStr(f, attr.a, attr.b);
    return v === null ? { ok: false, value: null } : { ok: true, value: v };
  }
  return { ok: false, value: null };
}

const componentOf = (f, a, b) => {
  const t = f.src.slice(a, b);
  const m = /^\s*(?:<\s*([A-Z][\w.]*)|([A-Z][\w.]*)\s*$)/.exec(t);
  return m ? (m[1] ?? m[2]).slice(0, MAX_TEXT) : null;
};

const joinRoute = (parent, p) => (p.startsWith('/') ? p : parent ? `${parent.replace(/\/+$/, '')}/${p}` : p);

// ---------------------------------------------------------------------------------------------
// Routes

function routeItem(f, framework, kind, method, url, name, component, a, b) {
  return {
    framework,
    kind,
    method,
    url: url === null ? null : url.slice(0, MAX_TEXT),
    name: name === null ? null : name.slice(0, MAX_TEXT),
    component,
    evidence: f.ev(a, b),
  };
}

/** React Router JSX: <Route path="..." element={<X />}> nesting, joined into full paths. */
function jsxRoutes(f, acc) {
  const stack = [];
  for (const t of f.masked.matchAll(/<\/Route\s*>|(?<![\w$])<Route(?![\w$.:-])/g)) {
    if (t[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    const nameEnd = t.index + t[0].length;
    const end = tagEnd(f.masked, nameEnd);
    if (end === -1) continue;
    const selfClosing = f.masked[end - 1] === '/';
    const attrs = attrsOf(f, nameEnd, selfClosing ? end - 1 : end);
    const parent = stack.length ? stack[stack.length - 1] : '';
    let full = parent;
    const pa = attrs.get('path');
    if (pa) {
      const { ok, value } = attrStr(f, pa);
      if (!ok || parent === null) {
        acc.skipped.routes++;
        full = null;
      } else {
        full = joinRoute(parent, value);
        const el = attrs.get('element') ?? attrs.get('Component') ?? attrs.get('component');
        acc.routes.push(routeItem(f, 'react-router', 'page', null, full, null, el && el.kind === 'expr' ? componentOf(f, el.a, el.b) : null, t.index, end));
      }
    }
    if (!selfClosing) stack.push(full);
  }
}

/** React Router data routers: createBrowserRouter([...]) and useRoutes([...]). */
function objectRoutes(f, acc) {
  const walk = (open, parent) => {
    const close = f.masked[open] === '[' ? matchBracket(f.masked, open) : -1;
    if (close === -1) {
      acc.skipped.routes++;
      return;
    }
    for (const el of splitTop(f.masked, open + 1, close)) {
      if (f.masked[el.a] !== '{') {
        acc.skipped.routes++;
        continue;
      }
      const props = propsOf(f, el.a);
      let full = parent;
      const pp = prop(props, 'path');
      if (pp) {
        const v = pp.kind === 'value' ? resolveStr(f, pp.a, pp.b) : null;
        if (v === null || parent === null) {
          acc.skipped.routes++;
          full = null;
        } else {
          full = joinRoute(parent, v);
          const cp = prop(props, 'element') ?? prop(props, 'Component');
          acc.routes.push(routeItem(f, 'react-router', 'page', null, full, null, cp && cp.kind === 'value' ? componentOf(f, cp.a, cp.b) : null, pp.pa, pp.pb));
        }
      }
      const ch = prop(props, 'children');
      if (ch && ch.kind === 'value') walk(ch.a, full);
    }
  };
  for (const m of f.masked.matchAll(/(?<![\w$.])(?:createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes)\s*\(/g)) {
    const call = callArgs(f, m.index + m[0].length - 1);
    if (!call || !call.args.length) continue;
    walk(call.args[0].a, '');
  }
}

/** React Navigation: <Stack.Screen name="Home" component={HomeScreen} />. */
function screenRoutes(f, acc) {
  for (const t of f.masked.matchAll(new RegExp(`(?<![\\w$])<${ID}\\.Screen(?![\\w$.:-])`, 'g'))) {
    const nameEnd = t.index + t[0].length;
    const end = tagEnd(f.masked, nameEnd);
    if (end === -1) continue;
    const attrs = attrsOf(f, nameEnd, f.masked[end - 1] === '/' ? end - 1 : end);
    const { ok, value } = attrStr(f, attrs.get('name'));
    if (!ok || value === null) {
      acc.skipped.routes++;
      continue;
    }
    const c = attrs.get('component');
    acc.routes.push(routeItem(f, 'react-navigation', 'screen', null, null, value, c && c.kind === 'expr' ? componentOf(f, c.a, c.b) : null, t.index, end));
  }
}

const dirOf = (p) => p.slice(0, p.lastIndexOf('/') === -1 ? 0 : p.lastIndexOf('/'));

/** Nearest ancestor directory of `path` that holds a package.json ('' = repo root), or null. */
function packageRootOf(pkgDirs, path) {
  let d = dirOf(path);
  for (;;) {
    if (pkgDirs.has(d)) return d;
    if (d === '') return null;
    d = dirOf(d);
  }
}

const defaultExport = (f) => {
  let m = new RegExp(`(?<![\\w$])export\\s+default\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*(${ID})?|class\\s+(${ID}))`).exec(f.masked);
  if (m) return { index: m.index, name: m[1] ?? m[2] ?? null };
  // "export default Name;" names a component; "export default connect(App)" or "{...}" does not.
  m = new RegExp(`(?<![\\w$])export\\s+default\\s+(${ID})[ \\t]*;?[ \\t]*(?:\\n|$)`).exec(f.masked);
  if (m) return { index: m.index, name: m[1] };
  m = /(?<![\w$])export\s+default\b/.exec(f.masked);
  return m ? { index: m.index, name: null } : null;
};

/** Next.js file routes: app/**\/page, app/**\/route, pages/** and pages/api/**. */
function nextRoutes(parsedByPath, files, read, acc) {
  const pkgDirs = new Map();
  for (const p of files) {
    if (p.slice(p.lastIndexOf('/') + 1) !== 'package.json') continue;
    let deps = {};
    try {
      const pkg = JSON.parse(read(p));
      deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    } catch {
      /* unreadable package.json: not a next package */
    }
    pkgDirs.set(dirOf(p), Object.prototype.hasOwnProperty.call(deps, 'next'));
  }
  const dirs = new Set(pkgDirs.keys());
  const rootDirs = new Map(); // next package root -> {app: bool, pages: bool} found at its root
  const owned = [];
  for (const p of parsedByPath.keys()) {
    const root = packageRootOf(dirs, p);
    if (root === null || !pkgDirs.get(root)) continue;
    const rel = root ? p.slice(root.length + 1) : p;
    owned.push({ p, root, rel });
    const flags = rootDirs.get(root) ?? { app: false, pages: false };
    if (rel.startsWith('app/')) flags.app = true;
    if (rel.startsWith('pages/')) flags.pages = true;
    rootDirs.set(root, flags);
  }
  for (const { p, root, rel } of owned) {
    const flags = rootDirs.get(root);
    let kind = null;
    let under = null;
    if (rel.startsWith('app/')) [kind, under] = ['app', rel.slice(4)];
    else if (rel.startsWith('pages/')) [kind, under] = ['pages', rel.slice(6)];
    else if (rel.startsWith('src/app/') && !flags.app) [kind, under] = ['app', rel.slice(8)];
    else if (rel.startsWith('src/pages/') && !flags.pages) [kind, under] = ['pages', rel.slice(10)];
    if (!kind) continue;
    const f = parsedByPath.get(p);
    const segs = under.replace(/\.[a-z]+$/, '').split('/');
    const last = segs.pop();
    if (kind === 'app') {
      if (segs.some((s) => s.startsWith('_')) || (last !== 'page' && last !== 'route')) continue;
      const url = `/${segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/')}`;
      if (last === 'page') {
        const d = defaultExport(f);
        if (d) acc.routes.push(routeItem(f, 'next-app', 'page', null, url, null, d.name, d.index, d.index + 1));
      } else {
        for (const m of f.masked.matchAll(/(?<![\w$])export\s+(?:async\s+function\s+|function\s+|const\s+|let\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?![\w$])/g)) {
          acc.routes.push(routeItem(f, 'next-app', 'handler', m[1], url, null, null, m.index, m.index + 1));
        }
      }
    } else {
      if (last.startsWith('_')) continue;
      const d = defaultExport(f);
      if (!d) continue;
      const parts = last === 'index' ? segs : [...segs, last];
      const url = `/${parts.join('/')}`;
      const api = segs[0] === 'api';
      acc.routes.push(routeItem(f, 'next-pages', api ? 'handler' : 'page', api ? 'ANY' : null, url, null, d.name, d.index, d.index + 1));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stores

const varBefore = (f, off) => {
  const m = new RegExp(`(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?$`).exec(f.masked.slice(Math.max(0, off - 200), off));
  return m ? m[1] : null;
};

/** The innermost top-level function or arrow-const name starting before `off`, or null. */
function enclosingName(f, off) {
  if (!f.fnNames) {
    f.fnNames = [];
    const re = new RegExp(
      `^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})|^(?:export\\s+)?(?:const|let)\\s+(${ID})\\s*(?::[^=\\n]+)?=\\s*(?:async\\s*)?(?:\\(|function|${ID}\\s*=>)`,
      'gm',
    );
    for (const m of f.masked.matchAll(re)) f.fnNames.push({ index: m.index, name: m[1] ?? m[2] });
  }
  let best = null;
  for (const x of f.fnNames) if (x.index < off) best = x.name;
  return best;
}

const names = (props, pick) => props.filter(pick).map((p) => p.key).slice(0, MAX_NAMES);

/** Object literal "{" right after the first "=>" (optionally parenthesised) between a and b, or -1. */
function arrowObject(f, a, b) {
  const m = /=>\s*\(?\s*\{/.exec(f.masked.slice(a, b));
  return m ? a + m.index + m[0].length - 1 : -1;
}

function reduxSlices(f, acc) {
  if (!hasSpec(f, /^@reduxjs\/toolkit(\/|$)/)) return;
  for (const m of f.masked.matchAll(/(?<![\w$.])createSlice\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const call = callArgs(f, open);
    if (!call || !call.args.length || f.masked[call.args[0].a] !== '{') {
      acc.skipped.stores++;
      continue;
    }
    const props = propsOf(f, call.args[0].a);
    const np = prop(props, 'name');
    const name = np && np.kind === 'value' ? litStr(f, np.a, np.b) : null;
    const rp = prop(props, 'reducers');
    let rObj = rp && rp.kind === 'value' ? (f.masked[rp.a] === '{' ? rp.a : arrowObject(f, rp.a, rp.b)) : -1;
    if (name === null || rObj === -1) {
      acc.skipped.stores++;
      continue;
    }
    const ip = prop(props, 'initialState');
    const state = ip && ip.kind === 'value' && f.masked[ip.a] === '{' ? names(propsOf(f, ip.a), (p) => p.key !== null) : null;
    acc.stores.push({
      library: 'redux-toolkit',
      kind: 'slice',
      name: name.slice(0, MAX_TEXT),
      variable: varBefore(f, m.index),
      actions: names(propsOf(f, rObj), (p) => p.key !== null),
      state,
      evidence: f.ev(m.index, call.close + 1),
    });
  }
}

const ACTION_VALUE = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^(?:async\s+)?function\b/;

function zustandStores(f, acc) {
  if (!hasSpec(f, /^zustand(\/|$)/)) return;
  for (const m of f.masked.matchAll(/(?<![\w$.])create\s*(?:<[^()]*?>)?\s*(?:\(\s*\)\s*)?\(/g)) {
    const call = callArgs(f, m.index + m[0].length - 1);
    if (!call) continue;
    const obj = arrowObject(f, m.index + m[0].length, call.close);
    if (obj === -1) {
      acc.skipped.stores++;
      continue;
    }
    const props = propsOf(f, obj);
    const isAction = (p) => p.kind === 'method' || (p.kind === 'value' && ACTION_VALUE.test(f.masked.slice(p.a, p.b)));
    acc.stores.push({
      library: 'zustand',
      kind: 'store',
      name: varBefore(f, m.index),
      variable: null,
      actions: names(props, (p) => p.key !== null && isAction(p)),
      state: names(props, (p) => p.key !== null && !isAction(p)),
      evidence: f.ev(m.index, call.close + 1),
    });
  }
}

/** RTK Query createApi({ baseQuery, endpoints: (build) => ({ name: build.query({ query }) }) }). */
function rtkQuery(f, acc) {
  if (!hasSpec(f, /^@reduxjs\/toolkit\/query(\/|$)/)) return;
  for (const m of f.masked.matchAll(/(?<![\w$.])createApi\s*\(/g)) {
    const call = callArgs(f, m.index + m[0].length - 1);
    if (!call || !call.args.length || f.masked[call.args[0].a] !== '{') {
      acc.skipped.stores++;
      continue;
    }
    const props = propsOf(f, call.args[0].a);
    const api = varBefore(f, m.index);
    // The base url: fetchBaseQuery({ baseUrl }) joins it to each path; any other baseQuery is unknown.
    let base = null;
    const bq = prop(props, 'baseQuery');
    if (bq && bq.kind === 'value') {
      const fb = /^fetchBaseQuery\s*\(/.exec(f.masked.slice(bq.a, bq.b));
      const fc = fb ? callArgs(f, bq.a + fb[0].length - 1) : null;
      if (fc && !fc.args.length) base = '';
      else if (fc && f.masked[fc.args[0].a] === '{') {
        const bu = prop(propsOf(f, fc.args[0].a), 'baseUrl');
        base = bu ? (bu.kind === 'value' ? resolveStr(f, bu.a, bu.b) : null) : '';
      }
    }
    const ep = prop(props, 'endpoints');
    const eObj = ep && ep.kind === 'value' ? arrowObject(f, ep.a, ep.b) : -1;
    if (eObj === -1) {
      acc.skipped.stores++;
      continue;
    }
    for (const e of propsOf(f, eObj)) {
      if (e.kind !== 'value') continue;
      const em = new RegExp(`^${ID}\\s*\\.\\s*(query|mutation|infiniteQuery)\\s*(?:<[^()]*?>)?\\s*\\(`).exec(f.masked.slice(e.a, e.b));
      if (!em) continue;
      const ec = callArgs(f, e.a + em[0].length - 1);
      acc.stores.push({
        library: 'rtk-query',
        kind: em[1] === 'mutation' ? 'mutation' : 'query',
        name: e.key.slice(0, MAX_TEXT),
        api,
        evidence: f.ev(e.pa, e.pb),
      });
      const qp = ec && ec.args.length && f.masked[ec.args[0].a] === '{' ? prop(propsOf(f, ec.args[0].a), 'query') : null;
      if (!qp) continue;
      const call2 = rtkCall(f, qp, base);
      if (call2) acc.apiCalls.push({ client: 'rtk-query', method: call2.method, url: call2.url, evidence: f.ev(qp.pa, qp.pb) });
      else acc.skipped.apiCalls++;
    }
  }
}

/** `query: (arg) => '/path'` or `=> ({ url, method })` -> {method, url} joined to `base`; null if not static. */
function rtkCall(f, qp, base) {
  if (qp.kind !== 'value' || base === null) return null;
  const m = f.masked;
  let depth = 0;
  let arrow = -1;
  for (let i = qp.a; i < qp.b; i++) {
    const c = m[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === '=' && m[i + 1] === '>' && depth === 0) {
      arrow = i + 2;
      break;
    }
  }
  if (arrow === -1) return null;
  let a = arrow;
  let b = qp.b;
  while (a < b && /\s/.test(m[a])) a++;
  if (m[a] === '(' && matchBracket(m, a) === b - 1) {
    a++;
    b--;
    while (a < b && /\s/.test(m[a])) a++;
  }
  if (m[a] === '{') {
    const props = propsOf(f, a);
    const up = prop(props, 'url');
    const mp = prop(props, 'method');
    const u = up && up.kind === 'value' ? resolveStr(f, up.a, up.b) : null;
    const url = u === null ? null : validUrl(joinUrl(base, u));
    const method = mp ? (mp.kind === 'value' ? litStr(f, mp.a, mp.b)?.toUpperCase() : null) : 'GET';
    return url && method && HTTP_METHODS.has(method) ? { method, url } : null;
  }
  const s = resolveStr(f, a, b);
  const url = s === null ? null : validUrl(joinUrl(base, s));
  return url ? { method: 'GET', url } : null;
}

/** An array literal key -> JSON-able list of parts; unknown parts become "{?}". null when not an array. */
function queryKey(f, a, b) {
  if (f.masked[a] !== '[') return null;
  const close = matchBracket(f.masked, a);
  if (close === -1) return null;
  return splitTop(f.masked, a + 1, close).map((p) => {
    const s = resolveStr(f, p.a, p.b);
    if (s !== null) return s.slice(0, MAX_TEXT);
    const t = f.src.slice(p.a, p.b);
    if (/^-?\d+(?:\.\d+)?$/.test(t)) return t;
    return CHAIN.test(t) ? `{${t}}`.slice(0, MAX_TEXT) : '{?}';
  });
}

function reactQuery(f, acc) {
  if (!hasSpec(f, /^(?:@tanstack\/react-query|react-query)(\/|$)/)) return;
  const re = /(?<![\w$.])(useQuery|useInfiniteQuery|useSuspenseQuery|useSuspenseInfiniteQuery|useMutation)\s*(?:<[^()]*?>)?\s*\(/g;
  for (const m of f.masked.matchAll(re)) {
    const call = callArgs(f, m.index + m[0].length - 1);
    if (!call) continue;
    const mutation = m[1] === 'useMutation';
    const first = call.args[0];
    let key = null;
    let ok = true;
    if (first && f.masked[first.a] === '{') {
      const kp = prop(propsOf(f, first.a), mutation ? 'mutationKey' : 'queryKey');
      if (kp && kp.kind === 'value') {
        key = queryKey(f, kp.a, kp.b);
        ok = key !== null;
      } else ok = mutation && !kp;
    } else if (first && f.masked[first.a] === '[') {
      key = queryKey(f, first.a, first.b);
      ok = key !== null;
    } else ok = mutation && !!first && /=>|^function\b/.test(f.masked.slice(first.a, first.b));
    if (!ok) {
      acc.skipped.stores++;
      continue;
    }
    acc.stores.push({
      library: 'react-query',
      kind: mutation ? 'mutation' : 'query',
      name: enclosingName(f, m.index),
      key,
      evidence: f.ev(m.index, call.close + 1),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// API calls: fetch and axios (direct and axios.create instances)

const AXIOS_METHODS = 'get|delete|head|options|post|put|patch|request';

/** axios.create instances across the repo: name -> [{path, base}] (base null when not static). */
function axiosInstances(parsed) {
  const defs = new Map();
  for (const f of parsed) {
    if (!f.specs.has('axios')) continue;
    const re = new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?axios\\s*\\.\\s*create\\s*\\(`, 'g');
    for (const m of f.masked.matchAll(re)) {
      const call = callArgs(f, m.index + m[0].length - 1);
      let base = '';
      if (call && call.args.length) {
        const bp = f.masked[call.args[0].a] === '{' ? prop(propsOf(f, call.args[0].a), 'baseURL') : null;
        base = f.masked[call.args[0].a] === '{' ? (bp ? (bp.kind === 'value' ? resolveStr(f, bp.a, bp.b) : null) : '') : null;
      }
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1]).push({ path: f.path, base });
    }
  }
  return defs;
}

/** {method, url} for an axios-style config object at `open` ("{"), joined to `base`; null if not static. */
function configCall(f, open, base) {
  const props = propsOf(f, open);
  if (props.some((p) => p.kind === 'spread')) return null;
  const up = prop(props, 'url');
  const mp = prop(props, 'method');
  const bp = prop(props, 'baseURL');
  const b2 = bp ? (bp.kind === 'value' ? resolveStr(f, bp.a, bp.b) : null) : base;
  const u = up && up.kind === 'value' ? resolveStr(f, up.a, up.b) : null;
  const method = mp ? (mp.kind === 'value' ? litStr(f, mp.a, mp.b)?.toUpperCase() : null) : 'GET';
  if (b2 === null || u === null || !method || !HTTP_METHODS.has(method)) return null;
  const url = validUrl(joinUrl(b2, u));
  return url ? { method, url } : null;
}

function httpCalls(f, instances, acc) {
  const emit = (client, r, start, close) => {
    if (r) acc.apiCalls.push({ client, method: r.method, url: r.url, evidence: f.ev(start, close + 1) });
    else acc.skipped.apiCalls++;
  };
  const isDecl = (idx, close) => /function\s*\*?\s*$/.test(f.masked.slice(Math.max(0, idx - 20), idx)) || /^\s*\{/.test(f.masked.slice(close + 1, close + 8));

  // Plain fetch(url, { method }).
  for (const m of f.masked.matchAll(/(?<![\w$.])fetch\s*(?:<[^()]*?>)?\s*\(/g)) {
    const call = callArgs(f, m.index + m[0].length - 1);
    if (!call || isDecl(m.index, call.close)) continue;
    let r = null;
    const a0 = call.args[0];
    const url = a0 ? validUrl(resolveStr(f, a0.a, a0.b)) : null;
    if (url) {
      if (call.args.length === 1) r = { method: 'GET', url };
      else if (call.args.length === 2 && f.masked[call.args[1].a] === '{') {
        const props = propsOf(f, call.args[1].a);
        const mp = prop(props, 'method');
        if (!props.some((p) => p.kind === 'spread')) {
          const method = mp ? (mp.kind === 'value' ? litStr(f, mp.a, mp.b)?.toUpperCase() : null) : 'GET';
          if (method && HTTP_METHODS.has(method)) r = { method, url };
        }
      }
    }
    emit('fetch', r, m.index, call.close);
  }

  // axios.get(url) / axios.request(config) / axios(config).
  if (f.specs.has('axios')) {
    const viaMember = new RegExp(`(?<![\\w$.])axios\\s*\\.\\s*(${AXIOS_METHODS})\\s*(?:<[^()]*?>)?\\s*\\(`, 'g');
    for (const m of f.masked.matchAll(viaMember)) memberCall(f, 'axios', m, '', emit);
    for (const m of f.masked.matchAll(/(?<![\w$.])axios\s*(?:<[^()]*?>)?\s*\(/g)) {
      const call = callArgs(f, m.index + m[0].length - 1);
      if (!call) continue;
      const a0 = call.args[0];
      emit('axios', a0 && f.masked[a0.a] === '{' ? configCall(f, a0.a, '') : null, m.index, call.close);
    }
  }

  // Calls through an axios.create instance defined here or imported by name.
  for (const [name, defs] of [...instances].sort((x, y) => byCodeUnit(x[0], y[0]))) {
    const here = defs.filter((d) => d.path === f.path);
    const there = defs.filter((d) => d.path !== f.path);
    let use = null;
    if (here.length) use = here;
    else if (f.names.has(name)) use = there;
    if (!use) continue;
    const esc = name.replace(/\$/g, '\\$');
    const re = new RegExp(`(?<![\\w$.])${esc}\\s*\\.\\s*(${AXIOS_METHODS})\\s*(?:<[^()]*?>)?\\s*\\(`, 'g');
    for (const m of f.masked.matchAll(re)) memberCall(f, 'axios', m, use.length === 1 ? use[0].base : null, emit);
  }
}

/** One `<obj>.<method>(...)` axios call; `base` is the instance baseURL (null = unknown). */
function memberCall(f, client, m, base, emit) {
  const call = callArgs(f, m.index + m[0].length - 1);
  if (!call) return;
  const method = m[1].toUpperCase();
  const a0 = call.args[0];
  let r = null;
  if (base !== null && a0) {
    if (method === 'REQUEST') r = f.masked[a0.a] === '{' ? configCall(f, a0.a, base) : null;
    else {
      const u = resolveStr(f, a0.a, a0.b);
      const url = u === null ? null : validUrl(joinUrl(base, u));
      if (url) r = { method, url };
    }
  }
  emit(client, r, m.index, call.close);
}

// ---------------------------------------------------------------------------------------------

const lineNo = (item) => Number(item.evidence[0].lines.split('-')[0]);

/** Extract the ts-frontend fragment from `files` (repo-relative paths), reading them through `read`. */
export function extractTsFrontend(files, read) {
  const acc = { skipped: Object.fromEntries(KINDS.map((k) => [k, 0])) };
  for (const k of KINDS) acc[k] = [];
  const parsedByPath = new Map();
  for (const path of files.filter((p) => SOURCE.test(p) && !NOT_SOURCE.test(p)).slice().sort(byCodeUnit)) {
    const src = read(path);
    if (typeof src !== 'string') continue;
    parsedByPath.set(path, parseFile(path, src));
  }
  const parsed = [...parsedByPath.values()];
  const instances = axiosInstances(parsed);
  for (const f of parsed) {
    if (hasSpec(f, /^react-router(-dom)?(\/|$)/)) {
      jsxRoutes(f, acc);
      objectRoutes(f, acc);
    }
    if (hasSpec(f, /^@react-navigation\//)) screenRoutes(f, acc);
    reduxSlices(f, acc);
    zustandStores(f, acc);
    rtkQuery(f, acc);
    reactQuery(f, acc);
    httpCalls(f, instances, acc);
  }
  nextRoutes(parsedByPath, files, read, acc);

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
  id: 'ts-frontend',
  detect: (inventory) => detectStacks(inventory.files, inventory.read ?? (() => null)).includes('ts-frontend'),
  extract: extractTsFrontend,
};

export default plugin;
