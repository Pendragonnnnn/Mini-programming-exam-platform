import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download } from '../../api/client';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { EmptyState, ErrorState, LoadingState, Seg, toast } from '../../components/ui';

const CAT: Record<string, [string, string]> = {
  publish: ['badge b-blue', 'Publish'],
  grade_change: ['badge b-amber', 'Grade change'],
  lockdown: ['badge b-red', 'Lockdown'],
  settings: ['badge b-gray', 'Settings'],
};

export function AuditLog() {
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const params = { category: category === 'all' ? undefined : category, q: search };
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['audit', category, search, page], queryFn: () => api('/teacher/audit', { query: { ...params, page, pageSize: 50 } }), placeholderData: (p) => p });
  const crumbs = ['Teacher', 'Audit log'];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportCsv = () => {
    const sp = new URLSearchParams();
    if (params.category) sp.set('category', params.category);
    if (search) sp.set('q', search);
    download(`/teacher/audit/export.csv${sp.toString() ? `?${sp}` : ''}`, 'audit-log.csv').catch((e) => toast.error(e));
  };
  return (
    <TeacherShell crumbs={crumbs}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 className="h1">Audit log</h1>
          <p className="sub">Every publish, grade change and settings change in your courses{data ? `, kept for ${data.retentionDays} days` : ''}.</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={exportCsv}>
          <Icon name="download" />
          Export CSV
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <Seg
          small
          value={category}
          onChange={(v) => { setCategory(v); setPage(1); }}
          options={[{ value: 'all', label: 'All' }, { value: 'publish', label: 'Publish' }, { value: 'grade_change', label: 'Grade changes' }, { value: 'settings', label: 'Settings' }, { value: 'lockdown', label: 'Lockdown' }]}
        />
        <label className="field" style={{ height: 38, width: 280 }}>
          <Icon name="search" stroke="var(--muted)" />
          <input type="search" placeholder="Search who, what or details…" aria-label="Search the audit log" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </label>
      </div>
      {isLoading ? (
        <LoadingState label="Loading the audit log" />
      ) : error && !data ? (
        <ErrorState what="the audit log" error={error} onRetry={() => refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState title="Nothing logged" text="No events match these filters." />
      ) : (
        <section className="card" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Who</th>
                  <th>Event</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r: any) => {
                  const [cls, label] = CAT[r.category] ?? ['badge b-gray', r.category];
                  return (
                    <tr key={r.id}>
                      <td className="mono tnum" style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                        {r.occurredAt.slice(0, 16).replace('T', ' ')}
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.who}</div>
                        <div className="hint">{r.role}</div>
                      </td>
                      <td>
                        <span className={cls}>{label}</span>
                      </td>
                      <td>{r.target}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 13 }}>{r.details}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
            <span className="hint tnum">
              {data.total} event{data.total === 1 ? '' : 's'} · page {page} of {pages}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <Icon name="arrowl" size={14} />
                Newer
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Older
                <Icon name="arrowr" size={14} />
              </button>
            </div>
          </div>
        </section>
      )}
    </TeacherShell>
  );
}
