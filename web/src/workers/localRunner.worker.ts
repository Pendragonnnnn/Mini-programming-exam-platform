/// <reference lib="webworker" />

import { loadPyodide, type PyodideInterface } from 'pyodide';
import { CLANG_DRIVER_DEFAULT_ARGS, compilerDiagnostics, createToolchain, type ClangToolchain } from '@live-codes/clang-wasm/toolchain';
import type { LocalRunRequest, LocalRunResult, LocalTestResult, LocalTestSpec } from '../lib/localRunner';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const OUTPUT_LIMIT = 100_000;
const RESULT_MARKER = '__AEGIS_RESULT__';
const EXCEPTION_MARKER = '__AEGIS_EXCEPTION__';

function installNetworkGuard() {
  const nativeFetch = scope.fetch.bind(scope);
  scope.fetch = (input, init = {}) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input : input.url;
    const url = new URL(rawUrl, scope.location.href);
    const allowed = url.origin === scope.location.origin && ['/pyodide/', '/clang/'].some((prefix) => url.pathname.startsWith(prefix));
    if (!allowed) return Promise.reject(new TypeError('Network access is disabled in the local code runner.'));
    return nativeFetch(input, { ...init, credentials: 'omit' });
  };
}

function safePath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe workspace file path: ${path}`);
  }
  return normalized;
}

function boundedText() {
  let value = '';
  let truncated = false;
  return {
    write(chunk: string) {
      const text = String(chunk);
      const remaining = Math.max(0, OUTPUT_LIMIT - value.length);
      if (text.length > remaining) truncated = true;
      value += text.slice(0, remaining);
    },
    get value() {
      return truncated ? `${value}\n[output truncated]` : value;
    },
  };
}

function lines(text: string): { stream: 'stdout' | 'stderr'; text: string }[] {
  return text ? [{ stream: 'stdout', text }] : [];
}

function resultWithTests(tests: LocalTestResult[], stdout = '', stderr = '', timeMs: number | null = null): LocalRunResult {
  const passed = tests.filter((test) => test.passed).length;
  return {
    status: 'completed',
    stdout,
    stderr,
    exitCode: null,
    timeMs,
    tests,
    testsPassed: passed,
    testsTotal: tests.length,
    diagnostics: [],
    console: [{ stream: 'system', text: `${passed} of ${tests.length} tests passed.`, tone: passed === tests.length ? 'ok' : 'warn' }],
  };
}

function makeTestResult(test: LocalTestSpec, actual: string, stderr: string, exitCode: number, timeMs: number): LocalTestResult {
  const norm = (value: string) => value.replace(/\r\n/g, '\n').trim();
  const expected = norm(test.expected);
  const output = norm(actual);
  const clip = (value: string, limit = 300) => (value.length > limit ? `${value.slice(0, limit)}…` : value);
  if (exitCode !== 0) {
    const last = norm(stderr).split('\n').filter(Boolean).pop() ?? `exit code ${exitCode}`;
    return { name: test.name, outcome: 'error', passed: false, actual: output, message: clip(`Program crashed: ${last}`), timeMs };
  }
  if (test.matchType === 'exception_class') {
    return { name: test.name, outcome: 'fail', passed: false, actual: output, message: 'Exception class match is only available for Python call tests.', timeMs };
  }
  let passed = false;
  if (test.matchType === 'exact') passed = output === expected;
  else if (test.matchType === 'token') passed = output.split(/\s+/).join(' ') === expected.split(/\s+/).join(' ');
  else if (test.matchType === 'float_tolerance') {
    const actualNumber = Number(output);
    const expectedNumber = Number(expected);
    passed = Number.isFinite(actualNumber) && Number.isFinite(expectedNumber) && Math.abs(actualNumber - expectedNumber) <= (test.floatTolerance || 0.01) + 1e-12;
  }
  return {
    name: test.name,
    outcome: passed ? 'pass' : 'fail',
    passed,
    actual: output,
    message: passed ? `Output matched: ${clip(test.expected, 120)}` : clip(`Expected ${expected} but was ${output || '(no output)'}`),
    timeMs,
  };
}

function parseHarnessOutput(output: string): { kind: 'result'; value: string } | { kind: 'exception'; cls: string; msg: string } | { kind: 'none' } {
  const resultLines = output.replace(/\r\n/g, '\n').split('\n');
  for (let index = resultLines.length - 1; index >= 0; index--) {
    const line = resultLines[index]!;
    if (line.startsWith(RESULT_MARKER)) return { kind: 'result', value: line.slice(RESULT_MARKER.length) };
    if (line.startsWith(EXCEPTION_MARKER)) {
      const rest = line.slice(EXCEPTION_MARKER.length);
      const separator = rest.indexOf('|');
      return { kind: 'exception', cls: separator < 0 ? rest : rest.slice(0, separator), msg: separator < 0 ? '' : rest.slice(separator + 1) };
    }
  }
  return { kind: 'none' };
}

function evaluatePythonCall(test: LocalTestSpec, output: string, stderr: string, exitCode: number, timeMs: number): LocalTestResult {
  const norm = (value: string) => value.replace(/\r\n/g, '\n').trim();
  const clip = (value: string, limit = 300) => (value.length > limit ? `${value.slice(0, limit)}…` : value);
  if (exitCode !== 0) {
    const last = norm(stderr).split('\n').filter(Boolean).pop() ?? `exit code ${exitCode}`;
    return { name: test.name, outcome: 'error', passed: false, actual: '', message: clip(`Test could not finish: ${last}`), timeMs };
  }
  const harness = parseHarnessOutput(output);
  if (harness.kind === 'none') {
    return { name: test.name, outcome: 'error', passed: false, actual: '', message: 'Test produced no result (did the program exit early?)', timeMs };
  }
  if (test.matchType === 'exception_class') {
    if (harness.kind === 'exception') {
      const allowed = norm(test.expected).split('|').map((item) => item.trim()).filter(Boolean);
      const passed = allowed.includes(harness.cls);
      return {
        name: test.name,
        outcome: passed ? 'pass' : 'fail',
        passed,
        actual: harness.cls,
        message: passed ? `${harness.cls} thrown as expected` : clip(`Expected ${allowed.join(' or ')} but ${harness.cls} was thrown: ${harness.msg}`),
        timeMs,
      };
    }
    const expected = norm(test.expected).split('|').map((item) => item.trim()).filter(Boolean).join(' or ');
    return { name: test.name, outcome: 'fail', passed: false, actual: harness.value, message: clip(`Expected ${expected} to be thrown, but ${harness.value === '<void>' ? 'the call returned normally' : `returned ${harness.value} instead`}.`), timeMs };
  }
  if (harness.kind === 'exception') {
    return { name: test.name, outcome: 'fail', passed: false, actual: harness.cls, message: clip(`Expected ${norm(test.expected)} but ${harness.cls} was thrown: ${harness.msg}`), timeMs };
  }
  const outputValue = norm(harness.value);
  const expected = norm(test.expected);
  let passed = false;
  if (test.matchType === 'exact') passed = outputValue === expected;
  else if (test.matchType === 'token') passed = outputValue.split(/\s+/).join(' ') === expected.split(/\s+/).join(' ');
  else if (test.matchType === 'float_tolerance') {
    const actualNumber = Number(outputValue);
    const expectedNumber = Number(expected);
    passed = Number.isFinite(actualNumber) && Number.isFinite(expectedNumber) && Math.abs(actualNumber - expectedNumber) <= (test.floatTolerance || 0.01) + 1e-12;
  }
  return {
    name: test.name,
    outcome: passed ? 'pass' : 'fail',
    passed,
    actual: outputValue,
    message: passed ? `Expected ${expected}, actual ${outputValue}` : clip(`Expected ${expected} but was ${outputValue}`),
    timeMs,
  };
}

function pythonEntry(files: Record<string, string>, preferred: string | null): string | null {
  const paths = Object.keys(files).filter((path) => path.endsWith('.py'));
  if (preferred && paths.includes(preferred)) return preferred;
  if (paths.includes('main.py')) return 'main.py';
  return paths.sort()[0] ?? null;
}

function pythonModuleNames(files: Record<string, string>): string[] {
  return [...new Set(Object.keys(files)
    .filter((path) => path.endsWith('.py'))
    .map((path) => path.replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').filter(Boolean).join('.'))
    .filter(Boolean))];
}

function cEntry(files: Record<string, string>, language: 'c' | 'cpp', preferred: string | null): string | null {
  const isSource = (path: string) => (language === 'c' ? path.endsWith('.c') : path.endsWith('.cpp') || path.endsWith('.cc'));
  const paths = Object.keys(files).filter(isSource).sort();
  if (preferred && paths.includes(preferred)) return preferred;
  return paths.find((path) => /(^|\/)main\.(c|cpp|cc)$/.test(path)) ?? paths[0] ?? null;
}

function pythonScriptForProgram(): string {
  return `
