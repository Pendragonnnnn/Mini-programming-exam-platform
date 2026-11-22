import { create } from 'zustand';

/** Server clock offset (serverNow - clientNow). Timers never trust the client clock. */
export const useClock = create<{ offsetMs: number }>(() => ({ offsetMs: 0 }));

export const clock = {
  observe(iso: string, rttMs: number) {
    const server = Date.parse(iso);
    if (Number.isNaN(server)) return;
    const offset = server + rttMs / 2 - Date.now();
    const prev = useClock.getState().offsetMs;
    // Server header has 1 s precision noise; smooth it.
    useClock.setState({ offsetMs: prev === 0 ? offset : Math.round(prev * 0.8 + offset * 0.2) });
  },
  now() {
    return Date.now() + useClock.getState().offsetMs;
  },
};

export function fmtClock(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
