import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (iac1..iac9) lead every title so the suite prints them first.
// The infrastructure-as-code stack plug-in of prescan (Terraform and Bicep), run on the fictional fleet platform in
// tests/fixtures/repos/iac/ (read as text only - the extractor must never run terraform, az or bicep).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'repos', 'iac');
const LIB = join(ROOT, 'scripts', 'lib', 'prescan');
const MODULE = join(LIB, 'iac.mjs');
const { default: plugin, extractIac, MAX_ITEMS, MAX_NESTED } = await import(pathToFileURL(MODULE).href);

const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });

const fixtureFiles = walk(FIXTURE).sort();
const fixtureRead = (p) => readFileSync(join(FIXTURE, p), 'utf8');
const frag = extractIac(fixtureFiles, fixtureRead);
const memFrag = (files) => extractIac(Object.keys(files).sort(), (p) => files[p] ?? null);
const ev = (path, lines) => [{ path, lines }];
const TF = 'terraform';
const BC = 'bicep/main.bicep';

test('iac1 one item per resource and module with type, name, address, scope and the block as evidence', () => {
  assert.deepEqual(frag.resources, [
    { kind: 'bicep', mode: 'managed', type: 'Microsoft.Storage/storageAccounts', name: 'storage', address: 'storage', scope: BC, evidence: ev(BC, '7-14') },
    { kind: 'bicep', mode: 'managed', type: 'Microsoft.Storage/storageAccounts/blobServices', name: 'blobService', address: 'blobService', scope: BC, evidence: ev(BC, '16-19') },
    { kind: 'bicep', mode: 'managed', type: 'Microsoft.Storage/storageAccounts/blobServices/containers', name: 'exports', address: 'exports', scope: BC, evidence: ev(BC, '22-33') },
    { kind: 'terraform', mode: 'managed', type: 'aws_vpc', name: 'main', address: 'aws_vpc.main', scope: TF, evidence: ev(`${TF}/main.tf`, '10-15') },
    { kind: 'terraform', mode: 'managed', type: 'aws_subnet', name: 'app', address: 'aws_subnet.app', scope: TF, evidence: ev(`${TF}/main.tf`, '17-20') },
    { kind: 'terraform', mode: 'managed', type: 'aws_security_group', name: 'app', address: 'aws_security_group.app', scope: TF, evidence: ev(`${TF}/main.tf`, '22-26') },
    { kind: 'terraform', mode: 'managed', type: 'aws_instance', name: 'web', address: 'aws_instance.web', scope: TF, evidence: ev(`${TF}/main.tf`, '28-38') },
  ]);
  assert.deepEqual(frag.modules, [
    { kind: 'terraform', name: 'database', address: 'module.database', source: './modules/database', target: 'terraform/modules/database', scope: TF, evidence: ev(`${TF}/modules.tf`, '1-5') },
    { kind: 'terraform', name: 'cache', address: 'module.cache', source: './modules/cache', target: 'terraform/modules/cache', scope: TF, evidence: ev(`${TF}/modules.tf`, '7-11') },
  ]);
});

test('iac2 references between resources and modules are edges read from expressions, each with its evidence lines', () => {
  const edge = (kind, scope, from, to, via, attributes, path, lines) => ({ kind, scope, from, to, via, attributes, evidence: lines.map((l) => ({ path, lines: String(l) })) });
  assert.deepEqual(frag.references, [
    edge('bicep', BC, 'blobService', 'storage', 'parent', [], BC, [17]),
    edge('bicep', BC, 'exports', 'blobService', 'parent', [], BC, [23]),
    edge('bicep', BC, 'exports', 'storage', 'depends_on', [], BC, [26]),
    edge('bicep', BC, 'exports', 'storage', 'attribute', ['name'], BC, [30]),
    edge('terraform', TF, 'aws_subnet.app', 'aws_vpc.main', 'attribute', ['id'], `${TF}/main.tf`, [18]),
    edge('terraform', TF, 'aws_security_group.app', 'aws_vpc.main', 'attribute', ['id'], `${TF}/main.tf`, [24]),
    edge('terraform', TF, 'aws_instance.web', 'aws_subnet.app', 'attribute', ['id'], `${TF}/main.tf`, [31]),
    edge('terraform', TF, 'aws_instance.web', 'aws_security_group.app', 'attribute', ['id'], `${TF}/main.tf`, [32]),
    edge('terraform', TF, 'aws_instance.web', 'module.database', 'attribute', ['endpoint'], `${TF}/main.tf`, [33]),
    edge('terraform', TF, 'aws_instance.web', 'module.database', 'depends_on', [], `${TF}/main.tf`, [36]),
    edge('terraform', TF, 'module.database', 'aws_subnet.app', 'attribute', ['id'], `${TF}/modules.tf`, [3]),
    edge('terraform', TF, 'module.cache', 'aws_vpc.main', 'attribute', ['id'], `${TF}/modules.tf`, [9]),
    edge('terraform', TF, 'module.cache', 'module.database', 'attribute', ['endpoint'], `${TF}/modules.tf`, [10]),
  ]);
});

