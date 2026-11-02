// containers.mjs - the containers stack plug-in of prescan: static, line-based extraction from Dockerfiles and compose files.
//
// extractContainers(files, read) -> fragment
//   { scanned, services[], dockerfiles[], skipped{services, dockerfiles}, truncated{services, dockerfiles} }
// A compose file (compose*.y(a)ml, docker-compose*.y(a)ml) gives one `service` per entry under `services:`:
//   { name, image, build: {context, dockerfile} | null, ports: [{host, container, protocol}], volumes: ['src:dst[:mode]'],
//     dependsOn: [name], envKeys: [NAME], evidence }
// `image` and `build` are as written (a build context and its Dockerfile are made repo-relative against the compose file,
// unless they hold a ${variable} or a URL); `envKeys` are the NAMES of the environment entries and of the keys in the
// env_file files the repo holds, never a value. A Dockerfile (Dockerfile, Dockerfile.*, *.Dockerfile) gives one `dockerfile`
// per file: { base, stages, ports: [{port, protocol}], command, entrypoint, evidence } read from the FINAL stage (a stage
// that starts FROM an earlier stage inherits its exposed ports, entrypoint and cmd, as the image does). `base` is the
// image of the final stage as written (an ARG stays `${NAME}`), `command` the ENTRYPOINT then CMD words, `entrypoint` the
// file that command runs (a script or an interpreter's first file argument), else null.
// Every item carries evidence: [{path, lines}] ("12" or "12-14": the service block, or the final stage). Items are sorted by
// path then line; each kind has a ceiling (MAX_ITEMS: the extract is the full record), and what it drops is counted in
// `truncated`. A recognised shape whose value cannot be resolved statically (a service that is a YAML alias or holds a
// merge key, a file without a FROM) is counted in `skipped`, never guessed.
//
// The YAML read here is the small block/flow subset a compose file uses, parsed by hand: no YAML library, and the
// scanned files are only ever read as text - no import, no eval, no process spawn, no `docker`. The default export is the
// plug-in object ({ id, detect(inventory), extract(files, read) }) that prescan.mjs loads. Node >= 18, ESM, zero dependencies.

import { posix } from 'node:path';
import { byCodeUnit } from './inventory.mjs';

export const KINDS = ['dockerfiles', 'services'];
export const MAX_ITEMS = 20000; // per kind: a ceiling against a pathological repo, not a budget (the explorer reads a summary)
export const MAX_NESTED = 2000; // ports, volumes, dependencies and env keys per service or Dockerfile
const MAX_TEXT = 200; // longest command / image string kept

const NON_DOCKERFILE_SUFFIX = /\.(?:md|markdown|txt|rst|json|ya?ml|toml|lock|bak|orig|swp|tmp|png|svg)$/i;
const COMPOSE_RE = /(?:^|\/)(?:docker-)?compose(?:[.-][A-Za-z0-9_.-]+)?\.ya?ml$/i;

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const isDockerfile = (p) => {
  const b = baseName(p);
  if (/^Dockerfile$/i.test(b)) return true;
  if (/^Dockerfile\./i.test(b)) return !NON_DOCKERFILE_SUFFIX.test(b);
  return /^.+\.Dockerfile$/i.test(b);
};
const isCompose = (p) => COMPOSE_RE.test(p);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

const clip = (s) => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : s);
const range = (a, b) => (a === b ? String(a) : `${a}-${b}`);
const uniqSorted = (xs) => [...new Set(xs)].sort(byCodeUnit);

