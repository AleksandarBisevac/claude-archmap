// pipelines.mjs - the pipelines stack plug-in of prescan: static extraction from GitHub Actions workflows and Azure Pipelines.
//
// extractPipelines(files, read) -> fragment
//   { scanned, pipelines[], jobs[], artifacts[], passes[], deployTargets[], skipped{pipelines, templates}, truncated{...} }
// A pipeline file is .github/workflows/*.y(a)ml (GitHub Actions), azure-pipelines*.y(a)ml or *.pipeline.y(a)ml (Azure
// Pipelines). It gives one `pipeline` per file: { kind: 'github-actions' | 'azure-pipelines', name, triggers: [event],
// evidence } (GitHub: the `on:` events; Azure: `trigger`, `pr` and `schedule` when set and not `none`; the name is the
// workflow's `name:`, else the file name). One `job` per job and per Azure stage: { pipeline: path, kind: 'job' | 'stage',
// id, stage, needs: [id], evidence } - `needs` holds GitHub `needs:` and Azure `dependsOn:`, `stage` is the stage an Azure job
// sits in. `artifacts` are the steps that upload or download a build artefact (actions/upload-artifact, download-artifact,
// PublishPipelineArtifact, PublishBuildArtifacts, DownloadPipelineArtifact, DownloadBuildArtifacts and the publish: /
// download: shorthands): { name, direction: 'upload' | 'download', job, pipeline, evidence } with the step as evidence.
// `passes` pair an upload with a download of the same name in another job of the same file: { name, from, to, pipeline,
// evidence: [upload step, download step] }. `deployTargets` are the string literals that name where a job deploys: an
// `environment` and the app name an Azure web app / function deploy task or action is given: { name, kind: 'environment'
// | 'app', job, pipeline, evidence } at the value's line. A value holding an expression (${{ }}, $( ), ${ }) is not a literal
// and is left out of the targets.
// Items are sorted by path then line; each kind has a ceiling (MAX_ITEMS), and what it drops is counted in `truncated`.
// What cannot be resolved statically (a pipeline file with no jobs, stages or steps; an Azure `template:` reference) is
// counted in `skipped`, never guessed.
//
// The YAML is read by the small parser of containers.mjs: no YAML library, and the scanned files are only ever read as
// text - no import, no eval, no process spawn, no `gh` or `az`. The default export is the plug-in object ({ id,
// detect(inventory), extract(files, read) }) that prescan.mjs loads. Node >= 18, ESM, zero dependencies.

import { byCodeUnit } from './inventory.mjs';
import { entryOf, parseYaml, textOf, valueOf } from './containers.mjs';

export const KINDS = ['artifacts', 'deployTargets', 'jobs', 'passes', 'pipelines'];
export const MAX_ITEMS = 20000; // per kind: a ceiling against a pathological repo, not a budget (the explorer reads a summary)
export const MAX_NESTED = 2000; // triggers and dependencies per pipeline or job
const MAX_TEXT = 200; // longest name kept

const GITHUB_RE = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
const AZURE_RE = /(?:^|\/)azure-pipelines(?:[.-][A-Za-z0-9_.-]*)?\.ya?ml$|\.pipeline\.ya?ml$/i;

const isGithub = (p) => GITHUB_RE.test(p);
const isAzure = (p) => AZURE_RE.test(p);
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);

