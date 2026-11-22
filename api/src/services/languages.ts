import type { Lang } from './runner/types';

/** Every programming language a coding question can use. */
export const ENABLED_LANGS: Lang[] = ['java', 'python', 'c', 'cpp', 'javascript'];

export interface LangInfo {
  id: Lang;
  label: string;
  /** File extensions a source file of this language may have. */
  exts: string[];
  /** Default entry file created for a new question. */
  entry: string;
  /** Can tests call functions directly (harness), or only feed STDIN? */
  callTests: boolean;
  starter: string;
}

export const LANGS: Record<Lang, LangInfo> = {
  java: {
    id: 'java',
    label: 'Java',
    exts: ['.java'],
    entry: 'Main.java',
    callTests: true,
    starter: 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        // Write your code here\n    }\n}\n',
  },
  python: {
    id: 'python',
    label: 'Python 3',
    exts: ['.py'],
    entry: 'main.py',
    callTests: true,
    starter: '# Write your code here\n',
  },
  c: {
    id: 'c',
    label: 'C (GCC)',
    exts: ['.c', '.h'],
    entry: 'main.c',
    callTests: false,
    starter: '#include <stdio.h>\n\nint main(void) {\n    // Write your code here\n    return 0;\n}\n',
  },
  cpp: {
    id: 'cpp',
    label: 'C++ (G++)',
    exts: ['.cpp', '.cc', '.h', '.hpp'],
    entry: 'main.cpp',
    callTests: false,
    starter: '#include <iostream>\nusing namespace std;\n\nint main() {\n    // Write your code here\n    return 0;\n}\n',
  },
  javascript: {
    id: 'javascript',
    label: 'JavaScript (Node.js)',
    exts: ['.js'],
    entry: 'main.js',
    callTests: true,
    starter: "// Read input with: const input = require('fs').readFileSync(0, 'utf8');\n// Write your code here\n",
  },
};

export const LANG_LABEL: Record<string, string> = Object.fromEntries(ENABLED_LANGS.map((l) => [l, LANGS[l].label]));
export const langLabel = (l: string) => LANG_LABEL[l] ?? l;
