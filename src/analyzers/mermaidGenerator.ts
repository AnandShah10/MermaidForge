import { CodeGraph } from './analyzer';

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
}

function quoteLabel(label: string): string {
  // Mermaid has no backslash escape inside quoted labels; `#quot;` is its entity for a double quote.
  return `"${label.replace(/\s+/g, ' ').replace(/"/g, '#quot;')}"`;
}

/**
 * Renders a generic CodeGraph (file/module nodes and their relationships) as
 * a Mermaid flowchart. Node ids are derived from each node's own `id` field
 * (already unique per analyzer, typically a file path) rather than its
 * label, so two files with the same base name in different folders don't
 * collide.
 */
const SHAPES: Record<string, [string, string]> = {
  app: ['([', '])'],
  router: ['[[', ']]'],
  external: ['[/', '/]'],
};

export function codeGraphToFlowchart(graph: CodeGraph, direction: 'TD' | 'LR' = 'LR'): string {
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const node of graph.nodes) {
    let candidate = sanitizeId(node.id);
    let suffix = 1;
    while (used.has(candidate)) candidate = `${sanitizeId(node.id)}_${suffix++}`;
    used.add(candidate);
    idMap.set(node.id, candidate);
  }

  const lines: string[] = [`flowchart ${direction}`];
  for (const node of graph.nodes) {
    const [open, close] = SHAPES[node.kind] ?? ['[', ']'];
    lines.push(`  ${idMap.get(node.id)}${open}${quoteLabel(node.label)}${close}`);
  }
  for (const edge of graph.edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to) continue; // edge referenced a node the analyzer didn't include — skip rather than emit a dangling reference
    // `ambiguous` (a call whose name matches several functions) is drawn dotted so a guess does not look like a fact.
    const arrow = edge.kind === 'ambiguous' ? '-.->' : '-->';
    lines.push(edge.label ? `  ${from} ${arrow}|${quoteLabel(edge.label)}| ${to}` : `  ${from} ${arrow} ${to}`);
  }
  return lines.join('\n') + '\n';
}

export interface ExtractedClass {
  id: string;
  stereotype: 'interface' | 'abstract' | 'enumeration' | null;
  members: string[]; // pre-formatted member lines, e.g. "+getName() string"
}

export interface ExtractedRelationship {
  from: string;
  to: string;
  type: 'inheritance' | 'realization';
}

/**
 * Class members are free text from source code (`'/a-b' { id: '/a' }`, `[u8; N]`, ...), but Mermaid parses them
 * as `visibility name type`. Braces end the class body, quotes/backticks open strings and newlines end the
 * member, so those are neutralised; long members are cut so one huge type literal cannot swamp the diagram.
 */
export function sanitizeMember(member: string): string {
  // Mermaid's member parser crashes on `<` before `(` (`f<R(A)`, `operator<(x)`); its own generic syntax is `~T~`.
  const flat = member.replace(/\s+/g, ' ').replace(/[{}]/g, ' ').replace(/<|(?<![-=])>/g, '~').replace(/["`]/g, "'").replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/** Renders extracted class/interface declarations and their inheritance as a Mermaid classDiagram. */
export function classesToClassDiagram(classes: ExtractedClass[], relationships: ExtractedRelationship[]): string {
  // Mermaid class ids are [A-Za-z0-9_]; anything else (generic arguments, `()`, `&'a [u8]`) gets a safe id plus the original as display label.
  const idMap = new Map<string, string>();
  const used = new Set<string>();
  const safeId = (raw: string): string => {
    const known = idMap.get(raw);
    if (known) return known;
    let base = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'type';
    if (!/^[A-Za-z_]/.test(base)) base = `t_${base}`;
    let cand = base;
    for (let n = 1; used.has(cand); n++) cand = `${base}_${n}`;
    used.add(cand);
    idMap.set(raw, cand);
    return cand;
  };
  for (const cls of classes) safeId(cls.id);
  const lines: string[] = ['classDiagram'];
  for (const cls of classes) {
    const id = safeId(cls.id);
    const label = id !== cls.id ? `["${cls.id.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 60)}"]` : '';
    const members = cls.members.map(sanitizeMember).filter(Boolean);
    if (members.length === 0 && cls.stereotype === null) {
      lines.push(`  class ${id}${label}`);
      continue;
    }
    lines.push(`  class ${id}${label} {`);
    if (cls.stereotype) lines.push(`    <<${cls.stereotype}>>`);
    for (const member of members) lines.push(`    ${member}`);
    lines.push('  }');
  }
  for (const rel of relationships) {
    // Skip relationships whose ends were never declared as classes rather than letting Mermaid invent empty ones from unsafe text.
    if (!idMap.has(rel.from) && !/^[A-Za-z_]\w*$/.test(rel.from)) continue;
    if (!idMap.has(rel.to) && !/^[A-Za-z_]\w*$/.test(rel.to)) continue;
    const arrow = rel.type === 'inheritance' ? '<|--' : '<|..';
    lines.push(`  ${idMap.get(rel.to) ?? rel.to} ${arrow} ${idMap.get(rel.from) ?? rel.from}`);
  }
  return lines.join('\n') + '\n';
}
