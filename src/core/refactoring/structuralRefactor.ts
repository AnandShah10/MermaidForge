import { ArchitectureDiagram, BlockDiagram, C4Diagram, ClassDiagram, ParsedDiagram, StateDiagram } from '../diagram/types';
import { projectGraph } from '../diagram/graphProjection';
import { removeIdentifierLines, renameInLine } from './renameIdentifier';

export interface StructuralResult {
  ok: true;
  newSource: string;
  description: string;
}
export interface StructuralError {
  ok: false;
  reason: string;
}

/** Last line index of the declaration starting at `start`: follows a trailing `{` to its matching `}` line. */
export function declarationEnd(lines: string[], start: number): number {
  const first = lines[start]?.replace(/%%.*$/, '') ?? '';
  if (!/\{\s*$/.test(first)) return start;
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].replace(/%%.*$/, '');
    for (const c of t) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth <= 0) return i;
  }
  return lines.length - 1;
}

// ---------------------------------------------------------------------------
// Remove unused
// ---------------------------------------------------------------------------

/** Ids with no relationships, for the kinds remove-unused supports other than flowcharts. */
export function unusedIds(diagram: ParsedDiagram): string[] | null {
  if (!['classDiagram', 'erDiagram', 'stateDiagram', 'requirementDiagram', 'c4', 'architecture'].includes(diagram.kind)) return null;
  const g = projectGraph(diagram);
  if (!g) return null;
  const used = new Set<string>();
  for (const e of g.edges) {
    used.add(e.source);
    used.add(e.target);
  }
  let candidates = [...g.nodes.keys()].filter((id) => !used.has(id));
  if (diagram.kind === 'stateDiagram') {
    // Only plain, top-level, explicitly named states; never the [*] markers or composite/choice/fork/join states.
    candidates = candidates.filter((id) => {
      const s = diagram.states.get(id);
      return !!s && s.kind === 'simple' && s.parentId === null && !id.startsWith('[');
    });
  }
  if (diagram.kind === 'architecture') candidates = candidates.filter((id) => diagram.nodes.find((n) => n.id === id)?.type === 'service');
  // Never empty a diagram: need at least one node that stays.
  return g.nodes.size - candidates.length >= 1 ? candidates : [];
}

export function removeUnusedStructural(diagram: ParsedDiagram): StructuralResult | StructuralError {
  const unused = unusedIds(diagram);
  if (unused === null) {
    const why = diagram.kind === 'block' ? ' Block diagrams are mostly laid out without edges, so "no relationships" does not mean "unused" and nothing is removed automatically.' : '';
    return { ok: false, reason: `Remove-unused supports flowchart, class, ER, state, requirement, C4 and architecture diagrams (this one is "${diagram.kind}").${why}` };
  }
  if (unused.length === 0) return { ok: false, reason: 'No unused (relationship-free) items were found.' };

  let source = diagram.sourceText;
  let lineCount = 0;
  for (const id of unused) {
    if (diagram.kind === 'classDiagram' || diagram.kind === 'erDiagram' || diagram.kind === 'stateDiagram') {
      const r = removeIdentifierLines(source, diagram.kind, id);
      source = r.text;
      lineCount += r.removed;
    } else {
      const lines = source.split('\n');
      const start = declStart(diagram, id);
      if (start === null) continue;
      const end = declarationEnd(lines, start);
      const drop = new Set<number>();
      for (let i = start; i <= end; i++) drop.add(i);
      if (diagram.kind === 'c4') {
        lines.forEach((l, i) => {
          if (new RegExp(`^\\s*Update(?:Element|Rel)?Style\\(\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,)]`).test(l)) drop.add(i);
        });
      }
      const edited = new Map<number, string>();
      if (diagram.kind === 'requirementDiagram') {
        // `style id ...` lines go; `class a,id,b name` lines lose just this id (dropped when it was the only target).
        lines.forEach((l, i) => {
          if (drop.has(i)) return;
          const st = /^(\s*)style\s+(\S+)\s/.exec(l);
          if (st && st[2] === id) {
            drop.add(i);
            return;
          }
          const cl = /^(\s*class\s+)(\S+)(\s+[\w-]+\s*)$/.exec(l);
          if (cl) {
            const targets = cl[2].split(',');
            if (!targets.includes(id)) return;
            const rest = targets.filter((t) => t !== id);
            if (rest.length === 0) drop.add(i);
            else edited.set(i, cl[1] + rest.join(',') + cl[3]);
          }
        });
      }
      source = lines.map((l, i) => edited.get(i) ?? l).filter((_l, i) => !drop.has(i)).join('\n');
      lineCount += drop.size;
    }
  }
  return { ok: true, newSource: source, description: `Removed ${unused.length} unused item(s): ${unused.join(', ')} (${lineCount} line(s)).` };
}

