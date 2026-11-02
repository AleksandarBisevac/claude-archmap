#!/usr/bin/env node
// grade-benchmark.mjs - tool-neutral grading of one benchmark cell against the five expectations of PROTOCOL.md.
//
//   node grade-benchmark.mjs <run-dir> <A|B|C> <tool> <checklist.json> [--draw-c4-plot <plot.py>]
//
// Reads the cell that run-candidate.sh left: <run-dir>/repo, the git checkout the session wrote into, and
// <run-dir>/exit-code. The artifacts are the files `git status --porcelain --untracked-files=all` reports in the
// checkout (new or changed by the run); the corpus is those of them with a text extension. Writes
// <run-dir>/grading.json and prints the summary line, `{"passed": .., "failed": .., "notGraded": .., "total": ..}`
// followed by `missing:` and the key components not found.
//
// The expectations (PROTOCOL.md, Expectations):
//   E1 the key components of the checklist are each named in the artifact corpus (any of a component's terms, as a
//      case-insensitive substring); with no corpus at all it fails.
//   E2 at least three request or data flows are described. archmap: sequences of architecture.model.json with two or
//      more steps. draw-c4: the flows of its model.json, or of the model draw-c4's own plot.py extracts from its HTML
//      page when --draw-c4-plot names that script. Any other tool: sequenceDiagram blocks, plus the 2nd- to
//      4th-level headings of a Markdown file whose name or title says flow or sequence and the flow-named headings
//      (flow, sequence, lifecycle, request path, pipeline) of the others, plus the flow-like perspectives of an .omm
//      tree (lifecycle, flow, transition, orchestration, pipeline), the tree found wherever it sits.
//   E3 every component carries a file reference: a file or folder path (a token that starts with / is a URL route,
//      not a path). archmap: model nodes with evidence[]. draw-c4: model nodes whose text holds a path-like token,
//      leaving out external systems, actors and the system boundary, which are not components with a file.
//      oh-my-mermaid: element description.md files with a path-like token, leaving out the elements described as
//      External, systems outside the repository. cc-codemaps: rows of the component tables of its Markdown with a
//      path-like token in the evidence column; a route table is not a component table and is skipped.
//   E4 the artifact is one or more files under docs/architecture, or under the location the tool documents.
//   E5 the run exits 0, as <run-dir>/exit-code records.
// A check that cannot be done mechanically for the tool is recorded as not graded (passed null, notGraded true) with
// the reason, and counts in neither passed nor failed. Without a model.json and without --draw-c4-plot, E2 and E3 of
// draw-c4 are not graded.
//
// The checklist is a JSON file {"A": [{"component": "<name>", "terms": ["<substring>", ...]}, ...], "B": [...],
// "C": [...]}; the benchmark's own checklists are private and stay out of the repository (PROTOCOL.md, Repositories).
// This script reproduces the private grader the recorded cells were graded with, rule for rule; grading.json is
// written as that grader wrote it (Python's json.dump, indent 2, ASCII-escaped), and the evidence strings render
// lists as it did. The code of the mapped repository is never run; the only program started besides git is the
// plot.py that --draw-c4-plot names, with `python3 -I`.
// Exit 0 graded, 2 usage error or unreadable input. Node >= 18, ESM, zero dependencies.

import { readFileSync, writeFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: grade-benchmark.mjs <run-dir> <A|B|C> <tool> <checklist.json> [--draw-c4-plot <plot.py>]';
// The location each tool's README documents for its output; a tool not listed counts docs/architecture only.
const DOCUMENTED = { archmap: 'docs/architecture', 'draw-c4': 'docs/architecture', 'oh-my-mermaid': '.omm', 'cc-codemaps': 'codemaps' };
const TEXT_EXT = ['.json', '.md', '.mmd', '.html', '.txt', '.yaml', '.yml', '.dsl', '.puml', '.svg'];

class UsageError extends Error {}

// ---- the regular-expression vocabulary of the private grader (Python re, Unicode \w and \b) ----
const WC = '\\p{L}\\p{N}_';
const WB = `(?:(?<![${WC}])(?=[${WC}])|(?<=[${WC}])(?![${WC}]))`;
// A file or folder path; a token that starts with / is a URL route, not a path.
const PATHLIKE = new RegExp(
  `(?<![/${WC}])[${WC}.-]+/[${WC}./-]*` +
    `|${WB}[${WC}-]+\\.(?:py|ts|tsx|js|mjs|go|rs|java|sql|yml|yaml|json|toml|duckdb|sqlite|db)${WB}` +
    `|${WB}(?:Dockerfile|Makefile)${WB}`,
  'u',
);
const FLOW_HEADING = new RegExp(`${WB}(?:flow|sequence|lifecycle|request path|pipeline)${WB}`, 'iu');
const EXTERNAL = new RegExp(`^\\s*external(?![${WC}])`, 'iu');
const COMPONENT_WORD = new RegExp(`(?<![${WC}])component`, 'iu');
const ROUTE_WORD = new RegExp(`(?<![${WC}])route`, 'iu');

// ---- Python semantics the evidence strings and grading.json depend on ----
const splitLines = (t) => {
  const lines = t.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};
const stripChar = (s, c) => {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === c) a++;
  while (b > a && s[b - 1] === c) b--;
  return s.slice(a, b);
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const truthy = (v) =>
  Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : typeof v === 'string' ? v !== '' : Boolean(v);
const pyLen = (v) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : typeof v === 'string' ? [...v].length : 0);
const asList = (v) => (Array.isArray(v) ? v : []);
const get = (o, k, d) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

function pyStrRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === q) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + q;
}
const pyNum = (n) => (Number.isInteger(n) ? String(n) : String(n).replace(/e([+-])(\d)$/, 'e$10$2'));
// Python's repr(), for the values json.load can give.
function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return pyNum(v);
  if (typeof v === 'string') return pyStrRepr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}
const pyStr = (v) => (typeof v === 'string' ? v : pyRepr(v));

// Python's json.dumps: ensure_ascii, separators (', ', ': ') flat, or ',' and ': ' with an indent.
function pyJsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}
function pyDumps(v, indent = null, level = 0) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return pyNum(v);
  if (typeof v === 'string') return pyJsonString(v);
  const entries = Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v);
  const [open, close] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return open + close;
  const item = ([k, x]) => (k === null ? '' : `${pyJsonString(k)}: `) + pyDumps(x, indent, level + 1);
  if (indent === null) return open + entries.map(item).join(', ') + close;
  const pad = ' '.repeat(indent * (level + 1));
  return `${open}\n${pad}${entries.map(item).join(`,\n${pad}`)}\n${' '.repeat(indent * level)}${close}`;
}
const pySlice = (s, n) => Array.from(s).slice(0, n).join('');

// ---- the cell ----
function parseArgs(argv) {
  const pos = [];
  let plot = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--draw-c4-plot') {
      if (i + 1 >= argv.length) throw new UsageError('--draw-c4-plot needs the path of plot.py');
      plot = argv[++i];
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 4) throw new UsageError(pos.length < 4 ? 'missing arguments' : 'too many arguments');
  const [runDir, letter, tool, checklist] = pos;
  if (!['A', 'B', 'C'].includes(letter)) throw new UsageError(`repository letter ${letter} is none of A, B, C`);
  const run = resolve(runDir);
  const repo = join(run, 'repo');
  if (!isDir(repo)) throw new UsageError(`${repo} is not a directory`);
  let list;
  try {
    list = JSON.parse(readFileSync(checklist, 'utf8'))[letter];
  } catch (e) {
    throw new UsageError(`cannot read the checklist ${checklist}: ${e.message}`);
  }
  if (!Array.isArray(list) || !list.every((c) => isObj(c) && typeof c.component === 'string' && Array.isArray(c.terms) && c.terms.every((t) => typeof t === 'string'))) {
    throw new UsageError(`the checklist has no list of {component, terms} for ${letter}`);
  }
  if (plot !== null && !isFile(plot)) throw new UsageError(`--draw-c4-plot: ${plot} is not a file`);
  return { run, repo, letter, tool, req: list.map((c) => [c.component, c.terms]), plot: plot === null ? null : resolve(plot) };
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function grade({ run, repo, letter, tool, req, plot }) {
  const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
  if (st.status !== 0) throw new UsageError(`git status failed in ${repo}: ${(st.stderr || st.error?.message || '').trim()}`);
  const changed = splitLines(st.stdout).filter((l) => l.trim()).map((l) => stripChar(l.slice(3).trim(), '"'));
  const artifacts = changed.filter((f) => isFile(join(repo, f)));
  // Read as Python's text mode reads: undecodable bytes replaced, every line ending made \n.
  const read = (f) => {
    try {
      return readFileSync(join(repo, f), 'utf8').replace(/\r\n?/g, '\n');
    } catch {
      return '';
    }
  };
  const corpus = new Map(artifacts.filter((f) => TEXT_EXT.some((x) => f.toLowerCase().endsWith(x))).map((f) => [f, read(f)]));
  const blob = [...corpus.values()].join('\n').toLowerCase();
  const res = [];
  const add = (key, text, passed, evidence) =>
    res.push({ key, text, passed, notGraded: passed === null, evidence: pySlice(String(evidence), 1500) });
  const loadJson = (f) => {
    try {
      return JSON.parse(read(f));
    } catch {
      return null;
    }
  };
  // The first artifact whose name ends so, parsed (null when it is not JSON), or null when there is none.
  const firstJson = (suffix) => {
    const f = artifacts.find((x) => x.endsWith(suffix));
    return f === undefined ? null : loadJson(f);
  };

  // E1
  const found = [];
  const missing = [];
  for (const [name, terms] of req) (terms.some((t) => blob.includes(t.toLowerCase())) ? found : missing).push(name);
  add('E1', 'the key components of the private checklist are each named in the produced artifact', corpus.size ? !missing.length : false,
    `${found.length}/${req.length} found; missing ${pyRepr(missing)}; corpus files ${corpus.size}`);

  // E2
  let flowsN = null;
  let how = '';
  let drawModel = null;
  if (tool === 'archmap') {
    const m = firstJson('architecture.model.json');
    if (isObj(m) && truthy(m)) {
      flowsN = asList(get(m, 'sequences', [])).filter((s) => pyLen(get(s, 'steps', [])) >= 2).length;
      how = 'model sequences with >=2 steps';
    } else how = 'no architecture.model.json among the artifacts';
  } else if (tool === 'draw-c4') {
    let m = firstJson('model.json');
    if (m === null) {
      const html = artifacts.find((f) => f.endsWith('.html'));
      if (html !== undefined && plot !== null) {
        const extracted = join(run, 'extracted-model.json');
        spawnSync('python3', ['-I', plot, 'extract', join(repo, html), extracted], { cwd: repo, encoding: 'utf8' });
        try {
          m = JSON.parse(readFileSync(extracted, 'utf8'));
        } catch {
          m = null;
        }
      }
    }
    if (isObj(m) && truthy(m)) {
      flowsN = pyLen(get(m, 'flows', []));
      how = 'model.json flows';
      drawModel = m;
      writeFileSync(join(run, 'draw-c4-model.json'), pyDumps(m));
    } else how = plot === null ? 'no model.json among the artifacts and no --draw-c4-plot to extract one from the HTML page' : 'no model.json among the artifacts and none extracted from an HTML page';
  } else {
    let seq = 0;
    for (const t of corpus.values()) seq += t.split('sequenceDiagram').length - 1;
    let heads = 0;
    for (const [f, t] of corpus) {
      if (!f.endsWith('.md')) continue;
      const lines = t.split('\n');
      const titled = lines.find((l) => l.startsWith('# '));
      const top = titled === undefined ? '' : titled.slice(2);
      const flowfile = /flow|sequence/i.test(`${f.split('/').pop()} ${top}`);
      for (const l of lines) {
        const h = l.match(/^#{2,4} ([\s\S]*)$/);
        if (h && (flowfile || FLOW_HEADING.test(h[1]))) heads += 1;
      }
    }
    // The path inside the .omm tree, wherever the tree sits.
    const omm = (f) => (`/${f}`.includes('/.omm/') ? f.replace(/^.*?(^|\/)\.omm\//, '') : null);
    const persp = new Set(
      artifacts
        .map(omm)
        .filter((p) => p && (p.match(/\//g) || []).length >= 1 && /lifecycle|flow|transition|orchestration|pipeline/.test(p.split('/')[0]))
        .map((p) => p.split('/')[0]),
    ).size;
    flowsN = seq + heads + persp;
    how = `sequenceDiagram blocks ${seq} + headings in flow files or flow-named headings ${heads} + flow-like perspectives ${persp}`;
  }
  add('E2', 'at least three request or data flows are described', flowsN === null ? null : flowsN >= 3,
    flowsN === null ? `not graded: ${how}` : `${flowsN} (${how})`);

  // E3
  let compTotal = null;
  let compWith = null;
  let detail = '';
  if (tool === 'archmap') {
    const m = firstJson('architecture.model.json');
    if (isObj(m) && truthy(m)) {
      const nodes = asList(get(m, 'nodes', []));
      compTotal = nodes.length;
      compWith = nodes.filter((n) => truthy(get(n, 'evidence', null))).length;
      detail = 'nodes with evidence[]';
    } else detail = 'no architecture.model.json among the artifacts';
  } else if (tool === 'draw-c4') {
    // The model E2 graded and kept as draw-c4-model.json.
    const m = drawModel;
    if (m) {
      let levels = get(m, 'levels', []);
      levels = isObj(levels) ? Object.values(levels) : asList(levels); // draw-c4 keys levels by id
      let nodes = levels.filter(isObj).flatMap((lv) => asList(get(lv, 'nodes', [])));
      if (!nodes.length) nodes = asList(get(m, 'nodes', []));
      // External systems, actors and the system boundary are not components with a file.
      nodes = nodes.filter((n) => !['external', 'person', 'focus'].includes(get(n, 'kind', null)));
      compTotal = nodes.length;
      compWith = nodes.filter((n) => PATHLIKE.test(['name', 'tech', 'desc', 'path', 'file', 'src', 'source'].map((k) => pyStr(get(n, k, ''))).join(' '))).length;
      detail = 'nodes whose text holds a path-like token (kind external excluded)';
    } else detail = how;
  } else if (tool === 'oh-my-mermaid') {
    // An element described as External is a system outside the repository, not a component with a file.
    const descs = artifacts.filter((f) => `/${f}`.includes('/.omm/') && f.endsWith('/description.md') && !EXTERNAL.test(corpus.get(f) ?? ''));
    if (descs.length) {
      compTotal = descs.length;
      compWith = descs.filter((f) => PATHLIKE.test(corpus.get(f) ?? '')).length;
      detail = 'element description.md files with a path-like token (elements described as External excluded)';
    } else detail = 'no element description.md in an .omm tree';
  } else if (tool === 'cc-codemaps') {
    let rowsTotal = 0;
    let rowsWith = 0;
    for (const [f, t] of corpus) {
      if (!f.endsWith('.md')) continue;
      const lines = splitLines(t);
      lines.forEach((l, i) => {
        // A component table: a header naming a component and an evidence column, then the separator row. A route
        // table, or a table keyed by path, is not one.
        if (
          l.startsWith('|') && COMPONENT_WORD.test(l) && /evidence|file|path|root|location/i.test(l) && !ROUTE_WORD.test(l) &&
          !/^\|\s*path\s*\|/i.test(l) && i + 1 < lines.length && /^\|[-: |]+\|?$/.test(lines[i + 1])
        ) {
          const cols = stripChar(l, '|').split('|').map((c) => c.trim().toLowerCase());
          let ev = cols.findIndex((c) => /evidence|file|folder|root|location|source/.test(c));
          if (ev === -1) ev = cols.findIndex((c) => /path/.test(c));
          for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
            const cells = stripChar(lines[j], '|').split('|').map((c) => c.trim());
            rowsTotal += 1;
            if (ev !== -1 && ev < cells.length && PATHLIKE.test(cells[ev])) rowsWith += 1;
          }
        }
      });
    }
    if (rowsTotal) {
      compTotal = rowsTotal;
      compWith = rowsWith;
      detail = 'rows of component tables with a path-like token in the evidence column';
    } else detail = 'no component table found';
  } else detail = `no component reading for the tool ${tool}`;
  add('E3', 'every component carries a file reference as evidence', compTotal === null ? null : compWith === compTotal && compTotal > 0,
    compTotal === null ? `not graded: ${detail}` : `${compWith}/${compTotal} (${detail})`);

  // E4
  const loc = DOCUMENTED[tool] ?? 'docs/architecture';
  const base = loc.replace(/\/+$/, '');
  const inDocs = artifacts.filter((f) => f.startsWith('docs/architecture/'));
  const inLoc = artifacts.filter((f) => f.startsWith(`${base}/`) || `/${f}`.includes(`/${base}/`));
  add('E4', 'the artifact is one or more files under docs/architecture of the repository, or the location the tool documents', inDocs.length > 0 || inLoc.length > 0,
    `docs/architecture: ${pyRepr(inDocs.slice(0, 8))}; documented ${loc}: ${pyRepr(inLoc.slice(0, 8))}; all new/changed: ${artifacts.length}`);

  // E5
  let ec = null;
  try {
    const raw = readFileSync(join(run, 'exit-code'), 'utf8').trim();
    if (/^[+-]?\d+(?:_\d+)*$/.test(raw)) ec = Number(raw.replace(/_/g, ''));
  } catch {
    ec = null;
  }
  add('E5', 'the run exits 0', ec === 0, `exit-code ${pyRepr(ec)}`);

  const graded = res.filter((r) => !r.notGraded);
  const summary = {
    passed: graded.filter((r) => r.passed).length,
    failed: graded.filter((r) => r.passed === false).length,
    notGraded: res.length - graded.length,
    total: res.length,
  };
  const out = {
    tool,
    repo: letter,
    expectations: res,
    summary,
    artifacts: artifacts.slice(0, 200),
    artifactBytes: artifacts.reduce((n, f) => n + statSync(join(repo, f)).size, 0),
  };
  writeFileSync(join(run, 'grading.json'), pyDumps(out, 2));
  return { summary, missing, line: `${pyDumps(summary)} missing: ${pyRepr(missing)}` };
}

export function main(argv) {
  try {
    if (argv.length === 1 && (argv[0] === '-h' || argv[0] === '--help')) {
      console.log(USAGE);
      return 0;
    }
    const { line } = grade(parseArgs(argv));
    console.log(line);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`grade-benchmark.mjs: ${e.message}`);
      console.error(USAGE);
      return 2;
    }
    throw e;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
