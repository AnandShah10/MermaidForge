import { matchClose } from '../common/routeUtils';

/** Small text helpers shared by the Rust route analyzers. `s` is scrubbed text (strings/comments blank), `code` the comment-stripped original, same offsets. */
export function literal(code: string, a: number, b: number): string | null {
  const m = /^\s*(?:"((?:[^"\\\n]|\\.)*)"|r#*"([^"]*)"#*)\s*$/.exec(code.slice(a, b));
  return m ? (m[1] ?? m[2] ?? '') : null;
}

export function shortText(code: string, a: number, b: number): string {
  const t = code.slice(a, b).replace(/\s+/g, ' ').trim();
  return t.length > 40 ? t.slice(0, 37) + '...' : t;
}

/** Last path segment of `a::b::c` (or the text itself). */
export function lastSegment(t: string): string {
  const m = /([A-Za-z_]\w*)\s*$/.exec(t.replace(/::<[^>]*>/g, ''));
  return m ? m[1] : t;
}

export interface Call {
  name: string;
  open: number;
  close: number;
}

/** Reads `.name(args)` calls following `pos` (a method chain), stopping at the first non-call. */
export function readChain(s: string, pos: number): Call[] {
  const calls: Call[] = [];
  let i = pos;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '.') break;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    const m = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (!m) break;
    const name = m[0];
    i += name.length;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith('::<', i)) {
      let depth = 0;
      let j = i + 2;
      for (; j < s.length; j++) {
        if (s[j] === '<') depth++;
        else if (s[j] === '>' && --depth === 0) break;
      }
      i = j + 1;
      while (i < s.length && /\s/.test(s[i])) i++;
    }
    if (s[i] !== '(') break;
    const close = matchClose(s, i);
    if (close < 0) break;
    calls.push({ name, open: i, close });
    i = close + 1;
  }
  return calls;
}