function declStart(d: ParsedDiagram, id: string): number | null {
  if (d.kind === 'requirementDiagram') {
    return d.requirements.find((r) => r.name === id)?.sourceRange?.startLine ?? d.elements.find((e) => e.name === id)?.sourceRange?.startLine ?? null;
  }
  if (d.kind === 'c4') return d.elements.find((e) => e.alias === id)?.sourceRange?.startLine ?? null;
  if (d.kind === 'architecture') return d.nodes.find((n) => n.id === id)?.sourceRange?.startLine ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// Extract into a group
// ---------------------------------------------------------------------------

/** Ids that extractGroup can move for this diagram, or null when the kind isn't supported. */
export function extractableIds(diagram: ParsedDiagram): string[] | null {
  switch (diagram.kind) {
    case 'classDiagram':
      return [...diagram.classes.values()].filter((c) => c.sourceRange).map((c) => c.id);
    case 'c4':
      return diagram.elements.filter((e) => e.boundary === null).map((e) => e.alias);
    case 'architecture':
      return diagram.nodes.filter((n) => n.type !== 'group' && n.parent === null).map((n) => n.id);
    case 'stateDiagram':
      return [...diagram.states.values()].filter((st) => st.parentId === null && st.kind !== 'composite' && st.kind !== 'startOrEnd' && !st.id.startsWith('[')).map((st) => st.id);
    case 'block':
      return diagram.blocks.filter((b) => b.parent === null && !b.isGroup && !b.isSpace && b.sourceRange).map((b) => b.id);
    default:
      return null;
  }
}

/**
 * class -> `namespace Id { ... }`, C4 -> `Boundary(id, "Title") { ... }`,
 * architecture -> `group id(cloud)[Title]` plus `in id` on each service,
 * state -> `state Id { ... }` composite, block -> `block:Id ... end`.
 * Declaration lines are moved (not copied) to the first selected position;
 * relationship lines stay where they are, which Mermaid allows.
 */
export function extractGroup(diagram: ParsedDiagram, ids: string[], groupId: string, title: string): StructuralResult | StructuralError {
  const allowed = extractableIds(diagram);
  if (!allowed) {
    return { ok: false, reason: `Extract-into-group supports flowchart, class (namespace), C4 (boundary), architecture (group), state (composite state) and block (block group) diagrams. ER, requirement and mindmap diagrams have no grouping syntax in Mermaid, so there is nothing to extract into (this one is "${diagram.kind}").` };
  }
  if (ids.length === 0) return { ok: false, reason: 'Select at least one item to extract.' };
  if (!/^[A-Za-z0-9_-]+$/.test(groupId)) return { ok: false, reason: `"${groupId}" is not a valid id (use letters, digits, "_" or "-").` };
  for (const id of ids) {
    if (!allowed.includes(id)) return { ok: false, reason: `"${id}" cannot be extracted (it is undeclared, already inside a group, or is a group itself).` };
  }
  const lines = diagram.sourceText.split('\n');

  if (diagram.kind === 'architecture') return extractArchitecture(diagram, ids, groupId, title, lines);
  if (diagram.kind === 'stateDiagram') return extractState(diagram, ids, groupId, title, lines);
  if (diagram.kind === 'block') return extractBlock(diagram, ids, groupId, lines);
  if (diagram.kind === 'classDiagram') {
    if (diagram.classes.has(groupId)) return { ok: false, reason: `"${groupId}" is already a class name.` };
  } else if (diagram.kind === 'c4') {
    if (diagram.elements.some((e) => e.alias === groupId) || diagram.boundaries.some((b) => b.alias === groupId)) return { ok: false, reason: `Alias "${groupId}" is already in use.` };
  }

  // Collect the line extents to move.
  const extents: Array<[number, number]> = [];
  for (const id of ids) {
    const start = diagram.kind === 'classDiagram' ? classDeclLine(diagram, id, lines) : (diagram as C4Diagram).elements.find((e) => e.alias === id)?.sourceRange?.startLine ?? null;
    if (start === null) return { ok: false, reason: `Could not find a standalone declaration line for "${id}" (declare it explicitly first).` };
    extents.push([start, declarationEnd(lines, start)]);
    if (diagram.kind === 'classDiagram') {
      // Other lines that mention the class (member lines, notes) would be left behind; only relationship lines may stay.
      const own = new Set<number>();
      for (let i = start; i <= declarationEnd(lines, start); i++) own.add(i);
      for (let i = 1; i < lines.length; i++) {
        if (own.has(i)) continue;
        if (renameInLine(lines[i], id, '\u0001', { skipBrackets: false, skipPipes: false, stopAtColon: true, stopAtAs: false }).count > 0 && !/(--|\.\.)/.test(lines[i])) {
          return { ok: false, reason: `"${id}" also appears on line ${i + 1} (${lines[i].trim().slice(0, 40)}); move its member/note lines into its declaration first.` };
        }
      }
    }
  }
  extents.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < extents.length; i++) if (extents[i][0] <= extents[i - 1][1]) return { ok: false, reason: 'Selected declarations overlap.' };

  const indent = '  ';
  const moved = extents.flatMap(([a, b]) => lines.slice(a, b + 1).map((l) => indent + l.trimStart()));
  const insertAt = extents[0][0];
  const drop = new Set<number>();
  for (const [a, b] of extents) for (let i = a; i <= b; i++) drop.add(i);
  const open = diagram.kind === 'classDiagram' ? `namespace ${groupId} {` : `Boundary(${groupId}, "${title.replace(/"/g, "'")}") {`;
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === insertAt) out.push(open, ...moved, '}');
    if (!drop.has(i)) out.push(l);
  });
  const what = diagram.kind === 'classDiagram' ? `namespace "${groupId}" (namespaces have no title; "${title}" was not used)` : `boundary "${groupId}"`;
  return { ok: true, newSource: out.join('\n'), description: `Moved ${ids.length} item(s) into ${what}.` };
}

