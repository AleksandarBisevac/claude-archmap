import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Case ids (ts1..ts8) lead every title so the suite prints them first.
// The ts-frontend stack plug-in of prescan, run on the fictional fleet-tracker fixture in
// tests/fixtures/repos/ts-web/ (read as text only - the extractor must never import it).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'repos', 'ts-web');
const TS_MODULE = join(ROOT, 'scripts', 'lib', 'prescan', 'ts-frontend.mjs');
const { default: tsExtractor, extractTsFrontend } = await import(pathToFileURL(TS_MODULE).href);

const walk = (dir, rel = '') =>
  readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });

const fixtureFiles = walk(FIXTURE).sort();
const fixtureRead = (p) => readFileSync(join(FIXTURE, p), 'utf8');
const frag = extractTsFrontend(fixtureFiles, fixtureRead);
const memFrag = (files) => extractTsFrontend(Object.keys(files).sort(), (p) => files[p] ?? null);

const KINDS = ['apiCalls', 'routes', 'stores'];
const ev = (i) => `${i.evidence[0].path}:${i.evidence[0].lines}`;
const routeRow = (r) => `${r.framework} ${r.method ?? '-'} ${r.url ?? r.name} ${r.component ?? '-'} ${ev(r)}`;
const callRow = (c) => `${c.client} ${c.method} ${c.url} ${ev(c)}`;

test('ts1 routes: React Router (JSX and data router), Next.js app/pages dirs and React Navigation, with line evidence', () => {
  assert.deepEqual(frag.routes.map(routeRow), [
    'next-app - /reports ReportsPage app/(dashboard)/reports/page.tsx:1',
    'next-app GET /api/health - app/api/health/route.ts:1',
    'next-app HEAD /api/health - app/api/health/route.ts:5',
    'next-app - / HomePage app/page.tsx:1',
    'next-app - /vehicles/[vehicleId] VehiclePage app/vehicles/[vehicleId]/page.tsx:1',
    'react-navigation - Home HomeScreen mobile/navigation.tsx:10',
    'react-navigation - TripDetail TripDetailScreen mobile/navigation.tsx:11',
    'next-pages - /about About pages/about.tsx:1',
    'next-pages ANY /api/ping handler pages/api/ping.ts:3',
    'next-pages - /drivers/[driverId] Driver pages/drivers/[driverId].tsx:1',
    'next-pages - /drivers Drivers pages/drivers/index.tsx:1',
    'next-pages - / Index pages/index.tsx:1',
    'react-router - / Dashboard src/App.tsx:7',
    'react-router - /vehicles VehicleList src/App.tsx:8',
    'react-router - /vehicles/:vehicleId VehicleDetail src/App.tsx:10',
    'react-router - * NotFound src/App.tsx:12',
    'react-router - /login Dashboard src/router.tsx:5',
    'react-router - /drivers DriverLayout src/router.tsx:7',
    'react-router - /drivers/:driverId DriverDetail src/router.tsx:11',
  ]);
  assert.deepEqual([...new Set(frag.routes.map((r) => r.kind))].sort(), ['handler', 'page', 'screen']);
});

test('ts2 Next.js app/ and pages/ count only at a package root that depends on next', () => {
  assert.ok(!frag.routes.some((r) => r.evidence[0].path.startsWith('src/pages/')), 'src/pages/Dashboard.tsx is a React Router view, not a page');
  assert.ok(!frag.routes.some((r) => /layout|_app/.test(r.evidence[0].path)), 'layouts and _app are not routes');

  const mem = memFrag({
    'web/package.json': '{"dependencies":{"next":"14.2.0"}}',
    'web/app/page.tsx': 'export default function Home() { return null; }\n',
    'web/src/pages/Legacy.tsx': 'export default function Legacy() { return null; }\n',
    'blog/package.json': '{"devDependencies":{"next":"14.2.0"}}',
    'blog/pages/index.tsx': 'export default function Index() { return null; }\n',
    'blog/pages/_app.tsx': 'export default function A() { return null; }\n',
    'blog/pages/_document.tsx': 'export default function D() { return null; }\n',
    'blog/pages/index.test.tsx': 'export default function T() { return null; }\n',
    'blog/pages/post/[slug].tsx': 'export default function Post() { return null; }\n',
    'blog/pages/api/hello.ts': 'export default function hello(req, res) { res.end(); }\n',
    'blog/src/pages/Ignored.tsx': 'export default function Ignored() { return null; }\n',
    'lib/package.json': '{"dependencies":{"react":"18"}}',
    'lib/pages/index.tsx': 'export default function P() { return null; }\n',
    'lib/app/page.tsx': 'export default function Q() { return null; }\n',
    'loose/pages/index.tsx': 'export default function L() { return null; }\n',
    'mono/package.json': '{"workspaces":["apps/*"]}',
    'mono/pages/x.tsx': 'export default function X() { return null; }\n',
    'mono/apps/site/package.json': '{"dependencies":{"next":"14.2.0"}}',
    'mono/apps/site/app/page.tsx': 'export default function () { return null; }\n',
  });
  assert.deepEqual(mem.routes.map(routeRow), [
    'next-pages ANY /api/hello hello blog/pages/api/hello.ts:1',
    'next-pages - / Index blog/pages/index.tsx:1',
    'next-pages - /post/[slug] Post blog/pages/post/[slug].tsx:1',
    'next-app - / - mono/apps/site/app/page.tsx:1',
    'next-app - / Home web/app/page.tsx:1',
    'next-pages - /Legacy Legacy web/src/pages/Legacy.tsx:1',
  ]);
});

