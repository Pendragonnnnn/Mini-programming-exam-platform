import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useTheme } from '../stores/theme';
import { Icon } from './Icon';
import { ago, Avatar } from './ui';

export function Logo({ to, sub }: { to: string; sub?: string }) {
  return (
    <Link to={to} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 10, background: 'var(--accent)', color: '#fff' }}>
        <Icon name="shield" size={19} />
      </span>
      {sub ? (
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>Aegis</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>
        </span>
      ) : (
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>Aegis</span>
      )}
    </Link>
  );
}

export function ThemeButton() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label="Switch light or dark mode" style={{ border: '1px solid var(--border)' }}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
    </button>
  );
}

export function useSignOut() {
  const nav = useNavigate();
  const qc = useQueryClient();
  return async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    useAuthStore.getState().clear();
    qc.clear();
    nav('/login', { replace: true });
  };
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api('/notifications', { query: { pageSize: 8 } }), refetchInterval: 15_000 });
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const icon = (t: string) => (t === 'proctor_flag' ? ['flag', 'var(--bad)'] : t === 'submission' ? ['check', 'var(--ok)'] : t === 'teacher_message' ? ['mail', 'var(--accent-text)'] : ['chat', 'var(--accent-text)']);
  const readAll = async () => {
    await api('/notifications/read-all', { method: 'POST' }).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="icon-btn" aria-label="Notifications" aria-expanded={open} onClick={() => setOpen(!open)} style={{ border: '1px solid var(--border)', position: 'relative' }}>
        <Icon name="bell" size={18} />
        {data?.unreadCount > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: 999, background: 'var(--bad)' }} />}
      </button>
      {open && (
        <div className="card" role="dialog" aria-label="Notifications" style={{ position: 'absolute', top: 46, right: 0, width: 360, zIndex: 30, overflow: 'hidden', boxShadow: '0 12px 32px rgba(15,23,42,.18)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <b>Notifications</b>
            <button type="button" className="btn btn-ghost btn-sm" onClick={readAll} style={{ height: 28 }}>
              Mark all read
            </button>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 380, overflow: 'auto' }}>
            {(data?.items ?? []).length === 0 && <li className="hint" style={{ padding: 16 }}>No notifications yet.</li>}
            {(data?.items ?? []).map((n: any) => {
              const [ic, col] = icon(n.type);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (n.link) nav(n.link);
                    }}
                    style={{ width: '100%', display: 'flex', gap: 12, padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border)', background: n.read ? 'transparent' : 'var(--accent-weak)', color: 'var(--text)', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
                  >
                    <span style={{ color: col, marginTop: 2 }}>
                      <Icon name={ic!} size={17} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13.5, lineHeight: 1.45 }}>{n.title}</span>
                      <span className="hint">{ago(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

const NAV = [
  { to: '/teacher', label: 'Dashboard', icon: 'grid', end: true },
  { to: '/teacher/exams/new', label: 'New exam', icon: 'fileplus' },
  { to: '/teacher/courses', label: 'Courses & students', icon: 'users' },
  { to: '/teacher/questions', label: 'Question bank', icon: 'book' },
  { to: '/teacher/monitor', label: 'Live monitor', icon: 'pulse', badge: 'live' as const },
  { to: '/teacher/grading', label: 'Grading', icon: 'check', badge: 'grade' as const },
  { to: '/teacher/results', label: 'Results', icon: 'chart' },
  { to: '/teacher/audit', label: 'Audit log', icon: 'shield' },
];

export function TeacherShell({ crumbs, children, wide }: { crumbs: string[]; children: ReactNode; wide?: boolean }) {
  const [navOpen, setNavOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const signOut = useSignOut();
  const nav = useNavigate();
  const [qtext, setQtext] = useState('');
  const { data: dash } = useQuery({ queryKey: ['teacher-dashboard'], queryFn: () => api('/teacher/dashboard'), staleTime: 15_000 });
  useEffect(() => {
    if (!navOpen) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [navOpen]);
  return (
    <div className="app" style={{ position: 'relative', width: '100%', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 64, padding: '10px 24px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <button type="button" className="icon-btn" aria-label="Open menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)} style={{ border: '1px solid var(--border)' }}>
            <Icon name="menu" size={19} />
          </button>
          <Logo to="/teacher" />
          <span aria-hidden="true" style={{ width: 1, height: 22, background: 'var(--border)' }} />
          <nav aria-label="Breadcrumb" className="crumb">
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: 'contents' }}>
                {i > 0 && <span aria-hidden="true" style={{ color: 'var(--faint)' }}>/</span>}
                {i === crumbs.length - 1 ? <b>{c}</b> : <span>{c}</span>}
              </span>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <form
            className="field hide-sm"
            style={{ width: 260, height: 38 }}
            onSubmit={(e) => {
              e.preventDefault();
              nav(`/teacher/questions?q=${encodeURIComponent(qtext)}`);
            }}
          >
            <Icon name="search" stroke="var(--muted)" />
            <input type="search" placeholder="Search the question bank" aria-label="Search" value={qtext} onChange={(e) => setQtext(e.target.value)} />
          </form>
          <Notifications />
          <ThemeButton />
          <Avatar initials={user?.initials ?? '?'} />
        </div>
      </header>
      {navOpen && (
        <>
          <div aria-hidden="true" onClick={() => setNavOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(15,23,42,.35)' }} />
          <aside aria-label="Main menu" style={{ position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 40, width: 280, background: 'var(--surface)', borderRight: '1px solid var(--border)', boxShadow: '8px 0 32px rgba(15,23,42,.18)', padding: '14px 14px 20px', display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px 0 8px', minHeight: 40 }}>
              <Logo to="/teacher" sub="Teacher workspace" />
              <button type="button" className="icon-btn" aria-label="Close menu" onClick={() => setNavOpen(false)}>
                <Icon name="close" size={18} />
              </button>
            </div>
            <nav aria-label="Main" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div className="over" style={{ padding: '0 12px 8px' }}>
                Workspace
              </div>
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-a ${isActive ? 'nav-on' : ''}`} onClick={() => setNavOpen(false)}>
                  <Icon name={n.icon} size={18} />
                  <span>{n.label}</span>
                  {n.badge === 'live' && dash?.liveExam && (
                    <span className="badge b-red" style={{ marginLeft: 'auto', height: 20 }}>
                      LIVE
                    </span>
                  )}
                  {n.badge === 'grade' && dash?.stats?.toGrade > 0 && (
                    <span className="badge b-gray tnum" style={{ marginLeft: 'auto', height: 20 }}>
                      {dash.stats.toGrade}
                    </span>
                  )}
                </NavLink>
              ))}
            </nav>
            <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
              <Avatar initials={user?.initials ?? '?'} />
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3, minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 600 }}>{user?.fullName}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.title ?? 'Teacher'}</span>
              </span>
              <button type="button" className="icon-btn" aria-label="Sign out" onClick={signOut}>
                <Icon name="signout" size={17} />
              </button>
            </div>
          </aside>
        </>
      )}
      <main style={{ width: '100%', maxWidth: wide ? 1480 : 1360, margin: '0 auto', padding: '28px 32px 40px', display: 'flex', flexDirection: 'column', gap: 24, flex: 1 }}>{children}</main>
    </div>
  );
}

export function StudentShell({ children, maxWidth = 1240 }: { children: ReactNode; maxWidth?: number }) {
  const user = useAuthStore((s) => s.user);
  const signOut = useSignOut();
  return (
    <div className="app" style={{ width: '100%', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <div style={{ maxWidth, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 64, padding: '10px 32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <Logo to="/student" />
            <nav aria-label="Main" style={{ display: 'flex', gap: 4 }}>
              <NavLink to="/student" end className={({ isActive }) => `nav-a ${isActive ? 'nav-on' : ''}`}>
                My exams
              </NavLink>
              <NavLink to="/student/results" className={({ isActive }) => `nav-a ${isActive ? 'nav-on' : ''}`}>
                Results
              </NavLink>
            </nav>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ThemeButton />
            <span className="hide-sm" style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, textAlign: 'right' }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>{user?.fullName}</span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                {user?.studentId}
              </span>
            </span>
            <Avatar initials={user?.initials ?? '?'} />
            <button type="button" className="icon-btn" aria-label="Sign out" onClick={signOut} style={{ border: '1px solid var(--border)' }}>
              <Icon name="signout" size={17} />
            </button>
          </div>
        </div>
      </header>
      <main style={{ width: '100%', maxWidth, margin: '0 auto', padding: 32, display: 'flex', flexDirection: 'column', gap: 24, flex: 1 }}>{children}</main>
      <footer style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>
        <div style={{ maxWidth, margin: '0 auto', padding: '20px 32px', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, fontSize: 13, color: 'var(--muted)' }}>
          <span>
            <b style={{ color: 'var(--text)' }}>Aegis Exam</b> · secure online exams
          </span>
        </div>
      </footer>
    </div>
  );
}
