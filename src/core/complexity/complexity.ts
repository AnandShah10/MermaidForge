import { ParsedDiagram } from '../diagram/types';
import { GraphProjection, projectGraph } from '../diagram/graphProjection';

export interface ComplexityReport {
  supported: true;
  nodeCount: number;
  edgeCount: number;
  density: number; // edges / (nodes * (nodes - 1)) for a directed graph
  subgraphCount: number;
  connectedComponents: number;
  cycles: string[][]; // list of node-id cycles found (simple cycles, best-effort)
  longestPathLength: number; // in edges, 0 if cyclic (undefined for cyclic graphs)
  maxFanIn: { nodeId: string; count: number } | null;
  maxFanOut: { nodeId: string; count: number } | null;
  estimatedEdgeCrossings: number;
  complexityScore: number; // 0-10
  recommendation: string;
}

export interface UnsupportedComplexityReport {
  supported: false;
  reason: string;
}

export function analyzeComplexity(diagram: ParsedDiagram, threshold = 7): ComplexityReport | UnsupportedComplexityReport {
  const graph = projectGraph(diagram);
  if (!graph) {
    return {
      supported: false,
      reason: `Complexity analysis needs a node/edge structure; "${diagram.kind}" diagrams don't have one.`,
    };
  }
  if (!graph.analyzable) {
    return {
      supported: false,
      reason: `Complexity metrics aren't meaningful for "${diagram.kind}" diagrams (request/reply message pairs form cycles by design).`,
    };
  }
  return analyzeGraphComplexity(graph, threshold);
}

function analyzeGraphComplexity(diagram: GraphProjection, threshold: number): ComplexityReport {
  const nodeIds = [...diagram.nodes.keys()];
  const n = nodeIds.length;
  const e = diagram.edges.length;

  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
    reverseAdjacency.set(id, []);
  }
  for (const edge of diagram.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!reverseAdjacency.has(edge.target)) reverseAdjacency.set(edge.target, []);
    adjacency.get(edge.source)!.push(edge.target);
    reverseAdjacency.get(edge.target)!.push(edge.source);
  }

  const density = n > 1 ? e / (n * (n - 1)) : 0;

  const connectedComponents = countConnectedComponents(nodeIds, adjacency, reverseAdjacency);
  const cycles = findSimpleCycles(nodeIds, adjacency);
  const longestPathLength = cycles.length === 0 ? longestPathInDag(nodeIds, adjacency) : 0;

  let maxFanIn: { nodeId: string; count: number } | null = null;
  let maxFanOut: { nodeId: string; count: number } | null = null;
  for (const id of nodeIds) {
    const inCount = reverseAdjacency.get(id)?.length ?? 0;
    const outCount = adjacency.get(id)?.length ?? 0;
    if (!maxFanIn || inCount > maxFanIn.count) maxFanIn = { nodeId: id, count: inCount };
    if (!maxFanOut || outCount > maxFanOut.count) maxFanOut = { nodeId: id, count: outCount };
  }

  // Edge-crossing estimate: for a non-planar-aware layout, approximate via
  // the classic bound of a random layout — this is a heuristic signal, not a
  // geometric computation (we don't run layout here), used only to flag
  // diagrams likely to render messily.
  const estimatedEdgeCrossings = Math.max(0, Math.round((e * (e - 1)) / Math.max(1, 4 * n)));

  const subgraphCount = diagram.groups.size;

  const complexityScore = computeScore({
    n,
    e,
    density,
    cyclesCount: cycles.length,
    maxFanOut: maxFanOut?.count ?? 0,
    subgraphCount,
  });

  const recommendation = buildRecommendation(complexityScore, threshold, n, subgraphCount);

  return {
    supported: true,
    nodeCount: n,
    edgeCount: e,
    density: round(density, 4),
    subgraphCount,
    connectedComponents,
    cycles,
    longestPathLength,
    maxFanIn,
    maxFanOut,
    estimatedEdgeCrossings,
    complexityScore: round(complexityScore, 1),
    recommendation,
  };
}

function countConnectedComponents(nodeIds: string[], adj: Map<string, string[]>, radj: Map<string, string[]>): number {
  const visited = new Set<string>();
  let components = 0;
  for (const start of nodeIds) {
    if (visited.has(start)) continue;
    components++;
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const next of [...(adj.get(cur) ?? []), ...(radj.get(cur) ?? [])]) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
  }
  return components;
}

/** Best-effort simple-cycle detection via DFS with a recursion stack; caps output to avoid blowup on dense graphs. */
function findSimpleCycles(nodeIds: string[], adj: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const MAX_CYCLES = 20;
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  function dfs(node: string) {
    if (cycles.length >= MAX_CYCLES) return;
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (cycles.length >= MAX_CYCLES) break;
      if (onStack.has(next)) {
        const startIdx = stack.indexOf(next);
        cycles.push(stack.slice(startIdx));
      } else if (!visited.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    onStack.delete(node);
  }

  for (const id of nodeIds) {
    if (!visited.has(id) && cycles.length < MAX_CYCLES) dfs(id);
  }
  return cycles;
}

function longestPathInDag(nodeIds: string[], adj: Map<string, string[]>): number {
  const memo = new Map<string, number>();
  function visit(node: string, guard: Set<string>): number {
    if (memo.has(node)) return memo.get(node)!;
    if (guard.has(node)) return 0; // defensive; shouldn't happen in an acyclic graph
    guard.add(node);
    let best = 0;
    for (const next of adj.get(node) ?? []) {
      best = Math.max(best, 1 + visit(next, guard));
    }
    guard.delete(node);
    memo.set(node, best);
    return best;
  }
  let overall = 0;
  for (const id of nodeIds) overall = Math.max(overall, visit(id, new Set()));
  return overall;
}

function computeScore(input: { n: number; e: number; density: number; cyclesCount: number; maxFanOut: number; subgraphCount: number }): number {
  // Deterministic, explainable weighting — not a black box. Each term is
  // capped before weighting so one extreme dimension can't blow past 10 alone.
  const sizeTerm = Math.min(4, input.n / 15); // scales up to 4 pts at ~60 nodes
  const edgeTerm = Math.min(3, input.e / 25); // up to 3 pts at ~75 edges
  const densityTerm = Math.min(1.5, input.density * 15);
  const cycleTerm = Math.min(1, input.cyclesCount * 0.3);
  const fanOutTerm = Math.min(0.5, Math.max(0, input.maxFanOut - 5) * 0.1);
  return sizeTerm + edgeTerm + densityTerm + cycleTerm + fanOutTerm;
}

function buildRecommendation(score: number, threshold: number, n: number, subgraphCount: number): string {
  if (score < threshold) {
    return 'Complexity is within a comfortable range for a single diagram.';
  }
  const suggestedParts = Math.max(2, Math.min(5, Math.ceil(n / 20)));
  if (subgraphCount > 0) {
    return `Complexity score exceeds the configured threshold (${threshold}). Consider splitting along existing subgraph boundaries into roughly ${suggestedParts} focused diagrams.`;
  }
  return `Complexity score exceeds the configured threshold (${threshold}). Consider grouping related nodes into subgraphs, or splitting into roughly ${suggestedParts} focused diagrams.`;
}

function round(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
