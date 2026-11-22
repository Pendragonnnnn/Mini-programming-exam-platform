export type Lang = 'java' | 'python' | 'c' | 'cpp' | 'javascript';
export type QuestionType = 'code' | 'single_choice' | 'multiple_choice' | 'true_false' | 'short_answer';

/** Options and answer key for non-code questions. Never sent to students as-is. */
export interface ChoiceSpec {
  options: { id: string; text: string; correct: boolean }[];
  shuffle: boolean;
  partialCredit: boolean;
  acceptedAnswers: string[];
  caseSensitive: boolean;
  explanation: string;
}
export type FileMap = Record<string, string>;

export interface TestSpec {
  id: string;
  name: string;
  kind: 'stdio' | 'call';
  input: string;
  expected: string;
  matchType: 'exact' | 'token' | 'exception_class' | 'float_tolerance';
  floatTolerance: number;
  weight: number;
  hidden: boolean;
  sortOrder: number;
}

export interface StarterFileSpec {
  path: string;
  content: string;
  readOnly: boolean;
  isEntrypoint: boolean;
}

/** Frozen question definition (exam snapshot / bank question). */
export interface QuestionSpec {
  /** Missing on snapshots made before question types existed: treat as 'code'. */
  type?: QuestionType;
  choice?: ChoiceSpec;
  title: string;
  topic: string | null;
  difficulty: 'easy' | 'intermediate' | 'advanced';
  instructionsMd: string;
  points: number;
  limits: { timeLimitMs: number; memoryLimitMb: number };
  languages: Lang[];
  files: Partial<Record<Lang, { starter: StarterFileSpec[]; reference: { path: string; content: string }[] }>>;
  setup: Partial<Record<Lang, { code: string; target: string }>>;
  tests: TestSpec[];
}

/** One sandbox job: write files, compile once, run several commands. */
export interface ExecJob {
  files: FileMap;
  compile: string | null;
  runs: { cmd: string; stdin: string; timeoutMs: number }[];
  memoryMb: number;
}

export interface ExecRunOut {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timeMs: number;
  timedOut: boolean;
}

export interface ExecResult {
  compile: { ok: boolean; output: string; timedOut?: boolean };
  runs: ExecRunOut[];
  internalError?: string;
}

export interface Driver {
  name: string;
  exec(job: ExecJob): Promise<ExecResult>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
