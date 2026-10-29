/**
 * Applies presentation-mode visibility to an already-rendered Mermaid SVG:
 * nodes not yet "revealed" get dimmed (not removed — removing them would
 * reflow the diagram and defeat the point of a stable presentation layout),
 * and edges get dimmed too when either endpoint isn't revealed yet.
 *
 * It recognises the element ids Mermaid 11 gives each diagram type (verified
 * against real renders by scripts/webview-smoke.mjs): every id carries a
 * per-render prefix (`mermaidforge-<n>-`), which is stripped first, then:
 *
 *   flowchart     node `flowchart-<id>-<n>`          edge `L_<a>_<b>_<n>`
 *   classDiagram  node `classId-<id>-<n>`            edge `id_<a>_<b>_<n>`
 *   erDiagram     node `entity-<id>-<n>`             edge `id_entity-<a>-<n>_entity-<b>-<n>_<k>`
 *   stateDiagram  node `state-<id>-<n>`              edges are `edge<N>` (no endpoints: never dimmed)
 *   requirement   node `<id>` (g.node)               edge `<a>-<b>-<n>`
 *   c4            node `<id>` (g.c4-shape)           edges carry no ids (never dimmed)
 *   architecture  node `service-<id>`                edge `L_<a>_<b>_<n>`
 *   block         node `<id>` (g.node)               edge `<random>-<n>-<a>-<b>`
 *   mindmap       node `node_<index>`                edge `edge_<parent>_<child>`
 *
 * Edge ids join two node ids with `_` or `-`, which can themselves contain
 * those characters, so the two ids are recovered by trying every split point
 * against the set of known ids. If Mermaid changes its id scheme, this
 * degrades gracefully: unrecognised elements simply stay at full opacity.
 */

const DIMMED_CLASS = 'mf-presentation-dimmed';
const RENDER_PREFIX = /^mermaidforge-\d+-/;

export type PresentationKind = 'flowchart' | 'classDiagram' | 'erDiagram' | 'stateDiagram' | 'requirementDiagram' | 'c4' | 'architecture' | 'block' | 'mindmap' | 'sequenceDiagram' | 'sankey';

export function stripRenderPrefix(id: string): string {
  return id.replace(RENDER_PREFIX, '');
}

/** Node id for a flowchart node element id (`mermaidforge-1-flowchart-A-0` or bare `flowchart-A-0`), else null. */
export function flowchartNodeId(elementId: string): string | null {
  const m = /^flowchart-(.+)-\d+$/.exec(stripRenderPrefix(elementId));
  return m ? m[1] : null;
}

interface KindMatchers {
  node: (id: string, el: Element) => string | null;
  edge: (id: string) => string | null; // returns "a<SEP>b" raw joined text to be split against known ids, or null
  alwaysVisible?: ReadonlySet<string>;
}

const PLAIN_NODE = (el: Element, id: string): string | null => (el.tagName.toLowerCase() === 'g' && el.classList.contains('node') ? id : null);

const MATCHERS: Record<Exclude<PresentationKind, 'sequenceDiagram' | 'sankey'>, KindMatchers> = {
  flowchart: { node: (id) => /^flowchart-(.+)-\d+$/.exec(id)?.[1] ?? null, edge: (id) => /^L[-_](.+)[-_]\d+$/.exec(id)?.[1] ?? null },
  classDiagram: { node: (id) => /^classId-(.+)-\d+$/.exec(id)?.[1] ?? null, edge: (id) => /^id_(.+)_\d+$/.exec(id)?.[1] ?? null },
  erDiagram: {
    node: (id) => /^entity-(.+)-\d+$/.exec(id)?.[1] ?? null,
    edge: (id) => {
      const m = /^id_entity-(.+)-\d+_entity-(.+)-\d+_\d+$/.exec(id);
      return m ? `${m[1]}\u0000${m[2]}` : null;
    },
  },
  stateDiagram: { node: (id) => /^state-(.+)-\d+$/.exec(id)?.[1] ?? null, edge: () => null, alwaysVisible: new Set(['root_start', 'root_end']) },
  requirementDiagram: { node: (id, el) => PLAIN_NODE(el, id), edge: (id) => /^(.+)-\d+$/.exec(id)?.[1] ?? null },
  c4: { node: (id, el) => (el.classList.contains('c4-shape') ? id : null), edge: () => null },
  architecture: { node: (id) => /^service-(.+)$/.exec(id)?.[1] ?? null, edge: (id) => /^L[-_](.+)[-_]\d+$/.exec(id)?.[1] ?? null },
  block: { node: (id, el) => PLAIN_NODE(el, id), edge: (id) => /^[a-z0-9]+-\d+-(.+)$/.exec(id)?.[1] ?? null },
  mindmap: { node: (id, el) => (el.classList.contains('mindmap-node') ? id : null), edge: (id) => { const m = /^edge_(\d+)_(\d+)$/.exec(id); return m ? `node_${m[1]}\u0000node_${m[2]}` : null; } },
};