test('iac3 variables and outputs by name only: no default, value, description or expression reaches the fragment', () => {
  const rows = (items) => items.map((i) => `${i.evidence[0].path}:${i.evidence[0].lines} ${i.kind} ${i.scope} ${i.name}`);
  assert.deepEqual(rows(frag.variables), [
    'bicep/main.bicep:4 bicep bicep/main.bicep location',
    'bicep/main.bicep:5 bicep bicep/main.bicep storageName',
    'terraform/modules/cache/main.tf:1-3 terraform terraform/modules/cache vpc_id',
    'terraform/modules/cache/main.tf:5-7 terraform terraform/modules/cache upstream',
    'terraform/modules/database/main.tf:1-3 terraform terraform/modules/database subnet_id',
    'terraform/modules/database/main.tf:5-8 terraform terraform/modules/database password',
    'terraform/variables.tf:1-4 terraform terraform region',
    'terraform/variables.tf:6-9 terraform terraform environment',
    'terraform/variables.tf:11-15 terraform terraform db_password',
  ]);
  assert.deepEqual(rows(frag.outputs), [
    'bicep/main.bicep:35 bicep bicep/main.bicep storageId',
    'bicep/main.bicep:36 bicep bicep/main.bicep containerName',
    'terraform/modules/cache/main.tf:9-11 terraform terraform/modules/cache endpoint',
    'terraform/modules/database/main.tf:10-12 terraform terraform/modules/database endpoint',
    'terraform/outputs.tf:1-3 terraform terraform web_address',
    'terraform/outputs.tf:5-8 terraform terraform database_endpoint',
  ]);
  for (const item of [...frag.variables, ...frag.outputs]) assert.deepEqual(Object.keys(item), ['kind', 'name', 'scope', 'evidence']);
  const text = JSON.stringify(frag);
  for (const value of ['eu-west-1', 'staging-marker', 'placeholder-not-a-secret', 'db.fleet.internal', 'cache.fleet.internal', 'Where the web tier', 'sensitive', 'Azure region']) {
    assert.ok(!text.includes(value), `${value} is a value, not a name`);
  }
});

