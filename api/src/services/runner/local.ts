import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Driver, ExecJob, ExecResult, ExecRunOut } from './types';

/**
 * DEVELOPMENT ONLY runner: executes code as child processes on this machine with time limits.
 * It is NOT a security sandbox. Production must use RUNNER=judge0 (isolate sandbox, no network).
 */
const MAX_OUT = 64 * 1024;

/** bash: on Windows use Git Bash (install "Git for Windows"), elsewhere the system bash. */
function findBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const tries = [process.env.AEGIS_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  for (const t of tries) if (t && existsSync(t)) return t;
  return 'bash';
}
const BASH = findBash();
/** Windows usually has `python`, not `python3`. */
let PY = 'python3';
if (process.platform === 'win32') {
  try {
    execSync('python3 --version', { stdio: 'ignore' });
  } catch {
    PY = 'python';
  }
}

function run(cmd: string, cwd: string, stdin: string, timeoutMs: number): Promise<ExecRunOut> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(BASH, ['-c', cmd], {
      cwd,
      env: { ...(process.platform === 'win32' ? process.env : {}), PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PY },
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (cur: string, chunk: Buffer) => (cur.length >= MAX_OUT ? cur : (cur + chunk.toString('utf8')).slice(0, MAX_OUT));
    child.stdout.on('data', (d: Buffer) => (stdout = cap(stdout, d)));
    child.stderr.on('data', (d: Buffer) => (stderr = cap(stderr, d)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: timedOut ? null : code, timeMs: Date.now() - started, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e), exitCode: -1, timeMs: Date.now() - started, timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

export const localDriver: Driver = {
  name: 'local',
  async exec(job: ExecJob): Promise<ExecResult> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-run-'));
    try {
      for (const [p, content] of Object.entries(job.files)) {
        const safe = path.normalize(p);
        if (safe.startsWith('..') || path.isAbsolute(safe)) continue;
        const full = path.join(dir, safe);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, 'utf8');
      }
      let compile: ExecResult['compile'] = { ok: true, output: '' };
      if (job.compile) {
        const c = await run(job.compile, dir, '', 60_000);
        compile = { ok: c.exitCode === 0 && !c.timedOut, output: (c.stdout + c.stderr).replaceAll(dir + '/', ''), timedOut: c.timedOut };
        if (!compile.ok) return { compile, runs: [] };
      }
      const runs: ExecRunOut[] = [];
      for (const r of job.runs) {
        const out = await run(r.cmd, dir, r.stdin, r.timeoutMs);
        out.stderr = out.stderr.replaceAll(dir + '/', '');
        runs.push(out);
      }
      return { compile, runs };
    } catch (e) {
      return { compile: { ok: false, output: '' }, runs: [], internalError: String(e) };
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
  async health() {
    const checks: [string, string][] = [
      ['Java', 'javac -version'],
      ['Python 3', `${PY} --version`],
      ['C', 'gcc --version'],
      ['C++', 'g++ --version'],
      ['JavaScript', 'node --version'],
    ];
    const ok: string[] = [];
    const missing: string[] = [];
    for (const [name, cmd] of checks) {
      const r = await run(`${cmd} >/dev/null 2>&1`, os.tmpdir(), '', 10_000);
      (r.exitCode === 0 ? ok : missing).push(name);
    }
    return { ok: ok.length > 0, detail: ok.length ? `Ready: ${ok.join(', ')}${missing.length ? ` · missing: ${missing.join(', ')}` : ''}` : 'No language runtimes installed on the server' };
  },
};
