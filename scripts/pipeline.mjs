#!/usr/bin/env node
// pipeline.mjs - the build driver: the orchestrating session runs three steps and two dispatch messages, and this
// script runs everything deterministic between them (docs/design.md D11, SKILL.md "Build flow").
//
//   node scripts/pipeline.mjs plan <repo> [--work <dir>] [--out <dir>] [--scope <path>] [--profile max|balanced|economy]
//        [--issues] [--update [--since <sha>]] [--project <name>] [--generated-at <iso>]
//   node scripts/pipeline.mjs finish --work <dir> [--usage <area>=<tokens>[@<duration>] ...] [--allow-missing]
//   node scripts/pipeline.mjs render --work <dir> [--usage <label>=<tokens>[@<duration>] ...]
//   node scripts/pipeline.mjs issues --work <dir> [--usage <label>=<tokens>[@<duration>]] [--anchors a,b]
//   node scripts/pipeline.mjs ledger --work <dir> [--usage reviewer=<tokens>[@<duration>]]
//
// plan    starts a fresh build in <work> (it removes the files an earlier build left there; without --work that is
//         <os tmpdir>/archmap/<short hash of the repo path>, a place a subagent may write, which Claude Code does not
//         allow outside the project and the OS temp dir; both levels are made mode 0o700, and one that is a symlink or
//         another user's exits 2), runs prescan.mjs (the per-area extracts and the explorers'
//         capped summaries of them), takes its areas as the partition (at most 8), and writes one explorer brief per
//         area, <work>/briefs/<area>.md, under BRIEF_CAP characters: the area, its globs, the summary and fragment
//         paths (the full extract is merge.mjs's: it makes the entities, relations and queue edges from it, so the
//         explorer lists no table), the caps, the fragment contract and the three-line reply, so the explorer needs
//         no reference file. It
//         prints the Agent calls to make, one per area. With --update it first runs diffmap.mjs against the model in
//         --out and briefs only the affected areas (and the areas of new files no area owns), naming the previous
//         model so ids stay stable; when nothing is affected it lists no call and the next step is render.
// finish  checks that every planned fragment is in <work>/fragments/ (a missing one exits 2 and names the file;
//         --allow-missing merges without it and names the area as not mapped), introspects each database file
//         prescan listed when its CLI (sqlite3, duckdb) is on PATH, read-only and schema only, else records the
//         skip; runs merge.mjs (--extracts --repo --digest, --previous when a model exists in --out, --areas on
//         update) into <work>/model.json, runs validate.mjs --repo, and writes the synthesizer brief
//         <work>/briefs/synthesizer.md with the digest and synth paths. It prints the one synthesizer Agent call.
// render  merges <work>/synth.json into the model (merge.mjs --synth --previous <work>/model.json), writes it to
//         --out, validates it with --repo, lays it out (seeded from the layout file in --out) and renders the clean
//         HTML (with archmap.theme.json when --out holds one). It prints the files, the counts, the ledger and a
//         final report skeleton; with --issues it also prints the reviewer Agent call.
// ledger  records the reviewer's row after an --issues review and prints the ledger.
// issues  (after a plan with --issues and a render) reads the reviewer's object from <work>/reviewer.json, merges it
//         into the overlay <home>/.claude/archmap/<repo-slug>/issues.json (issues.mjs merge, validated against the
//         model; an existing overlay is kept except on the anchors the reviewer covers), validates the model with
//         --issues, renders the internal HTML beside it (archmap.internal.html), records the reviewer's ledger row and
//         prints one JSON object. Nothing is written inside the repository. A missing reviewer.json exits 2 naming it.
//
// --usage pairs are what the orchestrator copies off the Agent completion lines: tokens as 34500, 34.5k or 1.2M,
// an optional duration after @ as 62s, 1m2s, 850ms or plain milliseconds. Each step records its own ledger rows
// (agent rows from the pairs, a tokens-0 row per script it ran) in <work>/ledger/<step>.jsonl and rebuilds
// <work>/usage.jsonl from the parts, so a step run twice records its rows once and the orchestrator never calls
// usage.mjs. Script rows carry no wall-clock duration, so the same inputs give byte-identical files.
// meta.generatedAt is the one clock reading: the time plan ran (the run's timestamp, as `date -u` gave the old flow),
// kept in <work>/pipeline.json for finish and render; --generated-at fixes it, which byte-identical reruns need.
//
// Every step prints ONE JSON line: {step, ok, exit, ..., runs: [{script, args, exit, messages?}], findings, next}.
// Nothing is hidden (each wrapped script's exit code and its messages, capped), and nothing big is printed: no
// fragment, extract, digest or model content. Wrapped scripts run with this Node, from the analysed repo's root,
// never through a shell. The scanned code is never executed: python3, the duckdb fallback, runs isolated (-I) from a
// temp directory of ours, so a duckdb.py in the repo is never imported. Exit 0 ok; 1 a wrapped script found the
// result invalid (merge, validate, layout or render exit 1); 2 usage error, missing work dir, plan, fragment or
// synth file, or a wrapped script's usage error. Node >= 18, ESM, zero npm dependencies.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchAny } from './lib/glob.mjs';
import { CAPS } from './merge.mjs';
import { makeRow, readLedger, renderTable, summarize } from './usage.mjs';

export const BRIEF_CAP = 4000; // characters per brief; with the agent file and an area summary it stays under 12 K
export const EXPLORER_TOOL_CALLS = 20;
export const SYNTH_READS = 12;
export const MAX_AREAS = 8;
const STATE_VERSION = 1;
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REFS = resolve(SCRIPTS, '../skills/architecture-map/references');
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 240;

export const PROFILE_MODELS = {
  max: { explorer: 'opus', synthesizer: 'opus', reviewer: 'opus' },
  balanced: { explorer: 'sonnet', synthesizer: 'sonnet', reviewer: 'opus' },
  economy: { explorer: 'haiku', synthesizer: 'sonnet', reviewer: 'sonnet' },
};
const PROFILE_WORDS = {
  max: 'explorer Opus high, synthesizer Opus high, reviewer Opus high',
  balanced: 'explorer Sonnet low, synthesizer Sonnet medium, reviewer Opus high',
  economy: 'explorer Haiku, synthesizer Sonnet, reviewer Sonnet; may miss cross-area links',
};
const STACK_REFS = { python: 'stack-python-backend.md', 'ts-frontend': 'stack-ts-frontend.md', 'node-backend': 'stack-node-backend.md' };
const DB_CLI = { sqlite: 'sqlite3', duckdb: 'duckdb' };
const LEDGER_PARTS = ['plan', 'finish', 'render', 'ledger'];
// what plan removes from <work> before a fresh build: only these names, never the directory itself
const BUILD_FILES = [
  'pipeline.json', 'prescan.json', 'extracts', 'briefs', 'fragments', 'synth.json', 'model.json', 'premerge.json',
  'digest.json', 'finish.json', 'reviewer.json', 'ledger', 'usage.jsonl',
];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

class StepError extends Error {
  constructor(message, extra = {}, exit = 2) {
    super(message);
    this.extra = extra;
    this.exit = exit;
  }
}

// ---------------------------------------------------------------------------
// arguments

const FLAGS = {
  plan: { value: ['--work', '--out', '--scope', '--profile', '--since', '--project', '--generated-at'], bool: ['--issues', '--update'], positional: 1 },
  finish: { value: ['--work'], multi: ['--usage'], bool: ['--allow-missing'], positional: 0 },
  render: { value: ['--work'], multi: ['--usage'], bool: [], positional: 0 },
  issues: { value: ['--work', '--anchors'], multi: ['--usage'], bool: [], positional: 0 },
  ledger: { value: ['--work'], multi: ['--usage'], bool: [], positional: 0 },
};

function parseArgs(step, argv) {
  const spec = FLAGS[step];
  const o = { positional: [], usage: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (spec.value.includes(a) || list(spec.multi).includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new StepError(`${a} needs a value`);
      if (a === '--usage') o.usage.push(v);
      else o[key] = v;
    } else if (spec.bool.includes(a)) o[key] = true;
    else if (a.startsWith('--')) throw new StepError(`unknown option ${a} for ${step}`);
    else o.positional.push(a);
  }
  if (o.positional.length > spec.positional) throw new StepError(`unexpected argument ${o.positional[spec.positional]}`);
  if (o.work === undefined && step !== 'plan') throw new StepError('missing --work <dir>');
  return o;
}

const MULT = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 };