function classDeclLine(d: ClassDiagram, id: string, lines: string[]): number | null {
  const start = d.classes.get(id)?.sourceRange?.startLine;
  if (start === undefined) return null;
  // Only a `class X` / `class X { ... }` line counts as a standalone declaration.
  return /^\s*class\s+/.test(lines[start] ?? '') ? start : null;
}

function extractArchitecture(d: ArchitectureDiagram, ids: string[], groupId: string, title: string, lines: string[]): StructuralResult | StructuralError {
  if (d.nodes.some((n) => n.id === groupId)) return { ok: false, reason: `Id "${groupId}" is already in use.` };
  const starts: number[] = [];
  for (const id of ids) {
    const n = d.nodes.find((x) => x.id === id);
    const at = n?.sourceRange?.startLine;
    if (at === undefined) return { ok: false, reason: `Could not find the declaration line for "${id}".` };
    starts.push(at);
  }
  starts.sort((a, b) => a - b);
  const startSet = new Set(starts);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === starts[0]) out.push(`${l.match(/^\s*/)?.[0] ?? ''}group ${groupId}(cloud)[${title.replace(/[\]\n]/g, ' ')}]`);
    if (startSet.has(i)) {
      const m = /^(.*?)(\s*%%.*)?$/.exec(l)!;
      out.push(`${m[1].replace(/\s+$/, '')} in ${groupId}${m[2] ?? ''}`);
    } else out.push(l);
  });
  return { ok: true, newSource: out.join('\n'), description: `Added group "${groupId}" and moved ${ids.length} item(s) into it.` };
}

/** Brace depth at the start of each line, counting only `state X {` style openers and `}` closers. */
function braceDepths(lines: string[]): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const l of lines) {
    depths.push(depth);
    const t = l.replace(/%%.*$/, '').trim();
    if (/\{\s*$/.test(t)) depth++;
    else if (t === '}') depth = Math.max(0, depth - 1);
  }
  return depths;
}

/**
 * State diagram: the selected states' declaration lines and every transition
 * whose two ends are both selected move into `state Id { ... }`. Transitions
 * that cross the boundary (one end outside, or `[*]`) stay where they are.
 * Refuses when a note targets a selected state (notes can span lines).
 */