// ---------------------------------------------------------------------------------------------
// A small YAML reader: nodes are { t: 'map', entries: [{key, line, end, v}], merge } | { t: 'seq', items: [{line, end, v}] }
// | { t: 'scalar', value } | { t: 'alias' }. Enough for compose files; anything stranger degrades to a scalar.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      // a quote opens a string only at the start of a token
      if (i === 0 || /[\s:,[{-]/.test(line[i - 1])) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const scalar = (value) => ({ t: 'scalar', value });
const NULL = () => scalar('');

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\/])/g, '$1');
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** A flow collection ([a, b] or {k: v}) or quoted/plain scalar held in one string. */
function flowValue(s, n) {
  let p = 0;
  const ws = () => {
    while (p < s.length && /\s/.test(s[p])) p++;
  };
  const quoted = () => {
    const q = s[p];
    let j = p + 1;
    while (j < s.length && s[j] !== q) j += s[j] === '\\' && q === '"' ? 2 : 1;
    const text = s.slice(p, j + 1);
    p = Math.min(j + 1, s.length);
    return unquote(text);
  };
  const plain = (stops) => {
    const from = p;
    while (p < s.length && !stops.includes(s[p])) p++;
    return s.slice(from, p).trim();
  };
  const value = () => {
    ws();
    const c = s[p];
    if (c === '[') {
      p++;
      const items = [];
      for (;;) {
        ws();
        if (p >= s.length) break;
        if (s[p] === ']') {
          p++;
          break;
        }
        const before = p;
        items.push({ line: n, end: n, v: value() });
        ws();
        if (s[p] === ',') p++;
        else if (s[p] !== ']' || p === before) {
          if (p === before) p++;
        }
      }
      return { t: 'seq', items };
    }
    if (c === '{') {
      p++;
      const entries = [];
      for (;;) {
        ws();
        if (p >= s.length) break;
        if (s[p] === '}') {
          p++;
          break;
        }
        const before = p;
        const key = s[p] === '"' || s[p] === "'" ? quoted() : plain(':,}');
        ws();
        let v = NULL();
        if (s[p] === ':') {
          p++;
          v = value();
        }
        entries.push({ key, line: n, end: n, v });
        ws();
        if (s[p] === ',') p++;
        else if (p === before) p++;
      }
      return { t: 'map', entries, merge: false };
    }
    if (c === '"' || c === "'") return scalar(quoted());
    if (c === '*') return { t: 'alias' };
    return scalar(plain(',]}'));
  };
  return value();
}

const BLOCK_SCALAR = /^[|>][+-]?\d*$/;
const QUOTED_KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/;
const PLAIN_KEY = /^([^\s"'[\]{},&*!|>#%@`-][^]*?|-[^\s][^]*?)\s*:(?:\s+(.*))?$/;

/** { key, rest } when `text` is a `key: rest` map entry, else null. */
function keyValue(text) {
  if (text[0] === '[' || text[0] === '{') return null;
  let m = QUOTED_KEY.exec(text);
  if (m) return { key: unquote(m[1]), rest: (m[2] ?? '').trim() };
  m = PLAIN_KEY.exec(text);
  if (m) return { key: m[1].trim(), rest: (m[2] ?? '').trim() };
  return null;
}

const isSeqLine = (l) => l.text === '-' || l.text.startsWith('- ');

function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = stripComment(raw).trimEnd();
    if (!t.trim() || /^(---|\.\.\.)(\s|$)/.test(t)) return;
    lines.push({ n: i + 1, indent: t.length - t.trimStart().length, text: t.trim() });
  });
  let i = 0;
  const endOf = () => lines[i - 1].n;

  // a value that follows `key:` or `-` with nothing after it: the child block, else null
  const child = (indent, sameIndentSeq) => {
    const nx = lines[i];
    if (nx && (nx.indent > indent || (sameIndentSeq && nx.indent === indent && isSeqLine(nx)))) return block(nx.indent);
    return NULL();
  };

  const inline = (rest, n) => {
    let r = rest;
    if (/^&\S+\s*$/.test(r)) return null; // anchor alone: the value is the child block
    r = r.replace(/^&\S+\s+/, '').replace(/^!\S*\s+/, '');
    if (r[0] === '*') return { t: 'alias' };
    if (r[0] === '[' || r[0] === '{') {
      const open = r[0];
      let joined = r;
      const depthOf = (s) => {
        let d = 0;
        let q = null;
        for (const c of s) {
          if (q) {
            if (c === q) q = null;
          } else if (c === '"' || c === "'") q = c;
          else if (c === '[' || c === '{') d++;
          else if (c === ']' || c === '}') d--;
        }
        return d;
      };
      while (depthOf(joined) > 0 && i < lines.length) joined += ` ${lines[i++].text}`;
      return flowValue(joined, n) ?? (open === '[' ? { t: 'seq', items: [] } : NULL());
    }
    return scalar(unquote(r));
  };

  function seq(indent) {
    const items = [];
    while (i < lines.length && lines[i].indent === indent && isSeqLine(lines[i])) {
      const l = lines[i];
      const rest = l.text.slice(1).trimStart();
      const start = l.n;
      let v;
      if (rest === '') {
        i++;
        v = child(indent, false);
      } else if (keyValue(rest) && !/^[&*]/.test(rest)) {
        // `- key: value` opens a map whose indent is the column of the key
        lines[i] = { n: l.n, indent: indent + (l.text.length - rest.length), text: rest };
        v = map(lines[i].indent);
      } else if (isSeqLine({ text: rest })) {
        lines[i] = { n: l.n, indent: indent + (l.text.length - rest.length), text: rest };
        v = seq(lines[i].indent);
      } else {
        i++;
        v = inline(rest, l.n) ?? child(indent, false);
      }
      items.push({ line: start, end: endOf(), v });
    }
    return { t: 'seq', items };
  }

  function map(indent) {
    const entries = [];
    let merge = false;
    while (i < lines.length && lines[i].indent === indent && !isSeqLine(lines[i])) {
      const l = lines[i];
      const kv = keyValue(l.text);
      if (!kv) {
        i++; // not a `key: value` line: a stray continuation line, skipped
        continue;
      }
      i++;
      let v;
      if (BLOCK_SCALAR.test(kv.rest)) {
        while (i < lines.length && lines[i].indent > indent) i++;
        v = scalar('');
      } else if (kv.rest === '') {
        v = child(indent, true);
      } else {
        v = inline(kv.rest, l.n) ?? child(indent, true);
        while (i < lines.length && lines[i].indent > indent) i++; // continuation lines of a multi-line scalar
      }
      if (kv.key === '<<') merge = true;
      else entries.push({ key: kv.key, line: l.n, end: endOf(), v });
    }
    return { t: 'map', entries, merge };
  }

  function block(indent) {
    return isSeqLine(lines[i]) ? seq(indent) : map(indent);
  }

  return lines.length ? block(lines[0].indent) : null;
}