test('iac4 other Terraform forms: data sources, heredocs, nested interpolation, comments and strings, scopes by directory, unresolved names, an unterminated block', () => {
  const m = memFrag({
    'infra/main.tf':
      'data "aws_ami" "base" {\n  most_recent = true\n}\n' +
      'resource "aws_instance" "web-1" {\n  ami = data.aws_ami.base.id\n  user_data = <<-EOT\n    echo ${aws_eip.ip.public_ip}\n    echo aws_eip.ip.id\n  EOT\n}\n' +
      'resource "aws_eip" "ip" {\n  instance = aws_instance.web-1.id\n  missing  = aws_nothing.here.id\n}\n' +
      'module "net" {\n  source = "terraform-aws-modules/vpc/aws"\n}\n' +
      'resource "aws_route" "r" {\n  vpc = module.net.vpc_id\n  /* aws_eip.ip.id is commented out */\n  tag = "${aws_eip.ip.id}-${"${aws_instance.web-1.id}"}"\n}\n',
    'other/a.tf': 'resource "aws_subnet" "s" {\n  vpc_id = aws_vpc.main.id\n}\n',
    'other/b.tf': 'resource "aws_vpc" "main" {\n}\n',
    'third/c.tf': 'resource "aws_subnet" "t" {\n  vpc_id = aws_vpc.main.id\n}\n',
    'broken/x.tf': 'resource "aws_vpc" "ok" {\n}\nresource "aws_vpc" "bad" {\n  cidr = "x"\n',
    'vars/prod.tfvars': 'token = "x"\nresource "aws_vpc" "v" {\n}\n',
    'tf/notes.tf.json': '{"resource": {}}',
    'docs/readme.md': 'resource "aws_vpc" "doc" {\n}\n',
  });
  assert.deepEqual(
    m.resources.map((r) => `${r.evidence[0].path}:${r.evidence[0].lines} ${r.mode} ${r.type} ${r.address} @${r.scope}`),
    [
      'broken/x.tf:1-2 managed aws_vpc aws_vpc.ok @broken',
      'infra/main.tf:1-3 data aws_ami data.aws_ami.base @infra',
      'infra/main.tf:4-10 managed aws_instance aws_instance.web-1 @infra',
      'infra/main.tf:11-14 managed aws_eip aws_eip.ip @infra',
      'infra/main.tf:18-22 managed aws_route aws_route.r @infra',
      'other/a.tf:1-3 managed aws_subnet aws_subnet.s @other',
      'other/b.tf:1-2 managed aws_vpc aws_vpc.main @other',
      'third/c.tf:1-3 managed aws_subnet aws_subnet.t @third',
    ],
  );
  assert.deepEqual(m.modules.map((x) => `${x.address} ${x.source} ${x.target}`), ['module.net terraform-aws-modules/vpc/aws null']);
  assert.deepEqual(
    m.references.map((r) => `${r.evidence.map((e) => `${e.path}:${e.lines}`).join('+')} ${r.from} -> ${r.to} ${r.via} [${r.attributes.join(',')}]`),
    [
      'infra/main.tf:5 aws_instance.web-1 -> data.aws_ami.base attribute [id]',
      'infra/main.tf:7 aws_instance.web-1 -> aws_eip.ip attribute [public_ip]',
      'infra/main.tf:12 aws_eip.ip -> aws_instance.web-1 attribute [id]',
      'infra/main.tf:19 aws_route.r -> module.net attribute [vpc_id]',
      'infra/main.tf:21 aws_route.r -> aws_eip.ip attribute [id]',
      'infra/main.tf:21 aws_route.r -> aws_instance.web-1 attribute [id]',
      'other/a.tf:2 aws_subnet.s -> aws_vpc.main attribute [id]',
    ],
  );
  assert.equal(m.skipped.blocks, 1, 'the block that never closes is counted, not guessed');
  assert.equal(m.scanned, 5, '.tfvars, .tf.json and markdown files are not read');
});

test('iac5 other Bicep forms: existing resources, modules, conditions and loops, property keys that match a symbol, the parent key', () => {
  const m = memFrag({
    'az/main.bicep':
      "param env string\nresource kv 'Microsoft.KeyVault/vaults@2023-02-01' existing = {\n  name: 'kv-fleet'\n}\n" +
      "module net './modules/net.bicep' = {\n  name: 'net'\n  params: {\n    vaultId: kv.id\n  }\n}\n" +
      "resource app 'Microsoft.Web/sites@2022-09-01' = if (env == 'prod') {\n  name: 'app'\n  properties: {\n    serverFarmId: net.outputs.farmId\n    other: { kv: 1 }\n  }\n}\n" +
      "resource disks 'Microsoft.Compute/disks@2023-01-02' = [for i in range(0, 2): {\n  name: 'disk${i}-${kv.name}'\n  parent: app\n}]\n",
    'az/main.bicepparam': "using './main.bicep'\nparam env = 'prod'\n",
  });
  assert.deepEqual(
    m.resources.map((r) => `${r.evidence[0].lines} ${r.mode} ${r.type} ${r.address}`),
    [
      '2-4 existing Microsoft.KeyVault/vaults kv',
      '11-17 managed Microsoft.Web/sites app',
      '18-21 managed Microsoft.Compute/disks disks',
    ],
  );
  assert.deepEqual(m.modules.map((x) => `${x.evidence[0].lines} ${x.address} ${x.source} ${x.target}`), ['5-10 net ./modules/net.bicep az/modules/net.bicep']);
  assert.deepEqual(
    m.references.map((r) => `${r.evidence[0].lines} ${r.from} -> ${r.to} ${r.via} [${r.attributes.join(',')}]`),
    [
      '8 net -> kv attribute [id]',
      '14 app -> net attribute [outputs]',
      '19 disks -> kv attribute [name]',
      '20 disks -> app parent []',
    ],
  );
  assert.deepEqual(m.variables.map((v) => v.name), ['env']);
  assert.equal(m.scanned, 1, 'a .bicepparam file holds values and is not read');
});

