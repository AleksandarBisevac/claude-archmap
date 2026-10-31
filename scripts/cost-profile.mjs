#!/usr/bin/env node
// cost-profile.mjs - offline token and list-price cost profile of Claude Code transcripts.
//
//   node scripts/cost-profile.mjs <transcript.jsonl>... [--json]
//
// Reads `claude -p --output-format stream-json --verbose` output (or a session .jsonl) and prints input, output,
// cache-read and cache-write tokens per model and per agent (the orchestrator, plus one row per subagent_type of
// the Agent tool calls that spawned the subagent messages), the assistant turns, the median and maximum context
// size per agent (cache read + cache write + input of one turn) and a list-price cost per row from RATES below.
//
// Counting: a message is counted once per message.id (stream-json repeats a message once per content block; the
// last copy wins). Every `result` event's modelUsage is CUMULATIVE for the session, so the figure to use is the
// LAST result event's modelUsage, never the sum of them. The per-model table and the cost take every token class
// from it when one exists. An assistant event carries output_tokens as counted at emission time (a handful of
// tokens), so summing them under-counts output several times over; input and the cache classes do reconcile.
// The per-agent table therefore keeps the stream's turns, context sizes and cache figures but labels its output
// column the stream's lower bound. Without a result event the model table is the stream's sums, flagged as a
// lower bound. The reconciliation line says MATCH (input and cache classes equal) or names the class and the gap.
// A model without a rate is reported "unpriced" and its cost is null, never 0.
// Nothing is read except the files named on the command line; nothing is sent anywhere.
// Exit 0 ok, 2 usage error or unreadable/malformed transcript. Node >= 18, ESM, zero dependencies.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// List prices in USD per million tokens, dated. Update the date when the numbers change.
export const RATES = {
  date: '2026-10-30',
  perMillion: {
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-haiku-5-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
};

const CLASSES = ['input', 'output', 'cacheRead', 'cacheWrite'];
const ORCHESTRATOR = 'orchestrator';
const UNKNOWN_AGENT = 'unknown-subagent';
const USAGE = 'usage: node scripts/cost-profile.mjs <transcript.jsonl>... [--json]';

class UsageError extends Error {}

const zero = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// Rates are looked up by exact id, then by id with a trailing date stamp removed.
function rateFor(model) {
  const t = RATES.perMillion;
  return t[model] ?? t[model.replace(/-\d{8}$/, '')] ?? null;
}

// Cost of token buckets keyed by model; null when any model with tokens has no rate.
function costOf(byModel) {
  let usd = 0;
  for (const [model, b] of Object.entries(byModel)) {
    const r = rateFor(model);
    if (!r) return null;
    for (const c of CLASSES) usd += (b[c] * r[c]) / 1e6;
  }
  return Number(usd.toFixed(6));
}

function readTranscript(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${e.code ?? e.message}`);
  }
  const events = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      throw new UsageError(`${path} line ${i + 1} is not valid JSON: ${e.message}`);
    }
  });
  return events;
}

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

// One transcript -> unique messages (agent, model, usage) and the last result event's modelUsage.
function collect(events) {
  const spawned = new Map(); // Agent tool_use id -> subagent_type
  for (const e of events) {
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const part of e.message.content) {
      if (part?.type === 'tool_use' && (part.name === 'Agent' || part.name === 'Task')) {
        spawned.set(part.id, part.input?.subagent_type ?? UNKNOWN_AGENT);
      }
    }
  }
  const messages = new Map();
  let anon = 0;
  let lastResult = null;
  let resultEvents = 0;
  for (const e of events) {
    if (e?.type === 'result') {
      resultEvents++;
      if (e.modelUsage && typeof e.modelUsage === 'object') lastResult = e.modelUsage;
      continue;
    }
    const m = e?.message;
    if (e?.type !== 'assistant' || !m?.usage || typeof m.model !== 'string' || m.model.startsWith('<')) continue;
    const parent = e.parent_tool_use_id ?? null;
    messages.set(m.id ?? `anon-${anon++}`, {
      agent: parent === null ? ORCHESTRATOR : (spawned.get(parent) ?? UNKNOWN_AGENT),
      model: m.model,
      input: num(m.usage.input_tokens),
      output: num(m.usage.output_tokens),
      cacheRead: num(m.usage.cache_read_input_tokens),
      cacheWrite: num(m.usage.cache_creation_input_tokens),
    });
  }
  return { messages: [...messages.values()], lastResult, resultEvents };
}

function add(into, m) {
  into.turns++;
  for (const c of CLASSES) into[c] += m[c];
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const FIELD = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadInputTokens', cacheWrite: 'cacheCreationInputTokens' };
const fromResult = (u) => ({ input: num(u?.[FIELD.input]), output: num(u?.[FIELD.output]), cacheRead: num(u?.[FIELD.cacheRead]), cacheWrite: num(u?.[FIELD.cacheWrite]) });

// Compare the stream's per-model sums with the last result event. Input and the cache classes must be equal;
// output is only a lower bound in the stream, so it is a mismatch only when the stream exceeds the result.
function reconcile(file, streamModels, { lastResult, resultEvents }) {
  if (!lastResult) return { file, resultEvents, matchesModelUsage: null, mismatches: [] };
  const mismatches = [];
  for (const model of [...new Set([...Object.keys(streamModels), ...Object.keys(lastResult)])].sort()) {
    const r = fromResult(lastResult[model]);
    for (const c of CLASSES) {
      const st = streamModels[model]?.[c] ?? 0;
      if (c === 'output' ? st > r[c] : st !== r[c]) mismatches.push({ model, class: c, stream: st, result: r[c], difference: Math.abs(st - r[c]) });
    }
  }
  return { file, resultEvents, matchesModelUsage: mismatches.length === 0, mismatches };
}

export function profile(files, readFn = readTranscript) {
  const models = {};
  let fromResultFiles = 0;
  let fromStreamFiles = 0;
  const agents = {}; // agent -> { total, byModel, contexts }
  const reconciliation = [];
  for (const file of files) {
    const c = collect(readFn(file));
    const fileModels = {};
    for (const m of c.messages) {
      add((fileModels[m.model] ??= zero()), m);
      const a = (agents[m.agent] ??= { total: zero(), byModel: {}, contexts: [] });
      add(a.total, m);
      add((a.byModel[m.model] ??= zero()), m);
      a.contexts.push(m.cacheRead + m.cacheWrite + m.input);
    }
    reconciliation.push(reconcile(file, fileModels, c));
    // The model table: every class from the last result event when there is one (a model the result does not
    // list keeps the stream's figures), otherwise the stream's sums.
    if (c.lastResult) fromResultFiles++;
    else fromStreamFiles++;
    for (const model of new Set([...Object.keys(fileModels), ...Object.keys(c.lastResult ?? {})])) {
      const into = (models[model] ??= zero());
      const stream = fileModels[model] ?? zero();
      into.turns += stream.turns;
      const src = c.lastResult && model in c.lastResult ? fromResult(c.lastResult[model]) : stream;
      for (const k of CLASSES) into[k] += src[k];
    }
  }
  const tokens = (b) => ({ turns: b.turns, input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite });
  const byModel = Object.keys(models).sort().map((model) => ({ model, ...tokens(models[model]), costUsd: costOf({ [model]: models[model] }) }));
  const agentNames = Object.keys(agents).sort((x, y) => (x === ORCHESTRATOR ? -1 : y === ORCHESTRATOR ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const byAgent = agentNames.map((agent) => ({
    agent,
    ...tokens(agents[agent].total),
    medianContext: median(agents[agent].contexts),
    maxContext: Math.max(...agents[agent].contexts),
    costUsd: costOf(agents[agent].byModel),
  }));
  const total = zero();
  for (const m of Object.values(models)) {
    total.turns += m.turns;
    for (const c of CLASSES) total[c] += m[c];
  }
  const states = reconciliation.map((r) => r.matchesModelUsage);
  return {
    rates: RATES,
    basis: {
      byModel: !fromStreamFiles ? 'result-event' : !fromResultFiles ? 'stream-lower-bound' : 'mixed',
      byAgentOutput: 'stream-lower-bound',
    },
    byModel,
    byAgent,
    total: { ...tokens(total), costUsd: costOf(models) },
    reconciliation: {
      files: reconciliation,
      matchesModelUsage: states.some((s) => s === false) ? false : states.every((s) => s === true) && states.length ? true : null,
    },
  };
}

const n = (v) => String(Math.round(v));
const usd = (v) => (v === null ? 'unpriced' : v.toFixed(4));

export function renderText(p) {
  const table = (head, rows) => {
    const all = [head, ...rows];
    const w = head.map((_, c) => Math.max(...all.map((r) => r[c].length)));
    const fmt = (r) => r.map((cell, c) => (c === 0 ? cell.padEnd(w[c]) : cell.padStart(w[c]))).join('  ');
    return [fmt(head), '-'.repeat(fmt(head).length), ...rows.map(fmt)];
  };
  const tok = (r) => [n(r.turns), n(r.input), n(r.output), n(r.cacheRead), n(r.cacheWrite)];
  const fromStream = p.basis.byModel !== 'result-event';
  const out = [`cost at list prices, rate table dated ${p.rates.date} (USD per million tokens)`, ''];
  out.push(fromStream ? 'per model (no result event for some or all files: stream sums, output is a lower bound)' : "per model (last result event's modelUsage)",
    ...table(['model', 'turns', 'input', fromStream ? 'output (lower bound)' : 'output', 'cache-read', 'cache-write', 'cost USD'],
      [...p.byModel.map((r) => [r.model, ...tok(r), usd(r.costUsd)]), ['total', ...tok(p.total), usd(p.total.costUsd)]]));
  const sum = (k) => p.byAgent.reduce((x, r) => x + r[k], 0);
  const agentCost = p.byAgent.some((r) => r.costUsd === null) ? null : Number(p.byAgent.reduce((x, r) => x + r.costUsd, 0).toFixed(6));
  out.push('', 'per agent (stream: turns, context and cache figures reconcile; output is the stream\'s lower bound, counted at emission time)',
    ...table(['agent', 'turns', 'input', 'output (stream, lower bound)', 'cache-read', 'cache-write', 'median ctx', 'max ctx', 'cost USD (stream)'],
      [...p.byAgent.map((r) => [r.agent, ...tok(r), n(r.medianContext), n(r.maxContext), usd(r.costUsd)]),
        ['total', n(sum('turns')), n(sum('input')), n(sum('output')), n(sum('cacheRead')), n(sum('cacheWrite')), '', '', usd(agentCost)]]));
  const unpriced = p.byModel.filter((r) => r.costUsd === null).map((r) => r.model);
  if (unpriced.length) out.push('', `unpriced (no rate in the table, cost not counted as 0): ${unpriced.join(', ')}`);
  const r = p.reconciliation;
  if (r.matchesModelUsage === null) {
    out.push('', 'no result event with modelUsage: totals are the sum of the assistant messages (a lower bound, output especially), not reconciled');
  } else if (r.matchesModelUsage) {
    out.push('', "MATCH: the stream's input, cache-read and cache-write equal the last result event's modelUsage (cumulative per session); output is taken from it");
  } else {
    const gaps = r.files.flatMap((f) => f.mismatches).map((m) => `${m.model} ${m.class} differs by ${m.difference} (stream ${m.stream}, result ${m.result})`);
    out.push('', `totals DO NOT equal the last result event's modelUsage: ${gaps.join('; ')}`);
  }
  return out.join('\n') + '\n';
}

function main(argv) {
  try {
    const files = [];
    let json = false;
    for (const a of argv) {
      if (a === '--json') json = true;
      else if (a === '-h' || a === '--help') {
        console.log(USAGE);
        return 0;
      } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
      else files.push(a);
    }
    if (!files.length) throw new UsageError('missing <transcript.jsonl>');
    const p = profile(files);
    process.stdout.write(json ? JSON.stringify(p, null, 2) + '\n' : renderText(p));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`cost-profile.mjs: ${e.message}`);
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
