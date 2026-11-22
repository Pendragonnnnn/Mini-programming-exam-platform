import { create } from 'zustand';

type Theme = 'light' | 'dark';
const KEY = 'aegis-theme';

function initial(): Theme {
  try {
    const t = window.localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* storage unavailable */
  }
  return 'light';
}

function apply(t: Theme) {
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.classList.add(t);
}

export const useTheme = create<{ theme: Theme; toggle: () => void }>((set, get) => {
  const t = initial();
  apply(t);
  return {
    theme: t,
    toggle: () => {
      const n: Theme = get().theme === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(KEY, n);
      } catch {
        /* ignore */
      }
      apply(n);
      set({ theme: n });
    },
  };
});
