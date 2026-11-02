#!/usr/bin/env node
// cost-profile.mjs - offline token and list-price cost profile of Claude Code transcripts.
//
//   node scripts/cost-profile.mjs <transcript.jsonl>... [--json] [--basename]
//
// Reads `claude -p --output-format stream-json --verbose` output (or a session .jsonl) and prints input, output,
// cache-read and cache-write tokens per model and per agent (the orchestrator, plus one row per subagent_type of
// the Agent tool calls that spawned the subagent messages), the assistant turns, the median and maximum context
// size per agent (cache read + cache write + input of one turn) and a list-price cost per row from RATES below.
// The streams of other plugins are read the same way: a subagent_type of any name labels its row, an Agent or Task call
// with no subagent_type is labelled `task:` plus a bounded slug of its description (a description holding a path-like
// token, a quoted string or more than four words is labelled `task:<n>-words-<hash>` instead, none of its text), and a stream that starts no subagent has the orchestrator row
// only. A transcript whose result events carry no modelUsage is profiled from the stream and its reconciliation entry
// is marked `modelUsage: "missing"`.
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
// --basename records each transcript in reconciliation.files by its base name instead of the path it was given, so a
// profile saved as evidence carries no directory of the machine that ran it.
// Nothing is read except the files named on the command line; nothing is sent anywhere.
// Exit 0 ok, 2 usage error or unreadable/malformed transcript. Node >= 18, ESM, zero dependencies.

import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// List prices in USD per million tokens, dated. Update the date when the numbers change, and the source comment of
// the row that changed. Source of every row: the Anthropic pricing page, platform.claude.com/docs/en/about-claude/
// pricing, as cached in the Claude API reference of Claude Code (model table cached 2026-10-06), read 2026-10-31.
// Cache writes are the 5-minute TTL write, 1.25x input (the 1-hour write is 2x and is not priced here). Cache reads
// differ by model: 0.025x input on Fable 5.1, 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x on Haiku 5.5.
export const RATES = {
  date: '2026-10-31',
  perMillion: {
    // pricing page, read 2026-10-31: 10 / 50, cache read 0.25 (0.025x input), cache write 12.5 (1.25x)
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    // pricing page, read 2026-10-31: 4 / 20, cache read 0.20 (0.05x input), cache write 5 (1.25x)
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    // pricing page, read 2026-10-31: 2 / 10, cache read 0.10 (0.05x input), cache write 2.5 (1.25x).
    // Until 2026-10-31 this row priced cache reads at 0.20 (0.1x input), twice the page's price.
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    // pricing page, read 2026-10-31: 0.10 / 0.50 for a prompt of at most 100K tokens (0.50 / 2.50 above it, not
    // modelled: a larger Haiku prompt is under-priced), cache read 0.01 (0.1x input), cache write 0.125 (1.25x).
    // Until 2026-10-31 this row held 1 / 5 / 0.1 / 1.25, the previous Haiku's prices.
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  },
};

const CLASSES = ['input', 'output', 'cacheRead', 'cacheWrite'];
const ORCHESTRATOR = 'orchestrator';
const UNKNOWN_AGENT = 'unknown-subagent';
const RESERVED_LABELS = new Set([ORCHESTRATOR, UNKNOWN_AGENT, 'total']);
const DESCRIPTION_SLUG_MAX = 40;
const DESCRIPTION_WORDS_MAX = 4;
// A path separator, a home tilde, an address, a leading dot or a file name with a letter extension (config.yaml, not v1.1).
const PATH_LIKE = /[\\/~@]|(?:^|\s)\.|[A-Za-z0-9_-]\.[A-Za-z]{1,5}\b/;
const QUOTED = /["'`‘’“”]/;
const USAGE = 'usage: node scripts/cost-profile.mjs <transcript.jsonl>... [--json] [--basename]';

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
  const spawned = new Map(); // Agent tool_use id -> subagent_type, else task:<description slug>
  const label = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  // The label lands in tracked profiles. A short plain description keeps a slug: lowercase [a-z0-9-] only, one hyphen per
  // run, cut to 40, never a row name of ours. A description that holds a path-like token, a quoted string or more than a
  // few words may carry repository text, so none of its words is kept: the label is its word count and a short hash.
  const describe = (v) => {
    if (typeof v !== 'string') return null;
    const words = v.trim().split(/\s+/).filter(Boolean);
    if (words.length > DESCRIPTION_WORDS_MAX || PATH_LIKE.test(v) || QUOTED.test(v)) {
      return `task:${words.length}-words-${createHash('sha256').update(v).digest('hex').slice(0, 6)}`;
    }
    const slug = v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, DESCRIPTION_SLUG_MAX).replace(/-+$/, '');
    return slug === '' || RESERVED_LABELS.has(slug) ? UNKNOWN_AGENT : `task:${slug}`;
  };
  for (const e of events) {
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const part of e.message.content) {
      if (part?.type === 'tool_use' && (part.name === 'Agent' || part.name === 'Task')) {
        spawned.set(part.id, label(part.input?.subagent_type) ?? describe(part.input?.description) ?? UNKNOWN_AGENT);
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
// Result events of which none carries modelUsage are marked `modelUsage: 'missing'`: nothing to reconcile against.
function reconcile(file, streamModels, { lastResult, resultEvents }) {
  if (!lastResult) {
    const none = { file, resultEvents, matchesModelUsage: null, mismatches: [] };
    return resultEvents ? { ...none, modelUsage: 'missing' } : none;
  }
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

export function profile(files, readFn = readTranscript, { baseNames = false } = {}) {
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
    reconciliation.push(reconcile(baseNames ? basename(file) : file, fileModels, c));
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
  const missing = r.files.filter((f) => f.modelUsage === 'missing').map((f) => f.file);
  if (missing.length) out.push(`reconciliation missing: the result events carry no modelUsage in ${missing.join(', ')}`);
  return out.join('\n') + '\n';
}

function main(argv) {
  try {
    const files = [];
    let json = false;
    let baseNames = false;
    for (const a of argv) {
      if (a === '--json') json = true;
      else if (a === '--basename') baseNames = true;
      else if (a === '-h' || a === '--help') {
        console.log(USAGE);
        return 0;
      } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
      else files.push(a);
    }
    if (!files.length) throw new UsageError('missing <transcript.jsonl>');
    const p = profile(files, readTranscript, { baseNames });
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
