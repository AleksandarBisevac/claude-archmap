// partition.mjs - split an inventory into at most `maxAreas` areas, one per explorer agent.
//
// Boundaries follow the repo's shape: every top-level directory is a unit, container directories
// (apps/, packages/, services/ and declared workspace globs) are opened so each member is its own
// unit, a monolith with fewer than three units is opened one level, and small leftovers are
// merged. Globs are disjoint and cover every path: `dir/**` owns a subtree, `dir/*` only the
// files directly in `dir` (`*` for the repo root). Workspace apps (`opts.apps`) are never folded into one bucket: each
// is its own area or the head of its area, and leftovers merge among themselves only. To hold the cap the two
// smallest leftovers merge while more than LEFTOVER_AREAS (or the cap, if lower) remain; a leftover joins an app's area
// only when it is the single one left and smaller than SMALL. So the area count may pass `maxAreas` by what the apps
// need: a workspace of 8 apps and many packages keeps 8 app areas and LEFTOVER_AREAS leftover areas, never one app
// area that swallowed every package. Deterministic: code-unit sorted throughout.
// Node >= 18, zero dependencies.

import { byCodeUnit } from './inventory.mjs';

export const MAX_AREAS = 8;
export const SMALL = 3; // fewer files than this is a "small leftover"
export const LEFTOVER_AREAS = 3; // leftover areas the cap never merges below (the apps take the rest of the cap)
const SPLIT_MIN = 8; // a monolith unit is only opened when it has at least this many files
const DEFAULT_CONTAINERS = new Set([
  'apps', 'packages', 'services', 'libs', 'modules', 'projects', 'workspaces', 'plugins', 'crates',
]);

