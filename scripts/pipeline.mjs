#!/usr/bin/env node
// pipeline.mjs - the build driver: the orchestrating session runs three steps and two dispatch messages, and this
// script runs everything deterministic between them (docs/design.md D11, SKILL.md "Build flow").
//
//   node scripts/pipeline.mjs plan <repo> --work <dir> [--out <dir>] [--scope <path>] [--profile max|balanced|economy]
//        [--issues] [--update [--since <sha>]] [--project <name>] [--generated-at <iso>]
//   node scripts/pipeline.mjs finish --work <dir> [--usage <area>=<tokens>[@<duration>] ...] [--allow-missing]
//   node scripts/pipeline.mjs render --work <dir> [--usage synthesizer=<tokens>[@<duration>]]
//   node scripts/pipeline.mjs ledger --work <dir> [--usage reviewer=<tokens>[@<duration>]]
//
// plan    starts a fresh build in <work> (it removes the files an earlier build left there), runs prescan.mjs (the
//         per-area extracts), takes its areas as the partition (at most 8), and writes one explorer brief per area,
//         <work>/briefs/<area>.md, under BRIEF_CAP characters: the area, its globs, the extract and fragment paths,
//         the caps, the fragment contract and the three-line reply, so the explorer needs no reference file. It
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
// never through a shell. The scanned code is never executed. Exit 0 ok; 1 a wrapped script found the result invalid
// (merge, validate, layout or render exit 1); 2 usage error, missing work dir, plan, fragment or synth file, or a
// wrapped script's usage error. Node >= 18, ESM, zero npm dependencies.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchAny } from './lib/glob.mjs';
import { CAPS } from './merge.mjs';
import { makeRow, readLedger, renderTable, summarize } from './usage.mjs';

export const BRIEF_CAP = 4000; // characters per brief; with the agent file and an extract it stays under 12 K
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
  if (o.work === undefined) throw new StepError('missing --work <dir>');
  return o;
}

const MULT = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 };