/** Parse one --usage pair: `<label>=<tokens>[@<duration>]`. */
export function parseUsage(pair) {
  // the label is whatever the orchestrator copied off the completion line: dots, pluses and slashes included
  const m = /^([^=]+)=(\d+(?:\.\d+)?)([kKmM]?)(?:@(.+))?$/.exec(pair);
  if (!m) throw new StepError(`--usage ${pair}: expected <label>=<tokens>[@<duration>], tokens as 34500, 34.5k or 1.2M`);
  const row = { label: m[1], tokens: Math.round(Number(m[2]) * MULT[m[3]]) };
  if (m[4] !== undefined) {
    const d = m[4];
    let ms;
    let x;
    if ((x = /^(\d+)(?:ms)?$/.exec(d))) ms = Number(x[1]);
    else if ((x = /^(\d+(?:\.\d+)?)s$/.exec(d))) ms = Math.round(Number(x[1]) * 1000);
    else if ((x = /^(\d+)m(?:(\d+(?:\.\d+)?)s)?$/.exec(d))) ms = Number(x[1]) * 60000 + Math.round(Number(x[2] ?? 0) * 1000);
    else throw new StepError(`--usage ${pair}: duration after @ is 62s, 1m2s, 850ms or milliseconds`);
    row.durationMs = ms;
  }
  return row;
}

function usageMap(pairs, allowed, step) {
  const map = new Map();
  for (const p of pairs) {
    const row = parseUsage(p);
    if (!allowed.includes(row.label)) {
      throw new StepError(`--usage ${p}: ${step} takes ${allowed.length ? allowed.join(', ') : 'no'} label(s), not "${row.label}"`);
    }
    if (map.has(row.label)) throw new StepError(`--usage ${row.label} given twice`);
    map.set(row.label, row);
  }
  return map;
}

/**
 * Match the explorers' --usage labels to areas, never refusing over a label: the exact area id first, then a unique
 * prefix of one. Any other label is recorded under its own name with a warning, never booked on an area by position:
 * a guess would put one explorer's tokens on another area and the ledger and its shares would be wrong without a sign.
 * Returns the row for each area, the unmatched rows and a warning for each of them.
 */
export function matchUsage(pairs, areas) {
  const byArea = new Map();
  const pending = [];
  for (const p of pairs) {
    const row = parseUsage(p);
    if (areas.includes(row.label) && !byArea.has(row.label)) byArea.set(row.label, row);
    else pending.push(row);
  }
  const extras = pending.filter((row) => {
    const hits = areas.filter((a) => a.startsWith(row.label));
    if (hits.length !== 1 || byArea.has(hits[0])) return true;
    byArea.set(hits[0], { ...row, label: hits[0] });
    return false;
  });
  const warnings = extras.map((row) =>
    `--usage ${row.label}: not an area id, nor a unique prefix of one without a row; recorded under its own label`);
  return { byArea, extras, warnings };
}

// ---------------------------------------------------------------------------
// running the wrapped scripts

const clip = (text) =>
  String(text ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, MAX_MESSAGES)
    .map((l) => (l.length > MAX_MESSAGE_CHARS ? `${l.slice(0, MAX_MESSAGE_CHARS)}...` : l));

/** Print the work, out and repo directories as <work>, <out> and <repo> in run records; the step's JSON names them once. */
function short(ctx, text) {
  let t = String(text);
  for (const [path, name] of ctx.aliases) t = t.split(path).join(name);
  return t;
}
const aliasesFor = (state) =>
  [[state.work, '<work>'], [state.out, '<out>'], [state.repo, '<repo>']].sort((a, b) => b[0].length - a[0].length);

const SCRIPT_PHASE = {
  'prescan.mjs': 'prescan', 'diffmap.mjs': 'diffmap', 'merge.mjs': 'merge', 'validate.mjs': 'validate',
  'layout.mjs': 'layout', 'render.mjs': 'render',
};

/** Run one bundled script with this Node from the repo root; record its exit, its capped messages and a tokens-0 ledger row. */
function runScript(ctx, script, args, { quietStdout = false, phase = SCRIPT_PHASE[script] } = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd: ctx.cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  const exit = r.status ?? 2;
  const entry = { script, args: args.map((a) => short(ctx, a)), exit };
  const messages = [...clip(r.stderr), ...(quietStdout ? [] : clip(r.stdout))].slice(0, MAX_MESSAGES).map((m) => short(ctx, m));
  if (r.error) messages.unshift(`could not run: ${r.error.message}`);
  if (messages.length) entry.messages = messages;
  ctx.runs.push(entry);
  ctx.ledger.push({ phase, label: script, tokens: 0 });
  return { exit, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new StepError(`cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new StepError(`${what} ${path} is not valid JSON: ${e.message}`);
  }
}

/** Every file under `dir` (relative), empty directories not counted; [] when `dir` does not exist. */
function filesUnder(dir, base = dir) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name), base) : [relative(base, join(dir, d.name))])).sort(cmp);
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Make `dir` a directory of the current user that nobody else can enter (mode 0o700), creating it when it is
 * missing, or say why it cannot be one: it is a symlink, not a directory, or owned by another uid. Returns null when
 * it is fine, else the reason. Where the platform has no uids (Windows) only the symlink and directory checks apply.
 */
export function privateDir(dir, uid = process.getuid?.()) {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') return `${dir} cannot be read: ${e.message}`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      st = lstatSync(dir);
    } catch (err) {
      return `${dir} cannot be made: ${err.message}`;
    }
  }
  if (st.isSymbolicLink()) return `${dir} is a symlink`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (uid !== undefined && st.uid !== uid) return `${dir} is not owned by the current user (uid ${uid}, owner ${st.uid})`;
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return null;
}

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// state and ledger

const statePath = (work) => join(work, 'pipeline.json');

function loadState(work) {
  if (!isDir(work)) throw new StepError(`work dir ${work} does not exist: run pipeline.mjs plan first`);
  if (!existsSync(statePath(work))) throw new StepError(`work dir ${work} has no pipeline.json: run pipeline.mjs plan first`);
  const s = readJson(statePath(work), 'pipeline state');
  if (!isObj(s) || s.schemaVersion !== STATE_VERSION) throw new StepError(`${statePath(work)} is not a pipeline state file: run plan again`);
  if (s.planning) throw new StepError(`plan did not complete in ${work}: run plan again`);
  return s;
}

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

function writeLedger(work, part, rows) {
  const dir = join(work, 'ledger');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${part}.jsonl`), rows.map((r) => `${JSON.stringify(makeRow(r))}\n`).join(''));
  const all = [];
  for (const p of LEDGER_PARTS) {
    const f = join(dir, `${p}.jsonl`);
    if (existsSync(f)) all.push(readFileSync(f, 'utf8'));
  }
  writeFileSync(join(work, 'usage.jsonl'), all.join(''));
}

function ledgerSummary(work) {
  const s = summarize(readLedger(join(work, 'usage.jsonl')));
  return { total: s.total, table: renderTable(s) };
}

function agentRow(phase, label, agent, model, usage) {
  const u = usage.get(label);
  return { phase, label, agent, model, ...(u ? { tokens: u.tokens, durationMs: u.durationMs } : {}) };
}

/**
 * The ledger rows of one agent role from its parsed --usage pairs, whatever label each carries (the orchestrator copies
 * it off a completion line): one row per pair, so a repeated label is a second row. No pair at all is one row with the
 * figures unknown, so the ledger says the agent ran.
 */
function agentRows(phase, agent, model, pairs, { whenNone = true } = {}) {
  if (!pairs.length) return whenNone ? [{ phase, label: phase, agent, model }] : [];
  return pairs.map((u) => ({ phase, label: u.label, agent, model, tokens: u.tokens, ...(u.durationMs !== undefined ? { durationMs: u.durationMs } : {}) }));
}

// ---------------------------------------------------------------------------
// briefs

const code = (s) => `\`${s}\``;

function capGlobs(globs, room) {
  const out = [];
  for (const g of globs) {
    if (out.join(', ').length + g.length + 4 > room) {
      out.push(`(+${globs.length - out.length} more, listed in the summary)`);
      break;
    }
    out.push(code(g));
  }
  return out.join(', ');
}

const FLOOR_NAMES = 4; // names listed per kind in the "must cover" line
const FLOOR_ROOM = 380; // characters of that line

/** The directory part of a repo-relative path ('' for a root file). */
const dirPart = (p) => String(p).split('/').slice(0, -1).join('/');
const distinctOf = (xs) => [...new Set(xs.filter((x) => x !== undefined && x !== null))];

/**
 * The coverage floor of one area, counted from its extract: entry-point groups (by directory), route groups (by
 * file), stores (by schema file), queues, jobs and external clients, plus, where the area has any, middleware modules
 * (a module path, or `<file>:<name>` for a middleware python code names) and modules (the sibling modules of a python
 * entry point). `names` is what each kind holds, for the brief. The floor is clamped to CAPS.nodes, the most nodes
 * merge.mjs keeps of a fragment: a floor above it would send the explorer after nodes the merge then drops. `total`
 * is the unclamped sum, which the brief states when it is over the cap.
 */
