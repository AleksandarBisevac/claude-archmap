import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface Vehicle {
  id: string;
  plate: string;
}

export const loadVehicles = createAsyncThunk('vehicles/load', async () => {
  const res = await fetch('/api/vehicles');
  return (await res.json()) as Vehicle[];
});

const vehiclesSlice = createSlice({
  name: 'vehicles',
  initialState: { items: [] as Vehicle[], selectedId: null as string | null },
  reducers: {
    vehicleSelected(state, action: PayloadAction<string>) {
      state.selectedId = action.payload;
    },
    vehiclesCleared(state) {
      state.items = [];
    },
  },
});

export const { vehicleSelected, vehiclesCleared } = vehiclesSlice.actions;
export default vehiclesSlice.reducer;
