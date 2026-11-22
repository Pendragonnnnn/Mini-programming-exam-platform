import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Banner } from '../components/ui';
import { useAuthStore } from '../stores/auth';

/** One-time setup on a brand-new server: create the first teacher account. */
export function Setup() {
  const nav = useNavigate();
  const [state, setState] = useState<'loading' | 'open' | 'done'>('loading');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/setup')
      .then((r) => setState(r.needsSetup ? 'open' : 'done'))
      .catch(() => setState('open'));
  }, []);
  if (state === 'done') return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const f: Record<string, string> = {};
    if (!fullName.trim()) f.fullName = 'Enter your name.';
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) f.email = 'Enter a valid email address.';
    if (pw.length < 8) f.password = 'Use at least 8 characters.';
    else if (pw !== pw2) f.password2 = 'The two passwords are not the same.';
    setFe(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      const r = await api('/auth/setup', { method: 'POST', body: { fullName: fullName.trim(), email: email.trim(), password: pw } });
      useAuthStore.getState().setSession(r);
      nav('/teacher/courses?welcome=1', { replace: true });
    } catch (x) {
      if (x instanceof ApiError) setFe(x.fieldErrors);
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const field = (id: string, label: string, value: string, set: (v: string) => void, type = 'text', auto?: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className={`field ${fe[id] ? 'invalid' : ''}`}>
        <input id={id} type={type} value={value} onChange={(e) => set(e.target.value)} autoComplete={auto} />
      </div>
      {fe[id] && <span className="err-text">{fe[id]}</span>}
    </div>
  );
  return (
    <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, minHeight: '100vh' }}>
      <form className="card" onSubmit={submit} noValidate style={{ width: 440, maxWidth: '100%', padding: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, background: 'var(--accent)', color: '#fff' }}>
            <Icon name="shield" size={20} />
          </span>
          <h1 className="h1" style={{ fontSize: 22 }}>
            Welcome to Aegis Exam
          </h1>
        </div>
        <p className="sub" style={{ margin: 0 }}>
          This server is empty. Create the first teacher account. After that you add your courses, classes and students yourself.
        </p>
        {state === 'loading' ? (
          <span className="hint">Checking the server…</span>
        ) : (
          <>
            {err && <Banner tone="bad">{err}</Banner>}
            {field('fullName', 'Your name', fullName, setFullName, 'text', 'name')}
            {field('email', 'Email (you sign in with this)', email, setEmail, 'email', 'username')}
            {field('password', 'Password (at least 8 characters)', pw, setPw, 'password', 'new-password')}
            {field('password2', 'Type the password again', pw2, setPw2, 'password', 'new-password')}
            <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create teacher account'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
