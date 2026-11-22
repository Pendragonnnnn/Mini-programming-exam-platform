import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { clock } from '../stores/clock';

export function LiveClock() {
  const { isFetching } = useQuery({
    queryKey: ['server-clock'],
    queryFn: () => api('/health'),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const now = new Date(clock.now());
  const date = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const synced = clock.isSynchronized(45_000);
  const status = synced ? 'Server-synced' : isFetching ? 'Syncing' : 'Device time';

  return (
    <div title={`${date} · ${status}`} aria-label={`Current local time ${time}, ${status}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25, whiteSpace: 'nowrap' }}>
      <time className="mono tnum" style={{ fontSize: 14, fontWeight: 700 }} dateTime={now.toISOString()}>
        {time}
      </time>
      <span className="hint" style={{ fontSize: 11 }}>
        {date} · {status}
      </span>
    </div>
  );
}
