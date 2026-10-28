import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { Driver, Vehicle } from '../types';

export const fleetApi = createApi({
  reducerPath: 'fleetApi',
  baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
  tagTypes: ['Vehicle', 'Driver'],
  endpoints: (build) => ({
    getVehicles: build.query<Vehicle[], void>({
      query: () => '/vehicles',
      providesTags: ['Vehicle'],
    }),
    addVehicle: build.mutation<Vehicle, Partial<Vehicle>>({
      query: (body) => ({ url: '/vehicles', method: 'POST', body }),
      invalidatesTags: ['Vehicle'],
    }),
    getDriver: build.query<Driver, string>({
      query: (id) => `/drivers/${id}`,
    }),
  }),
});
