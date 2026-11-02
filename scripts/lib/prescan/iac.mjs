// iac.mjs - the infrastructure-as-code stack plug-in of prescan: static extraction from Terraform (*.tf) and Bicep (*.bicep).
//
// extractIac(files, read) -> fragment
//   { scanned, resources[], modules[], variables[], outputs[], references[], skipped{blocks}, truncated{...} }
// `resources`: one per Terraform `resource` / `data` block and per Bicep `resource` statement:
//   { kind: 'terraform' | 'bicep', mode: 'managed' | 'data' | 'existing', type, name, address, scope, evidence }
// (Terraform: type `aws_subnet`, name `app`, address `aws_subnet.app` or `data.aws_ami.base`; Bicep: type
// `Microsoft.Storage/storageAccounts` without its @api-version, name and address the symbolic name; `existing` is a Bicep
// `existing` resource). `modules`: one per Terraform `module` block and Bicep `module` statement:
//   { kind, name, address, source, target, scope, evidence } - `source` as written, `target` the repo-relative path a
// local source points at (a directory for Terraform, a file for Bicep), else null. `variables` are the Terraform
// `variable` blocks and Bicep `param` statements, `outputs` the `output` blocks and statements: { kind, name, scope,
// evidence } - the NAME only; no default, value, description, type or expression is kept. `scope` is where an address
// is unique: the directory of a .tf file (a Terraform module is a directory), the file itself for Bicep.
// `references` are the edges read from the expressions of a resource or module block: { kind, scope, from, to, via,
// attributes, evidence }. `to` is an address declared in the same scope (a name that is not declared is dropped, never
// guessed); `via` is `attribute` (module.x.out, aws_x.y.id, Bicep storage.name, a Bicep `scope:` ...), `depends_on`
// (Terraform depends_on, Bicep dependsOn) or `parent` (Bicep parent:); `attributes` are the names read right after the
// address (sorted, no duplicates), `evidence` one {path, lines} per line that holds the reference. Expressions of
// outputs, locals and variables are not read, and a reference through a local value is not followed.
// Comments, string text and heredoc text hold no reference: only code and ${ } / %{ } interpolations are read.
// Every item carries evidence: [{path, lines}] ("12" or "12-14": the block or statement; a Bicep decorator line is not part of it).
// Items are sorted by path then line; each kind has a ceiling (MAX_ITEMS), and what it drops is counted in `truncated`.
// A block that never closes is counted in `skipped.blocks` (it and the rest of its file are not read), never guessed.
//
// The files are read as text: no HCL or Bicep parser, no import, no eval, no process spawn, no `terraform`, `az` or
// `bicep`; .tfvars, .tf.json and .bicepparam files hold values and are not read. The default export is the plug-in
// object ({ id, detect(inventory), extract(files, read) }) that prescan.mjs loads. Node >= 18, ESM, zero dependencies.

import { posix } from 'node:path';
import { byCodeUnit } from './inventory.mjs';

export const KINDS = ['modules', 'outputs', 'references', 'resources', 'variables'];
export const MAX_ITEMS = 20000; // per kind: a ceiling against a pathological repo, not a budget (the explorer reads a summary)
export const MAX_NESTED = 2000; // evidence lines and attributes per reference
const MAX_TEXT = 200; // longest type / source string kept
const MAX_INTERP = 32; // nesting of "${ "${ ... }" }" followed

const isTerraform = (p) => /\.tf$/i.test(p);
const isBicep = (p) => /\.bicep$/i.test(p);

const clip = (s) => s.slice(0, MAX_TEXT);
const range = (a, b) => (a === b ? String(a) : `${a}-${b}`);
const lineAt = (item, i = 0) => Number(item.evidence[i].lines.split('-')[0]);

// ---------------------------------------------------------------------------------------------
// The masked view of a file: the same text, same offsets and line breaks, with comments blanked and the text of strings
// and heredocs blanked (their quotes and their ${ } interpolations stay). Structure and references are read from it;
// names and string values are read from the original at the same offsets.

const HEREDOC = /<<-?([A-Za-z_]\w*)[ \t]*\r?\n/y;