function extractState(d: StateDiagram, ids: string[], groupId: string, title: string, lines: string[]): StructuralResult | StructuralError {
  if (d.states.has(groupId)) return { ok: false, reason: `"${groupId}" is already a state id.` };
  const sel = new Set(ids);
  const depths = braceDepths(lines);
  const opts = { skipBrackets: false, skipPipes: false, stopAtColon: true, stopAtAs: false };
  const noteLines = new Set<number>();
  for (const n of d.notes) {
    if (n.target && sel.has(n.target)) return { ok: false, reason: `A note is attached to "${n.target}"; move or remove it first (notes cannot be moved automatically).` };
    if (n.sourceRange) for (let i = n.sourceRange.startLine; i <= n.sourceRange.endLine; i++) noteLines.add(i);
  }
  const transitionByLine = new Map<number, { from: string; to: string }>();
  for (const t of d.transitions) if (t.sourceRange) transitionByLine.set(t.sourceRange.startLine, t);
  const header = lines.findIndex((l) => /^\s*stateDiagram/.test(l));
  const move: number[] = [];
  let firstMention = -1;
  for (let i = header + 1; i < lines.length; i++) {
    if (depths[i] !== 0 || noteLines.has(i)) continue;
    const line = lines[i];
    const mentions = ids.filter((id) => renameInLine(line, id, '\u0001', opts).count > 0 || new RegExp(`\\bas\\s+${id}\\b`).test(line));
    if (mentions.length === 0) continue;
    if (firstMention === -1) firstMention = i;
    const tr = transitionByLine.get(i);
    if (tr) {
      if (sel.has(tr.from) && sel.has(tr.to)) move.push(i);
      continue;
    }
    if (/\{\s*$/.test(line.replace(/%%.*$/, '').trim())) return { ok: false, reason: `"${mentions[0]}" is declared with a block on line ${i + 1}; extract only simple states.` };
    move.push(i);
  }
  if (firstMention === -1) return { ok: false, reason: 'None of the selected states is mentioned at the top level, so there is nothing to move.' };
  // A state belongs to the composite where Mermaid first meets it, so the composite goes at the first line that
  // mentions any selected state, and a state that only appears in boundary-crossing transitions is declared inside.
  const covered = new Set<string>();
  for (const i of move) for (const id of ids) if (renameInLine(lines[i], id, '\u0001', opts).count > 0 || new RegExp(`\\bas\\s+${id}\\b`).test(lines[i])) covered.add(id);
  const moved = [...ids.filter((id) => !covered.has(id)).map((id) => `    ${id}`), ...move.map((i) => '    ' + lines[i].trimStart())];
  const drop = new Set(move);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === firstMention) out.push(`  state ${groupId} {`, ...moved, '  }');
    if (!drop.has(i)) out.push(l);
  });
  void title; // composite states have no separate title in Mermaid; the id is the name
  return { ok: true, newSource: out.join('\n'), description: `Moved ${move.length} line(s) (${ids.length} state(s)) into composite state "${groupId}" (composite states have no title; "${title}" was not used).` };
}

/**
 * Block diagram: the lines declaring the selected blocks move into
 * `block:Id ... end`. A line holds a whole row (`A B:2 C`), so every block on a
 * moved line must be selected; edges (`A --> B`) stay where they are.
 */
function extractBlock(d: BlockDiagram, ids: string[], groupId: string, lines: string[]): StructuralResult | StructuralError {
  if (d.blocks.some((b) => b.id === groupId)) return { ok: false, reason: `"${groupId}" is already a block id.` };
  const sel = new Set(ids);
  const rows = new Set<number>();
  for (const id of ids) {
    const b = d.blocks.find((x) => x.id === id);
    if (b?.sourceRange) rows.add(b.sourceRange.startLine);
  }
  for (const b of d.blocks) {
    if (!b.sourceRange || !rows.has(b.sourceRange.startLine)) continue;
    if (!sel.has(b.id)) return { ok: false, reason: `Block "${b.id}" shares line ${b.sourceRange.startLine + 1} with a selected block; select it too (a row is moved as a whole).` };
  }
  const order = [...rows].sort((a, b) => a - b);
  const indent = lines[order[0]].match(/^\s*/)?.[0] ?? '';
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === order[0]) out.push(`${indent}block:${groupId}`, ...order.map((r) => `${indent}  ${lines[r].trimStart()}`), `${indent}end`);
    if (!rows.has(i)) out.push(l);
  });
  return { ok: true, newSource: out.join('\n'), description: `Moved ${ids.length} block(s) (${order.length} row(s)) into group "${groupId}".` };
}
