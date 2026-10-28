import { Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/vehicles" element={<VehicleList />}>
        <Route index element={<VehicleOverview />} />
        <Route path=":vehicleId" element={<VehicleDetail />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
