# ts-web (test fixture)

This directory is a **test fixture** for `scripts/lib/prescan/ts-frontend.mjs`. It is not a real application.
Everything in it is fictional (a made-up fleet tracker called Fleetwise), nothing here is meant to be built or
run, and the files are only ever read as text by the pre-scan tests.

`src/sidefx.ts` is a canary: importing or running it would write `EXECUTED.txt` and throw. The tests assert the
extractor never does.

One realistic example of each pattern the TS frontend extractor looks for:

| Pattern | File |
| --- | --- |
| React Router (JSX routes) | `src/App.tsx` |
| React Router (data router objects) | `src/router.tsx` |
| Next.js app directory pages and route handlers | `app/` |
| Next.js pages directory pages and API routes | `pages/` |
| React Navigation screens | `mobile/navigation.tsx` |
| Redux Toolkit slice | `src/store/vehiclesSlice.ts` |
| Zustand store | `src/store/tripStore.ts` |
| RTK Query endpoints | `src/api/fleetApi.ts` |
| React Query keys | `src/hooks/useVehicles.ts` |
| axios and fetch calls | `src/api/http.ts` |

`src/pages/` holds plain React components for React Router, not Next.js pages: Next only reads `pages/` at the
package root (or under `src/` when the root has none), so the extractor must not list them as routes.

The Next.js `app/` and `pages/` routers sit side by side only so one fixture covers both; a real Next.js project
would pick one. `package.json` lists `next`, which is what makes the extractor read those two directories.
`pages/_app.tsx` and `app/layout.tsx` are not routes, and the unresolvable names in `src/router.tsx`,
`mobile/navigation.tsx`, `app/vehicles/[vehicleId]/page.tsx` and `src/api/http.ts` exist to exercise the
`skipped` tally.