const entryOf = (node, key) => (node?.t === 'map' ? node.entries.find((e) => e.key === key) : undefined);
const valueOf = (node, key) => entryOf(node, key)?.v;
const textOf = (node) => (node?.t === 'scalar' && node.value !== '' ? node.value : null);

// ---------------------------------------------------------------------------------------------
// Compose

/** `8080:80`, `127.0.0.1:8443:8443/tcp`, `80`, `${PORT:-80}:80` -> {host, container, protocol}; ranges stay strings. */
function shortPort(text) {
  const held = [];
  const masked = text.replace(/\$\{[^}]*\}/g, (m) => `\u0000${held.push(m) - 1}\u0000`);
  const proto = /\/([A-Za-z]+)$/.exec(masked);
  const body = proto ? masked.slice(0, proto.index) : masked;
  const back = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, k) => held[Number(k)]);
  const parts = body.split(':');
  const container = back(parts[parts.length - 1]);
  const host = parts.length >= 2 ? back(parts[parts.length - 2]) : '';
  return { host: host === '' ? null : host, container, protocol: proto ? proto[1].toLowerCase() : 'tcp' };
}

const portOf = (v) => {
  if (v?.t === 'scalar') return v.value === '' ? null : shortPort(v.value);
  if (v?.t === 'map') {
    const target = textOf(valueOf(v, 'target'));
    if (target === null) return null;
    return { host: textOf(valueOf(v, 'published')), container: target, protocol: (textOf(valueOf(v, 'protocol')) ?? 'tcp').toLowerCase() };
  }
  return null;
};

const volumeOf = (v) => {
  if (v?.t === 'scalar') return v.value === '' ? null : v.value;
  if (v?.t === 'map') {
    const source = textOf(valueOf(v, 'source'));
    const target = textOf(valueOf(v, 'target'));
    return target === null ? null : source === null ? target : `${source}:${target}`;
  }
  return null;
};

/** A path written in a compose file, made repo-relative against the compose file's directory; null when it holds a ${variable}. */
const resolveIn = (dir, p) => (/\$/.test(p) ? null : posix.join(dir, p));

function buildOf(node, dir) {
  if (node === undefined || node.t === 'alias') return null;
  let context = null;
  let dockerfile = 'Dockerfile';
  if (node.t === 'scalar') context = textOf(node);
  else if (node.t === 'map') {
    context = textOf(valueOf(node, 'context')) ?? '.';
    dockerfile = textOf(valueOf(node, 'dockerfile')) ?? 'Dockerfile';
  }
  if (context === null) return null;
  const remote = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^git@|^\//.test(context) || /\$/.test(context);
  if (remote) return { context, dockerfile: null };
  const resolved = posix.join(dir, context);
  return { context: resolved, dockerfile: /\$/.test(dockerfile) ? null : posix.join(resolved, dockerfile) };
}

const envKeyOf = (text) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|$)/.exec(text)?.[1] ?? null;

