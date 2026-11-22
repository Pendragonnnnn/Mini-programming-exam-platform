import type { ExecJob, FileMap, Lang, QuestionSpec, TestSpec } from './types';

/** Python command: python3, or whatever the PY env var says (the local runner sets it to `python` on Windows). */
const PY = '"${PY:-python3}"';

export const RESULT = '__AEGIS_RESULT__';
export const EXC = '__AEGIS_EXCEPTION__';

const PY_BUILTINS = new Set(['print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'sorted', 'sum', 'min', 'max', 'abs', 'round', 'range', 'isinstance', 'type', 'repr', 'open', 'any', 'all', 'map', 'filter', 'zip', 'enumerate', 'bool']);
const JS_SKIP = new Set(['new', 'return', 'throw', 'if', 'for', 'while', 'switch', 'typeof', 'console', 'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'require']);
const JAVA_SKIP = new Set(['new', 'return', 'throw', 'if', 'for', 'while', 'assert', 'switch', 'do', 'try', 'synchronized', 'super', 'this']);

/** Split statements on top-level `;` (and newlines for Python), ignoring strings and brackets. */
export function splitStatements(src: string, lang: Lang): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\') {
        cur += src[++i] ?? '';
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ';' || ch === '\n')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Lines prefixed with `java:`, `python:`, `javascript:` (etc.) apply only to that language, so one test can cover both
 * (e.g. `java: getBalance()` / `python: get_balance()`). Unprefixed lines apply to every language.
 */
export function inputFor(lang: Lang, input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => {
      const m = /^\s*(java|python|javascript|js|cpp|c)\s*:\s?(.*)$/.exec(l);
      if (!m) return l;
      const tag = m[1] === 'js' ? 'javascript' : m[1];
      return tag === lang ? m[2]! : null;
    })
    .filter((l): l is string => l !== null)
    .join('\n');
}

/** `deposit(5)` -> `account.deposit(5)` when the setup declares a target object. */
export function bindTarget(stmt: string, target: string | null, lang: Lang): string {
  if (!target) return stmt;
  const m = /^([a-z_][A-Za-z0-9_]*)\s*\(/.exec(stmt);
  if (!m) return stmt;
  const name = m[1]!;
  if (lang === 'java' && JAVA_SKIP.has(name)) return stmt;
  if (lang === 'python' && PY_BUILTINS.has(name)) return stmt;
  if (lang === 'javascript' && JS_SKIP.has(name)) return stmt;
  return `${target}.${stmt}`;
}

function javaPackages(files: FileMap): string[] {
  const pk = new Set<string>();
  for (const [p, c] of Object.entries(files)) {
    if (!p.endsWith('.java')) continue;
    const m = /^\s*package\s+([\w.]+)\s*;/m.exec(c);
    if (m) pk.add(m[1]!);
  }
  return [...pk];
}

/** Fully qualified class with `public static void main`. */
export function javaEntrypoint(files: FileMap): string | null {
  const entries = Object.entries(files).filter(([p]) => p.endsWith('.java'));
  // Prefer Main.java
  entries.sort(([a], [b]) => (/(^|\/)Main\.java$/.test(a) ? -1 : /(^|\/)Main\.java$/.test(b) ? 1 : 0));
  for (const [p, c] of entries) {
    if (!/public\s+static\s+void\s+main\s*\(/.test(c)) continue;
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(c)?.[1];
    const cls = /(?:public\s+)?(?:final\s+)?class\s+(\w+)/.exec(c)?.[1] ?? p.split('/').pop()!.replace(/\.java$/, '');
    return pkg ? `${pkg}.${cls}` : cls;
  }
  return null;
}

export function pythonEntrypoint(files: FileMap): string | null {
  const paths = Object.keys(files).filter((p) => p.endsWith('.py'));
  if (paths.includes('main.py')) return 'main.py';
  return paths.sort()[0] ?? null;
}

function javaHarness(i: number, files: FileMap, test: TestSpec, setup: { code: string; target: string } | undefined): string {
  const imports = javaPackages(files).map((p) => `import ${p}.*;`).join('\n');
  const target = setup?.code ? setup.target || null : null;
  const stmts = splitStatements(inputFor('java', test.input), 'java').map((s) => bindTarget(s, target, 'java'));
  const exceptionMode = test.matchType === 'exception_class';
  const last = stmts.length ? stmts[stmts.length - 1]! : null;
  const head = exceptionMode || !last ? stmts : stmts.slice(0, -1);
  const body = [
    setup?.code ?? '',
    ...head.map((s) => s + ';'),
    exceptionMode || !last ? `System.out.println("${RESULT}<void>");` : `Object __r = (${last});\nSystem.out.println("${RESULT}" + String.valueOf(__r));`,
  ].join('\n      ');
  return `${imports}

public class __AegisT${i} {
  public static void main(String[] __args) {
    try {
      ${body}
    } catch (Throwable __t) {
      System.out.println("${EXC}" + __t.getClass().getSimpleName() + "|" + String.valueOf(__t.getMessage()).replace('\\n', ' '));
    }
    System.out.flush();
  }
}
`;
}

function pythonHarness(files: FileMap, test: TestSpec, setup: { code: string; target: string } | undefined): string {
  const modules = Object.keys(files)
    .filter((p) => p.endsWith('.py') && !p.includes('/') && p !== 'main.py' && !p.startsWith('__aegis'))
    .map((p) => p.replace(/\.py$/, ''));
  const target = setup?.code ? setup.target || null : null;
  const src = splitStatements(inputFor('python', test.input), 'python')
    .map((s) => bindTarget(s, target, 'python'))
    .join('\n');
  return `import sys, os, ast, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
__g = {"__name__": "__aegis__"}
def __fmt(v):
    if v is True: return "true"
    if v is False: return "false"
    if v is None: return "null"
    return str(v)
for __m in ${JSON.stringify(modules)}:
    try:
        exec("from " + __m + " import *", __g)
    except BaseException as __e:
        print("${EXC}" + type(__e).__name__ + "|" + str(__e).replace("\\n", " "))
        sys.exit(0)
try:
    exec(compile(${JSON.stringify(setup?.code ?? '')}, "<setup>", "exec"), __g)
    __tree = ast.parse(${JSON.stringify(src)})
    __body = __tree.body
    if __body and isinstance(__body[-1], ast.Expr):
        exec(compile(ast.Module(body=__body[:-1], type_ignores=[]), "<test>", "exec"), __g)
        __r = eval(compile(ast.Expression(body=__body[-1].value), "<test>", "eval"), __g)
        print("${RESULT}" + __fmt(__r))
    else:
        exec(compile(__tree, "<test>", "exec"), __g)
        print("${RESULT}<void>")
except BaseException as __e:
    print("${EXC}" + type(__e).__name__ + "|" + str(__e).replace("\\n", " "))
sys.stdout.flush()
`;
}

export function jsEntrypoint(files: FileMap): string | null {
  const paths = Object.keys(files).filter((p) => p.endsWith('.js') && !p.startsWith('__aegis'));
  for (const pref of ['main.js', 'index.js']) if (paths.includes(pref)) return pref;
  return paths.sort()[0] ?? null;
}

function jsHarness(files: FileMap, test: TestSpec, setup: { code: string; target: string } | undefined, entry: string | null): string {
  // Load every module except the entry file into one shared context, like <script> tags, then run the test.
  const modules = Object.keys(files).filter((p) => p.endsWith('.js') && !p.startsWith('__aegis') && p !== entry);
  const target = setup?.code ? setup.target || null : null;
  const stmts = splitStatements(inputFor('javascript', test.input), 'javascript').map((s) => bindTarget(s, target, 'javascript'));
  const last = stmts.length ? stmts[stmts.length - 1]! : null;
  const head = test.matchType === 'exception_class' || !last ? stmts : stmts.slice(0, -1);
  const tail = test.matchType === 'exception_class' || !last ? null : last;
  return `'use strict';
const vm = require('vm'), fs = require('fs'), path = require('path');
const __fmt = (v) => {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(__fmt).join(', ') + ']';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};
const ctx = vm.createContext({ console, require, process, Buffer, setTimeout, clearTimeout, module: { exports: {} }, exports: {} });
const run = (src, file) => vm.runInContext(src, ctx, { filename: file });
try {
  for (const f of ${JSON.stringify(modules)}) {
    ctx.module = { exports: {} }; ctx.exports = ctx.module.exports;
    run(fs.readFileSync(path.join(__dirname, f), 'utf8'), f);
    const ex = ctx.module.exports;
    if (ex && typeof ex === 'object') for (const k of Object.keys(ex)) if (!(k in ctx)) ctx[k] = ex[k];
    if (typeof ex === 'function' && ex.name && !(ex.name in ctx)) ctx[ex.name] = ex;
  }
  run(${JSON.stringify(setup?.code ?? '')}, '<setup>');
  run(${JSON.stringify(head.map((x) => x + ';').join('\n'))}, '<test>');
  ${tail === null ? `console.log(${JSON.stringify(RESULT + '<void>')});` : `const __r = run(${JSON.stringify('(' + tail + ')')}, '<test>');
  console.log(${JSON.stringify(RESULT)} + __fmt(__r));`}
} catch (e) {
  const name = e && e.constructor && e.constructor.name ? e.constructor.name : 'Error';
  console.log(${JSON.stringify(EXC)} + name + '|' + String(e && e.message !== undefined ? e.message : e).split(String.fromCharCode(10)).join(' '));
}
`;
}

export interface BuiltJob {
  job: ExecJob;
  command: string;
  /** Index into job.runs for each test (same order as `tests`). */
  testRunIndex: number[];
  /** Index of the plain program run, if any. */
  programRunIndex: number | null;
  noEntrypoint: boolean;
}

const JAVA_FLAGS = '-Xss16m -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8';

/**
 * Build the sandbox job for a run.
 * mode "program": run the entrypoint once (stdin optional).
 * mode "tests": run each test (call tests via harness, stdio tests via entrypoint).
 */
export function buildJob(lang: Lang, files: FileMap, spec: QuestionSpec, mode: 'program' | 'tests', tests: TestSpec[], stdin: string | null): BuiltJob {
  const timeoutMs = spec.limits.timeLimitMs;
  const memoryMb = Math.max(64, spec.limits.memoryLimitMb);
  const setup = spec.setup?.[lang];
  const all: FileMap = { ...files };
  const runs: ExecJob['runs'] = [];
  const testRunIndex: number[] = [];
  let programRunIndex: number | null = null;
  let noEntrypoint = false;

  if (lang === 'java') {
    const entry = javaEntrypoint(files);
    const runEntry = (input: string) => {
      runs.push({ cmd: `java ${JAVA_FLAGS} -Xmx${memoryMb}m -cp out ${entry}`, stdin: input, timeoutMs: timeoutMs + 1500 });
      return runs.length - 1;
    };
    if (mode === 'program') {
      if (entry) programRunIndex = runEntry(stdin ?? '');
      else noEntrypoint = true;
    } else {
      tests.forEach((t, i) => {
        if (t.kind === 'stdio') {
          if (entry) testRunIndex.push(runEntry(t.input));
          else testRunIndex.push(-1);
          return;
        }
        all[`__AegisT${i}.java`] = javaHarness(i, files, t, setup);
        runs.push({ cmd: `java ${JAVA_FLAGS} -Xmx${memoryMb}m -cp out __AegisT${i}`, stdin: '', timeoutMs: timeoutMs + 1500 });
        testRunIndex.push(runs.length - 1);
      });
    }
    return {
      job: { files: all, compile: `mkdir -p out && javac -encoding UTF-8 -nowarn -implicit:none -sourcepath __none__ -cp out -d out $(find . -name '*.java')`, runs, memoryMb },
      command: entry ? `$ javac -d out *.java && java ${entry}` : '$ javac -d out *.java',
      testRunIndex,
      programRunIndex,
      noEntrypoint,
    };
  }

  if (lang === 'c' || lang === 'cpp') {
    const isC = lang === 'c';
    const srcGlob = isC ? `$(find . -name '*.c')` : `$(find . -name '*.cpp' -o -name '*.cc')`;
    const compiler = isC ? 'gcc -std=c17' : 'g++ -std=c++17';
    const hasSource = Object.keys(files).some((p) => (isC ? p.endsWith('.c') : p.endsWith('.cpp') || p.endsWith('.cc')));
    const runEntry = (input: string) => {
      runs.push({ cmd: './__aegis_main', stdin: input, timeoutMs: timeoutMs + 500 });
      return runs.length - 1;
    };
    if (mode === 'program') {
      if (hasSource) programRunIndex = runEntry(stdin ?? '');
      else noEntrypoint = true;
    } else {
      tests.forEach((t) => testRunIndex.push(hasSource && t.kind === 'stdio' ? runEntry(t.input) : -1));
    }
    return {
      job: { files: all, compile: hasSource ? `${compiler} -O2 -Wall -o __aegis_main ${srcGlob} -lm` : 'true', runs, memoryMb },
      command: isC ? '$ gcc -std=c17 -O2 -o main *.c && ./main' : '$ g++ -std=c++17 -O2 -o main *.cpp && ./main',
      testRunIndex,
      programRunIndex,
      noEntrypoint,
    };
  }

  if (lang === 'javascript') {
    const entry = jsEntrypoint(files);
    const runEntry = (input: string) => {
      runs.push({ cmd: `node --max-old-space-size=${memoryMb} ${shellQuote(entry!)}`, stdin: input, timeoutMs: timeoutMs + 500 });
      return runs.length - 1;
    };
    if (mode === 'program') {
      if (entry) programRunIndex = runEntry(stdin ?? '');
      else noEntrypoint = true;
    } else {
      tests.forEach((t, i) => {
        if (t.kind === 'stdio') {
          testRunIndex.push(entry ? runEntry(t.input) : -1);
          return;
        }
        // Only a real program file (main.js / index.js) is left out of the shared test context.
        const progFile = ['main.js', 'index.js'].find((p) => p in files) ?? null;
        all[`__aegis_t${i}.js`] = jsHarness(files, t, setup, progFile);
        runs.push({ cmd: `node --max-old-space-size=${memoryMb} __aegis_t${i}.js`, stdin: '', timeoutMs: timeoutMs + 500 });
        testRunIndex.push(runs.length - 1);
      });
    }
    return {
      job: { files: all, compile: `for f in $(find . -name '*.js' ! -name '__aegis_t*'); do node --check "$f" || exit 1; done`, runs, memoryMb },
      command: entry ? `$ node ${entry}` : '$ node',
      testRunIndex,
      programRunIndex,
      noEntrypoint,
    };
  }

  // python
  const entry = pythonEntrypoint(files);
  const runEntry = (input: string) => {
    runs.push({ cmd: `${PY} -X utf8 ${shellQuote(entry!)}`, stdin: input, timeoutMs: timeoutMs + 500 });
    return runs.length - 1;
  };
  if (mode === 'program') {
    if (entry) programRunIndex = runEntry(stdin ?? '');
    else noEntrypoint = true;
  } else {
    tests.forEach((t, i) => {
      if (t.kind === 'stdio') {
        testRunIndex.push(entry ? runEntry(t.input) : -1);
        return;
      }
      all[`__aegis_t${i}.py`] = pythonHarness(files, t, setup);
      runs.push({ cmd: `${PY} -X utf8 __aegis_t${i}.py`, stdin: '', timeoutMs: timeoutMs + 500 });
      testRunIndex.push(runs.length - 1);
    });
  }
  return {
    job: { files: all, compile: `${PY} -m py_compile $(find . -name '*.py' ! -name '__aegis_t*')`, runs, memoryMb },
    command: entry ? `$ python3 ${entry}` : '$ python3',
    testRunIndex,
    programRunIndex,
    noEntrypoint,
  };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