/** Splits "a_b" / "a-b" into two known ids by trying each separator position. */
function splitEdgeIds(joined: string, known: ReadonlySet<string>, strict: boolean): [string, string] | null {
  if (joined.includes('\u0000')) {
    const [a, b] = joined.split('\u0000');
    return [a, b];
  }
  for (let i = 1; i < joined.length - 1; i++) {
    if ((joined[i] === '_' || joined[i] === '-') && known.has(joined.slice(0, i)) && known.has(joined.slice(i + 1))) {
      return [joined.slice(0, i), joined.slice(i + 1)];
    }
  }
  if (!strict) {
    // No universe of ids supplied: assume ids without separators and split at the first one.
    const m = /^([^_-]+)[_-](.+)$/.exec(joined);
    if (m) return [m[1], m[2]];
  }
  return null;
}

export function applyPresentationStep(
  root: ParentNode,
  revealedNodeIds: ReadonlySet<string>,
  kind: PresentationKind = 'flowchart',
  knownNodeIds?: ReadonlySet<string>,
): number {
  if (kind === 'sequenceDiagram') return applySequenceStep(root, revealedNodeIds, knownNodeIds ?? revealedNodeIds);
  if (kind === 'sankey') return applySankeyStep(root, revealedNodeIds, knownNodeIds ?? revealedNodeIds);
  const matchers = MATCHERS[kind] ?? MATCHERS.flowchart;
  const known = knownNodeIds ?? revealedNodeIds;
  let matchedNodes = 0;
  root.querySelectorAll('[id]').forEach((el) => {
    const id = stripRenderPrefix(el.id);

    const nodeId = matchers.node(id, el);
    if (nodeId !== null) {
      matchedNodes++;
      const visible = revealedNodeIds.has(nodeId) || (matchers.alwaysVisible?.has(nodeId) ?? false);
      // Only treat it as a node when it is a known one (guards e.g. requirement `g.node` vs edge labels).
      if (known.has(nodeId) || matchers.alwaysVisible?.has(nodeId) || knownNodeIds === undefined) setDimmed(el, !visible);
      return;
    }

    const joined = matchers.edge(id);
    if (joined !== null) {
      const ends = splitEdgeIds(joined, known, knownNodeIds !== undefined);
      if (ends) setDimmed(el, !(revealedNodeIds.has(ends[0]) && revealedNodeIds.has(ends[1])));
    }
  });
  // 0 means none of Mermaid's element ids matched: its id scheme has changed (see the header comment).
  return matchedNodes;
}

function countPrefixed(known: ReadonlySet<string>, prefix: string): number {
  let n = 0;
  for (const id of known) if (id.startsWith(prefix)) n++;
  return n;
}

/**
 * Sequence diagrams: Mermaid gives messages no ids, but emits each as a
 * `text.messageText` followed by its `line`/`path` `.messageLine*`, in source
 * order. Step N keeps the first N messages. Returns the number of messages
 * matched, or 0 when the SVG has a different number than the model (then
 * nothing is dimmed and the caller reports it).
 */
function applySequenceStep(root: ParentNode, revealed: ReadonlySet<string>, known: ReadonlySet<string>): number {
  const texts = [...root.querySelectorAll('text.messageText')];
  if (texts.length === 0 || texts.length !== countPrefixed(known, 'msg:')) return 0;
  texts.forEach((t, i) => {
    const dim = !revealed.has(`msg:${i}`);
    setDimmed(t, dim);
    const line = t.nextElementSibling;
    if (line && /(^|\s)messageLine\d/.test(line.getAttribute('class') ?? '')) setDimmed(line, dim);
  });
  return texts.length;
}

/**
 * Sankey diagrams: nodes (`g.nodes > g.node`), their labels (`g.node-labels >
 * text`, first line = name) and links (`g.links > g.link`) have no ids but
 * keep input order. Labels are checked against the expected names so a
 * reordering by Mermaid is detected instead of dimming the wrong things.
 */
function applySankeyStep(root: ParentNode, revealed: ReadonlySet<string>, known: ReadonlySet<string>): number {
  const nodes = [...root.querySelectorAll('g.nodes > g.node')];
  const labels = [...root.querySelectorAll('g.node-labels > text')];
  const links = [...root.querySelectorAll('g.links > g.link')];
  const names = labels.map((l) => (l.textContent ?? '').split('\n')[0].trim());
  if (nodes.length === 0 || nodes.length !== labels.length || links.length !== countPrefixed(known, 'link:')) return 0;
  if (names.some((n) => !known.has(`node:${n}`)) || countPrefixed(known, 'node:') !== nodes.length) return 0;
  nodes.forEach((n, i) => {
    const dim = !revealed.has(`node:${names[i]}`);
    setDimmed(n, dim);
    setDimmed(labels[i], dim);
  });
  links.forEach((l, i) => setDimmed(l, !revealed.has(`link:${i}`)));
  return nodes.length;
}

/** Removes all presentation dimming — used when exiting presentation mode. */
export function clearPresentationDimming(root: ParentNode): void {
  root.querySelectorAll(`.${DIMMED_CLASS}`).forEach((el) => el.classList.remove(DIMMED_CLASS));
}

function setDimmed(el: Element, dimmed: boolean): void {
  el.classList.toggle(DIMMED_CLASS, dimmed);
}