export function coverageFloor(extract) {
  const x = extract ?? {};
  const entry = distinctOf(list(x.entryPoints).map((e) => dirPart(typeof e === 'string' ? e : e?.file) || '.'));
  const routes = distinctOf(list(x.routes).map((r) => r?.file));
  const stores = distinctOf(list(x.tables).map((t) => t?.file));
  const queues = list(x.queues).map((q) => q?.name);
  const jobs = list(x.jobs).map((j) => (typeof j === 'string' ? j : j?.name ?? j?.file));
  const clients = list(x.clients).map((c) => c?.client);
  const middleware = distinctOf(list(x.middleware).filter((m) => typeof m === 'string'));
  const modules = distinctOf(list(x.modules).filter((m) => typeof m === 'string'));
  const parts = {
    'entry-point groups': entry, 'route groups': routes, stores, queues, jobs, 'external clients': clients,
    // listed only where there is one: the brief is capped
    ...(middleware.length ? { 'middleware modules': middleware } : {}),
    ...(modules.length ? { modules } : {}),
  };
  const counts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // the workspace apps of the area ride along: the brief names them, they are not part of the floor (merge makes their nodes)
  const apps = list(x.workspaceApps).filter((a) => a && typeof a.dir === 'string');
  return { floor: Math.min(CAPS.nodes, Math.max(1, total)), total, counts, names: parts, apps };
}

const shortName = (n) => String(n).split('/').slice(-2).join('/');

/**
 * The two floor lines: the number with its parts, and what each kind must cover (compact, cut at `room`; a room of 0
 * leaves the second line out, the count stays). Over the node cap the first line says how many the extract holds;
 * `terse` keeps that to the number and lists only the kinds the area has.
 */
function floorLines(cov, room = FLOOR_ROOM, terse = false) {
  // terse leaves the kinds of which there are none out of the parts
  const parts = Object.entries(cov.counts).filter(([, n]) => !terse || n > 0).map(([k, n]) => `${k}=${n}`).join(', ');
  const over = (cov.total ?? 0) > CAPS.nodes
    ? ` The extract holds ${cov.total}, more than the ${CAPS.nodes}-node cap${terse ? '' : ': map the most structural'}.` : '';
  const incomplete = terse ? 'A fragment under the floor is incomplete.' : 'A fragment with fewer nodes than this floor is incomplete.';
  const head = `- Coverage floor: at least ${cov.floor} nodes (${parts}).${over} ${incomplete}`;
  const groups = [['entry points', 'entry-point groups'], ['routers', 'route groups'], ['stores', 'stores'], ['queues', 'queues'], ['jobs', 'jobs'], ['clients', 'external clients'], ['middleware', 'middleware modules'], ['modules', 'modules']]
    .map(([label, key]) => [label, cov.names[key] ?? []])
    .filter(([, v]) => v.length)
    .map(([label, v]) => `${label} ${v.slice(0, FLOOR_NAMES).map(shortName).join(', ')}${v.length > FLOOR_NAMES ? ` (+${v.length - FLOOR_NAMES})` : ''}`);
  let cover = room > 0 ? groups.join('; ') : '';
  if (cover.length > room) cover = `${cover.slice(0, room - 1)}…`;
  return cover ? [head, `- Each of these needs its own node: ${cover}.`] : [head];
}

/**
 * The line naming the workspace apps of an area, or nothing: their app nodes are made by script. `short` is the
 * shorter tail; `appShort`, a terminal rung of the trims, names only how many apps there are (the summary lists them).
 */
function appLines(apps, short, appShort = false) {
  const all = list(apps);
  if (!all.length) return [];
  if (appShort) return [`- Workspace apps: ${all.length}, listed in the summary; their app nodes are made by script, write none.`];
  const names = all.map((a) => `${code(a.name ?? a.dir)} (${a.dir})`).join(', ');
  const tail = short ? 'made by script, write none.' : 'made by script (merge.mjs), so write none; its parts are your nodes, level 3.';
  return [`- Workspace app${all.length > 1 ? 's' : ''}: ${names}. The level-2 app node of each is ${tail}`];
}

export function explorerBrief({ area, summary, fragment, profile, previous, stackRef, coverage, short = false, globRoom = 600, floorRoom = FLOOR_ROOM, appShort = false, terse = false }) {
  const lines = [
    `# archmap explorer brief: ${area.id}`,
    '',
    // terse: the title, the paths and the contract say what the intro does
    ...(terse
      ? []
      : ['You map one area into one JSON fragment. This brief carries the contract, the caps and the vocabulary; you need no',
        'reference file.', '']),
    short
      ? `- Area: ${code(area.id)}, ${area.files} files${terse ? `, profile ${profile}` : ''}.`
      : `- Area: ${code(area.id)} (${area.title}), ${area.files} files, stacks: ${list(area.stacks).join(', ') || 'none recognised'}.`,
    `- Globs${terse ? '' : ', your boundary'} (map nothing outside them): ${capGlobs(list(area.globs), globRoom)}.`,
    summary
      ? `- ${terse ? 'Summary' : 'Summary of prescan\'s extract'}, read it first: ${summary}`
      : '- Summary: none (this area is not in the current prescan partition); start from the globs.',
    `- Fragment, the one file you write: ${fragment}`,
    ...(short && terse ? [] : [`- Profile ${profile}.`]),
    ...floorLines(coverage ?? coverageFloor(null), floorRoom, terse),
    ...appLines(coverage?.apps, short, appShort),
  ];
  // --update: the model the ids come from. The terse rung keeps the path and the ask, not the how
  if (previous) {
    lines.push(terse
      ? `- Previous model (keep its ids): ${previous}`
      : `- Previous model: ${previous}. Reuse the node ids this area already has there (Grep it for your globs) so ids stay stable.`);
  }
  if (stackRef) lines.push(`- Only if the summary leaves a framework question open: ${stackRef}`);
  lines.push(
    '',
    '## Work',
    '',
    ...(terse
      ? [`1. Read the summary, then make at least 6 and at most ${EXPLORER_TOOL_CALLS} tool calls in all, the Write included:`,
        '   Grep, then a line-range Read; never a whole tree.',
        '2. A node per frontend feature directory, backend router, handler or listed module, store, queue, job and',
        '   external client.']
      : [`1. Read the summary, then make at least 6 and at most ${EXPLORER_TOOL_CALLS} tool calls in all, the Write included.`,
        '   Grep for the next fact, then a line-range Read; never read a whole tree or walk it file by file.',
        '2. One node per feature directory of a frontend, per router, handler or listed module of a backend, plus every',
        '   store, queue, job and external client; then what prescan cannot see: what a handler does, which store it uses.']),
    '3. Never execute the project\'s code. Bash only for read-only database introspection; Write only the fragment path.',
    '',
    '## Fragment contract',
    '',
    `One JSON object: {"area":"${area.id}","nodes":[],"edges":[],"entities":[],"access":[],"coverage":[],"skipped":{"count":0,"reasons":[]}}`,
    '',
    '- node: `id`, `zone`, `kind`, `title`, `paths` (globs it owns), `level` (1 system, 2 container, 3 component),',
    '  `evidence`; `role` one sentence. kind: app, module, route-group, service, store, queue, job, external.',
    '  zone: browser, edge, service, data, external, platform, delivery.',
    '- edge: `id`, `from`, `to`, `type`, `desc` (one sentence), `confidence`, `evidence`; `async` optional. type: api,',
    '  static, auth, pull, sql, cache, persist, call, link, deploy, event, queue. confidence: verified (you read both',
    '  ends), inferred, external (a third party). To reach another area\'s node write `to: "area:<id>"` unless you read',
    '  its node id: merge resolves it to that area\'s main node. Never invent a node id.',
    '- entity, only what the summary does not list: `id`, `store` (node id), `name`, `kind` (table, view, collection,',
    '  dataset), `fields` [{`name`, `type`, `provenance`: declared|observed|inferred}], `evidence`.',
    '- access: `node`, `entity`, `ops` (letters of CRUD in that order, e.g. CR), `evidence`.',
    '- evidence: [{"path":"<repo-relative>","lines":"12-30"}], the lines you read or the summary names. No citable',
    '  lines, no element: count it in `skipped`. Cite, never quote source.',
    '- coverage: the globs you actually read; a subtree is `dir/**` (a bare directory matches only itself).',
    `- Caps: ${CAPS.nodes} nodes, ${CAPS.edges} edges, ${CAPS.entities} entities, ${CAPS.access} access rows. List the most structural first:`,
    '  merge.mjs keeps the first and drops the rest, and fixes slips in field shapes itself.',
    '- Entities, relations and queue edges come from the script (merge.mjs), as do cross-area edges, zones and SQL',
    '  access rows; tables the summary lists are made by script, so never list tables or fields it shows. Add entities',
    '  for tables, datasets or collections it does not list, each with evidence. Never emit meta, zones, sequences,',
    '  views, locked or notes.',
    '',
    '## Reply',
    '',
    'Write the fragment, then reply with exactly three lines and nothing else (never the JSON):',
    '',
    'fragment: <the fragment path above>',
    'counts: nodes=<n> edges=<n> entities=<n> access=<n>',
    'tool calls: <n>',
    '',
    'If you could not write it, the first line is `fragment: none` and the third line says why.',
    '',
  );
  return lines.join('\n');
}

