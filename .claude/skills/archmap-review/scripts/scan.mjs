#!/usr/bin/env node
// Mechanical first pass for archmap-review: scans ADDED lines of a git diff for rule violations that a pattern can
// catch. Read-only; prints JSON leads for the reviewer to confirm. Node >= 18, zero deps.
//
//   node .claude/skills/archmap-review/scripts/scan.mjs --base <ref> [--head <ref>] [--repo <dir>]
//
// Without --head the working tree (staged + unstaged) is compared against --base.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

function parseArgs(argv) {
  const out = { base: null, head: null, repo: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--head') out.head = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Returns [{file, line, text}] for every added line in the diff.
function addedLines(repo, base, head) {
  const range = head ? [`${base}...${head}`] : [base];
  const diff = git(repo, ['diff', '--unified=0', '--no-color', '--no-ext-diff', ...range]);
  const out = [];
  let file = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? null : raw.slice(6);
    } else if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
    } else if (file && raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1) });
      line++;
    }
  }
  // Untracked files are invisible to `git diff`; include them when scanning the working tree.
  if (!head) {
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    for (const f of untracked) {
      let content;
      try { content = readFileSync(join(repo, f), 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      content.split('\n').forEach((text, i) => out.push({ file: f, line: i + 1, text }));
    }
  }
  return out;
}

function loadDenylist(repo) {
  const p = join(repo, '.private', 'anonymise-denylist.txt');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    .map((s) => s.toLowerCase());
}

const isCode = (f) => /\.(mjs|cjs|js|ts)$/.test(f);
const isOwnCode = (f) => isCode(f) && !f.startsWith('.agents/') && !f.endsWith('elk.bundled.js');
const isShipped = (f) => /^(scripts|hooks|assets)\//.test(f) && !f.endsWith('elk.bundled.js');
const builtins = new Set(builtinModules);

const POST_18 = [
  [/\bfs(?:\.promises)?\.glob\b|\bglob\s*\(/, 'fs.glob (Node 22)'],
  [/import\.meta\.(dirname|filename)\b/, 'import.meta.dirname/filename (Node 20.11)'],
  [/\.(toSorted|toReversed|toSpliced)\s*\(|\.with\s*\(\s*-?\d/, 'change-array-by-copy methods (Node 20)'],
  [/\b(Object|Map)\.groupBy\s*\(/, 'Object/Map.groupBy (Node 21)'],
  [/\bPromise\.withResolvers\s*\(/, 'Promise.withResolvers (Node 22)'],
  [/\.(union|intersection|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\s*\(/, 'Set methods (Node 22)'],
  [/(?<![\w)\]])\/(?![/*\s])(?:[^/\\\n]|\\.)+\/[dgimsuy]*v[dgimsuy]*(?![\w])/, 'RegExp v flag (Node 20)'],
];
const NONDETERMINISM = /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(|\brandomUUID\s*\(/;
const SHELL_STRING = /\bexec(?:Sync)?\s*\(\s*`|\bexec(?:Sync)?\s*\([^)]*\+|shell\s*:\s*true/;
const EXTERNAL_URL = /https?:\/\/(?!example\.invalid|localhost|127\.0\.0\.1)[^\s'"`)<>]+/;
const IMPORT_SPEC = /(?:^\s*(?:import|export)\b[^'"]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([@\w][\w@/.\-]*|\.{1,2}\/[^'"]*|\/[^'"]*|node:[\w/]+)['"]/g;

function scan(lines, denylist) {
  const leads = [];
  const add = (rule, severity, l, note, withText = true) =>
    leads.push({ rule, severity, file: l.file, line: l.line, note, ...(withText ? { text: l.text.trim().slice(0, 160) } : {}) });

  for (const l of lines) {
    const comment = /^\s*(\/\/|\*|\/\*)/.test(l.text);
    const lower = l.text.toLowerCase();
    if (denylist && l.file !== 'docs/design.md' && !l.file.startsWith('.private/')) {
      denylist.forEach((term, idx) => {
        if (lower.includes(term)) add('1-denylist', 'high', l, `denylist term #${idx + 1} (text withheld)`, false);
      });
    }
    if (isShipped(l.file)) {
      const url = EXTERNAL_URL.exec(l.text);
      if (url && !/licen[cs]e|eclipse\.org\/legal|opensource\.org/i.test(l.text)) {
        add('4-offline', 'high', l, `external URL in shipped code: ${url[0].slice(0, 80)}`);
      }
    }
    if (isOwnCode(l.file) && !comment) {
      for (const m of l.text.matchAll(IMPORT_SPEC)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        if (builtins.has(spec)) add('2-deps', 'low', l, `builtin '${spec}' without the node: prefix`);
        else add('2-deps', 'high', l, `non-builtin import '${spec}' (zero npm deps)`);
      }
      for (const [re, what] of POST_18) if (re.test(l.text)) add('2-node18', 'high', l, `${what} - not in Node 18`);
      if (!l.file.startsWith('tests/') && NONDETERMINISM.test(l.text)) {
        add('3-determinism', 'med', l, 'time/randomness source - must not reach output');
      }
      if (SHELL_STRING.test(l.text)) add('7-scanner-safety', 'high', l, 'shell string child process - use execFile/spawn with an args array');
    }
    if (l.file.startsWith('schema/') && /"additionalProperties"\s*:\s*false/.test(l.text)) {
      add('5-model-contract', 'med', l, 'additionalProperties:false breaks unknown-key tolerance');
    }
    if (l.file === 'package.json' && /"(dev|peer|optional)?[dD]ependencies"\s*:/.test(l.text)) {
      add('2-deps', 'high', l, 'package.json dependencies (repo is zero-npm-deps)');
    }
  }
  return leads;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (args.help || !args.base) {
    console.error('usage: scan.mjs --base <ref> [--head <ref>] [--repo <dir>]');
    process.exit(args.help ? 0 : 2);
  }
  let lines;
  try { lines = addedLines(args.repo, args.base, args.head); } catch (e) { console.error(`git diff failed: ${e.message}`); process.exit(2); }
  const denylist = loadDenylist(args.repo);
  const leads = scan(lines, denylist);
  const files = [...new Set(lines.map((l) => l.file))].sort();
  console.log(JSON.stringify({
    base: args.base,
    head: args.head ?? 'WORKTREE',
    filesScanned: files.length,
    addedLines: lines.length,
    denylist: denylist ? `checked (${denylist.length} terms)` : 'SKIPPED - .private/anonymise-denylist.txt absent',
    leads,
  }, null, 2));
}

main();
