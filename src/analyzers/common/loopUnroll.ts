import { SourceFileInput } from '../analyzer';
import { matchBrace, scrub, ScrubLanguage } from './scrubber';
import { matchClose, splitArgs } from './routeUtils';

/**
 * Text-level unrolling of loops over literal collections that register routes, for the brace languages:
 *
 *   Go      for _, v := range []string{"a", "b"} { r.Mount("/"+v, h) }
 *   Rust    for (p, h) in [("/a", a), ("/b", b)] { app = app.route(p, get(h)); }   (also `.iter()`, `vec![..]`)
 *   Java    for (String v : List.of("a", "b")) { .. }                              (also Arrays.asList / Set.of / new T[]{..})
 *   C#      foreach (var v in new[] { "a", "b" }) { app.MapGet("/" + v, ..); }
 *   Kotlin  for (v in listOf("a", "b")) { .. }
 *   PHP     foreach (['a', 'b'] as $v) { Route::get("/$v", ..); }
 *
 * The body is repeated once per element with the loop variable replaced by the element's source text. Nothing is
 * executed. Only loops whose body uses the variable and contains a call that looks like route registration are
 * rewritten; at most 50 literal elements; the iterable must be written inline. Anything else is left untouched.
 */
type Lang = 'go' | 'rust' | 'java' | 'csharp' | 'kotlin' | 'php';

