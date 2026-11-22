import { create } from 'zustand';

export interface SessionUser {
  id: string;
  role: 'student' | 'teacher';
  studentId: string | null;
  email: string | null;
  isDemo?: boolean;
  fullName: string;
  displayName: string | null;
  initials: string;
  title: string | null;
}

interface AuthState {
  user: SessionUser | null;
  accessToken: string | null;
  bootstrapped: boolean;
  setSession: (r: { accessToken: string; user: SessionUser }) => void;
  clear: () => void;
  setBootstrapped: () => void;
}

/** Access token in memory only; the refresh token is an HttpOnly cookie. */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  bootstrapped: false,
  setSession: (r) => set({ user: r.user, accessToken: r.accessToken }),
  clear: () => set({ user: null, accessToken: null }),
  setBootstrapped: () => set({ bootstrapped: true }),
}));
