import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { ThemeButton } from '../components/Shell';
import { LANGS, langLabel, Seg } from '../components/ui';
import { DemoPanel } from '../components/Demo';
import { useAuthStore } from '../stores/auth';

export function Login() {
  const [role, setRole] = useState<'student' | 'teacher'>('student');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [roleHint, setRoleHint] = useState<'student' | 'teacher' | null>(null);
  const [sentReset, setSentReset] = useState(false);
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { user, bootstrapped } = useAuthStore();
  const [emailOn, setEmailOn] = useState(true);
  useEffect(() => {
    // A brand-new server has no teacher yet: go to the one-time setup screen.
    api('/auth/setup')
      .then((r) => {
        setEmailOn(!!r.emailEnabled);
        if (r.needsSetup) nav('/setup', { replace: true });
      })
      .catch(() => undefined);
  }, [nav]);

  if (bootstrapped && user) return <Navigate to={sp.get('next') || (user.role === 'teacher' ? '/teacher' : '/student')} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setRoleHint(null);
    const fe: Record<string, string> = {};
    if (!identifier.trim()) fe.identifier = role === 'student' ? 'Enter your student ID or email.' : 'Enter your staff email.';
    if (!password) fe.password = 'Enter your password.';
    if (Object.keys(fe).length) return setFieldErrors(fe);
    setBusy(true);
    try {
      const r = await api('/auth/login', { method: 'POST', body: { identifier: identifier.trim(), password, role } });
      useAuthStore.getState().setSession(r);
      const next = sp.get('next');
      nav(next && next.startsWith(`/${r.user.role}`) ? next : r.user.role === 'teacher' ? '/teacher' : '/student', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ROLE_MISMATCH') setRoleHint(role === 'student' ? 'teacher' : 'student');
      if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!identifier.trim()) {
      setFieldErrors({ identifier: 'Enter your ID or email first, then choose Forgot password.' });
      return;
    }
    await api('/auth/forgot-password', { method: 'POST', body: { identifier: identifier.trim() } }).catch(() => undefined);
    setSentReset(true);
  };

  return (
    <div className="app" style={{ position: 'relative', width: '100%', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 40px', background: '#0F1B3D' }}>
      <div style={{ position: 'absolute', top: 24, right: 24 }}>
        <ThemeButton />
      </div>
      <div style={{ width: '100%', maxWidth: 1180, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'clamp(32px, 5vw, 64px)' }}>
        <section style={{ flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 36, color: '#E7ECF7' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, background: '#2563EB', color: '#FFFFFF' }}>
              <Icon name="shield" size={20} />
            </span>
            <span style={{ fontWeight: 700, fontSize: 17, color: '#FFFFFF' }}>Aegis Exam</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 520 }}>
            <h1 style={{ margin: 0, fontSize: 40, lineHeight: 1.15, fontWeight: 700, letterSpacing: '-.025em', color: '#FFFFFF' }}>Secure online exams.</h1>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: '#B9C6E4' }}>
              Multiple choice, multiple answers, true/false, short answers and real coding questions, taken inside Safe Exam Browser.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {LANGS.map((l) => (
                <span key={l} className="mono" style={{ display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 12px', borderRadius: 999, border: '1px solid rgba(255,255,255,.16)', fontSize: 13, color: '#DCE4F5' }}>
                  {langLabel(l)}
                </span>
              ))}
            </div>
          </div>
        </section>
        <div style={{ flex: '0 0 400px', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <form className="card" onSubmit={submit} noValidate style={{ flex: '0 0 auto', width: 400, maxWidth: '100%', padding: 32, display: 'flex', flexDirection: 'column', gap: 20, boxShadow: '0 24px 60px rgba(0,0,0,.35)' }}>
          <div>
            <h2 className="h1" style={{ fontSize: 24 }}>
              Sign in
            </h2>
            <p className="sub">Students sign in with their student ID. Teachers use their email.</p>
          </div>
          <Seg
            value={role}
            onChange={(r) => {
              setRole(r);
              setError(null);
              setRoleHint(null);
            }}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
            options={[
              { value: 'student', label: (<><Icon name="user" size={15} />Student</>) },
              { value: 'teacher', label: (<><Icon name="users" size={15} />Teacher</>) },
            ]}
          />
          <p className="hint" style={{ margin: '-8px 0 0' }}>
            {role === 'student' ? 'You see your own exams and results only.' : 'You see the courses and exams you teach.'}
          </p>
          {error && (
            <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'var(--bad-bg)', color: 'var(--bad)', fontSize: 13 }}>
              <span>{error}</span>
              {roleHint && (
                <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => { setRole(roleHint); setError(null); setRoleHint(null); }}>
                  Switch to the {roleHint === 'teacher' ? 'Teacher' : 'Student'} tab
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="label" htmlFor="em">
              {role === 'student' ? 'Student ID or email' : 'Staff email'}
            </label>
            <div className={`field ${fieldErrors.identifier ? 'invalid' : ''}`}>
              <Icon name="mail" stroke="var(--muted)" />
              <input id="em" autoComplete="username" placeholder={role === 'student' ? 'Your student ID' : 'you@school.edu'} value={identifier} onChange={(e) => setIdentifier(e.target.value)} aria-invalid={!!fieldErrors.identifier} />
            </div>
            {fieldErrors.identifier && <span className="err-text">{fieldErrors.identifier}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <label className="label" htmlFor="pw">
                Password
              </label>
              <button type="button" className="btn btn-ghost btn-sm" style={{ height: 24, padding: '0 6px' }} onClick={forgot}>
                Forgot password?
              </button>
            </div>
            <div className={`field ${fieldErrors.password ? 'invalid' : ''}`}>
              <Icon name="lock" stroke="var(--muted)" />
              <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!fieldErrors.password} />
            </div>
            {fieldErrors.password && <span className="err-text">{fieldErrors.password}</span>}
          </div>
          <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
            <Icon name="arrowr" size={18} />
          </button>
          {sentReset && (
            <p role="status" style={{ margin: 0, textAlign: 'center', fontSize: 13, color: 'var(--ok)' }}>
              {emailOn ? 'If that account has an email, we sent it a reset link.' : 'Ask your teacher to send you a new password link.'}
            </p>
          )}
          <p className="hint" style={{ margin: 0, textAlign: 'center' }}>
            Exams open in Safe Exam Browser.
          </p>
        </form>
        <DemoPanel />
        </div>
      </div>
    </div>
  );
}