import io, runpy, sys, traceback
for __module in __modules:
    for __loaded in tuple(sys.modules):
        if __loaded == __module or __loaded.startswith(__module + "."):
            sys.modules.pop(__loaded, None)
class __AegisCapture:
    encoding = "utf-8"
    def __init__(self):
        self.parts = []
        self.size = 0
        self.truncated = False
    def write(self, text):
        text = str(text)
        remaining = ${OUTPUT_LIMIT} - self.size
        if remaining > 0:
            piece = text[:remaining]
            self.parts.append(piece)
            self.size += len(piece)
        if len(text) > remaining:
            self.truncated = True
        return len(text)
    def flush(self): pass
    def getvalue(self):
        return "".join(self.parts) + ("\\n[output truncated]" if self.truncated else "")
__out, __err = __AegisCapture(), __AegisCapture()
__old = (sys.stdin, sys.stdout, sys.stderr, sys.argv)
sys.stdin, sys.stdout, sys.stderr, sys.argv = io.StringIO(__stdin), __out, __err, [__entry]
__exit = 0
try:
    runpy.run_path(__entry, run_name="__main__")
except SystemExit as __e:
    __exit = __e.code if isinstance(__e.code, int) else (0 if __e.code is None else 1)
except BaseException:
    __exit = 1
    __err.write(traceback.format_exc())
