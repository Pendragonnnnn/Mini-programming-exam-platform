import { create } from 'zustand';

type ClockState = { serverAtMs: number | null; observedAt: number | null };

/** A server-time anchor advanced with the monotonic performance clock. */
export const useClock = create<ClockState>(() => ({ serverAtMs: null, observedAt: null }));

export const clock = {
  observe(iso: string, rttMs: number) {
    const server = Date.parse(iso);
    if (Number.isNaN(server)) return;
    const observedAt = performance.now();
    const estimate = server + Math.max(0, rttMs) / 2;
    const previous = useClock.getState();
    const previousNow = previous.serverAtMs === null || previous.observedAt === null ? null : previous.serverAtMs + observedAt - previous.observedAt;
    const serverAtMs = previousNow === null ? estimate : previousNow + (estimate - previousNow) * 0.2;
    useClock.setState({ serverAtMs, observedAt });
  },
  now() {
    const { serverAtMs, observedAt } = useClock.getState();
    return serverAtMs === null || observedAt === null ? Date.now() : serverAtMs + performance.now() - observedAt;
  },
  isSynchronized(maxAgeMs = Number.POSITIVE_INFINITY) {
    const observedAt = useClock.getState().observedAt;
    return observedAt !== null && performance.now() - observedAt < maxAgeMs;
  },
};

export function fmtClock(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec));
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