test('iac6 every item carries {path, lines} evidence inside the file, output sorted and deterministic', () => {
  for (const kind of ['resources', 'modules', 'variables', 'outputs', 'references']) {
    assert.ok(frag[kind].length > 0, `${kind} found something in the fixture`);
    for (const item of frag[kind]) {
      assert.ok(Array.isArray(item.evidence) && item.evidence.length >= 1, `${kind} item has evidence`);
      for (const { path, lines } of item.evidence) {
        assert.match(lines, /^[0-9]+(-[0-9]+)?$/);
        assert.ok(fixtureFiles.includes(path), `evidence path ${path} is a fixture file`);
        const [a, b = a] = lines.split('-').map(Number);
        const total = fixtureRead(path).split('\n').length;
        assert.ok(a >= 1 && a <= b && b <= total, `${path}:${lines} is inside the file`);
      }
    }
    const keys = frag[kind].map((i) => [i.evidence[0].path, Number(i.evidence[0].lines.split('-')[0])]);
    const sorted = keys.slice().sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    assert.deepEqual(keys, sorted, `${kind} is ordered by path then line`);
  }
  assert.deepEqual(Object.keys(frag), ['modules', 'outputs', 'references', 'resources', 'scanned', 'skipped', 'truncated', 'variables']);
  assert.equal(frag.scanned, 7, 'six Terraform files and one Bicep file were read');
  assert.deepEqual(frag.skipped, { blocks: 0 });
  assert.deepEqual(frag.truncated, { modules: 0, outputs: 0, references: 0, resources: 0, variables: 0 });
  const again = extractIac(fixtureFiles.slice().reverse(), fixtureRead);
  assert.equal(JSON.stringify(again), JSON.stringify(frag), 'input order does not change the output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(frag)), 'no timestamps');
});

test('iac7 caps: items past MAX_ITEMS per kind are counted in truncated; evidence lines and attributes past MAX_NESTED are dropped', () => {
  const files = {};
  for (let i = 0; i < MAX_ITEMS + 2; i++) files[`infra/r${String(i).padStart(6, '0')}.tf`] = `resource "t" "n${i}" {\n}\n`;
  const r = memFrag(files);
  assert.equal(r.resources.length, MAX_ITEMS);
  assert.equal(r.truncated.resources, 2);
  assert.equal(r.resources[0].evidence[0].path, 'infra/r000000.tf', 'the first rows in sort order are the ones kept');

  let body = 'resource "aws_a" "src" {\n';
  for (let i = 0; i < MAX_NESTED + 5; i++) body += `  k${i} = aws_a.dst.a${i}\n`;
  body += '}\nresource "aws_a" "dst" {\n}\n';
  const n = memFrag({ 'infra/big.tf': body });
  assert.equal(n.references.length, 1);
  assert.equal(n.references[0].evidence.length, MAX_NESTED);
  assert.equal(n.references[0].attributes.length, MAX_NESTED);
  assert.ok(JSON.stringify(frag).length < 200 * 1024, 'fragment stays small');
});

test('iac8 the plug-in detects .tf and .bicep files by name only, and names the stack iac', () => {
  assert.equal(plugin.id, 'iac');
  const det = (...files) => plugin.detect({ files });
  assert.equal(det('main.tf'), true);
  assert.equal(det('infra/modules/db/main.tf'), true);
  assert.equal(det('deploy/main.bicep'), true);
  assert.equal(det('app/main.py', 'package.json', 'prod.tfvars', 'main.bicepparam', 'x.tf.json', 'notes.tf.md', 'main.bicep.txt'), false);
  assert.equal(det(), false);
  assert.equal(typeof plugin.extract, 'function');
});

test('iac9 nothing is executed or imported from the scanned repo; the plug-in runs inside prescan and behind the stacks/ re-export', async () => {
  const src = readFileSync(MODULE, 'utf8');
  assert.ok(!/child_process|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|node:vm|node:worker_threads/.test(src), 'iac.mjs has no way to run code');

  const shim = join(LIB, 'stacks', 'iac.mjs');
  assert.equal(readFileSync(shim, 'utf8').trim(), "export { default } from '../iac.mjs';");
  const viaShim = await import(pathToFileURL(shim).href);
  assert.equal(viaShim.default, plugin, 'the re-export is the same object');

  const dir = mkdtempSync(join(tmpdir(), 'archmap-iacfix-'));
  try {
    for (const f of fixtureFiles) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), fixtureRead(f));
    }
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
    const { prescan } = await import(pathToFileURL(join(ROOT, 'scripts', 'prescan.mjs')).href);
    const out = await prescan(dir, { extractors: [plugin] });
    assert.ok(out.stacks.includes('iac'));
    assert.equal(JSON.stringify(out.extracts.iac), JSON.stringify(frag));
    const real = await prescan(dir);
    assert.equal(JSON.stringify(real.extracts.iac), JSON.stringify(frag), 'the default loader finds the plug-in');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