export function synthBrief({ digest, synth, profile, touched }) {
  const lines = [
    '# archmap synthesizer brief',
    '',
    'You write the narrative layer of the model: sequences and views. merge.mjs computed the structure; you add no',
    'nodes, edges, entities, access rows or relations, and you rename no id.',
    '',
    `- Digest, read it first (the model in brief; its ids are final): ${digest}`,
    `- Synth path, the one file you write: ${synth}`,
    `- Profile ${profile}. Budget: at most ${SYNTH_READS} targeted source reads (line ranges at paths the digest cites), 20 tool calls in all.`,
  ];
  if (touched) {
    const parts = Object.entries(touched).filter(([, ids]) => ids.length).map(([k, ids]) => `${k} ${ids.slice(0, 30).join(', ')}`);
    lines.push(`- Update: rework only what these touch and keep the ids: ${parts.join('; ') || 'none'}. Write only the touched or new sequences and views.`);
  }
  lines.push(
    '',
    '## What you write',
    '',
    '1. Sequences, 3-7. Start from the digest `drafts`: confirm each against its cited lines, then keep it under a plain',
    '   id without the `draft-` prefix, edit it, or drop it. Add the flows the drafts miss that a newcomer asks about',
    '   first: authentication, a background job, a failure or retry path. Fewer than 3 only when the system has fewer',
    '   distinct flows; say so in notes.',
    '   Shape: {"id","title","summary","participants":[{"id","label","node"}],"steps":[]}, 3-7 participants, `node` a',
    '   digest node id.',
    '   Message step: {"m":[from,to],"k":"<edge type word>","t":"short label","d":"one sentence","r":["path:12-30"]},',
    '   optional "ret"; `r` may be empty only for a pure return.',
    '   Fragment step: {"frag":"alt|else|opt|loop|end","t":"condition"}; every alt, opt and loop is closed by an end.',
    '   Note step: {"note":[participant ids],"t":"text","tone":"info|warn"}.',
    '2. Views: {"id","title","kind":"graph|deployment|trust","nodes":[ids]} or "zones":[ids]: a system view, one',
    '   component view per container, deployment and trust views where the zones support them.',
    '3. Notes: one line per judgement call. Conflicts: [{"ids":[],"reason":""}] for a draft the code contradicts or a',
    '   flow that needs a node or edge the digest lacks; never pick silently.',
    '',
    '## Output',
    '',
    'Write one JSON object {"sequences":[],"views":[],"notes":[],"conflicts":[]} to the synth path, then reply with',
    'exactly three lines and nothing else (never the JSON):',
    '',
    'synth: <the synth path above>',
    'counts: <n> sequences, <n> views',
    'tool calls: <n>',
    '',
  );
  return lines.join('\n');
}

const REVIEW_READS = 12;

/** The reviewer's brief: the model, the references by absolute path, the one file it writes and the three-line reply. */
export function reviewerBrief({ model, reviewer, profile, touched }) {
  const ref = (name) => join(REFS, name);
  const lines = [
    '# archmap reviewer brief',
    '',
    'You review the architecture the model describes and report what its structure and relations reveal as wrong:',
    'architecture-level issues, not line-level code review.',
    '',
    `- Model, read it whole first (every anchor you name must be an id in it): ${model}`,
    `- Reviewer path, the one file you write: ${reviewer}`,
    `- Profile ${profile}. Budget: at most ${REVIEW_READS} targeted source reads, only to confirm a suspicion at the cited lines.`,
    '- References, read these by the paths given here (nothing else is needed):',
    `  - ${ref('issues-catalog.md')}: your rulebook; follow it exactly`,
    `  - ${ref('model-schema.md')}: the element shapes and the evidence rule`,
    `  - ${ref('relation-taxonomy.md')}: edge types and confidence`,
    `  - ${ref('sequences.md')}: the step grammar, for a step anchor "<sequenceId>:<stepIndex>"`,
  ];
  if (touched) {
    const parts = Object.entries(touched).filter(([, ids]) => ids.length).map(([k, ids]) => `${k} ${ids.slice(0, 30).join(', ')}`);
    lines.push(`- Update: re-review only what these touch: ${parts.join('; ') || 'none'}.`);
  }
  lines.push(
    '',
    '## Output',
    '',
    'Write one JSON object {"issues":[],"unreviewed":[]} to the reviewer path (issue records as the catalogue defines',
    'them), then reply with exactly three lines and nothing else (never the JSON):',
    '',
    'reviewer: <the reviewer path above>',
    'counts: <n> issues, high=<n> med=<n> low=<n>',
    'tool calls: <n>',
    '',
  );
  return lines.join('\n');
}

