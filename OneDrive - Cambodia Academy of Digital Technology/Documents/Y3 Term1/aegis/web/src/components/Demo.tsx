/**
 * DEMO TESTING MODE (development only). The buttons appear only when the API says demo mode is on
 * (DEMO_MODE=true and NODE_ENV=development on the server); in production they never render.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { Icon } from './Icon';
import { useSignOut } from './Shell';

type DemoInfo = { enabled: boolean; accounts?: { student: { username: string; password: string }; teacher: { username: string; password: string } } };

/** Demo account box under the sign-in form. */
export function DemoPanel() {
  const nav = useNavigate();
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [apiDown, setApiDown] = useState<string | null>(null);
  const [busy, setBusy] = useState<'student' | 'teacher' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api('/auth/demo')
      .then((r) => setInfo(r))
      .catch((e) => setApiDown(errorMessage(e)));
  }, []);

  const enter = async (role: 'student' | 'teacher') => {
    setBusy(role);
    setErr(null);
    try {
      const r = await api('/auth/demo', { method: 'POST', body: { role } });
      useAuthStore.getState().setSession(r);
      nav(role === 'teacher' ? '/teacher' : '/student', { replace: true });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // In development, explain a dead API right here (that is what a "POST /api/auth/login · 500" means).
  if (apiDown && import.meta.env.DEV) {
    return (
      <div className="card" role="alert" style={{ width: 400, maxWidth: '100%', padding: 18, display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--bad)' }}>
        <b style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="alert" size={16} /> Server problem (development)
        </b>
        <span style={{ fontSize: 13.5 }}>{apiDown}</span>
        <span className="hint">Sign-in and demo mode both need the API. Open a terminal in the api folder, run npm run dev, and check that it prints “listening on :4000”.</span>
      </div>
    );
  }
  if (!info?.enabled || !info.accounts) return null;
  const a = info.accounts;
  return (
    <div className="card" style={{ width: 400, maxWidth: '100%', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, border: '1.5px dashed #F59E0B' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <b>Demo accounts</b>
        <span className="badge b-amber">DEMO MODE · development only</span>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="btn btn-secondary" style={{ flex: 1 }} disabled={!!busy} onClick={() => enter('student')}>
          <Icon name="user" size={16} />
          {busy === 'student' ? 'Opening…' : 'Demo Student'}
        </button>
        <button type="button" className="btn btn-secondary" style={{ flex: 1 }} disabled={!!busy} onClick={() => enter('teacher')}>
          <Icon name="users" size={16} />
          {busy === 'teacher' ? 'Opening…' : 'Demo Teacher'}
        </button>
      </div>
      {err && <span className="err-text">{err}</span>}
      <span className="hint" style={{ lineHeight: 1.6 }}>
        Or sign in with the form: Student tab <b className="mono">{a.student.username}</b> / <span className="mono">{a.student.password}</span> · Teacher tab <b className="mono">{a.teacher.username}</b> / <span className="mono">{a.teacher.password}</span>. Demo accounts only see the demo course, never real students.
      </span>
    </div>
  );
}

/** Small fixed "DEMO MODE" pill on every page of a demo session, with a one-click way back to the login page. */
export function DemoBadge() {
  const user = useAuthStore((s) => s.user);
  const signOut = useSignOut();
  if (!user?.isDemo) return null;
  return (
    <div role="status" style={{ position: 'fixed', left: 12, bottom: 72, zIndex: 60, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 12px', borderRadius: 999, background: '#F59E0B', color: '#1F1300', fontSize: 12.5, fontWeight: 700, boxShadow: '0 6px 20px rgba(0,0,0,.25)' }}>
      DEMO MODE · {user.role === 'teacher' ? 'Teacher' : 'Student'}
      <button type="button" onClick={signOut} style={{ border: 'none', borderRadius: 999, padding: '4px 10px', background: 'rgba(0,0,0,.18)', color: 'inherit', fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>
        Switch role
      </button>
    </div>
  );
}