test('ts3 stores: Redux Toolkit slice, Zustand store, RTK Query endpoints and React Query keys', () => {
  const rows = frag.stores.map((s) => {
    const head = `${s.library} ${s.kind} ${s.name}`;
    const body = s.library === 'react-query' ? ` ${JSON.stringify(s.key)}` : s.library === 'rtk-query' ? ` api=${s.api}` : ` actions=${s.actions.join(',')} state=${s.state.join(',')}`;
    return `${head}${body} ${ev(s)}`;
  });
  assert.deepEqual(rows, [
    'rtk-query query getVehicles api=fleetApi src/api/fleetApi.ts:9-12',
    'rtk-query mutation addVehicle api=fleetApi src/api/fleetApi.ts:13-16',
    'rtk-query query getDriver api=fleetApi src/api/fleetApi.ts:17-19',
    'react-query query useVehicles ["vehicles"] src/hooks/useVehicles.ts:5',
    'react-query query useVehicle ["vehicles","{id}"] src/hooks/useVehicles.ts:9',
    'react-query mutation useRetireVehicle null src/hooks/useVehicles.ts:14-17',
    'zustand store useTripStore actions=startTrip,endTrip state=activeTripId src/store/tripStore.ts:9-13',
    'redux-toolkit slice vehicles actions=vehicleSelected,vehiclesCleared state=items,selectedId src/store/vehiclesSlice.ts:13-24',
  ]);
});

test('ts4 apiCalls: axios (direct and instance), fetch and RTK Query with method and full path', () => {
  assert.deepEqual(frag.apiCalls.map(callRow), [
    'rtk-query GET /api/vehicles src/api/fleetApi.ts:10',
    'rtk-query POST /api/vehicles src/api/fleetApi.ts:14',
    'rtk-query GET /api/drivers/{id} src/api/fleetApi.ts:18',
    'fetch GET /api/drivers src/api/http.ts:8',
    'axios POST /api/vehicles/{vehicleId}/driver src/api/http.ts:13',
    'fetch POST /api/telemetry src/api/http.ts:17',
    'axios PUT /api/status src/api/http.ts:21',
    'axios GET /api/vehicles src/hooks/useVehicles.ts:5',
    'axios GET /api/vehicles/{id} src/hooks/useVehicles.ts:9',
    'axios DELETE /api/vehicles/{id} src/hooks/useVehicles.ts:15',
    'fetch GET /api/vehicles src/store/vehiclesSlice.ts:9',
  ]);
});

