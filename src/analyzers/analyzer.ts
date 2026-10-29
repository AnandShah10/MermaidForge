/**
 * Generic shape every "code → Mermaid" analyzer implements, so adding a new
 * language or a new kind of extraction (call graphs, component trees, route
 * maps, ...) means writing a function of this shape (or, for class diagrams,
 * returning ExtractedClass/ExtractedRelationship) and adding an entry to
 * `registry.ts` — not touching the command that calls it. See the registry
 * for the languages and analyses that exist; each analyzer's own module
 * comment documents what it does NOT handle.
 */

export interface SourceFileInput {
  /** Workspace-relative or otherwise stable path, used as the basis for node ids and display labels. */
  path: string;
  text: string;
}

export interface CodeGraphNode {
  id: string;
  label: string;
  /** Free-form category the analyzer assigns (e.g. "file", "class", "interface") — not interpreted by callers beyond display. */
  kind: string;
}

export interface CodeGraphEdge {
  from: string;
  to: string;
  label?: string;
  kind: string;
}

export interface CodeGraph {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
}

export interface CodeAnalyzer {
  id: string;
  displayName: string;
  /** File extensions this analyzer can meaningfully process, e.g. ['.ts', '.tsx']. */
  supportedExtensions: string[];
  analyze(files: SourceFileInput[]): CodeGraph;
}