function mask(text, bicep) {
  const n = text.length;
  const out = text.split('');
  const quote = bicep ? "'" : '"';
  const blank = (i) => {
    if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };
  const blankRange = (a, b) => {
    for (let i = a; i < b; i++) blank(i);
  };
  const interpAt = (i, depth) => depth < MAX_INTERP && text[i + 1] === '{' && (text[i] === '$' || (!bicep && text[i] === '%'));
  const escapedInterp = (i) => !bicep && (text[i] === '$' || text[i] === '%') && text[i + 1] === text[i] && text[i + 2] === '{';

  function str(start, depth) {
    if (bicep && text.startsWith("'''", start)) {
      const close = text.indexOf("'''", start + 3);
      blankRange(start + 3, close < 0 ? n : close);
      return close < 0 ? n : close + 3;
    }
    let i = start + 1;
    while (i < n) {
      const c = text[i];
      if (c === '\n') return i;
      if (c === quote) return i + 1;
      if (c === '\\') {
        blank(i);
        if (i + 1 < n && text[i + 1] !== '\n') blank(i + 1);
        i += 2;
      } else if (escapedInterp(i)) {
        blankRange(i, i + 3);
        i += 3;
      } else if (interpAt(i, depth)) {
        i = code(i + 2, depth + 1) + 1; // code stops on the closing }, which stays
      } else {
        blank(i);
        i++;
      }
    }
    return n;
  }

  function heredoc(start, depth, ident) {
    let i = start;
    let lineStart = true;
    while (i < n) {
      if (lineStart) {
        let eol = text.indexOf('\n', i);
        if (eol < 0) eol = n;
        if (text.slice(i, eol).trim() === ident) {
          blankRange(i, eol);
          return eol;
        }
        lineStart = false;
      }
      const c = text[i];
      if (c === '\n') {
        lineStart = true;
        i++;
      } else if (escapedInterp(i)) {
        blankRange(i, i + 3);
        i += 3;
      } else if (interpAt(i, depth)) {
        i = code(i + 2, depth + 1) + 1;
      } else {
        blank(i);
        i++;
      }
    }
    return n;
  }

  // Code from `start`; at depth > 0 (inside an interpolation) it stops on the } that closes it and returns its index.
  function code(start, depth) {
    let i = start;
    let braces = 0;
    while (i < n) {
      const c = text[i];
      if (c === '{') braces++;
      else if (c === '}' && depth > 0) {
        if (braces === 0) return i;
        braces--;
      } else if ((c === '/' && text[i + 1] === '/') || (!bicep && c === '#')) {
        const eol = text.indexOf('\n', i);
        const e = eol < 0 ? n : eol;
        blankRange(i, e);
        i = e;
        continue;
      } else if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        const e = close < 0 ? n : close + 2;
        blankRange(i, e);
        i = e;
        continue;
      } else if (c === quote) {
        i = str(i, depth);
        continue;
      } else if (!bicep && c === '<' && text[i + 1] === '<') {
        HEREDOC.lastIndex = i;
        const m = HEREDOC.exec(text);
        if (m) {
          i = heredoc(i + m[0].length, depth, m[1]);
          continue;
        }
      }
      i++;
    }
    return n;
  }

  code(0, 0);
  return out.join('');
}

/** Index of the bracket that closes the one at `open`, or -1. */
function matchClose(cl, open, openCh, closeCh) {
  let depth = 0;
  for (let i = open; i < cl.length; i++) {
    if (cl[i] === openCh) depth++;
    else if (cl[i] === closeCh && --depth === 0) return i;
  }
  return -1;
}

/** 1-based line of an offset, through the sorted start offsets of the lines. */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The repo-relative path a local module source points at, else null. */
function targetOf(source, fromDir, bicep) {
  if (source === null) return null;
  const local = bicep ? !/^(?:br|ts)[:/]|:/.test(source) : /^\.\.?\//.test(source);
  if (!local) return null;
  const t = posix.normalize(posix.join(fromDir, source)).replace(/\/$/, '');
  return t === '..' || t.startsWith('../') ? null : t;
}

