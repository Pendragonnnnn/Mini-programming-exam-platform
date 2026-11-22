declare module '@live-codes/clang-wasm/toolchain' {
  export interface ClangArtifact {}

  export interface ClangToolchain {
    runtime: {
      compileArtifact(
        code: string,
        options: {
          language: 'C' | 'C++';
          fileName: string;
          activePath: string;
          workspaceFiles: { path: string; content: string }[];
          compileArgs: string[];
          maxWasmMemoryBytes: number;
        },
      ): Promise<ClangArtifact>;
    };
    lock<T>(work: () => Promise<T>): Promise<T>;
    captureCompilerOutput<T>(work: () => Promise<T>): Promise<{ result: T; raw: string; error: Error | null }>;
    execute(
      artifact: ClangArtifact,
      options: {
        args: string[];
        maxWasmMemoryBytes: number;
        stdin: () => string | Uint8Array | null;
        stdout: (chunk: string) => void;
        stderr: (chunk: string) => void;
      },
    ): Promise<{ exitCode: number }>;
    dispose(): void;
  }

  export const CLANG_DRIVER_DEFAULT_ARGS: readonly string[];
  export function compilerDiagnostics(raw: string): string[];
  export function createToolchain(options: { baseUrl: string }): Promise<ClangToolchain>;
}
