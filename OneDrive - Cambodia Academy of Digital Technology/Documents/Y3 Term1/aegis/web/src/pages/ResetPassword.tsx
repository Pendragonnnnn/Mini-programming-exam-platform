import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { Banner } from '../components/ui';

/** Used for both invite links ("set your password") and password resets. */
export function ResetPassword() {
  const [sp] = useSearchParams();
  const token = sp.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<{ purpose: string; fullName: string; role: string; loginId: string } | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/link-info', { query: { token } })
      .then(setInfo)
      .catch((e) => setLinkErr(errorMessage(e)));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (pw.length < 8) return setErr('Use at least 8 characters.');
    if (pw !== pw2) return setErr('The two passwords are not the same.');
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: pw } });
      setDone(true);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const invite = info?.purpose === 'invite';
  return (
    <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, minHeight: '100vh' }}>
      <form className="card" onSubmit={submit} style={{ width: 420, maxWidth: '100%', padding: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h1 className="h1" style={{ fontSize: 22 }}>
          {invite ? 'Set up your account' : 'Choose a new password'}
        </h1>
        {linkErr ? (
          <Banner tone="bad">
            {linkErr} <Link to="/login">Back to sign in</Link>
          </Banner>
        ) : !info ? (
          <span className="hint">Checking your link…</span>
        ) : done ? (
          <Banner tone="ok">
            Password saved. <Link to="/login">Sign in</Link> with <b className="mono">{info.loginId}</b>.
          </Banner>
        ) : (
          <>
            <p className="sub" style={{ margin: 0 }}>
              Hello <b>{info.fullName}</b>. You will sign in with{' '}
              <b className="mono">{info.loginId}</b> on the {info.role === 'teacher' ? 'Teacher' : 'Student'} tab.
            </p>
            {err && <Banner tone="bad">{err}</Banner>}
            <label className="label" htmlFor="np">
              New password (at least 8 characters)
            </label>
            <div className="field">
              <input id="np" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
            </div>
            <label className="label" htmlFor="np2">
              Type it again
            </label>
            <div className="field">
              <input id="np2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
