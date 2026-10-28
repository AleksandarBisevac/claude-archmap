// partition.mjs - split an inventory into at most `maxAreas` areas, one per explorer agent.
//
// Boundaries follow the repo's shape: every top-level directory is a unit, container directories
// (apps/, packages/, services/ and declared workspace globs) are opened so each member is its own
// unit, a monolith with fewer than three units is opened one level, and small leftovers are
// merged. Globs are disjoint and cover every path: `dir/**` owns a subtree, `dir/*` only the
// files directly in `dir` (`*` for the repo root). Deterministic: code-unit sorted throughout.
// Node >= 18, zero dependencies.

import { byCodeUnit } from './inventory.mjs';

export const MAX_AREAS = 8;
const SMALL = 3; // fewer files than this is a "small leftover"
const SPLIT_MIN = 8; // a monolith unit is only opened when it has at least this many files
const DEFAULT_CONTAINERS = new Set([
  'apps', 'packages', 'services', 'libs', 'modules', 'projects', 'workspaces', 'plugins', 'crates',
]);

const slug = (dir) => (dir === '' ? 'root' : dir.replace(/\//g, '-'));

function makeUnit(dir, direct, paths, taken) {
  let id = slug(dir);
  for (let n = 2; taken.has(id); n++) id = `${slug(dir)}-${n}`;
  taken.add(id);
  const title = dir === '' ? 'Repo root files' : direct ? `${dir} (top-level files)` : dir;
  const globs = [direct ? (dir === '' ? '*' : `${dir}/*`) : `${dir}/**`];
  return { id, title, dir, direct, globs, paths: [...paths].sort(byCodeUnit) };
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

const merge = (list) => {
  const sorted = [...list].sort((a, b) => byCodeUnit(a.id, b.id));
  const n = sorted.length;
  return {
    id: n === 2 ? `${sorted[0].id}+${sorted[1].id}` : `${sorted[0].id}+${n - 1}`,
    title: n === 2 ? `${sorted[0].title} + ${sorted[1].title}` : `${sorted[0].title} + ${n - 1} more`,
    globs: [...new Set(sorted.flatMap((u) => u.globs))].sort(byCodeUnit),
    paths: sorted.flatMap((u) => u.paths).sort(byCodeUnit),
  };
};

/**
 * @param {string[]} paths repo-relative file paths (relative to the scan root)
 * @param {{containers?: string[], maxAreas?: number}} [opts] extra container dirs (workspace globs)
 * @returns {{id: string, title: string, globs: string[], paths: string[]}[]} sorted by id
 */
export function partition(paths, { containers = [], maxAreas = MAX_AREAS } = {}) {
  if (paths.length === 0) return [];
  const explicit = new Set(containers);
  const taken = new Set();
  const isContainer = (dir) => explicit.has(dir) || (!dir.includes('/') && DEFAULT_CONTAINERS.has(dir));

  // open(dir, paths, recurseContainers) -> units: the direct files as one unit, each child as one.
  const open = (dir, subtree) => {
    const { direct, children } = split(dir, subtree);
    const units = [];
    if (direct.length) units.push(makeUnit(dir, true, direct, taken));
    for (const [name, list] of [...children].sort((a, b) => byCodeUnit(a[0], b[0]))) {
      const child = dir === '' ? name : `${dir}/${name}`;
      units.push(...(isContainer(child) ? open(child, list) : [makeUnit(child, false, list, taken)]));
    }
    return units;
  };

  let units = open('', paths);

  // A monolith (src/ holds everything) would otherwise be one area: open its largest member.
  while (units.length < 3) {
    const cand = units
      .filter((u) => !u.direct && u.paths.length >= SPLIT_MIN && u.paths.some((p) => p.slice(u.dir.length + 1).includes('/')))
      .sort((a, b) => b.paths.length - a.paths.length || byCodeUnit(a.id, b.id))[0];
    if (!cand) break;
    const rest = units.filter((u) => u !== cand);
    taken.delete(cand.id);
    units = [...rest, ...open(cand.dir, cand.paths)];
  }

  let areas = units.map((u) => ({ id: u.id, title: u.title, globs: u.globs, paths: u.paths }));

  // Merge small leftovers into one bucket (only when there are at least two of them).
  const small = areas.filter((a) => a.paths.length < SMALL);
  if (small.length >= 2) {
    const bucket = merge(small);
    areas = [...areas.filter((a) => !small.includes(a)), { ...bucket, id: taken.has('misc') ? bucket.id : 'misc', title: 'Misc and small leftovers' }];
  }

  // Still too many: merge the two smallest until the cap holds.
  while (areas.length > maxAreas) {
    areas.sort((a, b) => a.paths.length - b.paths.length || byCodeUnit(a.id, b.id));
    const [a, b, ...rest] = areas;
    areas = [...rest, merge([a, b])];
  }
  return areas.sort((a, b) => byCodeUnit(a.id, b.id));
}
