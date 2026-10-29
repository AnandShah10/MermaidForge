/**
 * Scrubbers for Kotlin, Swift, PHP and Ruby: same contract as `scrub` in scrubber.ts — comments and string/char
 * literals become spaces, newlines are kept, and the output has exactly the input's length, so offsets and line
 * numbers still line up. Lexical only; the awkward corners are listed per language.
 */
export type ExtraScrubLanguage = 'kotlin' | 'swift' | 'php' | 'ruby';

const blank = (ch: string): string => (ch === '\n' || ch === '\r' ? ch : ' ');

export function scrubExtra(text: string, lang: ExtraScrubLanguage): string {
  const n = text.length;
  const out: string[] = [];
  const blankTo = (from: number, to: number) => {
    for (let k = from; k < to; k++) out.push(blank(text[k]));
  };
  let i = 0;

  /** End (exclusive) of a `/* ... *\/` comment starting at `at`, nested when `nested`. */
  const blockCommentEnd = (at: number, nested: boolean): number => {
    let depth = 1;
    let j = at + 2;
    while (j < n && depth > 0) {
      if (text[j] === '/' && text[j + 1] === '*' && nested) {
        depth++;
        j += 2;
      } else if (text[j] === '*' && text[j + 1] === '/') {
        depth--;
        j += 2;
      } else j++;
    }
    return Math.min(j, n);
  };
  const lineEnd = (at: number): number => {
    const k = text.indexOf('\n', at);
    return k < 0 ? n : k;
  };
  /** End of a quoted literal starting at `at` (quote char `q`), honouring backslash escapes; `multiline` lets it span lines. */
  const quotedEnd = (at: number, q: string, multiline: boolean): number => {
    let j = at + 1;
    while (j < n && text[j] !== q) {
      if (text[j] === '\\') j++;
      else if (text[j] === '\n' && !multiline) return j;
      j++;
    }
    return Math.min(j + 1, n);
  };

  // ---- PHP: only code between <?php / <?= and ?> counts; inline HTML is blanked. ----
  let inPhp = lang !== 'php';
  // ---- Ruby: pending heredocs, whose bodies start on the line after the opener. ----
  const heredocs: Array<{ tag: string; squiggly: boolean }> = [];

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (lang === 'php' && !inPhp) {
      const open = /^<\?(?:php\b|=)/i.exec(text.slice(i, i + 6));
      if (open) {
        out.push(...text.slice(i, i + open[0].length).split('').map(blank));
        i += open[0].length;
        inPhp = true;
      } else {
        out.push(blank(ch));
        i++;
      }
      continue;
    }

    if (lang === 'ruby' && ch === '\n' && heredocs.length) {
      // Blank the bodies of the heredocs opened on the line that just ended.
      out.push('\n');
      let pos = i + 1;
      for (const h of heredocs) {
        while (pos < n) {
          const e = lineEnd(pos);
          const lineText = text.slice(pos, e);
          const isEnd = (h.squiggly ? lineText.trim() : lineText.replace(/\r$/, '')) === h.tag || lineText.trim() === h.tag;
          blankTo(pos, e);
          pos = e;
          if (pos < n) {
            out.push('\n');
            pos++;
          }
          if (isEnd) break;
        }
      }
      heredocs.length = 0;
      i = pos;
      continue;
    }

    // ---------------- comments ----------------
    if (lang === 'kotlin' || lang === 'swift' || lang === 'php') {
      if (ch === '/' && next === '/') {
        const e = lineEnd(i);
        blankTo(i, e);
        i = e;
        continue;
      }
      if (ch === '/' && next === '*') {
        const e = blockCommentEnd(i, lang !== 'php');
        blankTo(i, e);
        i = e;
        continue;
      }
    }
    if (lang === 'php' && ch === '#' && next !== '[') {
      // `#[Attr]` is an attribute, not a comment.
      const e = lineEnd(i);
      blankTo(i, e);
      i = e;
      continue;
    }
    if (lang === 'php' && ch === '?' && next === '>') {
      out.push('?', '>');
      i += 2;
      inPhp = false;
      continue;
    }
    if (lang === 'ruby') {
      if (ch === '#' && !(text[i - 1] === '$' || text[i - 1] === '?')) {
        const e = lineEnd(i);
        blankTo(i, e);
        i = e;
        continue;
      }
      if (ch === '=' && text.startsWith('=begin', i) && (i === 0 || text[i - 1] === '\n')) {
        const end = text.indexOf('\n=end', i);
        const e = end < 0 ? n : lineEnd(end + 1);
        blankTo(i, e);
        i = e;
        continue;
      }
      if (text.startsWith('__END__', i) && (i === 0 || text[i - 1] === '\n')) {
        blankTo(i, n);
        i = n;
        continue;
      }
    }

    // ---------------- strings ----------------
    if (lang === 'kotlin') {
      if (text.startsWith('"""', i)) {
        const end = text.indexOf('"""', i + 3);
        const e = end < 0 ? n : end + 3;
        blankTo(i, e);
        i = e;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const e = quotedEnd(i, ch, false);
        blankTo(i, e);
        i = e;
        continue;
      }
    }
    if (lang === 'swift') {
      // Raw strings: #"..."#, ##"..."## (backslash is literal unless followed by the same hashes).
      const raw = /^(#+)"/.exec(text.slice(i, i + 12));
      if (raw) {
        const hashes = raw[1];
        const multi = text.startsWith('"""', i + hashes.length);
        const close = (multi ? '"""' : '"') + hashes;
        const end = text.indexOf(close, i + hashes.length + (multi ? 3 : 1));
        const e = end < 0 ? n : end + close.length;
        blankTo(i, e);
        i = e;
        continue;
      }
      if (text.startsWith('"""', i)) {
        let j = i + 3;
        while (j < n && !text.startsWith('"""', j)) j += text[j] === '\\' ? 2 : 1;
        const e = Math.min(j + 3, n);
        blankTo(i, e);
        i = e;
        continue;
      }
      if (ch === '"') {
        const e = quotedEnd(i, '"', false);
        blankTo(i, e);
        i = e;
        continue;
      }
    }
    if (lang === 'php') {
      if (ch === '<' && text.startsWith('<<<', i)) {
        // Heredoc / nowdoc: <<<TAG ... TAG;
        const m = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1[ \t]*\r?\n/.exec(text.slice(i, i + 80));
        if (m) {
          const bodyStart = i + m[0].length;
          const re = new RegExp(`^[ \\t]*${m[2]}\\b`, 'm');
          const rest = text.slice(bodyStart);
          const hit = re.exec(rest);
          const e = hit ? bodyStart + hit.index + hit[0].length : n;
          blankTo(i, e);
          i = e;
          continue;
        }
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const e = quotedEnd(i, ch, true);
        blankTo(i, e);
        i = e;
        continue;
      }
    }
    if (lang === 'ruby') {
      // Heredoc opener: <<~TAG, <<-TAG, <<TAG (the opener stays; the body is blanked at the next newline).
      const hd = /^<<([~-]?)(["'`]?)([A-Z_][A-Z0-9_]*)\2/.exec(text.slice(i, i + 40));
      if (hd) {
        // `<<~TAG` / `<<-TAG` always open a heredoc; a bare `<<TAG` only after `=`, `(`, `,`, `return` or at line start
        // (otherwise it is `list << CONSTANT`).
        const before = text.slice(Math.max(0, i - 40), i).replace(/[ \t]+$/, '');
        const opens = hd[1] !== '' || before === '' || /(?:[=(,]|\breturn|\n)$/.test(before);
        if (opens) {
          heredocs.push({ tag: hd[3], squiggly: hd[1] !== '' });
          out.push(...text.slice(i, i + hd[0].length).split(''));
          i += hd[0].length;
          continue;
        }
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        const e = quotedEnd(i, ch, true);
        blankTo(i, e);
        i = e;
        continue;
      }
      // %w[a b], %i[..], %q(..), %Q(..), %(..): paired or identical delimiters.
      const pct = /^%([wWiIqQrsx]?)([[({<|!/])/.exec(text.slice(i, i + 3));
      if (pct && !/[\w)\]}]\s*$/.test(text.slice(Math.max(0, i - 3), i))) {
        const open = pct[2];
        const close = ({ '[': ']', '(': ')', '{': '}', '<': '>' } as Record<string, string>)[open] ?? open;
        let depth = 1;
        let j = i + pct[0].length;
        while (j < n && depth > 0) {
          if (text[j] === '\\') j++;
          else if (text[j] === close && (--depth) === 0) break;
          else if (text[j] === open && open !== close) depth++;
          j++;
        }
        const e = Math.min(j + 1, n);
        blankTo(i, e);
        i = e;
        continue;
      }
      // Character literal ?a is rare; symbols like :"foo" start with a quote after a colon and are handled by the quote branch.
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}
