import { useVehicles } from '../hooks/useVehicles';

// A plain React Router view. It lives in src/pages but is NOT a Next.js page:
// this package keeps its Next.js pages in the root pages/ directory.
export default function Dashboard() {
  const { data } = useVehicles();
  return <h1>Fleet overview: {data?.length ?? 0} vehicles</h1>;
}
