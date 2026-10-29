/**
 * Minimal XML parser sufficient for the SVG that Mermaid emits. Not a general
 * XML implementation: no namespaces resolution, no DTD processing, no CDATA
 * beyond treating it as text. Recovers from mismatched close tags instead of
 * throwing, because a best-effort PDF is better than none.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated direct text content (whitespace preserved). */
  text: string;
  /** Direct text runs and child elements in document order. */
  parts: Array<string | XmlNode>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

export function parseXml(source: string): XmlNode[] {
  let s = source
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );

  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  const tagRe = /<(\/?)([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;

  const addText = (t: string) => {
    if (stack.length && t.length) {
      const top = stack[stack.length - 1];
      const decoded = decodeEntities(t);
      top.text += decoded;
      top.parts.push(decoded);
    }
  };

  while ((m = tagRe.exec(s))) {
    addText(s.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, name, attrSrc, selfClose] = m;
    if (closing) {
      // Pop to the matching open tag; ignore stray closers.
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) stack.length = idx;
      continue;
    }
    const node: XmlNode = { name, attrs: parseAttrs(attrSrc), children: [], text: '', parts: [] };
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
      stack[stack.length - 1].parts.push(node);
    }
    else roots.push(node);
    if (!selfClose) stack.push(node);
  }
  addText(s.slice(last));
  return roots;
}

export function findFirstElement(nodes: XmlNode[], name: string): XmlNode | null {
  for (const n of nodes) {
    if (n.name === name) return n;
    const inner = findFirstElement(n.children, name);
    if (inner) return inner;
  }
  return null;
}
