import { useEffect, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { create } from 'zustand';
import { ApiError, NetworkError } from '../api/client';
import { Icon } from './Icon';

export const LANGS = ['java', 'python', 'c', 'cpp', 'javascript'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_LABEL: Record<string, string> = { java: 'Java', python: 'Python 3', c: 'C', cpp: 'C++', javascript: 'JavaScript' };
export const LANG_EXTS: Record<string, string[]> = { java: ['.java'], python: ['.py'], c: ['.c', '.h'], cpp: ['.cpp', '.cc', '.h', '.hpp'], javascript: ['.js'] };
export const LANG_ENTRY: Record<string, string> = { java: 'Main.java', python: 'main.py', c: 'main.c', cpp: 'main.cpp', javascript: 'main.js' };
export const LANG_STARTER: Record<string, string> = {
  java: 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        // Write your code here\n    }\n}\n',
  python: '# Write your code here\n',
  c: '#include <stdio.h>\n\nint main(void) {\n    // Write your code here\n    return 0;\n}\n',
  cpp: '#include <iostream>\nusing namespace std;\n\nint main() {\n    // Write your code here\n    return 0;\n}\n',
  javascript: "// Read input with: const input = require('fs').readFileSync(0, 'utf8');\n// Write your code here\n",
};
/** Languages whose tests may call functions directly (others use STDIN/STDOUT tests only). */
export const CALL_TEST_LANGS = new Set(['java', 'python', 'javascript']);
export const langLabel = (l: string) => LANG_LABEL[l] ?? l;
export const langList = (ls: string[]) => ls.map(langLabel).join(', ');

export const QTYPE_LABEL: Record<string, string> = {
  code: 'Coding',
  single_choice: 'Multiple choice',
  multiple_choice: 'Multiple answers',
  true_false: 'True / False',
  short_answer: 'Short answer',
};
export const QTYPES = ['code', 'single_choice', 'multiple_choice', 'true_false', 'short_answer'] as const;
export const DIFF_LABEL: Record<string, string> = { easy: 'Easy', intermediate: 'Intermediate', advanced: 'Advanced' };
export const DIFF_CLS: Record<string, string> = { easy: 'badge b-green', intermediate: 'badge b-amber', advanced: 'badge b-red' };

export function LangBadge({ lang }: { lang: string }) {
  return (
    <span className="badge b-lang">
      <Icon name="code" size={12} />
      {langLabel(lang)}
    </span>
  );
}

export function Avatar({ initials, size = 36, strong = false }: { initials: string; size?: number; strong?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 999,
        fontWeight: 700,
        fontSize: size > 40 ? 14 : 12,
        flex: 'none',
        background: strong ? 'var(--accent)' : 'var(--accent-weak)',
        color: strong ? '#fff' : 'var(--accent-text)',
      }}
    >
      {initials}
    </span>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className={`sw ${on ? 'sw-on' : ''}`} aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, style, small }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; style?: CSSProperties; small?: boolean }) {
  return (
    <div className="seg" role="tablist" style={style}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={`seg-i ${o.value === value ? 'seg-on' : ''}`} style={small ? { height: 28 } : undefined} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="skel" style={{ width: 320, maxWidth: '60vw', height: 28 }} />
          <div className="skel" style={{ width: 440, maxWidth: '70vw', height: 14 }} />
        </div>
        <div className="skel" style={{ width: 160, height: 40 }} />
      </div>
      <div className="card" style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="skel" style={{ width: 200, height: 18 }} />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <div className="skel" style={{ width: 34, height: 34, borderRadius: 999 }} />
            <div className="skel" style={{ flex: 2, height: 14 }} />
            <div className="skel" style={{ flex: 1, height: 14 }} />
          </div>
        ))}
      </div>
      <p className="hint" role="status" style={{ margin: 0, textAlign: 'center' }}>
        {label}…
      </p>
    </div>
  );
}

