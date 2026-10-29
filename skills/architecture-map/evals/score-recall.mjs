#!/usr/bin/env node
// score-recall.mjs - issue recall of an archmap issues file against a ground truth of reference issues.
//
//   node score-recall.mjs <issues.json> <ground-truth.json> [--json]
//
// issues.json       the produced overlay: {"issues": [...]} (or a bare list) of archmap issues.
// ground-truth.json a list (or {"issues": [...]}) of reference issues:
//                   {id, sev: high|med|low, category, anchor, keywords[]}. `anchor` is an anchor hint, the
//                   node, edge, entity or step id the issue is about. The real ground truth stays in
//                   .private/ and is never tracked; tests use a synthetic one under tests/fixtures/evals/.
//
// Scored set: reference issues with sev high or med. Low ones are ignored (neither matched nor missed).
//
// Match rule - a reference issue is RECALLED when some produced issue
//   1. has the same category, AND
//   2. either its anchor value (node/edge/entity/step id) equals the reference anchor hint
//      (case-insensitive), OR it shares a keyword with it: some reference keyword occurs, case-insensitive
//      as a substring, in the produced issue's title, summary, impact, fix, detail or evidence paths.
// Reference issues are taken in file order, each pairs with the first still-unused produced issue that
// matches, anchor matches before keyword-only ones; a produced issue answers at most one reference issue.
// A produced issue that matches nothing changes nothing: recall is recalled / scored reference issues.
//
// Output: recall, the matched pairs and the misses (text, or one JSON object with --json).
// Exit 0 when recall >= 0.6, 1 below, 2 on usage error or unreadable/malformed input.
// Deterministic: no clock, no randomness, no environment. Node >= 18, ESM, zero dependencies.

import { readFileSync } from 'node:fs';

const THRESHOLD = 0.6;
const THRESHOLD_PCT = 60; // integer form of the threshold, so the comparison never meets float rounding
const SEV = ['high', 'med', 'low'];
const USAGE = 'usage: node score-recall.mjs <issues.json> <ground-truth.json> [--json]';

class InputError extends Error {}

const fail = (msg) => {
  process.stderr.write(`score-recall: ${msg}\n`);
  process.exit(2);
};

const readJson = (path, what) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`cannot read ${what} ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InputError(`${what} ${path} is not valid JSON: ${e.message}`);
  }
};

const listOf = (doc, what) => {
  const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.issues) ? doc.issues : null;
  if (!list) throw new InputError(`${what} must be a list or an object with an "issues" list`);
  return list;
};

const isText = (v) => typeof v === 'string' && v.length > 0;

const loadReference = (path) => {
  const list = listOf(readJson(path, 'ground truth'), 'ground truth');
  return list.map((r, i) => {
    const at = `ground truth entry ${i}`;
    if (!r || typeof r !== 'object') throw new InputError(`${at} is not an object`);
    if (!isText(r.id)) throw new InputError(`${at} has no id`);
    if (!SEV.includes(r.sev)) throw new InputError(`${at} (${r.id}) sev must be one of ${SEV.join(', ')}`);
    if (!isText(r.category)) throw new InputError(`${at} (${r.id}) has no category`);
    if (!Array.isArray(r.keywords) || !r.keywords.length || !r.keywords.every(isText)) {
      throw new InputError(`${at} (${r.id}) keywords must be a non-empty list of strings`);
    }
    if (r.anchor !== undefined && typeof r.anchor !== 'string') throw new InputError(`${at} (${r.id}) anchor must be a string`);
    return { id: r.id, sev: r.sev, category: r.category, anchor: (r.anchor ?? '').toLowerCase(), keywords: r.keywords.map((k) => k.toLowerCase()) };
  });
};

const anchorValue = (a) => (a && typeof a === 'object' ? [a.node, a.edge, a.entity, a.step].find((v) => typeof v === 'string') ?? '' : '');

const loadProduced = (path) => {
  const list = listOf(readJson(path, 'issues file'), 'issues file');
  return list.map((p, i) => {
    if (!p || typeof p !== 'object') throw new InputError(`issues entry ${i} is not an object`);
    const evidencePaths = Array.isArray(p.evidence) ? p.evidence.map((e) => (e && typeof e.path === 'string' ? e.path : '')) : [];
    const text = [p.title, p.summary, p.impact, p.fix, p.detail, ...evidencePaths].filter((s) => typeof s === 'string').join('\n').toLowerCase();
    return { id: String(p.id ?? `#${i}`), category: p.category, anchor: anchorValue(p.anchor).toLowerCase(), text };
  });
};

const score = (reference, produced) => {
  const counted = reference.filter((r) => r.sev !== 'low');
  if (!counted.length) throw new InputError('ground truth has no high or med reference issue to score');
  const used = new Set();
  const matched = [];
  const misses = [];
  for (const r of counted) {
    const sameCategory = produced.filter((p) => p.category === r.category && !used.has(p));
    const byAnchor = r.anchor ? sameCategory.find((p) => p.anchor === r.anchor) : undefined;
    const hit = byAnchor ?? sameCategory.find((p) => r.keywords.some((k) => p.text.includes(k)));
    if (hit) {
      used.add(hit);
      matched.push({ reference: r.id, produced: hit.id, by: byAnchor ? 'anchor' : 'keyword' });
    } else {
      misses.push({ id: r.id, sev: r.sev, category: r.category });
    }
  }
  const recalled = matched.length;
  const pass = recalled * 100 >= THRESHOLD_PCT * counted.length;
  return { recall: Math.round((recalled / counted.length) * 1000) / 1000, recalled, counted: counted.length, threshold: THRESHOLD, pass, matched, misses };
};

const render = (r) => {
  const lines = [
    `recall ${r.recall} (${r.recalled}/${r.counted} high+med reference issues recalled)`,
    `threshold ${r.threshold}: ${r.pass ? 'pass' : 'fail'}`,
    '',
    `matched (${r.matched.length}):`,
    ...r.matched.map((m) => `  ${m.reference} <- ${m.produced} (${m.by})`),
    '',
    `misses (${r.misses.length}):`,
    ...r.misses.map((m) => `  ${m.id} (${m.sev}, ${m.category})`),
  ];
  return `${lines.join('\n')}\n`;
};

const main = () => {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('-'));
  const files = args.filter((a) => !a.startsWith('-'));
  const unknown = flags.filter((f) => f !== '--json');
  if (unknown.length || files.length !== 2) fail(`${unknown.length ? `unknown option ${unknown[0]}; ` : ''}${USAGE}`);
  let result;
  try {
    const reference = loadReference(files[1]);
    const produced = loadProduced(files[0]);
    result = score(reference, produced);
  } catch (e) {
    if (e instanceof InputError) fail(e.message);
    throw e;
  }
  process.stdout.write(flags.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : render(result));
  process.exitCode = result.pass ? 0 : 1;
};

main();