const slug = (dir) => (dir === '' ? 'root' : dir.replace(/\//g, '-'));

function makeUnit(dir, direct, paths, taken, app = false) {
  let id = slug(dir);
  for (let n = 2; taken.has(id); n++) id = `${slug(dir)}-${n}`;
  taken.add(id);
  const title = dir === '' ? 'Repo root files' : direct ? `${dir} (top-level files)` : dir;
  const globs = [direct ? (dir === '' ? '*' : `${dir}/*`) : `${dir}/**`];
  return { id, title, dir, direct, globs, app, paths: [...paths].sort(byCodeUnit) };
}

/** Split the paths of a subtree rooted at `dir` into its direct files and per-child path lists. */
function split(dir, paths) {
  const cut = dir === '' ? 0 : dir.length + 1;
  const direct = [];
  const children = new Map();
  for (const p of paths) {
    const rest = p.slice(cut);
    const i = rest.indexOf('/');
    if (i === -1) direct.push(p);
    else {
      const name = rest.slice(0, i);
      if (!children.has(name)) children.set(name, []);
      children.get(name).push(p);
    }
  }
  return { direct, children };
}

/**
 * Merge areas into one bucket. The id is the first free of misc, misc-2, misc-3 (never an id joined from the
 * members', which grew with every directory and was repeated in every path and glob of the brief); the title
 * lists the member directories so the explorer still sees what the bucket holds.
 */
const merge = (list, inUse) => {
  const sorted = [...list].sort((a, b) => byCodeUnit(a.id, b.id));
  let id = 'misc';
  for (let n = 2; inUse.has(id); n++) id = `misc-${n}`;
  const members = sorted.flatMap((u) => u.members ?? [u.title]);
  return {
    id,
    title: `Misc: ${members.join(', ')}`,
    members,
    globs: [...new Set(sorted.flatMap((u) => u.globs))].sort(byCodeUnit),
    paths: sorted.flatMap((u) => u.paths).sort(byCodeUnit),
  };
};

/**
 * Fold a leftover area into an app's area: the app keeps its id (it is the head), the leftover's directories join its
 * title, globs and paths.
 */
const fold = (head, other) => {
  const members = other.members ?? [other.title];
  return {
    id: head.id,
    app: true,
    title: `${head.title} + ${members.join(', ')}`,
    globs: [...new Set([...head.globs, ...other.globs])].sort(byCodeUnit),
    paths: [...head.paths, ...other.paths].sort(byCodeUnit),
  };
};

/**
 * @param {string[]} paths repo-relative file paths (relative to the scan root)
 * @param {{containers?: string[], apps?: string[], maxAreas?: number}} [opts] extra container dirs (workspace globs);
 *   `apps` are the directories of the workspace apps, which the area cap yields to
 * @returns {{id: string, title: string, globs: string[], paths: string[]}[]} sorted by id
 */
export function partition(paths, { containers = [], apps = [], maxAreas = MAX_AREAS } = {}) {
  if (paths.length === 0) return [];
  const explicit = new Set(containers);
  const appDirs = new Set(apps);
  const taken = new Set();
  const isContainer = (dir) => explicit.has(dir) || (!dir.includes('/') && DEFAULT_CONTAINERS.has(dir));

  // open(dir, paths, recurseContainers) -> units: the direct files as one unit, each child as one.
  const open = (dir, subtree) => {
    const { direct, children } = split(dir, subtree);
    const units = [];
    if (direct.length) units.push(makeUnit(dir, true, direct, taken));
    for (const [name, list] of [...children].sort((a, b) => byCodeUnit(a[0], b[0]))) {
      const child = dir === '' ? name : `${dir}/${name}`;
      const isApp = appDirs.has(child);
      units.push(...(isContainer(child) && !isApp ? open(child, list) : [makeUnit(child, false, list, taken, isApp)]));
    }
    return units;
  };

  let units = open('', paths);

  // A monolith (src/ holds everything) would otherwise be one area: open its largest member.
  while (units.length < 3) {
    const cand = units
      .filter((u) => !u.direct && !u.app && u.paths.length >= SPLIT_MIN && u.paths.some((p) => p.slice(u.dir.length + 1).includes('/')))
      .sort((a, b) => b.paths.length - a.paths.length || byCodeUnit(a.id, b.id))[0];
    if (!cand) break;
    const rest = units.filter((u) => u !== cand);
    taken.delete(cand.id);
    units = [...rest, ...open(cand.dir, cand.paths)];
  }

  let areas = units.map((u) => ({ id: u.id, title: u.title, globs: u.globs, paths: u.paths, app: u.app }));

  // Merge small leftovers into one bucket (only when there are at least two of them). An app is never a leftover.
  const small = areas.filter((a) => !a.app && a.paths.length < SMALL);
  if (small.length >= 2) {
    const rest = areas.filter((a) => !small.includes(a));
    areas = [...rest, merge(small, new Set(rest.map((a) => a.id)))];
  }

  // Still too many: merge the two smallest leftovers while more than `keep` of them remain; a single leftover left,
  // smaller than SMALL, is folded into the smallest app (the app heads the area). Two apps are never merged, and the
  // leftovers keep `keep` areas of their own, so the cap yields by what the apps need rather than gluing every
  // package to one app.
  const keep = Math.max(1, Math.min(LEFTOVER_AREAS, maxAreas));
  const bySize = (a, b) => a.paths.length - b.paths.length || byCodeUnit(a.id, b.id);
  while (areas.length > maxAreas) {
    const free = areas.filter((a) => !a.app).sort(bySize);
    if (free.length > keep) {
      const [a, b] = free;
      const rest = areas.filter((x) => x !== a && x !== b);
      areas = [...rest, merge([a, b], new Set(rest.map((x) => x.id)))];
    } else if (free.length === 1 && free[0].paths.length < SMALL && areas.some((a) => a.app)) {
      const head = areas.filter((a) => a.app).sort(bySize)[0];
      areas = [...areas.filter((a) => a !== head && a !== free[0]), fold(head, free[0])];
    } else break;
  }
  return areas.map(({ id, title, globs, paths }) => ({ id, title, globs, paths })).sort((a, b) => byCodeUnit(a.id, b.id));
}
