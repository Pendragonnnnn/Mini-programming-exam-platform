import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { javascript } from '@codemirror/lang-javascript';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { indentWithTab } from '@codemirror/commands';
import { useMemo } from 'react';
import { useTheme } from '../stores/theme';

export interface EditorDiagnostic {
  line: number;
  column: number | null;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

interface Props {
  value: string;
  onChange?: (v: string) => void;
  language: string;
  readOnly?: boolean;
  diagnostics?: EditorDiagnostic[];
  highlightLines?: number[];
  /** Return false to block a paste (exam rule: no paste from outside the editor). */
  onPaste?: (text: string) => boolean;
  onCopy?: (text: string) => void;
  height?: string;
  ariaLabel?: string;
}

export function CodeEditor({ value, onChange, language, readOnly, diagnostics, highlightLines, onPaste, onCopy, height = '100%', ariaLabel }: Props) {
  const theme = useTheme((s) => s.theme);
  const extensions = useMemo(() => {
    const mode = language === 'python' ? python() : language === 'c' || language === 'cpp' ? cpp() : language === 'javascript' ? javascript() : java();
    const ext: Extension[] = [mode, keymap.of([indentWithTab]), EditorState.tabSize.of(4), EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? 'Code editor' })];
    if (readOnly) ext.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    if (diagnostics) {
      ext.push(
        lintGutter(),
        linter(
          (view) => {
            const out: CmDiagnostic[] = [];
            for (const d of diagnostics) {
              if (d.line < 1 || d.line > view.state.doc.lines) continue;
              const line = view.state.doc.line(d.line);
              const from = Math.min(line.to, line.from + Math.max(0, (d.column ?? 1) - 1));
              out.push({ from, to: Math.max(from + 1, line.to), severity: d.severity, message: d.message });
            }
            return out;
          },
          { delay: 0 },
        ),
      );
    }
    if (highlightLines?.length) {
      const lines = new Set(highlightLines);
      ext.push(
        EditorView.decorations.of((view) => {
          const ranges = [];
          for (let i = 1; i <= view.state.doc.lines; i++) if (lines.has(i)) ranges.push(lineHl.range(view.state.doc.line(i).from));
          return Decoration.set(ranges);
        }),
      );
    }
    if (onPaste || onCopy) {
      ext.push(
        EditorView.domEventHandlers({
          paste(e) {
            const text = e.clipboardData?.getData('text/plain') ?? '';
            if (onPaste && !onPaste(text)) {
              e.preventDefault();
              return true;
            }
            return false;
          },
          drop(e) {
            if (onPaste && !onPaste(e.dataTransfer?.getData('text/plain') ?? '')) {
              e.preventDefault();
              return true;
            }
            return false;
          },
          copy(_e, view) {
            onCopy?.(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to));
            return false;
          },
          cut(_e, view) {
            onCopy?.(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to));
            return false;
          },
        }),
      );
    }
    return ext;
  }, [language, readOnly, diagnostics, highlightLines, onPaste, onCopy, ariaLabel]);
  return (
    <CodeMirror
      value={value}
      height={height}
      style={{ height }}
      theme={theme}
      extensions={extensions}
      onChange={readOnly ? undefined : onChange}
      basicSetup={{ foldGutter: false, highlightActiveLine: !readOnly, autocompletion: false, searchKeymap: true }}
    />
  );
}

const lineHl = Decoration.line({ attributes: { style: 'background: var(--ed-hl); box-shadow: inset 3px 0 0 var(--bad);' } });