/** Parse one --usage pair: `<label>=<tokens>[@<duration>]`. */
export function parseUsage(pair) {
  const m = /^([A-Za-z0-9._-]+)=(\d+(?:\.\d+)?)([kKmM]?)(?:@(.+))?$/.exec(pair);
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

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

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

// ---------------------------------------------------------------------------
// briefs

const code = (s) => `\`${s}\``;

function capGlobs(globs, room) {
  const out = [];
  for (const g of globs) {
    if (out.join(', ').length + g.length + 4 > room) {
      out.push(`(+${globs.length - out.length} more, listed in the extract)`);
      break;
    }
    out.push(code(g));
  }
  return out.join(', ');
}

export function explorerBrief({ area, extract, fragment, profile, previous, stackRef }) {
  const lines = [
    `# archmap explorer brief: ${area.id}`,
    '',
    'You map one area into one JSON fragment. This brief carries the contract, the caps and the vocabulary; you need no',
    'reference file.',
    '',
    `- Area: ${code(area.id)} (${area.title}), ${area.files} files, stacks: ${list(area.stacks).join(', ') || 'none recognised'}.`,
    `- Globs, your boundary (map nothing outside them): ${capGlobs(list(area.globs), 600)}.`,
    extract
      ? `- Extract, read it first: ${extract}`
      : '- Extract: none (this area is not in the current prescan partition); start from the globs.',
    `- Fragment, the one file you write: ${fragment}`,
    `- Profile ${profile}. Budget: ${EXPLORER_TOOL_CALLS} tool calls, the final Write included.`,
  ];
  if (previous) lines.push(`- Previous model: ${previous}. Reuse the node ids this area already has there (Grep it for your globs) so ids stay stable.`);
  if (stackRef) lines.push(`- Only if the extract leaves a framework question open: ${stackRef}`);
  lines.push(
    '',
    '## Work',
    '',
    '1. Read the extract. Spot-check what carries the structure (the entry point, one route group, one table, one queue)',
    '   with a line-range Read and fix what is wrong; do not re-derive the rest.',
    '2. Add what the extract cannot see: what a handler does, which store a service uses, the layers. Grep or Glob for',
    '   the next fact, then Read a line range. Never read a whole tree or walk it file by file.',
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
    '  ends), inferred, external (a third party). `to` may be another area\'s node id.',
    '- entity: `id`, `store` (a node id), `name`, `kind` (table, view, collection, dataset), `fields`: `name`, `type`,',
    '  `provenance` (declared, observed, inferred), optional `pk`, `nullable`, `fk` {`entity`, `field`}; `evidence`.',
    '- access: `node`, `entity`, `ops` (letters of CRUD in that order, e.g. CR), `evidence`.',
    '- evidence: [{"path":"<repo-relative>","lines":"12-30"}], the lines you read or the extract names. No citable',
    '  lines, no element: count it in `skipped`. Cite, never quote source.',
    '- coverage: the globs you actually read; a subtree is `dir/**` (a bare directory matches only itself).',
    `- Caps: ${CAPS.nodes} nodes, ${CAPS.edges} edges, ${CAPS.entities} entities, ${CAPS.access} access rows. List the most structural first:`,
    '  merge.mjs keeps the first and drops the rest, and fixes slips in field shapes itself.',
    '- merge.mjs computes the cross-area edges, the zones, the SQL access rows and the foreign-key relations from the',
    '  extracts: do not spend calls on them. Never emit meta, zones, sequences, views, locked or notes.',
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

function writeBrief(path, text) {
  if (text.length > BRIEF_CAP) throw new StepError(`brief ${path} is ${text.length} characters, over the ${BRIEF_CAP} cap`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
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
  const work = resolve(o.work);
  const out = resolve(o.out ?? join(repo, 'docs/architecture'));
  const inside = relative(repo, work);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    if (git(repo, ['check-ignore', '-q', work]) === null) {
      throw new StepError(`work dir ${work} is inside the repo and not ignored by git: prescan would map it; use a directory outside the repo or a git-ignored one`);
    }
  }
  ctx.cwd = repo;
  ctx.aliases = aliasesFor({ work, out, repo });

  // a fresh build: clear what an earlier plan left, but never a directory plan did not make
  const leftover = BUILD_FILES.filter((f) => existsSync(join(work, f)));
  if (leftover.length && !existsSync(statePath(work))) {
    throw new StepError(`work dir ${work} holds ${leftover.join(', ')} but no pipeline.json: use an empty directory or one plan made`);
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
  let targets = areas.map((a) => ({ ...a, extractPath: join(work, 'extracts', `${a.id}.json`) }));
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
      if (a) return { ...a, extractPath: join(work, 'extracts', `${a.id}.json`) };
      ctx.findings.push(`area ${id} of the previous model is not in the current prescan partition; its brief has no extract`);
      const globs = list(prevModel?.meta?.coverage?.[id]);
      return { id, title: id, globs, files: 0, stacks: [], extractPath: null };
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
  for (const a of targets) {
    const brief = join(work, 'briefs', `${a.id}.md`);
    const fragment = join(work, 'fragments', `${a.id}.json`);
    const stack = list(a.stacks).map((s) => STACK_REFS[s]).find(Boolean) ?? 'discovery-generic.md';
    const input = { area: a, extract: a.extractPath, fragment, profile, previous: update ? previous : null, stackRef: join(REFS, stack) };
    let text = explorerBrief(input);
    // a long path can push a brief over the cap: the optional stack-reference line goes first
    if (text.length > BRIEF_CAP) text = explorerBrief({ ...input, stackRef: null });
    writeBrief(brief, text);
    planned.push({ id: a.id, title: a.title, files: a.files, brief });
    agents.push(agentCall('archmap-explorer', `archmap explorer: ${a.id}`.slice(0, 60),
      `Your brief is ${brief}. Read it first and follow it: it names your extract and the one fragment file you write. Reply with the three lines it specifies.`,
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
    databases: list(pre.sources).filter((s) => isObj(s) && DB_CLI[s.kind] && s.status === 'found').map((s) => ({ kind: s.kind, path: s.path })),
    update,
  };
  writeJson(statePath(work), state);
  writeLedger(work, 'plan', ctx.ledger);

  const nothing = update?.nothing === true;
  return {
    work, repo, out, mode: state.mode, commit: state.commit, profile, stacks: list(pre.stacks),
    areas: planned,
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

function queryColumns(kind, file) {
  let tmp = null;
  try {
    let args;
    if (kind === 'sqlite') args = ['-readonly', '-noheader', '-separator', '\t', file, SQLITE_COLUMNS];
    else {
      // a DuckDB file may be held by a server: open a copy, never the original
      tmp = mkdtempSync(join(tmpdir(), 'archmap-duckdb-'));
      const copy = join(tmp, basename(file));
      copyFileSync(file, copy);
      if (existsSync(`${file}.wal`)) copyFileSync(`${file}.wal`, `${copy}.wal`);
      args = ['-readonly', '-noheader', '-list', '-separator', '\t', copy, '-c', DUCKDB_COLUMNS];
    }
    const r = spawnSync(DB_CLI[kind], args, { encoding: 'utf8' });
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
  for (const db of state.databases) {
    const cli = DB_CLI[db.kind];
    if (!cliPresent(cli)) rows.push({ kind: db.kind, path: db.path, status: 'skipped', reason: `${cli} CLI not found on PATH` });
    else pending.push(db);
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
        rows.push({ kind: db.kind, path: db.path, status: 'skipped', reason: 'the fragments did not merge, so no store node could own the file' });
        continue;
      }
      const owner = list(model.nodes).find((n) => matchAny(list(n.paths), db.path))
        ?? list(model.nodes).find((n) => list(n.evidence).some((e) => e.path === db.path));
      if (!owner) {
        rows.push({ kind: db.kind, path: db.path, status: 'skipped', reason: 'no node owns the file, so its tables have no store' });
        continue;
      }
      const q = queryColumns(db.kind, join(state.repo, db.path));
      if (q.error) {
        rows.push({ kind: db.kind, path: db.path, status: 'skipped', reason: `${DB_CLI[db.kind]} could not read the schema: ${q.error}` });
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
  ctx.ledger.push({ phase: 'introspection', label: pending.length ? [...new Set(pending.map((d) => DB_CLI[d.kind]))].join(', ') : 'introspection (skipped)', tokens: 0 });
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
  const usage = usageMap(o.usage, state.areas, 'finish');
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
  const usage = usageMap(o.usage, state.update?.nothing ? [] : ['synthesizer'], 'render');
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
    rows.push(agentRow('synthesizer', 'synthesizer', 'archmap-synthesizer', PROFILE_MODELS[state.profile].synthesizer, usage));
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
  const agents = state.issues && exitCode === 0
    ? [agentCall('archmap-reviewer', 'archmap reviewer',
      `Review the architecture model at ${files.model} for architecture-level issues. Return the one JSON object your instructions define.`,
      overrideFor(state.profile, 'reviewer'))]
    : [];
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
      : agents.length ? 'dispatch the reviewer, then follow the --issues step of the skill' : 'write the final report from `report`',
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
// CLI

const STEPS = { plan, finish, render, ledger: ledgerStep };
const USAGE_TEXT =
  'usage: node scripts/pipeline.mjs plan <repo> --work <dir> [--out <dir>] [--scope <path>] [--profile p] [--issues] [--update [--since sha]] ' +
  '[--project name] [--generated-at iso] | finish --work <dir> [--usage <area>=<tokens>[@<duration>] ...] [--allow-missing] | ' +
  'render --work <dir> [--usage synthesizer=<tokens>[@<duration>]] | ledger --work <dir> [--usage reviewer=<tokens>[@<duration>]]';

export function main(argv) {
  const [step, ...rest] = argv;
  const ctx = { runs: [], findings: [], ledger: [], aliases: [], cwd: process.cwd() };
  let result;
  try {
    if (!STEPS[step]) throw new StepError(step === undefined ? 'missing step (plan|finish|render|ledger)' : `unknown step ${step}`);
    const o = parseArgs(step, rest);
    const { exitCode = 0, findings = [], ...body } = STEPS[step](o, ctx);
    result = { step, ok: exitCode === 0, exit: exitCode, ...body, runs: ctx.runs, findings: [...ctx.findings, ...findings] };
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