function envKeysOf(svc, dir, fileSet, read) {
  const keys = [];
  const env = valueOf(svc, 'environment');
  if (env?.t === 'map') keys.push(...env.entries.map((e) => e.key));
  else if (env?.t === 'seq') {
    for (const it of env.items) {
      const t = textOf(it.v);
      const k = t === null ? null : envKeyOf(t);
      if (k) keys.push(k);
    }
  }
  const ef = valueOf(svc, 'env_file');
  const paths = [];
  if (ef?.t === 'scalar') paths.push(textOf(ef));
  else if (ef?.t === 'seq') {
    for (const it of ef.items) paths.push(it.v.t === 'map' ? textOf(valueOf(it.v, 'path')) : textOf(it.v));
  }
  for (const rel of paths) {
    const at = rel === null ? null : resolveIn(dir, rel);
    if (at === null || !fileSet.has(at)) continue;
    const body = read(at);
    if (typeof body !== 'string') continue;
    for (const l of body.split(/\r?\n/)) {
      if (/^\s*#/.test(l)) continue;
      const k = envKeyOf(l);
      if (k && /=/.test(l)) keys.push(k); // names only: the value after `=` is never kept
    }
  }
  return uniqSorted(keys).slice(0, MAX_NESTED);
}

function dependsOf(node) {
  if (node?.t === 'seq') return uniqSorted(node.items.map((it) => textOf(it.v)).filter((x) => x !== null));
  if (node?.t === 'map') return uniqSorted(node.entries.map((e) => e.key));
  return [];
}

function extractCompose(path, text, acc, fileSet, read) {
  const root = parseYaml(text);
  const services = valueOf(root, 'services');
  if (services?.t !== 'map') return;
  const dir = dirOf(path);
  for (const e of services.entries) {
    const svc = e.v;
    if (svc.t !== 'map') {
      acc.skipped.services++; // an alias or an empty entry: nothing to read
      continue;
    }
    if (svc.merge) acc.skipped.services++; // `<<:` merges values this scan does not resolve
    const list = (key, pick) => {
      const n = valueOf(svc, key);
      return n?.t === 'seq' ? n.items.map((it) => pick(it.v)).filter((x) => x !== null).slice(0, MAX_NESTED) : [];
    };
    acc.services.push({
      name: e.key,
      image: textOf(valueOf(svc, 'image')),
      build: buildOf(valueOf(svc, 'build'), dir),
      ports: list('ports', portOf),
      volumes: list('volumes', volumeOf),
      dependsOn: dependsOf(valueOf(svc, 'depends_on')).slice(0, MAX_NESTED),
      envKeys: envKeysOf(svc, dir, fileSet, read),
      evidence: [{ path, lines: range(e.line, e.end) }],
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Dockerfile

/** The instructions of a Dockerfile as { keyword, args, start, end }, continuation lines joined, comments dropped. */
function instructions(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    if (/^\s*(#|$)/.test(raw[i])) continue;
    let args = raw[i].trim();
    const start = i + 1;
    while (/\\$/.test(args) && i + 1 < raw.length) {
      args = args.slice(0, -1).trimEnd();
      i++;
      if (/^\s*#/.test(raw[i])) continue;
      args += ` ${raw[i].trim()}`;
    }
    const m = /^([A-Za-z]+)\s*([^]*)$/.exec(args.replace(/\\$/, '').trim());
    if (m) out.push({ keyword: m[1].toUpperCase(), args: m[2].trim(), start, end: i + 1 });
  }
  return out;
}

const shellWords = (s) => s.split(/\s+/).filter(Boolean);
function commandOf(args) {
  if (args.startsWith('[')) {
    try {
      const v = JSON.parse(args);
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return { exec: true, tokens: v };
    } catch {
      /* not JSON: read as shell words below */
    }
  }
  return { exec: false, tokens: shellWords(args) };
}

const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node', 'python', 'python2', 'python3', 'pypy', 'pypy3', 'ruby', 'php', 'perl', 'sh', 'bash', 'dash', 'zsh', 'java', 'dotnet']);
const FILE_ARG = /^[^\s:$]+\.[A-Za-z0-9]{1,5}$/;
const trimDot = (p) => p.replace(/^(?:\.\/)+/, '');

/** The file a command runs: its own first word when that is a file, else an interpreter's first file argument; null otherwise. */
function entryFile(tokens) {
  if (!tokens.length) return null;
  const prog = baseName(tokens[0]).toLowerCase();
  if (!INTERPRETERS.has(prog)) return FILE_ARG.test(tokens[0]) ? trimDot(tokens[0]) : null;
  const rest = tokens.slice(1);
  if (prog === 'java') {
    const at = rest.indexOf('-jar');
    return at !== -1 && rest[at + 1] && FILE_ARG.test(rest[at + 1]) ? trimDot(rest[at + 1]) : null;
  }
  for (const t of rest) {
    if (t === '-m' || t === '-c' || t === '-e') return null; // a module or inline code, not a file
    if (t.startsWith('-')) continue;
    return FILE_ARG.test(t) ? trimDot(t) : null;
  }
  return null;
}

const portsOf = (args) =>
  shellWords(args).map((w) => {
    const m = /^(.*?)(?:\/([A-Za-z]+))?$/.exec(w);
    return { port: m[1], protocol: (m[2] ?? 'tcp').toLowerCase() };
  });

function extractDockerfile(path, text, acc) {
  const stages = [];
  const byAlias = new Map();
  let cur = null;
  for (const ins of instructions(text)) {
    if (ins.keyword === 'FROM') {
      const words = shellWords(ins.args).filter((w) => !w.startsWith('--'));
      if (!words.length) continue;
      const parent = byAlias.get(words[0].toLowerCase());
      cur = {
        base: parent ? parent.base : words[0],
        ports: parent ? parent.ports.slice() : [],
        entrypoint: parent ? parent.entrypoint : null,
        cmd: parent ? parent.cmd : null,
        start: ins.start,
        end: ins.end,
      };
      stages.push(cur);
      const as = words.findIndex((w, k) => k > 0 && w.toUpperCase() === 'AS');
      if (as !== -1 && words[as + 1]) byAlias.set(words[as + 1].toLowerCase(), cur);
      continue;
    }
    if (!cur) continue; // ARG and comments before the first FROM
    cur.end = ins.end;
    if (ins.keyword === 'EXPOSE') {
      for (const p of portsOf(ins.args)) if (!cur.ports.some((q) => q.port === p.port && q.protocol === p.protocol)) cur.ports.push(p);
    } else if (ins.keyword === 'ENTRYPOINT') {
      cur.entrypoint = commandOf(ins.args);
      cur.cmd = null; // a new ENTRYPOINT clears the CMD
    } else if (ins.keyword === 'CMD') {
      cur.cmd = commandOf(ins.args);
    }
  }
  if (!stages.length) {
    acc.skipped.dockerfiles++;
    return;
  }
  const last = stages[stages.length - 1];
  const tokens = last.entrypoint ? (last.entrypoint.exec ? [...last.entrypoint.tokens, ...(last.cmd?.tokens ?? [])] : last.entrypoint.tokens) : (last.cmd?.tokens ?? []);
  acc.dockerfiles.push({
    base: clip(last.base),
    stages: stages.length,
    ports: last.ports.slice(0, MAX_NESTED),
    command: tokens.length ? clip(tokens.join(' ')) : null,
    entrypoint: entryFile(tokens),
    evidence: [{ path, lines: range(last.start, last.end) }],
  });
}

// ---------------------------------------------------------------------------------------------

const lineNo = (item) => Number(item.evidence[0].lines.split('-')[0]);

/** Extract the containers fragment from `files` (repo-relative paths), reading them through `read`. */
export function extractContainers(files, read) {
  const acc = { skipped: Object.fromEntries(KINDS.map((k) => [k, 0])) };
  for (const k of KINDS) acc[k] = [];
  const sorted = files.slice().sort(byCodeUnit);
  const fileSet = new Set(sorted);
  let scanned = 0;
  for (const path of sorted) {
    const compose = isCompose(path);
    if (!compose && !isDockerfile(path)) continue;
    const text = read(path);
    if (typeof text !== 'string') continue;
    scanned++;
    if (compose) extractCompose(path, text, acc, fileSet, read);
    else extractDockerfile(path, text, acc);
  }
  const truncated = {};
  const out = { scanned };
  for (const k of KINDS) {
    // Array.prototype.sort is stable, so items on one line keep their discovery order.
    const items = acc[k].slice().sort((a, b) => byCodeUnit(a.evidence[0].path, b.evidence[0].path) || lineNo(a) - lineNo(b));
    truncated[k] = Math.max(0, items.length - MAX_ITEMS);
    out[k] = items.slice(0, MAX_ITEMS);
  }
  out.skipped = acc.skipped;
  out.truncated = truncated;
  return Object.fromEntries(Object.keys(out).sort(byCodeUnit).map((k) => [k, out[k]]));
}

const plugin = {
  id: 'containers',
  detect: (inventory) => inventory.files.some((p) => isDockerfile(p) || isCompose(p)),
  extract: extractContainers,
};

export default plugin;
