import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pyodideDir = dirname(require.resolve('pyodide/package.json'));
const clangWasmDir = resolve(dirname(require.resolve('@live-codes/clang-wasm')), '..');
const llvmDir = dirname(require.resolve('@wasm-idle/llvm-core/package.json'));
const wasiShimDir = resolve(dirname(require.resolve('@bjorn3/browser_wasi_shim')), '..');
const fflateDir = dirname(require.resolve('fflate/package.json'));
const publicDir = resolve('public');

await mkdir(join(publicDir, 'pyodide'), { recursive: true });
for (const file of ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  await copyFile(join(pyodideDir, file), join(publicDir, 'pyodide', file));
}

await mkdir(join(publicDir, 'licenses'), { recursive: true });
for (const [source, target] of [
  [join(clangWasmDir, 'LICENSE'), 'clang-wasm-LICENSE.txt'],
  [join(clangWasmDir, 'THIRD-PARTY-NOTICES.md'), 'clang-wasm-THIRD-PARTY-NOTICES.md'],
  [join(llvmDir, 'LICENSE.llvm.txt'), 'llvm-LICENSE.txt'],
  [join(llvmDir, 'LICENSE.emscripten.txt'), 'emscripten-LICENSE.txt'],
  [join(wasiShimDir, 'LICENSE-MIT'), 'browser-wasi-LICENSE-MIT.txt'],
  [join(wasiShimDir, 'LICENSE-APACHE'), 'browser-wasi-LICENSE-APACHE.txt'],
  [join(fflateDir, 'LICENSE'), 'fflate-LICENSE.txt'],
]) {
  await copyFile(source, join(publicDir, 'licenses', target));
}

await writeFile(
  join(publicDir, 'licenses', 'pyodide-NOTICE.txt'),
  'Pyodide 314.0.8 is distributed under MPL-2.0. License text and source are available at https://github.com/pyodide/pyodide/blob/main/LICENSE.\n',
);
