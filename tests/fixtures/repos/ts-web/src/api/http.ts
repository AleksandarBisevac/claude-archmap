import axios from 'axios';

const API_BASE = '/api';

export const http = axios.create({ baseURL: API_BASE });

export async function fetchDrivers() {
  const res = await fetch('/api/drivers');
  return res.json();
}

export function assignDriver(vehicleId: string, driverId: string) {
  return axios.post(`/api/vehicles/${vehicleId}/driver`, { driverId });
}

export async function postTelemetry(payload: unknown) {
  return fetch('/api/telemetry', { method: 'POST', body: JSON.stringify(payload) });
}

export function setStatus() {
  return axios({ method: 'put', url: '/api/status', data: {} });
}

export function loadRemote(url: string) {
  return fetch(url);
}
