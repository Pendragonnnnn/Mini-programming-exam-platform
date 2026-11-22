export type LocalLanguage = 'python' | 'c' | 'cpp';
export type LocalRunKind = 'run' | 'sample_tests';

export interface LocalTestSpec {
  id: string;
  name: string;
  kind: 'stdio' | 'call';
  input: string;
  expected: string;
  matchType: 'exact' | 'token' | 'exception_class' | 'float_tolerance';
  floatTolerance: number;
}

export interface LocalRunRequest {
  language: LocalLanguage;
  kind: LocalRunKind;
  files: Record<string, string>;
  entrypoint: string | null;
  tests: LocalTestSpec[];
  setup: { code: string; target: string } | null;
  timeLimitMs: number;
  memoryLimitMb: number;
}

export interface LocalTestResult {
  name: string;
  outcome: 'pass' | 'fail' | 'error' | 'timeout';
  passed: boolean;
  actual: string;
  message: string;
  timeMs: number | null;
}

export interface LocalRunResult {
  status: 'completed' | 'compile_error' | 'runtime_error' | 'time_limit';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timeMs: number | null;
  tests: LocalTestResult[];
  testsPassed: number;
  testsTotal: number;
  diagnostics: { path: string; line: number; column: number; message: string; source: string }[];
  console: { stream: 'system' | 'stdout' | 'stderr'; text: string; tone?: 'ok' | 'warn' }[];
}

type WorkerMessage =
  | { type: 'ready' | 'compile-start' | 'compile-done' | 'program-start' }
  | { type: 'test-start'; index: number }
  | { type: 'test-result'; index: number; result: LocalTestResult }
  | { type: 'result'; result: LocalRunResult }
  | { type: 'error'; message: string };

function testSummary(tests: LocalTestResult[]) {
  const passed = tests.filter((test) => test.passed).length;
  return {
    tests,
    testsPassed: passed,
    testsTotal: tests.length,
    console: [{ stream: 'system' as const, text: `${passed} of ${tests.length} tests passed.`, tone: passed === tests.length ? 'ok' as const : 'warn' as const }],
  };
}

function failedRemainingTests(request: LocalRunRequest, from: number, message: string): LocalTestResult[] {
  return request.tests.slice(from).map((test) => ({
    name: test.name,
    outcome: 'error',
    passed: false,
    actual: '',
    message,
    timeMs: null,
  }));
}

export function executeLocally(request: LocalRunRequest): Promise<LocalRunResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/localRunner.worker.ts', import.meta.url), { type: 'module' });
    const completedTests: LocalTestResult[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finished = false;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      worker.terminate();
    };

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    const finish = (result: LocalRunResult) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const setTimeoutFor = (ms: number, message: string, testIndex: number | null = null) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (testIndex !== null) {
          const current = request.tests[testIndex];
          const timeoutTest: LocalTestResult = {
            name: current?.name ?? `Test ${testIndex + 1}`,
            outcome: 'timeout',
            passed: false,
            actual: '',
            message: `Time limit exceeded (${request.timeLimitMs} ms)`,
            timeMs: request.timeLimitMs,
          };
          const tests = [...completedTests, timeoutTest, ...failedRemainingTests(request, testIndex + 1, 'Not run after the previous test exceeded its time limit.')];
          finish({
            status: 'completed',
            stdout: '',
            stderr: '',
            exitCode: null,
            timeMs: null,
            diagnostics: [],
            ...testSummary(tests),
          });
          return;
        }

        const tests = request.kind === 'sample_tests' ? failedRemainingTests(request, 0, message) : [];
        finish({
          status: 'time_limit',
          stdout: '',
          stderr: '',
          exitCode: null,
          timeMs: null,
          diagnostics: [],
          ...testSummary(tests),
          console: [{ stream: 'system', text: message, tone: 'warn' }],
        });
      }, ms);
    };

    setTimeoutFor(180_000, 'The browser runtime did not load in time. Check your connection and try again.');
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'ready') {
        setTimeoutFor(90_000, 'The browser compiler did not finish compiling in time.', null);
      } else if (message.type === 'compile-start') {
        setTimeoutFor(90_000, 'The browser compiler did not finish compiling in time.', null);
      } else if (message.type === 'compile-done') {
        if (timer !== null) clearTimeout(timer);
        setTimeoutFor(30_000, 'The browser runner stopped responding.');
      } else if (message.type === 'program-start') {
        setTimeoutFor(request.timeLimitMs + 1000, `Time limit exceeded (${request.timeLimitMs} ms).`, null);
      } else if (message.type === 'test-start') {
        setTimeoutFor(request.timeLimitMs + 1000, 'Sample test timed out.', message.index);
      } else if (message.type === 'test-result') {
        if (timer !== null) clearTimeout(timer);
        completedTests[message.index] = message.result;
        setTimeoutFor(30_000, 'The browser runner stopped responding.', null);
      } else if (message.type === 'result') {
        finish(message.result);
      } else if (message.type === 'error') {
        fail(new Error(message.message));
      }
    };
    worker.onerror = (event) => fail(new Error(event.message || 'The browser code runner failed.'));
    worker.onmessageerror = () => fail(new Error('The browser code runner returned an unreadable result.'));

    try {
      worker.postMessage(request);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }

  });
}
