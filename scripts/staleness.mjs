#!/usr/bin/env node
// staleness.mjs - tells whether the architecture model is behind git HEAD (docs/design.md D12, section 10 "Hook").
//
//   node scripts/staleness.mjs                                   hook mode (SessionStart, hooks/hooks.json)
//   node scripts/staleness.mjs --check [--project <dir>] [--json]  check mode (/archmap:check, CI)
//
// Both modes compare meta.commit of <project>/docs/architecture/architecture.model.json with HEAD through
// diffmap.mjs (imported, never spawned). A model behind HEAD is stale: one line
//   Architecture map is 12 commits behind (3 nodes, 1 entity affected) - run /archmap:update
// A model at HEAD is current. The LLM is never run; 0 tokens.
//
// Hook mode: project dir from CLAUDE_PROJECT_DIR, else the `cwd` of the hook's stdin JSON, else process.cwd().
// It prints the line when stale and nothing otherwise, and ALWAYS exits 0 - a missing, corrupt or unknown-commit
// model, a non-git dir, bad stdin, a git that hangs (the comparison runs in a child node process, `--assess <dir>`,
// killed after ARCHMAP_STALENESS_TIMEOUT_MS, default 5000) all end in silence.
// Check mode: prints the line (or "Architecture map is current"; --json prints {stale, behind, nodes, entities,
// base, head}). Exit 0 current, 1 stale, 2 no model / usage error / not a git repo / unreadable model.
// Node >= 18, ESM, zero dependencies.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { diffmap, readGitChanges } from './diffmap.mjs';

export const MODEL_REL = 'docs/architecture/architecture.model.json';
const USAGE = 'usage: node scripts/staleness.mjs [--check [--project <dir>] [--json]]';
const DEFAULT_TIMEOUT_MS = 5000;

class UsageError extends Error {}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The one-line stale report. */
export function formatStale(r) {
  return `Architecture map is ${plural(r.behind, 'commit')} behind (${plural(r.nodes, 'node')}, ${r.entities} ${r.entities === 1 ? 'entity' : 'entities'} affected) - run /archmap:update`;
}

/**
 * Compare the project's model with HEAD. Throws UsageError when there is no model, it cannot be read or has no
 * commit, or git cannot answer.
 * @returns {{stale: boolean, behind: number, nodes: number, entities: number, base: string, head: string}}
 */
export function assess(projectDir) {
  const modelPath = join(projectDir, MODEL_REL);
  if (!existsSync(modelPath)) throw new UsageError(`no model at ${modelPath}`);
  let model;
  try {
    model = JSON.parse(readFileSync(modelPath, 'utf8'));
  } catch (e) {
    throw new UsageError(`cannot read model ${modelPath}: ${e.code ?? e.message}`);
  }
  const base = model?.meta?.commit;
  if (typeof base !== 'string' || base === '') throw new UsageError('the model has no meta.commit');
  let r;
  try {
    r = diffmap(model, readGitChanges(projectDir, base));
  } catch (e) {
    throw new UsageError(String(e?.message ?? e));
  }
  return { stale: r.behind > 0, behind: r.behind, nodes: r.nodes.length, entities: r.entities.length, base: r.base, head: r.head };
}

/** Read the hook's stdin JSON, bounded; resolves {} on anything unusable. */
function readHookInput(ms = 1000) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done({});
    const chunks = [];
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        done(v && typeof v === 'object' ? v : {});
      } catch {
        done({});
      }
    };
    const timer = setTimeout(finish, ms);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function hookMain() {
  let dir = process.env.CLAUDE_PROJECT_DIR;
  if (!dir) {
    const input = await readHookInput();
    dir = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  }
  dir = resolve(dir);
  if (!existsSync(join(dir, MODEL_REL))) return;
  const timeout = Number(process.env.ARCHMAP_STALENESS_TIMEOUT_MS) > 0 ? Number(process.env.ARCHMAP_STALENESS_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const out = await new Promise((done) => {
    let buf = '';
    let child;
    const timer = setTimeout(() => { child?.kill('SIGKILL'); done(''); }, timeout);
    const end = (v) => { clearTimeout(timer); done(v); };
    try {
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--assess', dir], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return end('');
    }
    child.stdout.on('data', (c) => { buf += c; });
    child.on('error', () => end(''));
    child.on('close', () => end(buf));
  });
  let r;
  try { r = JSON.parse(out); } catch { return; }
  if (r?.stale === true) process.stdout.write(formatStale(r) + '\n');
}

function parseArgs(argv) {
  const o = { check: false, project: undefined, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--check') o.check = true;
    else if (a === '--json') o.json = true;
    else if (a === '--project') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--project needs a value');
      o.project = v;
    } else throw new UsageError(`unknown argument ${a}`);
  }
  if (!o.check && (o.project !== undefined || o.json)) throw new UsageError('--project and --json need --check');
  return o;
}

function checkMain(o) {
  const dir = resolve(o.project ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  const r = assess(dir);
  process.stdout.write(o.json ? JSON.stringify(r, null, 2) + '\n' : (r.stale ? formatStale(r) : 'Architecture map is current') + '\n');
  return r.stale ? 1 : 0;
}

async function main(argv) {
  if (argv[0] === '--assess' && argv.length === 2) {
    try { process.stdout.write(JSON.stringify(assess(argv[1]))); } catch { /* silent: the parent prints nothing */ }
    return 0;
  }
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    // A usage mistake in hook mode (no --check) still must not disturb the session.
    if (!argv.includes('--check')) return 0;
    console.error(`staleness.mjs: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  if (!o.check) {
    try { await hookMain(); } catch { /* silent */ }
    return 0;
  }
  try {
    return checkMain(o);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`staleness.mjs: ${e.message}`);
      return 2;
    }
    // Any other failure is a crashed check, not a fresh map: let the direct-run handler report it with exit 2.
    throw e;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  // Only hook mode (no --check) always exits 0; a check that crashes prints the error and exits 2.
  const onReject = argv.includes('--check')
    ? (e) => { try { console.error(`staleness.mjs: ${e?.stack ?? e}`); } catch { /* nothing left to report to */ } process.exit(2); }
    : () => { process.exit(0); };
  main(argv).then((code) => { process.exit(code); }, onReject);
}