function writeBrief(path, text) {
  if (text.length > BRIEF_CAP) throw new StepError(`brief ${path} is ${text.length} characters, over the ${BRIEF_CAP} cap`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// What an explorer brief gives up, in order, when it would pass the cap: the optional lines (the stack reference),
// then the area line (the area's title and stacks, the long glob list), then the floor's list of names, then the
// whole names line (the floor keeps its count and parts), the globs down to 40 characters, the app line down to a
// count, and, last, the wording: the intro goes, the labels, the floor line (its kinds of none, its cap note), the
// work steps and the --update previous-model line (to its path and the ask to keep the ids) down to their gist. The
// last four rungs are terminal: what is left is the contract, the paths, the floor's count and fixed text, so a
// brief ends under BRIEF_CAP even with a 200-character work path and, on --update, a previous-model path as long
// (tests/pipeline.test.mjs p29); writeBrief's throw is only a guard against a change that breaks that. The
// contract and the paths are never cut.
export const BRIEF_TRIMS = [
  { drop: 'stack reference line', opts: { stackRef: null } },
  { drop: 'area title and stacks', opts: { stackRef: null, short: true } },
  { drop: 'globs beyond 200 characters', opts: { stackRef: null, short: true, globRoom: 200 } },
  { drop: 'globs beyond 80 characters', opts: { stackRef: null, short: true, globRoom: 80 } },
  { drop: 'floor names beyond 160 characters', opts: { stackRef: null, short: true, globRoom: 80, floorRoom: 160 } },
  { drop: 'floor names (the count stays)', opts: { stackRef: null, short: true, globRoom: 80, floorRoom: 0 } },
  { drop: 'globs beyond 40 characters', opts: { stackRef: null, short: true, globRoom: 40, floorRoom: 0 } },
  { drop: 'app names (their count stays)', opts: { stackRef: null, short: true, globRoom: 40, floorRoom: 0, appShort: true } },
  { drop: 'intro, and the labels, floor line, work steps and previous-model line to their gist', opts: { stackRef: null, short: true, globRoom: 40, floorRoom: 0, appShort: true, terse: true } },
];

/** The explorer brief under BRIEF_CAP, with the note of what was trimmed (null when nothing was). */
export function fitExplorerBrief(input, id) {
  let text = explorerBrief(input);
  if (text.length <= BRIEF_CAP) return { text, note: null };
  const before = text.length;
  const dropped = [];
  for (const t of BRIEF_TRIMS) {
    text = explorerBrief({ ...input, ...t.opts });
    dropped.push(t.drop);
    if (text.length <= BRIEF_CAP) break;
  }
  return { text, note: { area: id, before, after: text.length, dropped } };
}

const agentCall = (subagentType, description, prompt, model) => ({
  subagent_type: subagentType,
  description,
  prompt,
  ...(model ? { model } : {}),
});
const overrideFor = (profile, role) => (profile === 'balanced' ? undefined : PROFILE_MODELS[profile][role]);

// ---------------------------------------------------------------------------
// plan

function plan(o, ctx) {
  const [repoArg] = o.positional;
  if (repoArg === undefined) throw new StepError('missing <repo>');
  const profile = o.profile ?? 'balanced';
  if (!PROFILE_MODELS[profile]) throw new StepError('--profile must be max, balanced or economy');
  if (o.since !== undefined && !o.update) throw new StepError('--since needs --update');
  const repo = resolve(repoArg);
  if (!isDir(repo)) throw new StepError(`repo ${repoArg} is not a directory`);
  // subagents write their fragments here, and Claude Code denies a subagent a Write outside the project and the OS
  // temp dir when nobody can approve it: the default is a directory under the OS temp dir, one per repo path. Its
  // name is predictable and the temp dir may be shared (/tmp), so both levels must be the user's own and private
  const work = resolve(o.work ?? join(tmpdir(), 'archmap', createHash('sha256').update(repo).digest('hex').slice(0, 12)));
  if (o.work === undefined) {
    for (const dir of [dirname(work), work]) {
      const refused = privateDir(dir);
      if (refused) throw new StepError(`default work dir: ${refused}; remove it or pass --work <dir>`);
    }
  }
  const out = resolve(o.out ?? join(repo, 'docs/architecture'));
  const inside = relative(repo, work);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    if (git(repo, ['check-ignore', '-q', work]) === null) {
      throw new StepError(`work dir ${work} is inside the repo and not ignored by git: prescan would map it; use a directory outside the repo or a git-ignored one`);
    }
  }
  ctx.cwd = repo;
  ctx.aliases = aliasesFor({ work, out, repo });

  // a fresh build: clear what an earlier plan left, but never a directory plan did not make. A directory somebody
  // else made is fine when it holds no file at all (an empty one, or only the empty directories plan itself uses).
  if (!existsSync(statePath(work))) {
    const files = filesUnder(work);
    if (files.length) {
      throw new StepError(`work dir ${work} holds ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''} but no pipeline.json: use an empty directory or one plan made`);
    }
  }
  mkdirSync(work, { recursive: true });
  for (const f of BUILD_FILES) rmSync(join(work, f), { recursive: true, force: true });
  writeJson(statePath(work), { schemaVersion: STATE_VERSION, planning: true });

  const prescanArgs = [repo, '--out', join(work, 'prescan.json'), ...(o.scope ? ['--scope', o.scope] : [])];
  if (runScript(ctx, 'prescan.mjs', prescanArgs).exit !== 0) throw new StepError('prescan.mjs failed', {}, 2);
  const pre = readJson(join(work, 'prescan.json'), 'prescan output');
  const areas = list(pre.areas).slice(0, MAX_AREAS);
  if (list(pre.areas).length > MAX_AREAS) ctx.findings.push(`prescan returned ${pre.areas.length} areas; only the first ${MAX_AREAS} are planned`);
  if (!pre.commit) ctx.findings.push('the repo has no commit: evidence cannot be checked at meta.commit');

  const modelPath = join(out, 'architecture.model.json');
  const previous = existsSync(modelPath) ? modelPath : null;
  const paths = (id) => ({ extractPath: join(work, 'extracts', `${id}.json`), summaryPath: join(work, 'extracts', `${id}.summary.json`) });
  let targets = areas.map((a) => ({ ...a, ...paths(a.id) }));
  let update = null;
  if (o.update) {
    if (!previous) throw new StepError(`--update needs a model at ${modelPath}: run a build first`);
    const dm = runScript(ctx, 'diffmap.mjs', [previous, '--repo', repo, '--json', ...(o.since ? ['--since', o.since] : [])], { quietStdout: true });
    if (dm.exit !== 0) throw new StepError('diffmap.mjs failed', {}, 2);
    const report = JSON.parse(dm.stdout);
    const prevModel = readJson(previous, 'previous model');
    const affected = new Set(list(report.areas));
    for (const f of list(report.uncovered)) {
      const owner = areas.find((a) => matchAny(list(a.globs), f));
      if (owner) affected.add(owner.id);
      else ctx.findings.push(`new file ${f} is in no prescan area`);
    }
    const nothing = !list(report.areas).length && !list(report.nodes).length && !list(report.entities).length && !list(report.uncovered).length;
    targets = nothing ? [] : [...affected].sort(cmp).map((id) => {
      const a = areas.find((x) => x.id === id);
      if (a) return { ...a, ...paths(a.id) };
      ctx.findings.push(`area ${id} of the previous model is not in the current prescan partition; its brief has no extract`);
      const globs = list(prevModel?.meta?.coverage?.[id]);
      return { id, title: id, globs, files: 0, stacks: [], extractPath: null, summaryPath: null };
    });
    update = {
      base: report.base, head: report.head, files: list(report.files).length, nothing,
      touched: { nodes: list(report.nodes), entities: list(report.entities), sequences: list(report.sequences) },
    };
    if (!report.files?.length) ctx.findings.push('diffmap sees no committed change since meta.commit; uncommitted edits are not seen');
  }

  mkdirSync(join(work, 'fragments'), { recursive: true });
  const agents = [];
  const planned = [];
  const trimmed = [];
  for (const a of targets) {
    const brief = join(work, 'briefs', `${a.id}.md`);
    const fragment = join(work, 'fragments', `${a.id}.json`);
    const stack = list(a.stacks).map((s) => STACK_REFS[s]).find(Boolean) ?? 'discovery-generic.md';
    const coverage = coverageFloor(a.extractPath && existsSync(a.extractPath) ? readJson(a.extractPath, 'extract') : null);
    const input = { area: a, summary: a.summaryPath, fragment, profile, previous: update ? previous : null, stackRef: join(REFS, stack), coverage };
    const fitted = fitExplorerBrief(input, a.id);
    if (fitted.note) trimmed.push(fitted.note);
    writeBrief(brief, fitted.text);
    planned.push({ id: a.id, title: a.title, files: a.files, brief });
    agents.push(agentCall('archmap-explorer', `archmap explorer: ${a.id}`.slice(0, 60),
      `Your brief is ${brief}. Read it first and follow it: it names your summary and the one fragment file you write. Reply with the three lines it specifies.`,
      overrideFor(profile, 'explorer')));
  }

  const state = {
    schemaVersion: STATE_VERSION,
    mode: o.update ? 'update' : 'build',
    repo, work, out, scope: o.scope ?? null, profile, issues: !!o.issues,
    project: o.project ?? basename(repo),
    commit: pre.commit ?? null,
    generatedAt: o.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    previous,
    areas: targets.map((a) => a.id),
    databases: databasesOf(pre),
    update,
  };
  writeJson(statePath(work), state);
  writeLedger(work, 'plan', ctx.ledger);

  const nothing = update?.nothing === true;
  return {
    work, repo, out, mode: state.mode, commit: state.commit, profile, stacks: list(pre.stacks),
    workNote: `subagents must be able to write under ${work}: it is under the OS temp dir, which Claude Code lets a subagent write; a --work outside the project and the OS temp dir is denied`,
    areas: planned,
    trimmed,
    agents,
    next: nothing
      ? `nothing is affected: run pipeline.mjs render --work ${work} (re-render only)`
      : `dispatch the ${agents.length} Agent calls in ONE message, wait for all, then run pipeline.mjs finish --work ${work} --usage <area>=<tokens> per explorer`,
  };
}

// ---------------------------------------------------------------------------
// introspection (read-only, schema only, never rows)

const SQLITE_COLUMNS =
  "SELECT m.type, m.name, p.cid, p.name, p.type, p.pk, p.\"notnull\" FROM sqlite_master m, pragma_table_info(m.name) p " +
  "WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid";
const DUCKDB_COLUMNS =
  "SELECT CASE WHEN t.table_type = 'VIEW' THEN 'view' ELSE 'table' END, c.table_name, c.ordinal_position, c.column_name, " +
  "c.data_type, 0, CASE WHEN c.is_nullable = 'YES' THEN 0 ELSE 1 END FROM information_schema.columns c " +
  'JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name ' +
  "WHERE c.table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY c.table_name, c.ordinal_position";

function cliPresent(cli) {
  const r = spawnSync(cli, ['-version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/**
 * The file databases of a build: the database files the inventory found, plus every path a program opens by
 * literal (duckdb.connect, sqlite3.connect, ...) whether or not the file is in the repository - DuckDB and
 * SQLite create theirs at runtime. One row per kind and path, sorted.
 */
function databasesOf(pre) {
  const byKey = new Map();
  const add = (kind, path) => {
    if (typeof path === 'string' && path && DB_CLI[kind] && !byKey.has(`${kind}\0${path}`)) byKey.set(`${kind}\0${path}`, { kind, path });
  };
  for (const s of list(pre.sources)) if (isObj(s) && s.status === 'found') add(s.kind, s.path);
  for (const x of Object.values(isObj(pre.extracts) ? pre.extracts : {})) {
    for (const s of list(isObj(x) ? x.stores : [])) if (isObj(s)) add(s.kind, s.path);
  }
  return [...byKey.values()].sort((p, q) => cmp(p.path, q.path) || cmp(p.kind, q.kind));
}

// DuckDB without its CLI can still be read by the python module: the same query, the same tab-separated rows.
const DUCKDB_PY =
  'import sys, duckdb\n' +
  'con = duckdb.connect(sys.argv[1], read_only=True)\n' +
  'for r in con.execute(sys.argv[2]).fetchall():\n' +
  "    print('\\t'.join('' if v is None else str(v) for v in r))\n";

/**
 * python3 for the duckdb module, never able to load the scanned repo's code (scanner safety): isolated mode (-I), so
 * neither the working directory nor PYTHON* variables reach sys.path, run from `cwd`, a temp directory of ours, never
 * the analysed repo's root the driver is run from. A duckdb.py there is never imported.
 */
const python = (args, cwd) => spawnSync('python3', ['-I', ...args], { encoding: 'utf8', cwd });

/** How a database kind can be read here: {tool} when it can, {reason} naming what is missing when it cannot. */
function readerFor(kind) {
  const cli = DB_CLI[kind];
  if (cliPresent(cli)) return { tool: cli };
  const missing = `${cli} CLI not found on PATH`;
  // sqlite3 is in python's standard library, so a python fallback would make the CLI check meaningless: duckdb only
  if (kind !== 'duckdb') return { reason: missing };
  const probeDir = mkdtempSync(join(tmpdir(), 'archmap-probe-'));
  let py;
  try {
    py = python(['-c', 'import duckdb'], probeDir);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  if (py.error) return { reason: `${missing} and python3 is not on PATH` };
  if (py.status !== 0) return { reason: `${missing} and the python duckdb module is not installed` };
  return { tool: 'python3 duckdb module' };
}

function queryColumns(kind, file, tool) {
  let tmp = null;
  try {
    let run;
    if (kind === 'sqlite') run = ['sqlite3', ['-readonly', '-noheader', '-separator', '\t', file, SQLITE_COLUMNS]];
    else {
      // a DuckDB file may be held by a server: open a copy, never the original
      tmp = mkdtempSync(join(tmpdir(), 'archmap-duckdb-'));
      const copy = join(tmp, basename(file));
      copyFileSync(file, copy);
      if (existsSync(`${file}.wal`)) copyFileSync(`${file}.wal`, `${copy}.wal`);
      run = tool === DB_CLI.duckdb
        ? ['duckdb', ['-readonly', '-noheader', '-list', '-separator', '\t', copy, '-c', DUCKDB_COLUMNS]]
        : ['python3', ['-c', DUCKDB_PY, copy, DUCKDB_COLUMNS]];
    }
    const r = run[0] === 'python3' ? python(run[1], tmp) : spawnSync(run[0], run[1], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return { error: clip(r.stderr || r.error?.message || 'failed')[0] ?? 'failed' };
    const tables = new Map();
    for (const line of r.stdout.split('\n')) {
      const c = line.split('\t');
      if (c.length < 7) continue;
      const [type, table, , name, colType, pk, notnull] = c;
      if (!tables.has(table)) tables.set(table, { kind: type === 'view' ? 'view' : 'table', fields: [] });
      const f = { name, type: colType || 'unknown', provenance: 'observed' };
      if (Number(pk) > 0) f.pk = true;
      else if (Number(notnull) === 0) f.nullable = true;
      tables.get(table).fields.push(f);
    }
    return { tables };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'table';

/** One skipped file database: the row a reader of the model finds in meta.sources, naming what is missing. */
const skippedRow = (db, reason) => ({ type: 'introspection-skipped', kind: db.kind, path: db.path, status: 'skipped', reason });

function introspect(ctx, state, fragmentsDir) {
  const target = join(fragmentsDir, 'introspection.json');
  rmSync(target, { force: true });
  if (!state.databases.length) return [];
  if (state.mode === 'update') {
    ctx.findings.push('introspection is not re-run by update; the previous model keeps its observed fields');
    return [];
  }
  const rows = [];
  const pending = [];
  const readers = new Map();
  const repoRoot = resolve(state.repo);
  const realRoot = existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
  for (const db of state.databases) {
    const file = resolve(repoRoot, db.path);
    if (!file.startsWith(repoRoot + sep)) {
      rows.push(skippedRow(db, `${db.path} is outside the repository, so it is not read`));
      continue;
    }
    if (!existsSync(file)) {
      rows.push(skippedRow(db, `${db.path} does not exist in the repository: a ${db.kind} file is created when the program runs, so there is no schema to read`));
      continue;
    }
    // the path is inside, but a symlink on it may lead out: compare where it really is, and read that file only
    const real = realpathSync(file);
    if (!real.startsWith(realRoot + sep)) {
      rows.push(skippedRow(db, `${db.path} is a link that leads outside the repository, so it is not read`));
      continue;
    }
    if (!statSync(real).isFile()) {
      rows.push(skippedRow(db, `${db.path} is not a file`));
      continue;
    }
    if (!readers.has(db.kind)) readers.set(db.kind, readerFor(db.kind));
    const reader = readers.get(db.kind);
    if (reader.reason) rows.push(skippedRow(db, reader.reason));
    else pending.push({ ...db, file: real, tool: reader.tool });
  }
  const entities = [];
  if (pending.length) {
    // the store node that owns each file comes from the explorers' fragments: merge them once, without the extracts
    const pre = join(state.work, 'premerge.json');
    rmSync(pre, { force: true });
    const m = runScript(ctx, 'merge.mjs', [fragmentsDir, '--out', pre, '--commit', state.commit ?? 'unknown', '--project', state.project,
      '--profile', state.profile, '--generated-at', state.generatedAt, '--json'], { quietStdout: true, phase: 'introspection' });
    const model = m.exit === 0 ? readJson(pre, 'pre-merge model') : null;
    rmSync(pre, { force: true });
    for (const db of pending) {
      if (!model) {
        rows.push(skippedRow(db, 'the fragments did not merge, so no store node could own the file'));
        continue;
      }
      const owner = list(model.nodes).find((n) => matchAny(list(n.paths), db.path))
        ?? list(model.nodes).find((n) => list(n.evidence).some((e) => e.path === db.path));
      if (!owner) {
        rows.push(skippedRow(db, 'no node owns the file, so its tables have no store'));
        continue;
      }
      const q = queryColumns(db.kind, db.file, db.tool);
      if (q.error) {
        rows.push(skippedRow(db, `${db.tool} could not read the schema: ${q.error}`));
        continue;
      }
      const known = new Set(list(model.entities).flatMap((e) => [String(e.name).toLowerCase(), String(e.id).toLowerCase()]));
      let declared = 0;
      let added = 0;
      for (const [table, t] of [...q.tables].sort(([a], [b]) => cmp(a, b))) {
        if (known.has(table.toLowerCase())) {
          declared++;
          continue;
        }
        entities.push({ id: slug(table), store: owner.id, name: table, kind: t.kind, fields: t.fields });
        added++;
      }
      rows.push({ kind: db.kind, path: db.path, status: 'ok', store: owner.id, entities: added, alreadyDeclared: declared });
    }
  }
  ctx.ledger.push({ phase: 'introspection', label: pending.length ? [...new Set(pending.map((d) => d.tool))].join(', ') : 'introspection (skipped)', tokens: 0 });
  writeJson(target, {
    area: 'introspection', nodes: [], edges: [], entities, access: [], coverage: [],
    skipped: { count: 0, reasons: [] }, sources: rows,
  });
  return rows;
}

// ---------------------------------------------------------------------------
// finish

function mergeArgs(state, { out, previous, synth, digest, areas }) {
  const w = state.work;
  return [
    join(w, 'fragments'), '--out', out,
    ...(previous ? ['--previous', previous] : []),
    ...(synth ? ['--synth', synth] : []),
    '--extracts', join(w, 'extracts'), '--repo', state.repo,
    ...(digest ? ['--digest', digest] : []),
    ...(areas ? ['--areas', areas.join(',')] : []),
    '--commit', state.commit ?? 'unknown', '--project', state.project, '--profile', state.profile,
    '--generated-at', state.generatedAt, '--json',
  ];
}

function mergeReport(stdout) {
  try {
    const j = JSON.parse(stdout);
    return { conflicts: list(j.conflicts), renames: list(j.renames).length, findings: list(j.findings).slice(0, MAX_MESSAGES) };
  } catch {
    return { conflicts: [], renames: 0, findings: [] };
  }
}

function validateRun(ctx, state, model) {
  const v = runScript(ctx, 'validate.mjs', [model, '--repo', state.repo, '--json'], { quietStdout: true });
  let findings = [];
  let evidence = 'unknown';
  try {
    const j = JSON.parse(v.stdout);
    findings = list(j.findings).slice(0, MAX_MESSAGES).map((f) => `${f.code} ${f.pointer || '/'} ${f.message}`);
    evidence = j.evidence;
  } catch { /* exit code says it */ }
  return { exit: v.exit, findings, evidence, command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" ${model} --repo ${state.repo}` };
}

function finish(o, ctx) {
  const work = resolve(o.work);
  const state = loadState(work);
  ctx.cwd = state.repo;
  ctx.aliases = aliasesFor(state);
  const matched = matchUsage(o.usage, state.areas);
  const usage = matched.byArea;
  ctx.warnings = matched.warnings;
  if (state.update?.nothing) {
    return { counts: null, agents: [], next: `nothing is affected: run pipeline.mjs render --work ${work}` };
  }
  const fragmentsDir = join(work, 'fragments');
  if (!isDir(fragmentsDir)) throw new StepError(`fragments dir ${fragmentsDir} is missing: run plan again`);
  const present = new Set(readdirSync(fragmentsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
  const missing = state.areas.filter((a) => !present.has(a));
  if (missing.length && !o.allowMissing) {
    throw new StepError(
      `missing fragment(s): ${missing.map((a) => join(fragmentsDir, `${a}.json`)).join(', ')}; ` +
        'name them in the report as not mapped and run finish again with --allow-missing',
      { missing },
    );
  }
  for (const extra of [...present].filter((a) => !state.areas.includes(a) && a !== 'introspection').sort(cmp)) {
    ctx.findings.push(`fragment ${extra}.json was not planned; merge.mjs reads it too`);
  }

  const introspection = introspect(ctx, state, fragmentsDir);
  const model = join(work, 'model.json');
  const digest = join(work, 'digest.json');
  for (const f of [model, digest, join(work, 'finish.json')]) rmSync(f, { force: true });
  const mergedAreas = state.areas.filter((a) => !missing.includes(a));
  const m = runScript(ctx, 'merge.mjs', mergeArgs(state, {
    out: model, digest, previous: state.previous, areas: state.mode === 'update' ? mergedAreas : null,
  }), { quietStdout: true });
  const report = mergeReport(m.stdout);
  const done = { areas: mergedAreas, notMapped: missing, introspection, conflicts: report.conflicts };
  const ledger = () => writeLedger(work, 'finish', [
    ...state.areas.map((a) => agentRow('explorer', a, 'archmap-explorer', PROFILE_MODELS[state.profile].explorer, usage)),
    ...matched.extras.map((x) => agentRow('explorer', x.label, 'archmap-explorer', PROFILE_MODELS[state.profile].explorer, new Map([[x.label, x]]))),
    ...ctx.ledger,
  ]);
  if (m.exit !== 0) {
    ledger();
    return { exitCode: m.exit === 1 ? 1 : 2, ...done, findings: report.findings.map((f) => `${f.code} ${f.pointer || '/'} ${f.message}`), agents: [], next: 'merge refused the result: report its findings; do not patch the model by hand' };
  }
  const v = validateRun(ctx, state, model);
  writeJson(join(work, 'finish.json'), done);
  ledger();
  const mj = readJson(model, 'merged model');
  const dj = readJson(digest, 'digest');
  const counts = {
    nodes: list(mj.nodes).length, edges: list(mj.edges).length, entities: list(mj.entities).length,
    access: list(mj.access).length, relations: list(mj.relations).length, drafts: list(dj.drafts).length,
  };
  if (v.exit !== 0) {
    return { exitCode: v.exit === 1 ? 1 : 2, counts, ...done, validate: { command: v.command, exit: v.exit, evidenceChecked: v.evidence === 'checked' }, findings: v.findings, agents: [], next: 'validate found the merged model invalid: report the findings; do not patch the model by hand' };
  }
  const synthPath = join(work, 'synth.json');
  const brief = join(work, 'briefs', 'synthesizer.md');
  writeBrief(brief, synthBrief({ digest, synth: synthPath, profile: state.profile, touched: state.update?.touched ?? null }));
  return {
    counts, ...done,
    validate: { command: v.command, exit: v.exit, evidenceChecked: v.evidence === 'checked' },
    agents: [agentCall('archmap-synthesizer', 'archmap synthesizer',
      `Your brief is ${brief}. Read it first and follow it: it names the digest you read and the one synth file you write. Reply with the three lines it specifies.`,
      overrideFor(state.profile, 'synthesizer'))],
    next: `dispatch the synthesizer Agent call, wait for it, then run pipeline.mjs render --work ${work} --usage synthesizer=<tokens>`,
  };
}

// ---------------------------------------------------------------------------
// render

function render(o, ctx) {
  const work = resolve(o.work);
  const state = loadState(work);
  ctx.cwd = state.repo;
  ctx.aliases = aliasesFor(state);
  const usage = o.usage.map(parseUsage);
  if (state.update?.nothing && usage.length) throw new StepError(`--usage ${o.usage[0]}: render takes no usage when the update left nothing to synthesize`);
  const out = state.out;
  const files = {
    model: join(out, 'architecture.model.json'),
    layout: join(out, 'architecture.layout.json'),
    html: join(out, 'archmap.html'),
  };
  const nothing = state.update?.nothing === true;
  let done = { areas: [], notMapped: [], introspection: [], conflicts: [] };
  let conflicts = [];
  const rows = [];
  if (!nothing) {
    const synth = join(work, 'synth.json');
    if (!existsSync(join(work, 'model.json')) || !existsSync(join(work, 'finish.json'))) {
      throw new StepError(`${join(work, 'model.json')} is missing: run pipeline.mjs finish --work ${work} first`);
    }
    if (!existsSync(synth)) throw new StepError(`synth file ${synth} is missing: dispatch the synthesizer from finish first`);
    done = readJson(join(work, 'finish.json'), 'finish record');
    rows.push(...agentRows('synthesizer', 'archmap-synthesizer', PROFILE_MODELS[state.profile].synthesizer, usage));
    mkdirSync(out, { recursive: true });
    const m = runScript(ctx, 'merge.mjs', mergeArgs(state, {
      out: files.model, previous: join(work, 'model.json'), synth, areas: state.mode === 'update' ? done.areas : null,
    }), { quietStdout: true });
    const report = mergeReport(m.stdout);
    conflicts = report.conflicts;
    if (m.exit !== 0) {
      writeLedger(work, 'render', [...rows, ...ctx.ledger]);
      return { exitCode: m.exit === 1 ? 1 : 2, conflicts, findings: report.findings.map((f) => `${f.code} ${f.pointer || '/'} ${f.message}`), agents: [], ledger: { total: ledgerSummary(work).total }, next: 'merge refused the synthesizer object: report its findings' };
    }
  } else if (!existsSync(files.model)) throw new StepError(`no model at ${files.model} to re-render`);

  const v = validateRun(ctx, state, files.model);
  let exitCode = v.exit === 0 ? 0 : v.exit === 1 ? 1 : 2;
  if (exitCode === 0) {
    const l = runScript(ctx, 'layout.mjs', [files.model, '--layout', files.layout]);
    exitCode = l.exit;
    if (exitCode === 0) {
      const theme = join(out, 'archmap.theme.json');
      const r = runScript(ctx, 'render.mjs', [files.model, '--layout', files.layout, ...(existsSync(theme) ? ['--theme', theme] : []), '--out', files.html]);
      exitCode = r.exit;
    }
  }
  writeLedger(work, 'render', [...rows, ...ctx.ledger]);
  const ledger = ledgerSummary(work);
  const model = readJson(files.model, 'model');
  const counts = {
    nodes: list(model.nodes).length, edges: list(model.edges).length, entities: list(model.entities).length,
    sequences: list(model.sequences).length, views: list(model.views).length,
  };
  const skipped = list(model.meta?.sources).filter((s) => isObj(s) && (s.status === 'skipped' || (s.type === 'truncation'))).map((s) =>
    [s.area, s.kind ?? s.type, s.path, s.reason ?? (s.dropped ? JSON.stringify(s.dropped) : '')].filter(Boolean).join(' ')).slice(0, MAX_MESSAGES);
  const agents = [];
  if (state.issues && exitCode === 0) {
    const brief = join(work, 'briefs', 'reviewer.md');
    writeBrief(brief, reviewerBrief({
      model: files.model, reviewer: join(work, 'reviewer.json'), profile: state.profile, touched: state.update?.touched ?? null,
    }));
    agents.push(agentCall('archmap-reviewer', 'archmap reviewer',
      `Your brief is ${brief}. Read it first and follow it: it names the model, the references and the one file you write. Reply with the three lines it specifies.`,
      overrideFor(state.profile, 'reviewer')));
  }
  return {
    exitCode,
    files,
    validate: { command: v.command, exit: v.exit, evidenceChecked: v.evidence === 'checked' },
    counts,
    conflicts,
    notMapped: done.notMapped,
    skipped,
    profile: state.profile,
    findings: v.findings,
    ledger: { total: ledger.total },
    report: reportSkeleton({ state, files, v, counts, conflicts, notMapped: done.notMapped, skipped, ledger }),
    agents,
    next: exitCode !== 0
      ? 'a step found the model invalid and nothing was rendered: report the findings'
      : agents.length ? `dispatch the reviewer Agent call alone in one message, wait for it, then run pipeline.mjs issues --work ${work} --usage reviewer=<tokens>@<duration>` : 'write the final report from `report`',
  };
}

function reportSkeleton({ state, files, v, counts, conflicts, notMapped, skipped, ledger }) {
  return [
    `Files written: ${files.model}, ${files.layout}, ${files.html}`,
    `Validate: ${v.command} -> exit ${v.exit} (evidence ${v.evidence === 'checked' ? 'checked at meta.commit' : v.evidence})`,
    `Elements: ${counts.nodes} nodes, ${counts.edges} edges, ${counts.entities} entities, ${counts.sequences} sequences, ${counts.views} views`,
    `Not mapped: ${notMapped.length ? notMapped.join(', ') : 'none'}`,
    `Skipped or not checked: ${skipped.length ? skipped.join('; ') : 'none recorded'}`,
    `Conflicts: ${conflicts.length ? conflicts.map((c) => `${list(c.ids).join(', ')}: ${c.reason}`).join('; ') : 'none'}`,
    `Profile: ${state.profile} (${PROFILE_WORDS[state.profile]})`,
    'Usage ledger:',
    ledger.table.trimEnd(),
    'Measure the orchestrator\'s own context with scripts/cost-profile.mjs on the session transcript; it is not an agent row.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ledger (the reviewer row of an --issues run)

function ledgerStep(o) {
  const work = resolve(o.work);
  const state = loadState(work);
  const usage = usageMap(o.usage, ['reviewer'], 'ledger');
  const rows = usage.size ? [agentRow('reviewer', 'reviewer', 'archmap-reviewer', PROFILE_MODELS[state.profile].reviewer, usage)] : [];
  writeLedger(work, 'ledger', rows);
  const ledger = ledgerSummary(work);
  return { ledger: { total: ledger.total }, report: `Usage ledger:\n${ledger.table.trimEnd()}`, agents: [], next: 'replace the usage ledger in the final report with this one' };
}

// ---------------------------------------------------------------------------
// issues (the overlay of an --issues run: merge, validate, internal render, the reviewer's ledger row)

function issuesStep(o, ctx) {
  const work = resolve(o.work);
  const state = loadState(work);
  ctx.cwd = state.repo;
  ctx.aliases = aliasesFor(state);
  if (!state.issues) throw new StepError(`work dir ${work} was planned without --issues: run plan again with --issues`);
  const reviewer = join(work, 'reviewer.json');
  if (!existsSync(reviewer)) {
    throw new StepError(`reviewer file ${reviewer} is missing: dispatch the reviewer from render first; it writes that file`);
  }
  const out = state.out;
  const files = { model: join(out, 'architecture.model.json'), layout: join(out, 'architecture.layout.json') };
  if (!existsSync(files.model)) throw new StepError(`no model at ${files.model}: run pipeline.mjs render --work ${work} first`);
  const usage = o.usage.map(parseUsage);
  if (usage.length) writeLedger(work, 'ledger', agentRows('reviewer', 'archmap-reviewer', PROFILE_MODELS[state.profile].reviewer, usage, { whenNone: false }));

  const where = runScript(ctx, 'issues.mjs', ['path', '--project', state.repo], { quietStdout: true, phase: 'merge' });
  const dir = where.stdout.trim();
  if (where.exit !== 0 || !dir) throw new StepError('issues.mjs path printed no overlay directory');
  const overlay = join(dir, 'issues.json');
  const html = join(dir, 'archmap.internal.html');
  // the overlay's scripts cost no tokens: ctx.ledger is never written here, so the ledger keeps the reviewer's row only
  const done = (exitCode, extra) => {
    const ledger = ledgerSummary(work);
    return {
      exitCode, files: { issues: overlay, html }, ledger: { total: ledger.total },
      report: `Usage ledger:\n${ledger.table.trimEnd()}`, agents: [], ...extra,
    };
  };

  const merged = runScript(ctx, 'issues.mjs', [
    'merge', ...(existsSync(overlay) ? ['--existing', overlay] : []), '--incoming', reviewer, '--model', files.model,
    ...(o.anchors ? ['--anchors', o.anchors] : []), '--out', overlay, '--project', state.repo,
  ], { quietStdout: true, phase: 'merge' });
  if (merged.exit !== 0) {
    return done(merged.exit === 1 ? 1 : 2, { next: 'issues.mjs refused the reviewer object: report the runs\' messages; nothing was written' });
  }
  const v = runScript(ctx, 'validate.mjs', [files.model, '--issues', overlay, '--repo', state.repo, '--json'], { quietStdout: true });
  let findings = [];
  try {
    findings = list(JSON.parse(v.stdout).findings).slice(0, MAX_MESSAGES).map((f) => `${f.code} ${f.pointer || '/'} ${f.message}`);
  } catch { /* the exit code says it */ }
  const validate = { command: `node "\${CLAUDE_PLUGIN_ROOT}/scripts/validate.mjs" ${files.model} --issues ${overlay} --repo ${state.repo}`, exit: v.exit };
  if (v.exit !== 0) return done(v.exit === 1 ? 1 : 2, { validate, findings, next: 'validate found the overlay invalid: report the findings' });
  const theme = join(out, 'archmap.theme.json');
  const r = runScript(ctx, 'render.mjs', [
    files.model, '--layout', files.layout, ...(existsSync(theme) ? ['--theme', theme] : []), '--issues', overlay, '--mode', 'internal', '--out', html,
  ]);
  const issues = list(readJson(overlay, 'issues overlay').issues);
  const counts = { issues: issues.length, high: 0, med: 0, low: 0 };
  for (const i of issues) if (counts[i?.sev] !== undefined) counts[i.sev]++;
  return done(r.exit === 0 ? 0 : r.exit === 1 ? 1 : 2, {
    validate, counts,
    next: r.exit === 0 ? 'write the final report from the render report and this ledger; the overlay stays outside the repository' : 'the internal render failed: report the runs',
  });
}

// ---------------------------------------------------------------------------
// CLI

const STEPS = { plan, finish, render, issues: issuesStep, ledger: ledgerStep };
const USAGE_TEXT =
  'usage: node scripts/pipeline.mjs plan <repo> [--work <dir>] [--out <dir>] [--scope <path>] [--profile p] [--issues] [--update [--since sha]] ' +
  '[--project name] [--generated-at iso] | finish --work <dir> [--usage <area>=<tokens>[@<duration>] ...] [--allow-missing] | ' +
  'render --work <dir> [--usage <label>=<tokens>[@<duration>] ...] | issues --work <dir> [--usage reviewer=<tokens>[@<duration>]] [--anchors a,b] | ledger --work <dir> [--usage reviewer=<tokens>[@<duration>]]';

export function main(argv) {
  const [step, ...rest] = argv;
  const ctx = { runs: [], findings: [], ledger: [], aliases: [], cwd: process.cwd() };
  let result;
  try {
    if (!STEPS[step]) throw new StepError(step === undefined ? 'missing step (plan|finish|render|issues|ledger)' : `unknown step ${step}`);
    const o = parseArgs(step, rest);
    const { exitCode = 0, findings = [], ...body } = STEPS[step](o, ctx);
    result = {
      step, ok: exitCode === 0, exit: exitCode, ...body, runs: ctx.runs, findings: [...ctx.findings, ...findings],
      ...(ctx.warnings?.length ? { warnings: ctx.warnings } : {}),
    };
  } catch (e) {
    const known = e instanceof StepError;
    result = {
      step: step ?? null, ok: false, exit: known ? e.exit : 2, error: known ? e.message : `internal error: ${e?.stack ?? e}`,
      ...(known ? e.extra : {}), runs: ctx.runs, findings: ctx.findings, ...(STEPS[step] ? {} : { usage: USAGE_TEXT }),
    };
  }
  return result;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const result = main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exit;
}
