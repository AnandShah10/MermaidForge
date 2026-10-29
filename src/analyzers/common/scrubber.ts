/**
 * Language-aware "scrubber": replaces comments and string/char literals with
 * spaces (newlines are preserved) so the regex/brace-matching analyzers for
 * languages without a bundled parser don't get fooled by code-looking text
 * inside strings or comments. Output has exactly the same length and line
 * structure as the input, so offsets/lines still line up with the original.
 *
 * This is a lexical pass, not a parser: it is correct for ordinary source,
 * and deliberately simple about the exotic bits (documented per language
 * below). It never throws; on unterminated constructs it blanks to the end.
 */
import { ExtraScrubLanguage, scrubExtra } from './scrubberExtra';

export type ScrubLanguage = 'python' | 'rust' | 'cpp' | 'java' | 'csharp' | 'go' | ExtraScrubLanguage;

function blank(ch: string): string {
  return ch === '\n' || ch === '\r' ? ch : ' ';
}

export interface ScrubOptions {
  /**
   * Python only: keep a `"` at the first and last character of each blanked
   * string literal (interior still blank). Lets callers that split argument
   * lists on the scrubbed text see that a literal argument exists, instead
   * of mistaking it for an empty argument.
   */
  keepStringDelimiters?: boolean;
}