test('ts5 every item carries {path, lines} evidence inside the file, output sorted and deterministic', () => {
  for (const kind of KINDS) {
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
  assert.deepEqual(Object.keys(frag), ['apiCalls', 'routes', 'scanned', 'skipped', 'stores', 'truncated']);
  const again = extractTsFrontend(fixtureFiles.slice().reverse(), fixtureRead);
  assert.equal(JSON.stringify(again), JSON.stringify(frag), 'input order does not change the output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(frag)), 'no timestamps');
});

test('ts6 unknown patterns are skipped and counted, never guessed; the fragment is size-capped', () => {
  // Fixture tally: two non-literal screen/route names, a fetch of a non-literal url, a fetch whose base is env.
  assert.deepEqual(frag.skipped, { apiCalls: 2, routes: 2, stores: 0 });

  const odd = memFrag({
    'web/odd.tsx':
      "import axios from 'axios';\n" +
      "import { Route, Routes } from 'react-router-dom';\n" +
      "import { create } from 'zustand';\n" +
      "import { useQuery } from '@tanstack/react-query';\n" +
      "import { createApi } from '@reduxjs/toolkit/query/react';\n\n" +
      'export const routes = (\n  <Routes>\n    <Route path={PATHS[0]} element={<A />} />\n  </Routes>\n);\n\n' +
      'export const useBag = create(makeBag);\n\n' +
      'export function useAll() {\n  return useQuery({ queryKey: keys.all, queryFn: load });\n}\n\n' +
      'export const api = createApi({\n  baseQuery: base,\n  endpoints: (build) => ({\n' +
      '    find: build.query({\n      query: (a) => buildQuery(a),\n    }),\n  }),\n});\n\n' +
      'export function go(u) {\n  fetch(build(u));\n  axios.get(`${BASE_URL}/x`);\n  fetch(`/ok/${u}`, { method: VERB });\n}\n',
  });
  assert.deepEqual(odd.skipped, { apiCalls: 4, routes: 1, stores: 2 });
  assert.deepEqual(odd.routes, [], 'routes: nothing is guessed from unknown shapes');
  assert.deepEqual(odd.apiCalls, [], 'apiCalls: nothing is guessed from unknown shapes');
  assert.deepEqual(odd.stores.map((s) => `${s.library} ${s.name}`), ['rtk-query find'], 'only the endpoint with a recognisable shape is recorded');

  const many = { 'site/package.json': '{"dependencies":{"next":"14"}}' };
  for (let i = 0; i < 400; i++) many[`site/pages/p${String(i).padStart(3, '0')}.tsx`] = `export default function P${i}() {\n  return null;\n}\n`;
  const big = memFrag(many);
  assert.ok(big.routes.length <= 300 && big.routes.length > 0, `routes capped (${big.routes.length})`);
  assert.equal(big.truncated.routes, 400 - big.routes.length);
  assert.equal(big.routes[0].url, '/p000', 'the cap keeps the first items in sort order');
  assert.ok(JSON.stringify(big).length < 200 * 1024, 'fragment stays small');
});

test('ts7 JSX route nesting joins paths, and string constants resolve; template params become {name}', () => {
  const m = memFrag({
    'web/a.tsx':
      "import { Route, Routes } from 'react-router-dom';\n" +
      "const BASE = '/v2';\n" +
      'export const t = (\n  <Routes>\n' +
      '    <Route path="/team" element={<Team />}>\n' +
      '      <Route path="members" element={<Members />}>\n' +
      '        <Route path=":id/edit" element={<Edit />} />\n' +
      '      </Route>\n' +
      '    </Route>\n' +
      '    <Route path="/solo" element={<Solo />} />\n' +
      '  </Routes>\n);\n' +
      'export const go = (id) => fetch(`${BASE}/cars/${id}`, { method: "delete" });\n',
  });
  assert.deepEqual(m.routes.map((r) => `${r.url} ${r.component}`), ['/team Team', '/team/members Members', '/team/members/:id/edit Edit', '/solo Solo']);
  assert.deepEqual(m.apiCalls.map((c) => `${c.method} ${c.url}`), ['DELETE /v2/cars/{id}']);
});

test('ts8 nothing is executed or imported from the scanned repo; the plug-in runs inside prescan', () => {
  const canary = join(FIXTURE, 'src', 'EXECUTED.txt');
  assert.ok(!existsSync(canary), 'canary absent before');
  extractTsFrontend(fixtureFiles, fixtureRead);
  assert.ok(!existsSync(canary), 'the import-time canary in src/sidefx.ts was never run');

  const src = readFileSync(TS_MODULE, 'utf8');
  assert.ok(!/child_process|\beval\s*\(|new Function|\bimport\s*\(|\brequire\s*\(|node:vm|node:worker_threads/.test(src), 'ts-frontend.mjs has no way to run code');

  assert.equal(tsExtractor.id, 'ts-frontend');
  assert.equal(tsExtractor.detect({ files: ['web/App.tsx'] }), true);
  assert.equal(tsExtractor.detect({ files: ['app/main.py'] }), false);

  const dir = mkdtempSync(join(tmpdir(), 'archmap-tsfix-'));
  try {
    for (const f of fixtureFiles) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), fixtureRead(f));
    }
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
    return import(pathToFileURL(join(ROOT, 'scripts', 'prescan.mjs')).href).then(async ({ prescan }) => {
      const out = await prescan(dir, { extractors: [tsExtractor] });
      assert.deepEqual(out.stacks, ['ts-frontend']);
      assert.equal(JSON.stringify(out.extracts['ts-frontend']), JSON.stringify(frag));
      assert.ok(!existsSync(join(dir, 'src', 'EXECUTED.txt')));
      rmSync(dir, { recursive: true, force: true });
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
});
