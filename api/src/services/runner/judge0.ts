import AdmZip from 'adm-zip';
import { config } from '../../config';
import { shellQuote } from './harness';
import type { Driver, ExecJob, ExecResult, ExecRunOut } from './types';

/**
 * Production runner: Judge0 CE "Multi-file program" (language id JUDGE0_LANG_MULTIFILE, default 89).
 * One Judge0 submission per run: a zip with the files, a `compile` script and a `run` script that executes
 * every test command in sequence and prints delimited results.
 */

const headers = () => ({
  'Content-Type': 'application/json',
  ...(config.judge0Token ? { 'X-Auth-Token': config.judge0Token } : {}),
});

const unb64 = (s: string | null | undefined) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

function buildZip(job: ExecJob): string {
  const zip = new AdmZip();
  for (const [p, c] of Object.entries(job.files)) zip.addFile(p, Buffer.from(c, 'utf8'));
  job.runs.forEach((r, i) => zip.addFile(`__stdin_${i}.txt`, Buffer.from(r.stdin, 'utf8')));
  zip.addFile('compile', Buffer.from(`#!/bin/bash\n${job.compile ?? 'true'}\n`, 'utf8'));
  const lines = ['#!/bin/bash'];
  job.runs.forEach((r, i) => {
    const sec = Math.max(1, Math.ceil(r.timeoutMs / 1000));
    lines.push(
      `echo "__AEGIS_BEGIN_${i}__"`,
      `__s=$(date +%s%N)`,
      `timeout -s KILL ${sec} bash -c ${shellQuote(r.cmd)} < __stdin_${i}.txt 2> __err_${i}.txt`,
      `__c=$?`,
      `__e=$(date +%s%N)`,
      `echo ""`,
      `echo "__AEGIS_END_${i}__ $__c $(( (__e-__s)/1000000 ))"`,
      `echo "__AEGIS_ERR_${i}__"; head -c 65536 __err_${i}.txt; echo ""; echo "__AEGIS_ERREND_${i}__"`,
    );
  });
  zip.addFile('run', Buffer.from(lines.join('\n') + '\n', 'utf8'));
  return zip.toBuffer().toString('base64');
}

function parseRuns(stdout: string, job: ExecJob): ExecRunOut[] {
  return job.runs.map((r, i) => {
    const begin = stdout.indexOf(`__AEGIS_BEGIN_${i}__\n`);
    const endRe = new RegExp(`__AEGIS_END_${i}__ (\\d+) (\\d+)`);
    const endM = endRe.exec(stdout);
    if (begin < 0 || !endM) return { stdout: '', stderr: '', exitCode: null, timeMs: r.timeoutMs, timedOut: true };
    const out = stdout.slice(begin + `__AEGIS_BEGIN_${i}__\n`.length, endM.index).replace(/\n$/, '');
    const errStart = stdout.indexOf(`__AEGIS_ERR_${i}__\n`);
    const errEnd = stdout.indexOf(`__AEGIS_ERREND_${i}__`);
    const err = errStart >= 0 && errEnd > errStart ? stdout.slice(errStart + `__AEGIS_ERR_${i}__\n`.length, errEnd).replace(/\n$/, '') : '';
    const code = Number(endM[1]);
    return { stdout: out, stderr: err, exitCode: code === 137 ? null : code, timeMs: Number(endM[2]), timedOut: code === 137 };
  });
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export const judge0Driver: Driver = {
  name: 'judge0',
  async exec(job: ExecJob): Promise<ExecResult> {
    const totalSec = job.runs.reduce((a, r) => a + r.timeoutMs / 1000, 0) + 5;
    const body = {
      language_id: config.judge0MultiFileLang,
      additional_files: buildZip(job),
      cpu_time_limit: Math.min(15, Math.ceil(totalSec)),
      wall_time_limit: Math.min(20, Math.ceil(totalSec * 1.5)),
      memory_limit: Math.max(job.memoryMb, 256) * 1024 + 256 * 1024,
      max_processes_and_or_threads: 64,
      enable_network: false,
      max_file_size: 1024,
    };
    try {
      const res = await fetch(`${config.judge0Url}/submissions?base64_encoded=true&wait=false`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
      if (!res.ok) return { compile: { ok: false, output: '' }, runs: [], internalError: `Judge0 ${res.status}: ${await res.text()}` };
      const { token } = (await res.json()) as { token: string };
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await sleep(500);
        const r = await fetch(`${config.judge0Url}/submissions/${token}?base64_encoded=true&fields=status,stdout,stderr,compile_output,time,memory,exit_code,message`, { headers: headers() });
        if (!r.ok) continue;
        const s = (await r.json()) as any;
        const id = s.status?.id as number;
        if (id === 1 || id === 2) continue;
        const compileOut = unb64(s.compile_output);
        if (id === 6) return { compile: { ok: false, output: compileOut }, runs: [] };
        if (id === 13 || id === 14) return { compile: { ok: true, output: compileOut }, runs: [], internalError: s.message ?? 'Judge0 internal error' };
        // Any other status: the run script itself finished (or was cut by the overall limit); parse what we have.
        return { compile: { ok: true, output: compileOut }, runs: parseRuns(unb64(s.stdout), job) };
      }
      return { compile: { ok: true, output: '' }, runs: [], internalError: 'The runner took too long.' };
    } catch (e) {
      return { compile: { ok: false, output: '' }, runs: [], internalError: `Judge0 unreachable: ${String(e)}` };
    }
  },
  async health() {
    try {
      const r = await fetch(`${config.judge0Url}/about`, { headers: headers(), signal: AbortSignal.timeout(3000) });
      return { ok: r.ok, detail: r.ok ? 'Judge0 sandbox ready' : `Judge0 returned ${r.status}` };
    } catch {
      return { ok: false, detail: 'Code runner unavailable. Tell your invigilator.' };
    }
  },
};