export function scrub(text: string, lang: ScrubLanguage, options: ScrubOptions = {}): string {
  if (lang === 'kotlin' || lang === 'swift' || lang === 'php' || lang === 'ruby') return scrubExtra(text, lang);
  const out: string[] = [];
  const n = text.length;
  let i = 0;

  const blankRange = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(blank(text[k]));
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (lang === 'python') {
      if (ch === '#') {
        let j = i;
        while (j < n && text[j] !== '\n') j++;
        blankRange(i, j);
        i = j;
        continue;
      }
      // String with optional prefix (r, b, u, f, rb, br, fr, rf, case-insensitive).
      const prefix = /^[rRbBuUfF]{1,2}(?=["'])/.exec(text.slice(i, i + 3));
      const start = i + (prefix ? prefix[0].length : 0);
      const q = text[start];
      if ((q === '"' || q === "'") && (prefix || !/[A-Za-z0-9_]/.test(text[i - 1] ?? ' '))) {
        const triple = text.startsWith(q.repeat(3), start);
        const raw = prefix ? /[rR]/.test(prefix[0]) : false;
        let j = start + (triple ? 3 : 1);
        for (; j < n; j++) {
          if (text[j] === '\\' && !raw) {
            j++;
            continue;
          }
          if (triple) {
            if (text.startsWith(q.repeat(3), j)) {
              j += 3;
              break;
            }
          } else if (text[j] === q) {
            j++;
            break;
          } else if (text[j] === '\n') break; // unterminated single-line string
        }
        const end = Math.min(j, n);
        blankRange(i, end);
        if (options.keepStringDelimiters && end - i >= 2) {
          out[out.length - (end - i)] = '"';
          out[out.length - 1] = text[end - 1] === '\n' ? '\n' : '"';
        }
        i = end;
        continue;
      }
      out.push(ch);
      i++;
      continue;
    }

    // C-family comments
    if (ch === '/' && next === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blankRange(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Rust block comments nest; C/C++ do not.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (lang === 'rust' && text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      blankRange(i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }

    if (lang === 'rust') {
      // Raw string r"..." / r#"..."# / br#"..."#
      const raw = /^b?r(#*)"/.exec(text.slice(i, i + 12));
      if (raw && !/[A-Za-z0-9_]/.test(text[i - 1] ?? ' ')) {
        const closer = '"' + raw[1];
        const end = text.indexOf(closer, i + raw[0].length);
        const j = end < 0 ? n : end + closer.length;
        blankRange(i, j);
        i = j;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        j = Math.min(j + 1, n);
        blankRange(i, j);
        i = j;
        continue;
      }
      if (ch === "'") {
        // Char literal vs lifetime: 'a' / '\n' are chars; 'a (no closing quote right after) is a lifetime.
        if (next === '\\') {
          let j = i + 2;
          while (j < n && text[j] !== "'" && text[j] !== '\n') j++;
          j = Math.min(j + 1, n);
          blankRange(i, j);
          i = j;
          continue;
        }
        const cp = next !== undefined ? String.fromCodePoint(text.codePointAt(i + 1)!) : '';
        if (cp && text[i + 1 + cp.length] === "'") {
          blankRange(i, i + 2 + cp.length);
          i += 2 + cp.length;
          continue;
        }
      }
      out.push(ch);
      i++;
      continue;
    }

    // C / C++
    if (lang === 'cpp') {
      const rawStr = /^(?:u8|u|U|L)?R"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 24));
      if (rawStr) {
        const closer = ')' + rawStr[1] + '"';
        const end = text.indexOf(closer, i + rawStr[0].length);
        const j = end < 0 ? n : end + closer.length;
        blankRange(i, j);
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'") {
        // A digit separator like 1'000'000 is not a char literal.
        if (ch === "'" && /[0-9a-fA-F]/.test(text[i - 1] ?? '') && /[0-9a-fA-F]/.test(next ?? '')) {
          out.push(ch);
          i++;
          continue;
        }
        let j = i + 1;
        while (j < n && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        j = Math.min(j + 1, n);
        blankRange(i, j);
        i = j;
        continue;
      }
    }
    // Java / C#
    if (lang === 'java' || lang === 'csharp') {
      // Text block (Java) / raw string literal (C# 11): """ ... """
      if (text.startsWith('"""', i)) {
        let j = i + 3;
        while (j < n && !text.startsWith('"""', j)) j += text[j] === '\\' && lang === 'java' ? 2 : 1;
        j = Math.min(j + 3, n);
        blankRange(i, j);
        i = j;
        continue;
      }
      if (lang === 'csharp') {
        // Verbatim (@"..."), interpolated-verbatim ($@"..." / @$"...") — "" is an escaped quote, no backslash escapes.
        const verb = /^(?:\$@|@\$|@)"/.exec(text.slice(i, i + 3));
        if (verb) {
          let j = i + verb[0].length;
          while (j < n) {
            if (text[j] === '"') {
              if (text[j + 1] === '"') {
                j += 2;
                continue;
              }
              j++;
              break;
            }
            j++;
          }
          blankRange(i, Math.min(j, n));
          i = Math.min(j, n);
          continue;
        }
        // Interpolated $"..." — the whole literal is blanked (code inside {} holes is not analysed).
        if (ch === '$' && next === '"') {
          let j = i + 2;
          while (j < n && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
          j = Math.min(j + 1, n);
          blankRange(i, j);
          i = j;
          continue;
        }
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        j = Math.min(j + 1, n);
        blankRange(i, j);
        i = j;
        continue;
      }
    }

    // Go: interpreted strings, raw `strings`, rune literals
    if (lang === 'go') {
      if (ch === '`') {
        const end = text.indexOf('`', i + 1);
        const j = end < 0 ? n : end + 1;
        blankRange(i, j);
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < n && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        j = Math.min(j + 1, n);
        blankRange(i, j);
        i = j;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

/** Index of the `}` matching the `{` at `openIdx` in already-scrubbed text, or text.length if unbalanced. */
export function matchBrace(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Splits on a separator at bracket depth 0 (parens, brackets, braces, and angle brackets when requested). */
export function splitTopLevel(s: string, sep: string, angle = true): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c) || (angle && c === '<')) depth++;
    else if (')]}'.includes(c) || (angle && c === '>' && s[i - 1] !== '-')) depth = Math.max(0, depth - 1);
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim().length) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length);
}

/**
 * Makes a type/parameter string safe inside a Mermaid classDiagram member
 * line: generics use Mermaid's `~T~` syntax, lifetimes and braces are
 * dropped, and tuples/parens become brackets.
 */
export function sanitizeType(raw: string): string {
  return raw
    .replace(/'[A-Za-z_]\w*\s*/g, '')
    .replace(/</g, '~')
    .replace(/>/g, '~')
    .replace(/\(/g, '[')
    .replace(/\)/g, ']')
    .replace(/[{}"`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