const ROUTE_CALL = /\b(?:Handle|HandleFunc|Mount|Route|Group|Get|Post|Put|Delete|Patch|GET|POST|PUT|DELETE|PATCH|route|nest|mount|merge|scope|Map\w+|get|post|put|delete|patch|any|use|Use|Any|Add\w*)\s*\(/;

interface Head {
  names: string[];
  /** [start, end) of the elements text (inside the brackets) in the scrubbed text. */
  elems: [number, number];
  /** Index of the `{` that opens the loop body. */
  open: number;
}

function ws(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** Elements range of a literal collection starting at `i` (after `new T[] {`, `listOf(`, `[`, ...), plus the index after it. */
function literal(s: string, i: number, lang: Lang): { elems: [number, number]; end: number } | null {
  i = ws(s, i);
  const open = (o: number): { elems: [number, number]; end: number } | null => {
    const c = matchClose(s, o);
    return c < 0 ? null : { elems: [o + 1, c], end: c + 1 };
  };
  let m: RegExpExecArray | null;
  const sub = s.slice(i, i + 80);
  if (lang === 'go' && (m = /^\[(?:\d*|\.\.\.)\]\s*[\w.*]+\s*(?=\{)/.exec(sub))) return open(i + m[0].length);
  if (lang === 'rust' && (m = /^vec!\s*(?=\[)/.exec(sub))) return open(i + m[0].length);
  if (lang === 'java' && (m = /^(?:List\.of|Arrays\.asList|Set\.of)\s*(?=\()/.exec(sub))) return open(i + m[0].length);
  if (lang === 'java' && (m = /^new\s+[\w.]+\s*\[\s*\]\s*(?=\{)/.exec(sub))) return open(i + m[0].length);
  if (lang === 'csharp' && (m = /^new\s*\[\s*\]\s*(?=\{)/.exec(sub))) return open(i + m[0].length);
  if (lang === 'csharp' && (m = /^new\s*(?:[\w.]+\s*\[\s*\]|List\s*<[^>]*>\s*(?:\(\s*\))?)?\s*(?=\{|\[)/.exec(sub))) return open(i + m[0].length);
  if (lang === 'kotlin' && (m = /^(?:listOf|arrayOf|setOf|mutableListOf)\s*(?=\()/.exec(sub))) return open(i + m[0].length);
  if (lang === 'php' && (m = /^array\s*(?=\()/.exec(sub))) return open(i + m[0].length);
  if (s[i] === '[' || s[i] === '{') return open(i);
  return null;
}

function parseHead(s: string, kw: number, lang: Lang): Head | null {
  const sub = s.slice(kw, kw + 200);
  let m: RegExpExecArray | null;
  let names: string[];
  let from: number;
  if (lang === 'go') {
    m = /^for\s+(?:_|(\w+))\s*,\s*(\w+)\s*:=\s*range\s+/.exec(sub);
    if (!m || m[1]) return null; // an index variable is used: not a plain value loop
    names = [m[2]];
    from = kw + m[0].length;
  } else if (lang === 'rust') {
    m = /^for\s+&?(\(?[\w&\s,]+\)?)\s+in\s+/.exec(sub);
    if (!m) return null;
    names = m[1].replace(/[()&\s]/g, '').split(',').filter(Boolean);
    from = kw + m[0].length;
  } else if (lang === 'java') {
    m = /^for\s*\(\s*(?:final\s+)?[\w.<>\[\]]+\s+(\w+)\s*:\s*/.exec(sub);
    if (!m) return null;
    names = [m[1]];
    from = kw + m[0].length;
  } else if (lang === 'csharp') {
    m = /^foreach\s*\(\s*(?:var|[\w.<>\[\]]+)\s+(\w+)\s+in\s+/.exec(sub);
    if (!m) return null;
    names = [m[1]];
    from = kw + m[0].length;
  } else if (lang === 'kotlin') {
    m = /^for\s*\(\s*(\w+)\s+in\s+/.exec(sub);
    if (!m) return null;
    names = [m[1]];
    from = kw + m[0].length;
  } else {
    m = /^foreach\s*\(\s*/.exec(sub);
    if (!m) return null;
    names = [];
    from = kw + m[0].length;
  }
  const lit = literal(s, from, lang);
  if (!lit) return null;
  let p = ws(s, lit.end);
  if (lang === 'rust') {
    const it = /^\.\s*(?:iter|into_iter)\s*\(\s*\)/.exec(s.slice(p, p + 30));
    if (it) p = ws(s, p + it[0].length);
  }
  if (lang === 'php') {
    const as = /^as\s+\$(\w+)\s*\)/.exec(s.slice(p, p + 40));
    if (!as) return null;
    names = [`$${as[1]}`];
    p = ws(s, p + as[0].length);
  } else if (lang === 'java' || lang === 'csharp' || lang === 'kotlin') {
    if (s[p] !== ')') return null;
    p = ws(s, p + 1);
  }
  if (s[p] !== '{') return null;
  return { names, elems: lit.elems, open: p };
}

/** `"/" + "a"` -> `"/a"` (simple double-quoted literals only), so route analyzers see one literal path. */
function foldLiterals(body: string): string {
  let prev = '';
  let cur = body;
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/"([^"\\\n]*)"\s*\+\s*"([^"\\\n]*)"/g, '"$1$2"');
  }
  return cur;
}

export function unrollLoopsInText(text: string, lang: Lang): string {
  if (!/\b(?:for|foreach)\b/.test(text)) return text;
  let cur = text;
  for (let round = 0; round < 3; round++) {
    const scr = scrub(cur, lang as ScrubLanguage);
    let out = '';
    let last = 0;
    let changed = false;
    const re = /\b(?:for|foreach)\b/g;
    for (let m = re.exec(scr); m; m = re.exec(scr)) {
      if (m.index < last) continue;
      const head = parseHead(scr, m.index, lang);
      if (!head) continue;
      const close = matchBrace(scr, head.open);
      if (close < 0) continue;
      const bodyScr = scr.slice(head.open + 1, close);
      const bodyOrig = cur.slice(head.open + 1, close);
      const idRe = (n: string) => new RegExp(n.startsWith('$') ? `\\${n}(?!\\w)` : `(?<![\\w.$])${n}(?!\\w)`, 'g');
      const interpolated = (lang === 'php' || lang === 'kotlin') && head.names.some((n) => new RegExp(`\\$\\{?${n.replace(/^\$/, '')}\\b`).test(bodyOrig));
      if (!(head.names.some((n) => idRe(n).test(bodyScr)) || interpolated) || !ROUTE_CALL.test(bodyScr)) continue;
      const elems = splitArgs(scr, cur, head.elems[0], head.elems[1]);
      if (elems.length === 0 || elems.length > 50) continue;
      const pieces: string[] = [];
      let ok = true;
      for (const [a, b] of elems) {
        let values: string[];
        const raw = cur.slice(a, b);
        const lead = raw.length - raw.trimStart().length;
        const elOrig = raw.trim();
        const elScr = scr.slice(a + lead, a + lead + elOrig.length);
        if (head.names.length === 1) values = [elOrig];
        else if (/^[[({]/.test(elScr) && matchClose(elScr, 0) === elScr.length - 1) {
          values = splitArgs(elScr, elOrig, 1, elScr.length - 1).map(([x, y]) => elOrig.slice(x, y).trim());
        } else values = [];
        if (values.length !== head.names.length) {
          ok = false;
          break;
        }
        let body = bodyOrig;
        // Replace on the scrubbed text's identifier positions so string contents are never touched.
        const edits: Array<[number, number, string]> = [];
        head.names.forEach((n, k) => {
          for (const mm of bodyScr.matchAll(idRe(n))) edits.push([mm.index!, mm.index! + mm[0].length, values[k]]);
        });
        edits.sort((x, y) => y[0] - x[0]);
        for (const [x, y, v] of edits) body = body.slice(0, x) + v + body.slice(y);
        if (lang === 'php' || lang === 'kotlin') {
          // String interpolation ("/$v", "/{$v}", "/${v}"): substitute plain string-literal elements inside double quotes.
          head.names.forEach((n, k) => {
            const lit = /^(['"])([^'"\\]*)\1$/.exec(values[k]);
            if (!lit) return;
            const bare = n.replace(/^\$/, '');
            const interp = new RegExp(`\\{\\$${bare}\\}|\\$\\{${bare}\\}|\\$${bare}(?!\\w)`, 'g');
            body = body.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => `"${inner.replace(interp, lit[2])}"`);
          });
        }
        pieces.push(foldLiterals(body));
      }
      if (!ok) continue;
      out += cur.slice(last, m.index) + pieces.join('\n');
      last = close + 1;
      re.lastIndex = close + 1;
      changed = true;
    }
    if (!changed) break;
    cur = out + cur.slice(last);
  }
  return cur;
}

export function unrollLoops(files: SourceFileInput[], lang: Lang): SourceFileInput[] {
  return files.map((f) => (typeof f.text === 'string' ? { ...f, text: unrollLoopsInText(f.text, lang) } : f));
}
