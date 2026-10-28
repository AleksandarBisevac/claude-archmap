# Stack reference: TypeScript frontend

Covers React, Next.js and React Native; routers (React Router, the Next.js file router, React Navigation); state and
data layers RTK Query, React Query, Redux and Zustand; and HTTP via axios and fetch. Prescan detects it from
`package.json` dependencies and `.tsx`/`.jsx` files, and runs `scripts/lib/prescan/ts-frontend.mjs`
(also `stacks/ts-frontend.mjs`). The output is `extracts.ts-frontend`. The scanned code is only ever read as text;
never execute, import, build or serve the project, and never run its package scripts.

## What prescan already extracts

All items carry `evidence: [{path, lines}]`, sorted, capped per kind (see `truncated`).

| Kind | What it holds |
|---|---|
| `routes` | React Router (JSX `<Route>` and data-router objects), Next.js `app/` and `pages/` page files, route handlers and `pages/api`, React Navigation `<X.Screen>` entries. Next.js dirs count only in packages that depend on `next`. |
| `stores` | Redux Toolkit slices, Zustand stores, RTK Query endpoints and React Query keys (`useQuery`, `useMutation`), with action or state names (capped). |
| `apiCalls` | `fetch`, axios (direct and `axios.create` instances) and RTK Query endpoints, with method and path where they are string literals. |
| `skipped`, `truncated` | Calls whose URL is computed, and items dropped by the cap. |

## What you must still read yourself

1. **Nodes.** Prescan lists routes and stores but no components. Group routes into `route-group` nodes by layout or
   navigator (a Next.js `layout.tsx`, a React Router parent route, a tab or stack navigator). Read the app root
   (`main.tsx`, `App.tsx`, `_app.tsx`, `app/layout.tsx`, `index.js` for React Native) for providers: the Redux
   `<Provider>`, `QueryClientProvider`, theme and auth providers. These tell you which store layers are in play. The
   frontend app is one `app` node; stores become `store` nodes only for client state worth showing.
2. **Edges.** Connect a route group to the stores and API clients its screens use: read the import list and hook calls
   (`useSelector`, `useAppDispatch`, `useGetOrdersQuery`, `useQuery`) of the page files prescan listed. Connect the
   frontend to backend `route-group` nodes by matching `apiCalls` paths to routes in other areas (use the id the
   area map gave you); use `confidence: inferred` when only the path matches, and `external` for a third-party host.
3. **Base URLs and clients.** Prescan keeps literal paths. Read `axios.create({ baseURL })` and the RTK Query
   `fetchBaseQuery({ baseUrl })` lines to learn which backend a client targets; the value usually comes from an
   environment variable, so cite the variable name, not its value. Read interceptors for auth edges.
4. **Entities and access.** A frontend rarely owns entities. Record client-side shapes only when they model a store
   the user cares about; for a backend contract, read the TypeScript types or generated API clients that mirror
   it (cite them as `declared`) and leave the entity itself to the backend explorer. Access rows come from API
   calls: `GET` is R, `POST` C, `PUT`/`PATCH` U, `DELETE` D, against the entity the backend route maps to.
5. **Dynamic routing.** Next.js parallel and intercepting routes, catch-all segments, and routes built from arrays are
   counted in `skipped`. Read the file tree of `app/` with a single directory listing at that package only, and
   cite the page files.
6. **React Native.** Native modules and platform folders (`ios/`, `android/`) are deploy and external concerns: read
   the app config (`app.json`, `eas.json`) for the deploy unit and push or analytics SDKs, but not native sources.

## Fictional example

`shop-web` has `src/store/api.ts` with an RTK Query `getOrders` endpoint (`GET /orders`, prescan line 22). You read
`src/pages/OrdersPage.tsx:1-40`, find `useGetOrdersQuery`, and emit an edge `OrdersPage group -> shop-api orders group`
of type `calls` with `confidence: inferred`, citing `api.ts:22` and the page lines where the hook is used.
