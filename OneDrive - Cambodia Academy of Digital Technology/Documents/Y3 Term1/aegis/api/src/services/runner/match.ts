import { EXC, RESULT } from './harness';
import type { ExecRunOut, TestSpec } from './types';

export interface TestEval {
  outcome: 'pass' | 'fail' | 'error' | 'timeout';
  actual: string;
  message: string;
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();

function parseHarness(stdout: string): { kind: 'result'; value: string } | { kind: 'exception'; cls: string; msg: string } | { kind: 'none' } {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.startsWith(RESULT)) return { kind: 'result', value: l.slice(RESULT.length) };
    if (l.startsWith(EXC)) {
      const rest = l.slice(EXC.length);
      const bar = rest.indexOf('|');
      return { kind: 'exception', cls: bar < 0 ? rest : rest.slice(0, bar), msg: bar < 0 ? '' : rest.slice(bar + 1) };
    }
  }
  return { kind: 'none' };
}

function compare(actual: string, t: TestSpec): boolean {
  const a = norm(actual);
  const e = norm(t.expected);
  switch (t.matchType) {
    case 'exact':
      return a === e;
    case 'token':
      return a.split(/\s+/).join(' ') === e.split(/\s+/).join(' ');
    case 'float_tolerance': {
      const x = Number(a);
      const y = Number(e);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return Math.abs(x - y) <= (t.floatTolerance || 0.01) + 1e-12;
    }
    case 'exception_class':
      return false; // handled separately
  }
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);

export function evaluateTest(t: TestSpec, run: ExecRunOut | null, timeLimitMs: number): TestEval {
  if (!run) return { outcome: 'error', actual: '', message: 'No program entry point (add a main method / main.py) for this STDIN test.' };
  if (run.timedOut) return { outcome: 'timeout', actual: '', message: `Time limit exceeded (${timeLimitMs} ms)` };

  if (t.kind === 'stdio') {
    const actual = norm(run.stdout);
    if (run.exitCode !== 0 && run.exitCode !== null) {
      const last = norm(run.stderr).split('\n').filter(Boolean).pop() ?? `exit code ${run.exitCode}`;
      return { outcome: 'error', actual, message: clip(`Program crashed: ${last}`) };
    }
    if (t.matchType === 'exception_class') return { outcome: 'fail', actual, message: 'Exception class match is only available for call tests.' };
    return compare(actual, t)
      ? { outcome: 'pass', actual, message: `Output matched: ${clip(t.expected, 120)}` }
      : { outcome: 'fail', actual, message: clip(`Expected ${norm(t.expected)} but was ${actual || '(no output)'}`) };
  }

  const h = parseHarness(run.stdout);
  if (h.kind === 'none') {
    const last = norm(run.stderr).split('\n').filter(Boolean).pop();
    return { outcome: 'error', actual: '', message: clip(last ? `Test could not finish: ${last}` : 'Test produced no result (did the program exit early?)') };
  }
  if (t.matchType === 'exception_class') {
    if (h.kind === 'exception') {
      const allowed = norm(t.expected).split('|').map((x) => x.trim()).filter(Boolean);
      return allowed.includes(h.cls)
        ? { outcome: 'pass', actual: h.cls, message: `${h.cls} thrown as expected` }
        : { outcome: 'fail', actual: h.cls, message: clip(`Expected ${allowed.join(' or ')} but ${h.cls} was thrown: ${h.msg}`) };
    }
    const want = norm(t.expected).split('|').map((x) => x.trim()).filter(Boolean).join(' or ');
    return { outcome: 'fail', actual: h.value, message: clip(`Expected ${want} to be thrown, but ${h.value === '<void>' ? 'the call returned normally' : `returned ${h.value}`} instead.`) };
  }
  if (h.kind === 'exception') {
    return { outcome: 'fail', actual: h.cls, message: clip(`Expected ${norm(t.expected)} but ${h.cls} was thrown: ${h.msg}`) };
  }
  return compare(h.value, t)
    ? { outcome: 'pass', actual: h.value, message: `Expected ${norm(t.expected)}, actual ${h.value}` }
    : { outcome: 'fail', actual: h.value, message: clip(`Expected ${norm(t.expected)} but was ${h.value}`) };
}
