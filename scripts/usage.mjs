#!/usr/bin/env node
// usage.mjs - the per-phase token and duration ledger (docs/design.md D11).
//
//   node scripts/usage.mjs add <ledger.jsonl> --phase <phase> [--label area] [--agent name] [--model m]
//        [--tokens n] [--duration-ms n]
//   node scripts/usage.mjs print <ledger.jsonl> [--json]
//
// phase: prescan | explorer | introspection | merge | synthesizer | reviewer | layout | render.
// The orchestrator records one JSONL row per step, taking tokens and duration from the subagent completion
// notifications; a script that costs no tokens is recorded with --tokens 0. A figure that was not given is left
// out of the row and printed as "unknown", never as 0; the total says how many rows were unknown.
// The ledger lives in the work directory, not in the repo. Output is deterministic for the same ledger (rows are
// grouped by phase in pipeline order and carry no timestamps).
// Exit 0 ok, 2 usage error or unreadable ledger. Node >= 18, ESM, zero dependencies.

import { readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PHASES = ['prescan', 'explorer', 'introspection', 'merge', 'synthesizer', 'reviewer', 'layout', 'render'];

const USAGE = `usage:
  node scripts/usage.mjs add <ledger.jsonl> --phase <${PHASES.join('|')}>
       [--label area] [--agent name] [--model m] [--tokens n] [--duration-ms n]
  node scripts/usage.mjs print <ledger.jsonl> [--json]`;

class UsageError extends Error {}

const STRING_FLAGS = ['--phase', '--label', '--agent', '--model'];
const NUMBER_FLAGS = ['--tokens', '--duration-ms'];

function parseArgs(argv) {
  const o = { cmd: undefined, ledger: undefined, json: false, help: false, row: {} };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--json') o.json = true;
    else if (STRING_FLAGS.includes(a) || NUMBER_FLAGS.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      if (NUMBER_FLAGS.includes(a)) {
        if (!/^\d+$/.test(v)) throw new UsageError(`${a} must be a non-negative integer, got "${v}"`);
        o.row[a === '--tokens' ? 'tokens' : 'durationMs'] = Number(v);
      } else o.row[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else pos.push(a);
  }
  if (o.help) return o;
  [o.cmd, o.ledger] = pos;
  if (pos.length > 2) throw new UsageError(`unexpected argument ${pos[2]}`);
  if (o.cmd !== 'add' && o.cmd !== 'print') throw new UsageError(o.cmd === undefined ? 'missing command (add|print)' : `unknown command ${o.cmd}`);
  if (o.ledger === undefined) throw new UsageError('missing <ledger.jsonl>');
  if (o.cmd === 'add') {
    if (o.row.phase === undefined) throw new UsageError('missing --phase');
    if (!PHASES.includes(o.row.phase)) throw new UsageError(`--phase must be one of ${PHASES.join(', ')}`);
  } else if (Object.keys(o.row).length) throw new UsageError('print takes only --json');
  return o;
}

// Fixed key order keeps the ledger file deterministic.
function makeRow(r) {
  const out = { phase: r.phase };
  for (const k of ['label', 'agent', 'model', 'tokens', 'durationMs']) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

function readLedger(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ledger ${path}: ${e.code ?? e.message}`);
  }
  const rows = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let r;
    try {
      r = JSON.parse(line);
    } catch (e) {
      throw new UsageError(`ledger ${path} line ${i + 1} is not valid JSON: ${e.message}`);
    }
    if (r === null || typeof r !== 'object' || !PHASES.includes(r.phase)) {
      throw new UsageError(`ledger ${path} line ${i + 1} has no valid phase`);
    }
    for (const k of ['tokens', 'durationMs']) {
      if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k] >= 0)) {
        throw new UsageError(`ledger ${path} line ${i + 1}: ${k} must be a non-negative integer`);
      }
    }
    rows.push(r);
  });
  return rows;
}

function tally(rows) {
  const known = (k) => rows.filter((r) => r[k] !== undefined);
  const sum = (k) => (known(k).length ? known(k).reduce((s, r) => s + r[k], 0) : null);
  return {
    rows: rows.length,
    tokens: sum('tokens'),
    durationMs: sum('durationMs'),
    unknownTokens: rows.length - known('tokens').length,
    unknownDuration: rows.length - known('durationMs').length,
  };
}

export function summarize(rows) {
  const phases = PHASES.filter((p) => rows.some((r) => r.phase === p)).map((phase) => ({
    phase,
    ...tally(rows.filter((r) => r.phase === phase)),
  }));
  return { phases, total: tally(rows) };
}

const fmtTokens = (t, unknown) => {
  if (t === null) return 'unknown';
  return unknown ? `${t} + ${unknown} unknown` : String(t);
};
const fmtSecs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const fmtDuration = (ms, unknown) => {
  if (ms === null) return 'unknown';
  return unknown ? `${fmtSecs(ms)} + ${unknown} unknown` : fmtSecs(ms);
};

export function renderTable({ phases, total }) {
  const lines = [['phase', 'rows', 'tokens', 'duration']];
  for (const p of phases) lines.push([p.phase, String(p.rows), fmtTokens(p.tokens, p.unknownTokens), fmtDuration(p.durationMs, p.unknownDuration)]);
  lines.push(['total', String(total.rows), fmtTokens(total.tokens, total.unknownTokens), fmtDuration(total.durationMs, total.unknownDuration)]);
  const w = [0, 1, 2, 3].map((c) => Math.max(...lines.map((l) => l[c].length)));
  const fmt = (l) => `${l[0].padEnd(w[0])}  ${l[1].padStart(w[1])}  ${l[2].padEnd(w[2])}  ${l[3]}`.trimEnd();
  const out = [fmt(lines[0]), ...lines.slice(1, -1).map(fmt)];
  out.push('-'.repeat(out[0].length), fmt(lines[lines.length - 1]));
  if (total.unknownTokens) out.push(`${total.unknownTokens} of ${total.rows} rows have unknown tokens (not counted as 0).`);
  if (total.unknownDuration) out.push(`${total.unknownDuration} of ${total.rows} rows have unknown duration (not counted as 0).`);
  return out.join('\n') + '\n';
}

function main(argv) {
  try {
    const o = parseArgs(argv);
    if (o.help) {
      console.log(USAGE);
      return 0;
    }
    if (o.cmd === 'add') {
      appendFileSync(o.ledger, JSON.stringify(makeRow(o.row)) + '\n');
      return 0;
    }
    const s = summarize(readLedger(o.ledger));
    process.stdout.write(o.json ? JSON.stringify(s, null, 2) + '\n' : renderTable(s));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`usage.mjs: ${e.message}`);
      return 2;
    }
    if (e && e.code) {
      console.error(`usage.mjs: ${e.code}: ${e.message}`);
      return 2;
    }
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
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