finally:
    sys.stdin, sys.stdout, sys.stderr, sys.argv = __old
{"stdout": __out.getvalue(), "stderr": __err.getvalue(), "exitCode": __exit}
`;
}

function pythonScriptForCall(): string {
  return `
import ast, sys
for __module in __resetModules:
    for __loaded in tuple(sys.modules):
        if __loaded == __module or __loaded.startswith(__module + "."):
            sys.modules.pop(__loaded, None)
class __AegisCapture:
    encoding = "utf-8"
    def __init__(self):
        self.parts = []
        self.size = 0
        self.truncated = False
    def write(self, text):
        text = str(text)
        remaining = ${OUTPUT_LIMIT} - self.size
        if remaining > 0:
            piece = text[:remaining]
            self.parts.append(piece)
            self.size += len(piece)
        if len(text) > remaining:
            self.truncated = True
        return len(text)
    def flush(self): pass
    def getvalue(self):
        return "".join(self.parts) + ("\\n[output truncated]" if self.truncated else "")
__out, __err = __AegisCapture(), __AegisCapture()
__old = (sys.stdout, sys.stderr)
sys.stdout, sys.stderr = __out, __err
__g = {"__name__": "__aegis__"}
try:
    for __m in __modules:
        try:
            exec("from " + __m + " import *", __g)
        except BaseException as __e:
            print(${JSON.stringify(EXCEPTION_MARKER)} + type(__e).__name__ + "|" + str(__e).replace("\\n", " "))
            __g = None
            break
    if __g is not None:
        exec(compile(__setup, "<setup>", "exec"), __g)
        __tree = ast.parse(__source)
        __body = __tree.body
        if __body and isinstance(__body[-1], ast.Expr):
            exec(compile(ast.Module(body=__body[:-1], type_ignores=[]), "<test>", "exec"), __g)
            __r = eval(compile(ast.Expression(body=__body[-1].value), "<test>", "eval"), __g)
            def __fmt(v):
                if v is True: return "true"
                if v is False: return "false"
                if v is None: return "null"
                return str(v)
            print(${JSON.stringify(RESULT_MARKER)} + __fmt(__r))
        else:
            exec(compile(__tree, "<test>", "exec"), __g)
            print(${JSON.stringify(RESULT_MARKER)} + "<void>")
except BaseException as __e:
    print(${JSON.stringify(EXCEPTION_MARKER)} + type(__e).__name__ + "|" + str(__e).replace("\\n", " "))
