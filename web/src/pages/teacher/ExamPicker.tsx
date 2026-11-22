import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Icon } from '../../components/Icon';
import { TeacherShell } from '../../components/Shell';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { STATUS_BADGE } from './Dashboard';

const TOOL = {
  monitor: { title: 'Live monitor', statuses: ['live', 'scheduled'], empty: 'No exam is live or scheduled right now.' },
  grading: { title: 'Grading', statuses: ['grading', 'live', 'completed'], empty: 'No exam has submissions to grade yet.' },
  results: { title: 'Results', statuses: ['completed', 'grading'], empty: 'No exam has finished yet.' },
} as const;

/** Nav targets for Live monitor / Grading / Results: jump straight in when there is one obvious exam. */
export function ExamPicker({ tool }: { tool: keyof typeof TOOL }) {
  const t = TOOL[tool];
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['teacher-exams', tool], queryFn: () => api('/teacher/exams', { query: { status: t.statuses.join(',') } }) });
  if (isLoading) return <TeacherShell crumbs={['Teacher', t.title]}><LoadingState label="Loading exams" /></TeacherShell>;
  if (error) return <TeacherShell crumbs={['Teacher', t.title]}><ErrorState what="your exams" error={error} onRetry={() => refetch()} /></TeacherShell>;
  const items = data.items as any[];
  if (tool === 'monitor') {
    const live = items.filter((x) => x.status === 'live');
    if (live.length === 1) return <Navigate to={`/teacher/exams/${live[0].examId}/monitor`} replace />;
  }
  if (items.length === 1) return <Navigate to={`/teacher/exams/${items[0].examId}/${tool}`} replace />;
  return (
    <TeacherShell crumbs={['Teacher', t.title]}>
      <div>
        <h1 className="h1">{t.title}</h1>
        <p className="sub">Choose an exam.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="Nothing here yet" text={t.empty} action={<Link className="btn btn-primary" to="/teacher">Back to dashboard</Link>} />
      ) : (
        <section className="card" style={{ overflow: 'hidden' }}>
          {items.map((e) => {
            const [cls, label] = STATUS_BADGE[e.status] ?? ['badge b-gray', e.status];
            return (
              <Link key={e.examId} to={`/teacher/exams/${e.examId}/${tool}`} className="grid-r" style={{ gridTemplateColumns: 'minmax(0,1fr) 140px 120px', color: 'var(--text)' }}>
                <span>
                  <b>{e.title}</b>
                  <div className="hint">{e.course}</div>
                </span>
                <span>
                  <span className={cls}>{label}</span>
                </span>
                <span style={{ textAlign: 'right', color: 'var(--accent-text)', display: 'inline-flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6 }}>
                  Open
                  <Icon name="arrowr" size={15} />
                </span>
              </Link>
            );
          })}
        </section>
      )}
    </TeacherShell>
  );
}
