export interface Diagnostic {
  path: string;
  line: number;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: 'javac' | 'python' | 'gcc' | 'node' | 'runtime';
}

const cleanPath = (p: string) => p.replace(/^\.\//, '').replace(/^\/box\//, '').replace(/^.*?\/aegis-run-[^/]+\//, '');

export function parseJavac(out: string): Diagnostic[] {
  const lines = out.replace(/\r\n/g, '\n').split('\n');
  const res: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.+?\.java):(\d+): (error|warning): (.+)$/.exec(lines[i]!);
    if (!m) continue;
    let column: number | null = null;
    // javac prints the source line, then a caret line
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const caret = lines[j]!.indexOf('^');
      if (caret >= 0 && /^\s*\^\s*$/.test(lines[j]!)) {
        column = caret + 1;
        break;
      }
    }
    const path = cleanPath(m[1]!);
    if (path.startsWith('__AegisT')) continue; // harness errors are reported separately
    res.push({ path, line: Number(m[2]), column, endLine: null, endColumn: null, severity: m[3] === 'error' ? 'error' : 'warning', message: m[4]!, source: 'javac' });
  }
  return res;
}

export function parsePython(out: string): Diagnostic[] {
  const res: Diagnostic[] = [];
  const re = /File "(.+?)", line (\d+)/g;
  let m: RegExpExecArray | null;
  let last: { path: string; line: number } | null = null;
  while ((m = re.exec(out))) {
    const path = cleanPath(m[1]!);
    if (path.startsWith('<') || path.startsWith('__aegis')) continue;
    last = { path, line: Number(m[2]) };
  }
  if (!last) return res;
  const msgLine = out.trim().split('\n').filter(Boolean).pop() ?? 'Error';
  const caretLine = out.split('\n').find((l) => /^\s*\^+\s*$/.test(l));
  res.push({
    path: last.path,
    line: last.line,
    column: caretLine ? caretLine.indexOf('^') - 3 > 0 ? caretLine.indexOf('^') - 3 : 1 : null,
    endLine: null,
    endColumn: null,
    severity: 'error',
    message: msgLine.replace(/^.*py_compile\.PyCompileError:\s*/, ''),
    source: 'python',
  });
  return res;
}

/** gcc / g++: `main.c:4:5: error: expected ';' before 'return'` */
export function parseGcc(out: string): Diagnostic[] {
  const res: Diagnostic[] = [];
  for (const l of out.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^(.+?\.(?:c|cc|cpp|h|hpp)):(\d+):(\d+): (fatal error|error|warning): (.+)$/.exec(l);
    if (!m) continue;
    const path = cleanPath(m[1]!);
    if (path.startsWith('__aegis')) continue;
    res.push({ path, line: Number(m[2]), column: Number(m[3]), endLine: null, endColumn: null, severity: m[4] === 'warning' ? 'warning' : 'error', message: m[5]!, source: 'gcc' });
  }
  return res;
}

/** node --check / runtime stack: `main.js:3` + `SyntaxError: ...`, or `at ... (main.js:3:5)` */
export function parseNode(out: string): Diagnostic[] {
  const text = out.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const msg = lines.find((l) => /^\w*Error\b/.test(l.trim()))?.trim() ?? lines.filter(Boolean).pop() ?? 'Error';
  let hit: { path: string; line: number; column: number | null } | null = null;
  const head = /^(.+?\.js):(\d+)$/m.exec(text);
  if (head) hit = { path: cleanPath(head[1]!), line: Number(head[2]), column: null };
  if (!hit) {
    const at = /\(?([^\s()]+?\.js):(\d+):(\d+)\)?/.exec(text);
    if (at) hit = { path: cleanPath(at[1]!), line: Number(at[2]), column: Number(at[3]) };
  }
  if (!hit || hit.path.startsWith('__aegis') || hit.path.startsWith('node:')) return [];
  return [{ path: hit.path, line: hit.line, column: hit.column, endLine: null, endColumn: null, severity: 'error', message: msg, source: 'node' }];
}

export function parseDiagnostics(lang: string, out: string): Diagnostic[] {
  if (lang === 'java') return parseJavac(out);
  if (lang === 'python') return parsePython(out);
  if (lang === 'c' || lang === 'cpp') return parseGcc(out);
  if (lang === 'javascript') return parseNode(out);
  return [];
}
