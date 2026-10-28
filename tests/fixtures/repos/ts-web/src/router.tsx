import { createBrowserRouter } from 'react-router-dom';
import Dashboard from './pages/Dashboard';

export const router = createBrowserRouter([
  { path: '/login', element: <Dashboard /> },
  {
    path: '/drivers',
    element: <DriverLayout />,
    children: [
      { index: true, element: <DriverList /> },
      { path: ':driverId', element: <DriverDetail /> },
    ],
  },
  { path: ROUTES.settings, element: <Settings /> },
]);
