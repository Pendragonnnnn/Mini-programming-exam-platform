import crypto from 'node:crypto';
import type { ChoiceSpec, QuestionSpec } from './runner';
import { normChoice } from './questions';

/** What a student sends for a non-code question. */
export interface ChoiceResponse {
  selected?: string[];
  text?: string;
}

const normText = (s: string, caseSensitive: boolean) => {
  const t = s.normalize('NFC').trim().replace(/\s+/g, ' ');
  return caseSensitive ? t : t.toLowerCase();
};

export function isAnswered(spec: QuestionSpec, r: ChoiceResponse | null | undefined): boolean {
  if (!r) return false;
  if (spec.type === 'short_answer') return !!r.text?.trim();
  return (r.selected?.length ?? 0) > 0;
}

/**
 * Automatic score for a non-code answer.
 * - one-answer / true-false: full points when the chosen option is correct.
 * - multiple answers: all-or-nothing, or with partial credit (correct picks minus wrong picks).
 * - short answer: full points when the text matches an accepted answer; otherwise 0 and the teacher reviews it.
 */
export function scoreChoice(spec: QuestionSpec, r: ChoiceResponse | null | undefined, points: number): { score: number; correct: boolean; needsReview: boolean } {
  const c = normChoice(spec.choice);
  if (spec.type === 'short_answer') {
    const text = r?.text ?? '';
    const ok = !!text.trim() && c.acceptedAnswers.some((a) => normText(a, c.caseSensitive) === normText(text, c.caseSensitive));
    return { score: ok ? points : 0, correct: ok, needsReview: !ok && !!text.trim() };
  }
  const valid = new Set(c.options.map((o) => o.id));
  const picked = new Set((r?.selected ?? []).filter((id) => valid.has(id)));
  const right = new Set(c.options.filter((o) => o.correct).map((o) => o.id));
  if (spec.type === 'multiple_choice') {
    const hits = [...picked].filter((id) => right.has(id)).length;
    const wrong = picked.size - hits;
    const exact = hits === right.size && wrong === 0;
    if (exact) return { score: points, correct: true, needsReview: false };
    if (!c.partialCredit || right.size === 0) return { score: 0, correct: false, needsReview: false };
    const frac = Math.max(0, (hits - wrong) / right.size);
    return { score: Math.round(points * frac), correct: false, needsReview: false };
  }
  // single_choice / true_false
  const ok = picked.size === 1 && right.has([...picked][0]!);
  return { score: ok ? points : 0, correct: ok, needsReview: false };
}

/** Options as a student sees them: no answer key, shuffled per session when the teacher asked for it. */
export function studentOptions(spec: QuestionSpec, seed: string): { id: string; text: string }[] {
  const c: ChoiceSpec = normChoice(spec.choice);
  const opts = c.options.map((o) => ({ id: o.id, text: o.text }));
  if (!c.shuffle || spec.type === 'true_false') return opts;
  const key = (id: string) => crypto.createHash('sha256').update(seed + ':' + id).digest('hex');
  return opts.sort((a, b) => key(a.id).localeCompare(key(b.id)));
}

/** Human-readable answer (teacher grading view, CSV, results). */
export function describeResponse(spec: QuestionSpec, r: ChoiceResponse | null | undefined): string {
  if (!r) return '';
  if (spec.type === 'short_answer') return r.text ?? '';
  const c = normChoice(spec.choice);
  return c.options
    .filter((o) => r.selected?.includes(o.id))
    .map((o) => o.text)
    .join('; ');
}