export function ErrorState({ what, error, onRetry }: { what: string; error: unknown; onRetry?: () => void }) {
  const hint = error instanceof ApiError || error instanceof NetworkError ? error.hint : null;
  const notFound = error instanceof ApiError && error.status === 404;
  const msg =
    error instanceof ApiError && error.status < 500
      ? error.message
      : "The server didn't respond. Check your connection, then try again. Your unsaved work is kept on this device.";
  return (
    <div role="alert" className="card" style={{ padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
      <span className="icon-tile" style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--bad-bg)', color: 'var(--bad)' }}>
        <Icon name="alert" size={24} />
      </span>
      <h2 className="h2">{notFound ? `${what[0]!.toUpperCase()}${what.slice(1)} was not found` : `Couldn't load ${what}`}</h2>
      <p className="sub" style={{ maxWidth: 440, margin: 0 }}>
        {msg}
      </p>
      {onRetry && !notFound && (
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          <Icon name="refresh" />
          Try again
        </button>
      )}
      {hint && <span className="hint mono">{hint}</span>}
    </div>
  );
}

export function EmptyState({ icon = 'clipboard', title, text, action }: { icon?: string; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="card" style={{ padding: '56px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center', borderStyle: 'dashed' }}>
      <span className="icon-tile" style={{ width: 48, height: 48, borderRadius: 14 }}>
        <Icon name={icon} size={24} />
      </span>
      <h2 className="h2">{title}</h2>
      <p className="sub" style={{ maxWidth: 420, margin: 0 }}>
        {text}
      </p>
      {action}
    </div>
  );
}

export function Banner({ tone, children, onClose, action }: { tone: 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode; onClose?: () => void; action?: ReactNode }) {
  const map = {
    ok: ['var(--ok-line)', 'var(--ok-bg)', 'var(--ok)', 'check'],
    warn: ['var(--warn-line)', 'var(--warn-bg)', 'var(--warn)', 'alert'],
    bad: ['var(--bad-line)', 'var(--bad-bg)', 'var(--bad)', 'alert'],
    info: ['var(--accent-line)', 'var(--accent-weak)', 'var(--accent-text)', 'info'],
  }[tone];
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, border: `1px solid ${map[0]}`, background: map[1], color: map[2], fontSize: 13.5 }}>
      <Icon name={map[3]!} size={17} />
      <span style={{ flex: 1 }}>{children}</span>
      {action}
      {onClose && (
        <button type="button" className="icon-btn" style={{ width: 28, height: 28, color: 'inherit' }} aria-label="Dismiss" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

// ---------- toasts ----------
interface Toast {
  id: number;
  tone: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}
const useToasts = create<{ items: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), t.tone === 'bad' ? 8000 : 5000);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export const toast = {
  ok: (text: string) => useToasts.getState().push({ tone: 'ok', text }),
  warn: (text: string) => useToasts.getState().push({ tone: 'warn', text }),
  bad: (text: string) => useToasts.getState().push({ tone: 'bad', text }),
  info: (text: string) => useToasts.getState().push({ tone: 'info', text }),
  error: (e: unknown) => useToasts.getState().push({ tone: 'bad', text: e instanceof Error ? e.message : 'Something went wrong. Try again.' }),
};

export function Toasts() {
  const { items, drop } = useToasts();
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="card" style={{ boxShadow: '0 12px 32px rgba(15,23,42,.18)' }}>
          <Banner tone={t.tone} onClose={() => drop(t.id)}>
            {t.text}
          </Banner>
        </div>
      ))}
    </div>
  );
}

// ---------- time helpers ----------
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 20) return 'now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, opts);
}

export function fmtUtc(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => (n < 10 ? '0' : '') + n;
  return `${M[d.getUTCMonth()]} ${d.getUTCDate()} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function useInterval(fn: () => void, ms: number | null) {
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Icon name="refresh" size={size} style={{ animation: 'spin 1s linear infinite' }} />;
}
