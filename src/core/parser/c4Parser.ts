import { C4Boundary, C4Diagram, C4Element, C4Relation, C4StyleUpdate, C4Variant, ParseIssue } from '../diagram/types';
import { extractFrontmatter } from './detectDiagramType';
import { makeRange, splitTopLevel, stripComment, unquote } from './parserUtils';

/**
 * Parses the C4 diagram family (`C4Context`, `C4Container`, `C4Component`,
 * `C4Dynamic`, `C4Deployment`). Every statement is a macro call on ONE line:
 * `Macro(arg, "arg", $named="x")`, optionally ending in `{` to open a
 * boundary, which is closed by a `}` line.
 *
 *  - Elements: Person, System, SystemDb, SystemQueue, Container, ContainerDb,
 *    ContainerQueue, Component, ComponentDb, ComponentQueue (+ `_Ext`
 *    variants). Positional args: alias, label, then `techn, descr` for
 *    Container/Component or just `descr` otherwise.
 *  - Boundaries: Boundary, Enterprise_Boundary, System_Boundary,
 *    Container_Boundary and deployment nodes (Node, Node_L, Node_R,
 *    Deployment_Node) — each takes (alias, label[, type]) and may nest.
 *  - Relations: Rel, BiRel, Rel_U/Up/D/Down/L/Left/R/Right/Back
 *    (from, to, label[, techn]) and RelIndex (index, from, to, label).
 *  - UpdateElementStyle / UpdateRelStyle / UpdateLayoutConfig are modelled in
 *    `styleUpdates` (alias targets + `$param="value"` pairs, values raw).
 *  - Acknowledged but not modelled (rendering only): LAYOUT_* and SHOW_LEGEND-style calls,
 *    and `$named=` arguments (tags, links, sprites).
 * An unknown macro is a warning, not an error, since C4-PlantUML-style
 * macros evolve; fewer arguments than a macro needs is an error.
 */