const clip = (s) => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : s);
const range = (a, b) => (a === b ? String(a) : `${a}-${b}`);
const isLiteral = (s) => !/\$\{|\$\(|\$\[/.test(s);
const lineAt = (item, i = 0) => Number(item.evidence[i].lines.split('-')[0]);

/** The entry of a map whose key equals `key` ignoring case (Azure task inputs are case-insensitive). */
const entryCi = (node, key) => (node?.t === 'map' ? node.entries.find((e) => e.key.toLowerCase() === key.toLowerCase()) : undefined);

/** A scalar or a list of scalars as an array of texts, written order, no duplicates. */
function listOf(node) {
  if (node?.t === 'scalar') return textOf(node) === null ? [] : [textOf(node)];
  if (node?.t === 'seq') return [...new Set(node.items.map((it) => textOf(it.v)).filter((x) => x !== null))];
  return [];
}

/** The steps of a sequence of step maps; a `template:` step is counted and left out. */
function stepsOf(node, acc) {
  if (node?.t !== 'seq') return [];
  const steps = [];
  for (const it of node.items) {
    if (it.v?.t !== 'map') continue;
    if (entryOf(it.v, 'template')) {
      acc.skipped.templates++;
      continue;
    }
    steps.push(it);
  }
  return steps;
}

/** Every `steps:` sequence found under `node`, depth first (an Azure deployment job keeps them under its strategy). */
function nestedSteps(node, out = []) {
  if (node?.t !== 'map') return out;
  for (const e of node.entries) {
    if (e.key === 'steps') out.push(e.v);
    else nestedSteps(e.v, out);
  }
  return out;
}

function record(ctx, kind, item) {
  ctx.acc[kind].push(item);
}

function artifact(ctx, step, job, direction, name) {
  const item = { name: name === null ? null : clip(name), direction, job, pipeline: ctx.path, evidence: [{ path: ctx.path, lines: range(step.line, step.end) }] };
  record(ctx, 'artifacts', item);
}

function target(ctx, job, kind, name, entry) {
  if (name === null || !isLiteral(name)) return;
  record(ctx, 'deployTargets', { name: clip(name), kind, job, pipeline: ctx.path, evidence: [{ path: ctx.path, lines: String(entry.line) }] });
}

/** `environment: name` or `environment: { name: name }` -> a deploy target at the value's line. */
function environmentOf(ctx, jobNode, jobId) {
  const e = entryOf(jobNode, 'environment');
  if (!e) return;
  if (e.v.t === 'scalar') target(ctx, jobId, 'environment', textOf(e.v), e);
  else if (e.v.t === 'map') {
    const n = entryOf(e.v, 'name');
    if (n) target(ctx, jobId, 'environment', textOf(n.v), n);
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub Actions

const GH_UPLOAD = /^actions\/upload-artifact(?:@|$)/i;
const GH_DOWNLOAD = /^actions\/download-artifact(?:@|$)/i;
const GH_DEPLOY = [
  [/^azure\/webapps-deploy(?:@|$)/i, 'app-name'],
  [/^azure\/functions-action(?:@|$)/i, 'app-name'],
  [/^google-github-actions\/deploy-cloudrun(?:@|$)/i, 'service'],
];

function githubSteps(ctx, jobNode, jobId) {
  for (const step of stepsOf(valueOf(jobNode, 'steps'), ctx.acc)) {
    const uses = textOf(valueOf(step.v, 'uses'));
    if (uses === null) continue;
    const withNode = valueOf(step.v, 'with');
    if (GH_UPLOAD.test(uses) || GH_DOWNLOAD.test(uses)) {
      const name = textOf(valueOf(withNode, 'name')) ?? textOf(valueOf(withNode, 'pattern'));
      artifact(ctx, step, jobId, GH_UPLOAD.test(uses) ? 'upload' : 'download', name);
      continue;
    }
    for (const [re, input] of GH_DEPLOY) {
      const e = re.test(uses) ? entryOf(withNode, input) : undefined;
      if (e) target(ctx, jobId, 'app', textOf(e.v), e);
    }
  }
}

function githubTriggers(root) {
  const on = valueOf(root, 'on');
  if (on?.t === 'map') return on.entries.map((e) => e.key);
  return listOf(on);
}

function extractGithub(ctx, root) {
  const jobs = valueOf(root, 'jobs');
  if (jobs?.t !== 'map' || !jobs.entries.length) return false;
  for (const e of jobs.entries) {
    if (e.v.t !== 'map') continue;
    record(ctx, 'jobs', {
      pipeline: ctx.path,
      kind: 'job',
      id: e.key,
      stage: null,
      needs: listOf(valueOf(e.v, 'needs')).slice(0, MAX_NESTED),
      evidence: [{ path: ctx.path, lines: range(e.line, e.end) }],
    });
    environmentOf(ctx, e.v, e.key);
    githubSteps(ctx, e.v, e.key);
  }
  return {
    kind: 'github-actions',
    name: textOf(valueOf(root, 'name')) ?? baseName(ctx.path),
    triggers: [...new Set(githubTriggers(root))].slice(0, MAX_NESTED),
  };
}

// ---------------------------------------------------------------------------------------------
// Azure Pipelines

const AZ_PUBLISH = /^(PublishPipelineArtifact|PublishBuildArtifacts)@/i;
const AZ_DOWNLOAD = /^(DownloadPipelineArtifact|DownloadBuildArtifacts)@/i;
const AZ_WEBAPP = /^(AzureWebApp|AzureWebAppContainer|AzureFunctionApp|AzureRmWebAppDeployment)@/i;

function azureSteps(ctx, steps, jobId) {
  for (const step of steps) {
    const task = textOf(valueOf(step.v, 'task'));
    const inputs = valueOf(step.v, 'inputs');
    if (task !== null && AZ_PUBLISH.test(task)) {
      const name = textOf(entryCi(inputs, 'artifact')?.v) ?? textOf(entryCi(inputs, 'artifactName')?.v) ?? (/^PublishBuildArtifacts/i.test(task) ? 'drop' : null);
      artifact(ctx, step, jobId, 'upload', name);
    } else if (task !== null && AZ_DOWNLOAD.test(task)) {
      artifact(ctx, step, jobId, 'download', textOf(entryCi(inputs, 'artifact')?.v) ?? textOf(entryCi(inputs, 'artifactName')?.v));
    } else if (entryOf(step.v, 'publish')) {
      artifact(ctx, step, jobId, 'upload', textOf(valueOf(step.v, 'artifact')));
    } else if (entryOf(step.v, 'download')) {
      if (textOf(valueOf(step.v, 'download')) !== 'none') artifact(ctx, step, jobId, 'download', textOf(valueOf(step.v, 'artifact')));
    } else if (task !== null && AZ_WEBAPP.test(task)) {
      const e = entryCi(inputs, 'appName') ?? entryCi(inputs, 'WebAppName');
      if (e) target(ctx, jobId, 'app', textOf(e.v), e);
    }
  }
}

/** Jobs of a `jobs:` sequence (top level or inside a stage). Returns true when any step or job was read. */
function azureJobs(ctx, jobsNode, stage) {
  if (jobsNode?.t !== 'seq') return false;
  for (const it of jobsNode.items) {
    if (it.v?.t !== 'map') continue;
    if (entryOf(it.v, 'template')) {
      ctx.acc.skipped.templates++;
      continue;
    }
    const deployment = entryOf(it.v, 'deployment');
    const id = textOf((deployment ?? entryOf(it.v, 'job'))?.v);
    if (id === null) continue;
    record(ctx, 'jobs', {
      pipeline: ctx.path,
      kind: 'job',
      id,
      stage,
      needs: listOf(valueOf(it.v, 'dependsOn')).slice(0, MAX_NESTED),
      evidence: [{ path: ctx.path, lines: range(it.line, it.end) }],
    });
    environmentOf(ctx, it.v, id);
    const stepNodes = deployment ? nestedSteps(valueOf(it.v, 'strategy')) : [valueOf(it.v, 'steps')];
    for (const node of stepNodes) azureSteps(ctx, stepsOf(node, ctx.acc), id);
  }
  return true;
}

function azureTriggers(root) {
  const out = [];
  for (const e of root.entries) {
    const label = { trigger: 'trigger', pr: 'pr', schedules: 'schedule' }[e.key];
    if (!label) continue;
    const none = e.v.t === 'scalar' && (e.v.value === '' || e.v.value.toLowerCase() === 'none');
    const empty = e.v.t === 'seq' && !e.v.items.length;
    if (!none && !empty) out.push(label);
  }
  return out;
}

function extractAzure(ctx, root) {
  const stages = valueOf(root, 'stages');
  let found = false;
  if (stages?.t === 'seq') {
    for (const it of stages.items) {
      if (it.v?.t !== 'map') continue;
      if (entryOf(it.v, 'template')) {
        ctx.acc.skipped.templates++;
        continue;
      }
      const id = textOf(valueOf(it.v, 'stage'));
      if (id === null) continue;
      found = true;
      record(ctx, 'jobs', {
        pipeline: ctx.path,
        kind: 'stage',
        id,
        stage: null,
        needs: listOf(valueOf(it.v, 'dependsOn')).slice(0, MAX_NESTED),
        evidence: [{ path: ctx.path, lines: range(it.line, it.end) }],
      });
      azureJobs(ctx, valueOf(it.v, 'jobs'), id);
    }
  }
  if (azureJobs(ctx, valueOf(root, 'jobs'), null)) found = true;
  const steps = valueOf(root, 'steps');
  if (steps?.t === 'seq') {
    found = true;
    azureSteps(ctx, stepsOf(steps, ctx.acc), null);
  }
  if (!found) return false;
  return { kind: 'azure-pipelines', name: baseName(ctx.path), triggers: azureTriggers(root).slice(0, MAX_NESTED) };
}

// ---------------------------------------------------------------------------------------------

/** Pair each upload with the downloads of the same name in other jobs of the same file. */
function passesOf(artifacts) {
  const out = [];
  for (const down of artifacts) {
    if (down.direction !== 'download' || down.name === null || down.job === null) continue;
    for (const up of artifacts) {
      if (up.direction !== 'upload' || up.name !== down.name || up.job === null || up.job === down.job) continue;
      out.push({ name: down.name, from: up.job, to: down.job, pipeline: down.pipeline, evidence: [up.evidence[0], down.evidence[0]] });
    }
  }
  return out;
}

/** Extract the pipelines fragment from `files` (repo-relative paths), reading them through `read`. */
export function extractPipelines(files, read) {
  const acc = { skipped: { pipelines: 0, templates: 0 } };
  for (const k of KINDS) acc[k] = [];
  const sorted = files.slice().sort(byCodeUnit);
  let scanned = 0;
  for (const path of sorted) {
    const github = isGithub(path);
    if (!github && !isAzure(path)) continue;
    const text = read(path);
    if (typeof text !== 'string') continue;
    scanned++;
    const root = parseYaml(text);
    if (root?.t !== 'map' || !root.entries.length) {
      acc.skipped.pipelines++;
      continue;
    }
    // Items of one file are gathered apart so that a file that turns out to hold no pipeline adds nothing.
    const ctx = { path, acc: { skipped: acc.skipped, artifacts: [], deployTargets: [], jobs: [], passes: [], pipelines: [] } };
    const head = github ? extractGithub(ctx, root) : extractAzure(ctx, root);
    if (!head) {
      acc.skipped.pipelines++;
      continue;
    }
    acc.pipelines.push({ ...head, evidence: [{ path, lines: range(root.entries[0].line, root.entries[root.entries.length - 1].end) }] });
    ctx.acc.passes = passesOf(ctx.acc.artifacts);
    for (const k of KINDS.filter((x) => x !== 'pipelines')) acc[k].push(...ctx.acc[k]);
  }
  const truncated = {};
  const out = { scanned };
  for (const k of KINDS) {
    // Array.prototype.sort is stable, so items on one line keep their discovery order.
    const items = acc[k].slice().sort((a, b) => byCodeUnit(a.evidence[0].path, b.evidence[0].path) || lineAt(a) - lineAt(b) || (k === 'passes' ? lineAt(a, 1) - lineAt(b, 1) : 0));
    truncated[k] = Math.max(0, items.length - MAX_ITEMS);
    out[k] = items.slice(0, MAX_ITEMS);
  }
  out.skipped = acc.skipped;
  out.truncated = truncated;
  return Object.fromEntries(Object.keys(out).sort(byCodeUnit).map((k) => [k, out[k]]));
}

const plugin = {
  id: 'pipelines',
  detect: (inventory) => inventory.files.some((p) => isGithub(p) || isAzure(p)),
  extract: extractPipelines,
};

export default plugin;
