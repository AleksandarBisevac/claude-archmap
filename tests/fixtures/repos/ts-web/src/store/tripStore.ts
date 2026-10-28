import { create } from 'zustand';

interface TripState {
  activeTripId: string | null;
  startTrip: (id: string) => void;
  endTrip: () => void;
}

export const useTripStore = create<TripState>()((set) => ({
  activeTripId: null,
  startTrip: (id) => set({ activeTripId: id }),
  endTrip: () => set({ activeTripId: null }),
}));
