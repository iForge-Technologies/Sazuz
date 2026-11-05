'use client';

import { create } from 'zustand';

interface HealthViewState {
  autoRefresh: boolean;
  toggleAutoRefresh: () => void;
}

export const useHealthViewStore = create<HealthViewState>((set) => ({
  autoRefresh: true,
  toggleAutoRefresh: () => set((state) => ({ autoRefresh: !state.autoRefresh })),
}));
