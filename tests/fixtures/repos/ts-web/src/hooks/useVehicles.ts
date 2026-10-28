import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../api/http';

export function useVehicles() {
  return useQuery({ queryKey: ['vehicles'], queryFn: () => http.get('/vehicles') });
}

export function useVehicle(id: string) {
  return useQuery({ queryKey: ['vehicles', id], queryFn: () => http.get(`/vehicles/${id}`) });
}

export function useRetireVehicle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => http.delete(`/vehicles/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ['vehicles'] }),
  });
}