const ELEMENT_BASES = ['Person', 'System', 'SystemDb', 'SystemQueue', 'Container', 'ContainerDb', 'ContainerQueue', 'Component', 'ComponentDb', 'ComponentQueue'];
const ELEMENT_MACROS = new Set<string>([...ELEMENT_BASES, ...ELEMENT_BASES.map((b) => `${b}_Ext`)]);
const BOUNDARY_MACROS = new Set(['Boundary', 'Enterprise_Boundary', 'System_Boundary', 'Container_Boundary', 'Node', 'Node_L', 'Node_R', 'Deployment_Node']);
const REL_MACROS = new Set(['Rel', 'BiRel', 'Rel_U', 'Rel_Up', 'Rel_D', 'Rel_Down', 'Rel_L', 'Rel_Left', 'Rel_R', 'Rel_Right', 'Rel_Back']);
const STYLE_MACROS = /^(UpdateElementStyle|UpdateRelStyle|UpdateLayoutConfig)$/;
const IGNORED_MACROS = /^(LAYOUT_[A-Z_]+|SHOW_LEGEND|HIDE_STEREOTYPE|SHOW_FLOATING_LEGEND|AddElementTag|AddRelTag|AddBoundaryTag)$/;
const CALL = /^([A-Za-z_]\w*)\s*\((.*)\)\s*(\{)?\s*$/;

function positional(args: string[]): string[] {
  return args.map((a) => a.trim()).filter((a) => !/^\$[A-Za-z]\w*\s*=/.test(a)).map(unquote);
}

export function parseC4Diagram(source: string): C4Diagram {
  const { frontmatter, body } = extractFrontmatter(source);
  const lines = body.split(/\r?\n/);
  const parseIssues: ParseIssue[] = [];
  const comments: C4Diagram['comments'] = [];
  const elements: C4Element[] = [];
  const boundaries: C4Boundary[] = [];
  const relations: C4Relation[] = [];
  const styleUpdates: C4StyleUpdate[] = [];
  const stack: Array<{ alias: string; line: number }> = [];
  let variant: C4Variant | null = null;
  let title: string | null = null;
  let headerFound = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    const { code, comment } = stripComment(rawLine);
    if (comment) comments.push({ text: comment.trim(), sourceRange: makeRange(lineIdx, rawLine.indexOf('%%'), rawLine.length) });
    const trimmed = code.trim();
    if (!trimmed) continue;
    const range = makeRange(lineIdx, 0, trimmed.length);

    if (!headerFound) {
      const h = /^C4(Context|Container|Component|Dynamic|Deployment)?\b/i.exec(trimmed);
      if (h) {
        headerFound = true;
        variant = (h[1] ? h[1][0].toUpperCase() + h[1].slice(1).toLowerCase() : null) as C4Variant | null;
        continue;
      }
      if (!trimmed.startsWith('%%{')) parseIssues.push({ message: 'Expected a "C4Context" (or C4Container/C4Component/C4Dynamic/C4Deployment) header before diagram content.', severity: 'error', range });
      continue;
    }

    if (trimmed === '}') {
      if (stack.length === 0) parseIssues.push({ message: 'Unmatched "}" — no boundary is open.', severity: 'error', range });
      else stack.pop();
      continue;
    }
    const t = /^title\s+(.*)$/i.exec(trimmed);
    if (t) {
      title = unquote(t[1]);
      continue;
    }

    const m = CALL.exec(trimmed);
    if (!m) {
      parseIssues.push({ message: `Unrecognized statement: "${trimmed}"`, severity: 'warning', range });
      continue;
    }
    const [, macro, argSrc, brace] = m;
    const args = positional(splitTopLevel(argSrc));
    const parent = stack.length ? stack[stack.length - 1].alias : null;

    if (STYLE_MACROS.test(macro)) {
      const params: Record<string, string> = {};
      for (const a of splitTopLevel(argSrc)) {
        const p = /^\s*\$([A-Za-z]\w*)\s*=\s*(.*?)\s*$/.exec(a);
        if (p) params[p[1]] = unquote(p[2]);
      }
      styleUpdates.push({ macro: macro as C4StyleUpdate['macro'], targets: args, params, sourceRange: range });
      continue;
    } else if (IGNORED_MACROS.test(macro)) {
      continue;
    } else if (ELEMENT_MACROS.has(macro)) {
      if (args.length < 2) {
        parseIssues.push({ message: `${macro} needs at least (alias, label) but got ${args.length} argument(s).`, severity: 'error', range });
        continue;
      }
      const hasTechn = /^(Container|Component)/.test(macro);
      elements.push({
        macro,
        alias: args[0],
        label: args[1],
        techn: hasTechn ? args[2] ?? null : null,
        description: (hasTechn ? args[3] : args[2]) ?? null,
        external: macro.endsWith('_Ext'),
        boundary: parent,
        sourceRange: range,
      });
    } else if (BOUNDARY_MACROS.has(macro)) {
      if (args.length < 2) {
        parseIssues.push({ message: `${macro} needs at least (alias, label) but got ${args.length} argument(s).`, severity: 'error', range });
      } else {
        boundaries.push({ macro, alias: args[0], label: args[1], type: args[2] ?? null, parent, sourceRange: range });
      }
      if (brace) stack.push({ alias: args[0] ?? '', line: lineIdx });
      else if (args.length >= 2) parseIssues.push({ message: `${macro}(${args[0]}) has no "{" on its line — nested elements will not be attached to it.`, severity: 'warning', range });
      continue;
    } else if (REL_MACROS.has(macro) || macro === 'RelIndex') {
      const a = macro === 'RelIndex' ? args.slice(1) : args;
      if (a.length < 3) {
        parseIssues.push({ message: `${macro} needs (from, to, label) but got ${a.length} argument(s).`, severity: 'error', range });
        continue;
      }
      relations.push({ macro, from: a[0], to: a[1], label: a[2], techn: a[3] ?? null, sourceRange: range });
    } else {
      parseIssues.push({ message: `Unknown C4 macro "${macro}".`, severity: 'warning', range });
    }
    if (brace) stack.push({ alias: '', line: lineIdx }); // non-boundary macro opened a block: keep braces balanced
  }

  for (const open of stack) parseIssues.push({ message: `Boundary "${open.alias}" is never closed with "}".`, severity: 'error', range: makeRange(open.line, 0, lines[open.line]?.length ?? 0) });
  if (!headerFound) parseIssues.push({ message: 'No C4 header found.', severity: 'error', range: makeRange(0, 0, 0) });
  return { kind: 'c4', variant, title, elements, boundaries, relations, styleUpdates, comments, frontmatter, parseIssues, sourceText: source };
}