finally:
    sys.stdout, sys.stderr = __old
{"stdout": __out.getvalue(), "stderr": __err.getvalue()}
`;
}

function splitStatements(source: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      current += char;
      if (char === '\\') current += source[++index] ?? '';
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if ('([{'.includes(char)) depth++;
    if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ';' || char === '\n')) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function pythonTestInput(input: string): string {
  return input.replace(/\r\n/g, '\n').split('\n').filter((line) => !/^\s*(java|javascript|js|cpp|c)\s*:\s?/.test(line)).map((line) => {
    const match = /^\s*python\s*:\s?(.*)$/.exec(line);
    return match ? match[1]! : line;
  }).join('\n');
}

function bindPythonTarget(statement: string, target: string | null): string {
  if (!target || /^(print|len|str|int|float|list|dict|set|tuple|sorted|sum|min|max|abs|round|range|isinstance|type|repr|open|any|all|map|filter|zip|enumerate|bool)\s*\(/.test(statement)) return statement;
  return statement.replace(/^([a-z_][A-Za-z0-9_]*)\s*\(/, (_match, name: string) => `${target}.${name}(`);
}

function pythonCallInput(test: LocalTestSpec, setup: { code: string; target: string } | null, files: Record<string, string>): { source: string; modules: string[] } {
  const target = setup?.code ? setup.target || null : null;
  const source = splitStatements(pythonTestInput(test.input)).map((statement) => bindPythonTarget(statement, target)).join('\n');
  const modules = Object.keys(files)
    .filter((path) => path.endsWith('.py') && !path.includes('/') && path !== 'main.py' && !path.startsWith('__aegis'))
    .map((path) => path.replace(/\.py$/, ''));
  return { source, modules };
}

async function initializePyodide(): Promise<PyodideInterface> {
  installNetworkGuard();
  return loadPyodide({
    indexURL: new URL('/pyodide/', scope.location.href).href,
    jsglobals: Object.create(null),
  });
}

async function runPython(request: LocalRunRequest, pyodide: PyodideInterface): Promise<LocalRunResult> {
  const files = Object.fromEntries(Object.entries(request.files).map(([path, content]) => [safePath(path), content]));
  const pyPaths = Object.keys(files).filter((path) => path.endsWith('.py'));
  const entry = pythonEntry(files, request.entrypoint);
  scope.postMessage({ type: 'compile-start' });
  try {
    for (const [path, content] of Object.entries(files)) {
      const normalized = `/${path}`;
      const directory = normalized.slice(0, normalized.lastIndexOf('/')) || '/';
      pyodide.FS.mkdirTree(directory);
      pyodide.FS.writeFile(normalized, content);
    }
    pyodide.runPython(`import os, sys\nos.chdir("/")\nsys.path.insert(0, "/")`);
    const paths = pyodide.toPy({ __paths: pyPaths });
    try {
      pyodide.runPython(`\nfor __path in __paths:\n    with open(__path, encoding="utf-8") as __file:\n        compile(__file.read(), __path, "exec")\n`, { globals: paths });
    } finally {
      paths.destroy();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tests = request.kind === 'sample_tests' ? request.tests.map((test) => ({ name: test.name, outcome: 'error' as const, passed: false, actual: '', message: 'Compilation failed', timeMs: null })) : [];
    scope.postMessage({ type: 'compile-done' });
    return {
      status: 'compile_error',
      stdout: '',
      stderr: message,
      exitCode: null,
      timeMs: null,
      tests,
      testsPassed: 0,
      testsTotal: tests.length,
      diagnostics: [],
      console: [{ stream: 'stderr', text: message }, { stream: 'system', text: 'Compilation failed.' }],
    };
  }
  scope.postMessage({ type: 'compile-done' });

  if (request.kind === 'run') {
    if (!entry) {
      return {
        status: 'completed',
        stdout: '',
        stderr: '',
        exitCode: 0,
        timeMs: 0,
        tests: [],
        testsPassed: 0,
        testsTotal: 0,
        diagnostics: [],
        console: [{ stream: 'system', text: 'No Python file to run.', tone: 'warn' }],
      };
    }
    scope.postMessage({ type: 'program-start' });
    const start = performance.now();
    const globals = pyodide.toPy({ __entry: entry, __stdin: '', __modules: pythonModuleNames(files) });
    try {
      const value = await pyodide.runPythonAsync(pythonScriptForProgram(), { globals });
      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        result = value.toJs({ dict_converter: Object.fromEntries }) as { stdout: string; stderr: string; exitCode: number };
      } finally {
        value.destroy();
      }
      const elapsed = Math.round(performance.now() - start);
      const status = result.exitCode === 0 ? 'completed' : 'runtime_error';
      const console = [
        { stream: 'system' as const, text: '$ python ' + entry },
        ...lines(result.stdout),
        ...(result.stderr ? [{ stream: 'stderr' as const, text: result.stderr }] : []),
        { stream: 'system' as const, text: `Process finished in ${(elapsed / 1000).toFixed(2)}s · exit code ${result.exitCode}`, tone: status === 'completed' ? 'ok' as const : 'warn' as const },
      ];
      return { status, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timeMs: elapsed, tests: [], testsPassed: 0, testsTotal: 0, diagnostics: [], console };
    } finally {
      globals.destroy();
    }
  }

  const results: LocalTestResult[] = [];
  for (const [index, test] of request.tests.entries()) {
    scope.postMessage({ type: 'test-start', index });
    const started = performance.now();
    let result: LocalTestResult;
    if (test.kind === 'stdio') {
      if (!entry) result = { name: test.name, outcome: 'error', passed: false, actual: '', message: 'No Python file to run for this STDIN test.', timeMs: null };
      else {
        const globals = pyodide.toPy({ __entry: entry, __stdin: test.input, __modules: pythonModuleNames(files) });
        try {
          const value = await pyodide.runPythonAsync(pythonScriptForProgram(), { globals });
          let run: { stdout: string; stderr: string; exitCode: number };
          try {
            run = value.toJs({ dict_converter: Object.fromEntries }) as { stdout: string; stderr: string; exitCode: number };
          } finally {
            value.destroy();
          }
          result = makeTestResult(test, run.stdout, run.stderr, run.exitCode, Math.round(performance.now() - started));
        } finally {
          globals.destroy();
        }
      }
    } else {
      const { source, modules } = pythonCallInput(test, request.setup, files);
      const globals = pyodide.toPy({
        __source: source,
        __setup: request.setup?.code ?? '',
        __modules: modules,
        __resetModules: pythonModuleNames(files),
      });
      try {
        const value = await pyodide.runPythonAsync(pythonScriptForCall(), { globals });
        let output: { stdout: string; stderr: string };
        try {
          output = value.toJs({ dict_converter: Object.fromEntries }) as { stdout: string; stderr: string };
        } finally {
          value.destroy();
        }
        result = evaluatePythonCall(test, output.stdout, output.stderr, 0, Math.round(performance.now() - started));
      } finally {
        globals.destroy();
      }
    }
    results.push(result);
    scope.postMessage({ type: 'test-result', index, result });
  }
  return resultWithTests(results);
}

async function runNative(request: LocalRunRequest): Promise<LocalRunResult> {
  const language = request.language as 'c' | 'cpp';
  const files = Object.fromEntries(Object.entries(request.files).map(([path, content]) => [safePath(path), content]));
  const preferred = request.entrypoint ? safePath(request.entrypoint) : null;
  const entry = cEntry(files, language, preferred);
  if (!entry) {
    const message = language === 'c' ? 'No .c file to compile.' : 'No .cpp file to compile.';
    return {
      status: 'completed',
      stdout: '',
      stderr: '',
      exitCode: 0,
      timeMs: 0,
      tests: [],
      testsPassed: 0,
      testsTotal: 0,
      diagnostics: [],
      console: [{ stream: 'system', text: message, tone: 'warn' }],
    };
  }

  const toolchain: ClangToolchain = await createToolchain({ baseUrl: new URL('/clang/', scope.location.href).href });
  const maxWasmMemoryBytes = Math.max(64, request.memoryLimitMb) * 1024 * 1024;
  const workspaceFiles = Object.entries(files)
    .filter(([path]) => path !== entry)
    .map(([path, content]) => ({ path, content }));
  scope.postMessage({ type: 'ready' });
  scope.postMessage({ type: 'compile-start' });
  try {
    const started = performance.now();
    const compiled = await toolchain.lock(() => toolchain.captureCompilerOutput(() => toolchain.runtime.compileArtifact(files[entry], {
      language: language === 'c' ? 'C' : 'C++',
      fileName: entry,
      activePath: entry,
      workspaceFiles,
      maxWasmMemoryBytes,
      compileArgs: [
        ...CLANG_DRIVER_DEFAULT_ARGS,
        language === 'c' ? '-std=c17' : '-std=c++17',
        '-O2',
        '-Wall',
      ],
    })));
    const compileMs = Math.round(performance.now() - started);
    scope.postMessage({ type: 'compile-done' });
    if (compiled.error || !compiled.result) {
      const diagnostics = compilerDiagnostics(compiled.raw);
      const message = diagnostics.join('\n') || String(compiled.error ?? 'Compilation failed.');
      const tests = request.kind === 'sample_tests' ? request.tests.map((test) => ({ name: test.name, outcome: 'error' as const, passed: false, actual: '', message: 'Compilation failed', timeMs: null })) : [];
      return {
        status: 'compile_error',
        stdout: '',
        stderr: message,
        exitCode: null,
        timeMs: compileMs,
        tests,
        testsPassed: 0,
        testsTotal: tests.length,
        diagnostics: [],
        console: [{ stream: 'stderr', text: message }, { stream: 'system', text: 'Compilation failed.' }],
      };
    }

    const runOnce = async (input: string) => {
      const stdout = boundedText();
      const stderr = boundedText();
      let sent = false;
      const timeStarted = performance.now();
      const execution = await toolchain.execute(compiled.result, {
        args: [],
        maxWasmMemoryBytes,
        stdin: () => sent ? null : (sent = true, input),
        stdout: (chunk) => stdout.write(chunk),
        stderr: (chunk) => stderr.write(chunk),
      });
      return { stdout: stdout.value, stderr: stderr.value, exitCode: execution.exitCode, timeMs: Math.round(performance.now() - timeStarted) };
    };

    if (request.kind === 'run') {
      scope.postMessage({ type: 'program-start' });
      const run = await runOnce('');
      const status = run.exitCode === 0 ? 'completed' : 'runtime_error';
      return {
        status,
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode,
        timeMs: run.timeMs,
        tests: [],
        testsPassed: 0,
        testsTotal: 0,
        diagnostics: [],
        console: [
          { stream: 'system', text: `$ ${language === 'c' ? 'clang' : 'clang++'} ${entry}` },
          ...lines(run.stdout),
          ...(run.stderr ? [{ stream: 'stderr' as const, text: run.stderr }] : []),
          { stream: 'system', text: `Process finished in ${(run.timeMs / 1000).toFixed(2)}s · exit code ${run.exitCode}`, tone: status === 'completed' ? 'ok' : 'warn' },
        ],
      };
    }

    const results: LocalTestResult[] = [];
    for (const [index, test] of request.tests.entries()) {
      scope.postMessage({ type: 'test-start', index });
      if (test.kind !== 'stdio') {
        const result: LocalTestResult = { name: test.name, outcome: 'error', passed: false, actual: '', message: 'Function-call tests are not available for C/C++. Ask your teacher to use STDIN/STDOUT tests.', timeMs: null };
        results.push(result);
        scope.postMessage({ type: 'test-result', index, result });
        continue;
      }
      const run = await runOnce(test.input);
      const result = makeTestResult(test, run.stdout, run.stderr, run.exitCode, run.timeMs);
      results.push(result);
      scope.postMessage({ type: 'test-result', index, result });
    }
    return resultWithTests(results);
  } finally {
    toolchain.dispose();
  }
}

async function execute(request: LocalRunRequest): Promise<LocalRunResult> {
  for (const path of Object.keys(request.files)) safePath(path);
  if (request.language === 'python') {
    const pyodide = await initializePyodide();
    scope.postMessage({ type: 'ready' });
    return runPython(request, pyodide);
  }
  installNetworkGuard();
  return runNative(request);
}

scope.onmessage = async (event: MessageEvent<LocalRunRequest>) => {
  try {
    const request = event.data;
    const result = await execute(request);
    scope.postMessage({ type: 'result', result });
  } catch (error) {
    scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

export {};