// ---------------------------------------------------------------------------------------------
// Terraform

const TF_HEAD = /[ \t\r\n]*([A-Za-z_][\w-]*)((?:[ \t]+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*)[ \t]*\{/y;
const TF_LABEL = /"([^"\n]*)"|([A-Za-z_][\w-]*)/g;
const TF_SOURCE = /(?:^|\n)[ \t]*source[ \t]*=[ \t]*"([^"\n]*)"/d;
const TF_LABELS = { resource: 2, data: 2, module: 1, variable: 1, output: 1 };

function parseTerraform(path, text, ctx) {
  const cl = mask(text, false);
  const lineOf = lineIndex(text);
  const dir = posix.dirname(path);
  let p = 0;
  while (p < cl.length) {
    TF_HEAD.lastIndex = p;
    const m = TF_HEAD.exec(cl);
    if (!m) {
      const nl = cl.indexOf('\n', p);
      if (nl < 0) break;
      p = nl + 1;
      continue;
    }
    const start = m.index + m[0].match(/^\s*/)[0].length;
    const open = m.index + m[0].length - 1;
    const close = matchClose(cl, open, '{', '}');
    if (close < 0) {
      ctx.skipped.blocks++;
      return;
    }
    p = close + 1;
    const type = m[1];
    const labels = [];
    const base = start + type.length;
    for (const l of m[2].matchAll(TF_LABEL)) labels.push(l[2] ?? text.slice(base + l.index + 1, base + l.index + 1 + l[1].length));
    if (labels.length !== TF_LABELS[type]) continue;
    const evidence = [{ path, lines: range(lineOf(start), lineOf(close)) }];
    if (type === 'variable' || type === 'output') {
      ctx.acc[type === 'variable' ? 'variables' : 'outputs'].push({ kind: 'terraform', name: labels[0], scope: dir, evidence });
      continue;
    }
    let address;
    if (type === 'module') {
      address = `module.${labels[0]}`;
      const s = TF_SOURCE.exec(cl.slice(open + 1, close));
      const raw = s ? text.slice(open + 1 + s.indices[1][0], open + 1 + s.indices[1][1]) : null;
      const source = raw !== null && !/\$\{|%\{/.test(raw) ? clip(raw) : null;
      ctx.acc.modules.push({ kind: 'terraform', name: labels[0], address, source, target: targetOf(source, dir, false), scope: dir, evidence });
    } else {
      address = type === 'data' ? `data.${labels[0]}.${labels[1]}` : `${labels[0]}.${labels[1]}`;
      ctx.acc.resources.push({
        kind: 'terraform',
        mode: type === 'data' ? 'data' : 'managed',
        type: labels[0],
        name: labels[1],
        address,
        scope: dir,
        evidence,
      });
    }
    ctx.blocks.push({ kind: 'terraform', scope: dir, address, path, lineOf, cl, from: open + 1, to: close, bicep: false });
  }
}

const TF_DATA_REF = /(?<![\w.-])data\.([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?/g;
const TF_REF = /(?<![\w.-])([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?/g;
const TF_DEPENDS = /\bdepends_on[ \t]*=[ \t]*\[/;

function terraformRefs(block, declared) {
  const body = block.cl.slice(block.from, block.to);
  const found = [];
  for (const m of body.matchAll(TF_DATA_REF)) found.push({ at: m.index, to: `data.${m[1]}.${m[2]}`, attr: m[3] ?? null });
  for (const m of body.matchAll(TF_REF)) if (m[1] !== 'data') found.push({ at: m.index, to: `${m[1]}.${m[2]}`, attr: m[3] ?? null });
  const dep = TF_DEPENDS.exec(body);
  const depEnd = dep ? matchClose(body, dep.index + dep[0].length - 1, '[', ']') : -1;
  return found
    .filter((f) => declared.has(f.to))
    .sort((a, b) => a.at - b.at)
    .map((f) => ({
      to: f.to,
      attr: f.attr,
      via: dep && f.at >= dep.index && f.at <= depEnd ? 'depends_on' : 'attribute',
      line: block.lineOf(block.from + f.at),
    }));
}

// ---------------------------------------------------------------------------------------------
// Bicep

const BICEP_KEYWORD = /(?:resource|module|param|output|var|type|func|targetScope|import|using|metadata|extension)(?!\w)/y;
const BICEP_DECORATOR = /@[A-Za-z_][\w.]*/y;
const BICEP_RESOURCE = /^resource[ \t]+([A-Za-z_]\w*)[ \t]+'([^'\n]*)'(?:[ \t]+(existing)(?!\w))?/d;
const BICEP_MODULE = /^module[ \t]+([A-Za-z_]\w*)[ \t]+'([^'\n]*)'/d;
const BICEP_NAMED = /^(param|output)[ \t]+([A-Za-z_]\w*)/;

/** End offset (the line break, or the end of the text) of the statement starting at `start`, or -1 when a bracket never closes. */
function statementEnd(cl, start) {
  let depth = 0;
  for (let i = start; i < cl.length; i++) {
    const c = cl[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0) return i;
  }
  return 0 >= depth ? cl.length : -1;
}

function parseBicep(path, text, ctx) {
  const cl = mask(text, true);
  const lineOf = lineIndex(text);
  const dir = posix.dirname(path);
  const n = cl.length;
  let p = 0;
  while (p < n) {
    while (p < n && /\s/.test(cl[p])) p++;
    if (p >= n) break;
    if (cl[p] === '@') {
      BICEP_DECORATOR.lastIndex = p;
      const d = BICEP_DECORATOR.exec(cl);
      if (d) {
        p += d[0].length;
        if (cl[p] === '(') {
          const close = matchClose(cl, p, '(', ')');
          if (close < 0) {
            ctx.skipped.blocks++;
            return;
          }
          p = close + 1;
        }
        continue;
      }
    }
    BICEP_KEYWORD.lastIndex = p;
    if (!BICEP_KEYWORD.test(cl)) {
      const nl = cl.indexOf('\n', p);
      p = nl < 0 ? n : nl + 1;
      continue;
    }
    const end = statementEnd(cl, p);
    if (end < 0) {
      ctx.skipped.blocks++;
      return;
    }
    const st = cl.slice(p, end);
    let last = end;
    while (last > p && /\s/.test(cl[last - 1])) last--;
    const evidence = [{ path, lines: range(lineOf(p), lineOf(last - 1)) }];
    const named = BICEP_NAMED.exec(st);
    const res = BICEP_RESOURCE.exec(st);
    const mod = res ? null : BICEP_MODULE.exec(st);
    if (named) {
      ctx.acc[named[1] === 'param' ? 'variables' : 'outputs'].push({ kind: 'bicep', name: named[2], scope: path, evidence });
    } else if (res || mod) {
      const m = res ?? mod;
      const literal = text.slice(p + m.indices[2][0], p + m.indices[2][1]);
      if (res) {
        ctx.acc.resources.push({
          kind: 'bicep',
          mode: res[3] ? 'existing' : 'managed',
          type: clip(literal.replace(/@[^@]*$/, '')),
          name: res[1],
          address: res[1],
          scope: path,
          evidence,
        });
      } else {
        const source = clip(literal);
        ctx.acc.modules.push({ kind: 'bicep', name: mod[1], address: mod[1], source, target: targetOf(source, dir, true), scope: path, evidence });
      }
      ctx.blocks.push({ kind: 'bicep', scope: path, address: m[1], path, lineOf, cl, from: p + m[0].length, to: end, bicep: true });
    }
    p = end;
  }
}

const BICEP_DEPENDS = /\bdependsOn[ \t]*:[ \t]*\[/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function bicepRefs(block, symbols) {
  if (symbols.length < 2 && symbols[0] === block.address) return [];
  const body = block.cl.slice(block.from, block.to);
  const re = new RegExp(`(?<![\\w.])(${symbols.slice().sort((a, b) => b.length - a.length || byCodeUnit(a, b)).map(escapeRe).join('|')})(?!\\w)(?:\\.([A-Za-z_]\\w*))?`, 'g');
  const dep = BICEP_DEPENDS.exec(body);
  const depEnd = dep ? matchClose(body, dep.index + dep[0].length - 1, '[', ']') : -1;
  const out = [];
  for (const m of body.matchAll(re)) {
    const before = body.slice(0, m.index);
    const lineHead = before.slice(before.lastIndexOf('\n') + 1);
    if (!m[2]) {
      // `sym: value` at the start of a property is a key, not a use of the symbol
      const prev = before.trimEnd().slice(-1);
      if (/^[ \t]*:/.test(body.slice(m.index + m[0].length)) && (prev === '' || prev === '{' || prev === ',' || /\n[ \t]*$/.test(before))) continue;
    }
    let via = 'attribute';
    if (/^[ \t]*parent[ \t]*:[ \t]*$/.test(lineHead)) via = 'parent';
    else if (dep && m.index >= dep.index && m.index <= depEnd) via = 'depends_on';
    out.push({ to: m[1], attr: m[2] ?? null, via, line: block.lineOf(block.from + m.index) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

/** Extract the iac fragment from `files` (repo-relative paths), reading them through `read`. */
export function extractIac(files, read) {
  const ctx = { skipped: { blocks: 0 }, blocks: [], acc: {} };
  for (const k of KINDS) ctx.acc[k] = [];
  let scanned = 0;
  for (const path of files.slice().sort(byCodeUnit)) {
    const bicep = isBicep(path);
    if (!bicep && !isTerraform(path)) continue;
    const text = read(path);
    if (typeof text !== 'string') continue;
    scanned++;
    (bicep ? parseBicep : parseTerraform)(path, text, ctx);
  }

  const declared = new Map(); // scope -> addresses
  for (const item of [...ctx.acc.resources, ...ctx.acc.modules]) {
    if (!declared.has(item.scope)) declared.set(item.scope, new Set());
    declared.get(item.scope).add(item.address);
  }
  const edges = new Map();
  for (const block of ctx.blocks) {
    const names = declared.get(block.scope);
    const refs = block.bicep ? bicepRefs(block, [...names]) : terraformRefs(block, names);
    for (const r of refs) {
      if (!names.has(r.to) || r.to === block.address) continue;
      const key = [block.scope, block.address, r.to, r.via].join('\0');
      if (!edges.has(key)) edges.set(key, { kind: block.kind, scope: block.scope, from: block.address, to: r.to, via: r.via, attrs: new Set(), at: new Map() });
      const e = edges.get(key);
      if (r.attr !== null) e.attrs.add(r.attr);
      e.at.set(`${block.path}\0${r.line}`, { path: block.path, line: r.line });
    }
  }
  ctx.acc.references = [...edges.values()].map((e) => ({
    kind: e.kind,
    scope: e.scope,
    from: e.from,
    to: e.to,
    via: e.via,
    attributes: [...e.attrs].sort(byCodeUnit).slice(0, MAX_NESTED),
    evidence: [...e.at.values()]
      .sort((a, b) => byCodeUnit(a.path, b.path) || a.line - b.line)
      .slice(0, MAX_NESTED)
      .map((x) => ({ path: x.path, lines: String(x.line) })),
  }));

  const truncated = {};
  const out = { scanned };
  for (const k of KINDS) {
    // Array.prototype.sort is stable, so items on one line keep their discovery order.
    const items = ctx.acc[k].slice().sort(
      (a, b) =>
        byCodeUnit(a.evidence[0].path, b.evidence[0].path) ||
        lineAt(a) - lineAt(b) ||
        (k === 'references' ? byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to) || byCodeUnit(a.via, b.via) : 0),
    );
    truncated[k] = Math.max(0, items.length - MAX_ITEMS);
    out[k] = items.slice(0, MAX_ITEMS);
  }
  out.skipped = ctx.skipped;
  out.truncated = truncated;
  return Object.fromEntries(Object.keys(out).sort(byCodeUnit).map((k) => [k, out[k]]));
}

const plugin = {
  id: 'iac',
  detect: (inventory) => inventory.files.some((p) => isTerraform(p) || isBicep(p)),
  extract: extractIac,
};

export default plugin;
