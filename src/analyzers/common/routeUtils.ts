import { CodeGraph } from '../analyzer';

/**
 * Helpers shared by the route-map analyzers (Go, Rust). Statement structure is
 * read from "scrubbed" text (strings/comments blanked, same offsets) and
 * literal values from the comment-stripped original at the same offsets.
 */
export interface RouteHolder {
  id: string;
  label: string;
  kind: 'app' | 'router';
}
export interface RouteEntry {
  holder: RouteHolder;
  method: string;
  path: string;
  handler: string;
}
export interface RouteMount {
  parent: RouteHolder;
  child: RouteHolder;
  prefix: string;
}

/** Index of the bracket closing the one at `open`, or -1. */
export function matchClose(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if ('([{'.includes(s[i])) depth++;
    else if (')]}'.includes(s[i]) && --depth === 0) return i;
  }
  return -1;
}

/**
 * Top-level comma split of s[from, to) returning [start, end) pairs. `s` is
 * scrubbed (strings blank) so brackets are reliable; `code` decides whether an
 * argument is empty (a string literal is blank in `s`).
 */
export function splitArgs(s: string, code: string, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  out.push([start, to]);
  return out.filter(([a, b]) => code.slice(a, b).trim() !== '');
}

export function joinPaths(...ps: string[]): string {
  const raw = ps.filter((p) => p !== '');
  const segs = raw.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const last = raw[raw.length - 1] ?? '';
  return '/' + segs.join('/') + (segs.length > 0 && /\/$/.test(last) ? '/' : '');
}

/**
 * Turns holders/routes/mounts into the graph: holder nodes (only those that
 * have a route or mount), mount edges labelled with the prefix, and one node
 * per route. A route shows its full path only when its holder is reachable by
 * exactly one chain of mounts; otherwise the router-relative path is shown.
 */
export function assembleRouteGraph(holders: Iterable<RouteHolder>, routes: RouteEntry[], mounts: RouteMount[]): CodeGraph {
  const incoming = new Map<string, RouteMount[]>();
  for (const mt of mounts) incoming.set(mt.child.id, [...(incoming.get(mt.child.id) ?? []), mt]);
  const prefixesOf = (h: RouteHolder, stack: Set<string>): string[] => {
    const ins = incoming.get(h.id);
    if (!ins || ins.length === 0) return [''];
    if (stack.has(h.id)) return [''];
    stack.add(h.id);
    const out: string[] = [];
    for (const mt of ins) for (const pp of prefixesOf(mt.parent, stack)) out.push(mt.prefix ? joinPaths(pp, mt.prefix) : pp);
    stack.delete(h.id);
    return [...new Set(out)];
  };

  const used = new Set<string>();
  for (const r of routes) used.add(r.holder.id);
  for (const mt of mounts) {
    used.add(mt.parent.id);
    used.add(mt.child.id);
  }

  const nodes: CodeGraph['nodes'] = [];
  const edges: CodeGraph['edges'] = [];
  for (const h of holders) if (used.has(h.id)) nodes.push({ id: h.id, label: h.label, kind: h.kind });
  for (const mt of mounts) edges.push({ from: mt.parent.id, to: mt.child.id, label: mt.prefix ? joinPaths(mt.prefix) : '/', kind: 'mount' });
  let rn = 0;
  for (const r of routes) {
    const prefixes = prefixesOf(r.holder, new Set());
    const shown = prefixes.length === 1 ? joinPaths(prefixes[0], r.path) : joinPaths(r.path);
    const id = `${r.holder.id}::route${rn++}`;
    nodes.push({ id, label: `${r.method} ${shown}${r.handler ? `<br/>${r.handler}` : ''}`, kind: 'route' });
    edges.push({ from: r.holder.id, to: id, kind: 'route' });
  }
  return { nodes, edges };
}
