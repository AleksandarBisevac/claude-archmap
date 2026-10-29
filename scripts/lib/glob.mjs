// glob.mjs - a small dependency-free path-glob matcher for the globs prescan emits (docs/design.md §5, `paths`
// and `meta.coverage`). Supported syntax:
//   **       any characters, separators included; `**/` also matches zero directories; `dir/**` owns the subtree
//   *        any characters inside one path segment
//   ?        exactly one character inside one path segment
// Everything else is literal (no braces, classes or negation). Paths and globs use "/" (a "\" in a path is read
// as "/"), and a leading "./" is ignored on either side. Node >= 18, ESM, zero dependencies.

const normalise = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
const cache = new Map();

/** The RegExp for one glob, anchored at both ends. */
export function globToRegExp(glob) {
  const g = normalise(glob);
  const hit = cache.get(g);
  if (hit) return hit;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
  }
  const rx = new RegExp(`^${re}$`, 's');
  cache.set(g, rx);
  return rx;
}

/** True when `path` matches `glob`. An empty glob matches nothing. */
export function matchGlob(glob, path) {
  if (typeof glob !== 'string' || glob === '') return false;
  return globToRegExp(glob).test(normalise(path));
}

/** True when `path` matches any glob of `globs` (an empty or missing list matches nothing). */
export function matchAny(globs, path) {
  return Array.isArray(globs) && globs.some((g) => matchGlob(g, path));
}
