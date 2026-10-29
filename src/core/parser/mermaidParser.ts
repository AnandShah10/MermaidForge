import { ParsedDiagram, ParseIssue } from '../diagram/types';
import { detectDiagramType, extractFrontmatter } from './detectDiagramType';
import { parseFlowchart } from './flowchartParser';
import { parseSequenceDiagram } from './sequenceParser';
import { parseClassDiagram } from './classParser';
import { parseErDiagram } from './erParser';
import { parseStateDiagram } from './stateParser';
import { parsePieDiagram } from './pieParser';
import { parseJourneyDiagram } from './journeyParser';
import { parseGitGraph } from './gitGraphParser';
import { parseTimelineDiagram } from './timelineParser';
import { parseMindmapDiagram } from './mindmapParser';
import { parseGanttDiagram } from './ganttParser';
import { parseSankeyDiagram } from './sankeyParser';
import { parseQuadrantDiagram } from './quadrantParser';
import { parseXyChartDiagram } from './xychartParser';
import { parsePacketDiagram } from './packetParser';
import { parseRequirementDiagram } from './requirementParser';
import { parseBlockDiagram } from './blockParser';
import { parseArchitectureDiagram } from './architectureParser';
import { parseC4Diagram } from './c4Parser';

/**
 * Parses arbitrary Mermaid source into a ParsedDiagram. This is the single
 * entry point every subsystem (preview, linter, formatter, complexity,
 * refactoring, AI context builder) should call — do not re-implement
 * diagram-type sniffing elsewhere.
 */
export function parseMermaid(source: string): ParsedDiagram {
  const kind = detectDiagramType(source);
  if (kind === 'flowchart') {
    return parseFlowchart(source);
  }
  if (kind === 'sequenceDiagram') {
    return parseSequenceDiagram(source);
  }
  if (kind === 'classDiagram') {
    return parseClassDiagram(source);
  }
  if (kind === 'erDiagram') {
    return parseErDiagram(source);
  }
  if (kind === 'stateDiagram') {
    return parseStateDiagram(source);
  }
  if (kind === 'pie') {
    return parsePieDiagram(source);
  }
  if (kind === 'journey') {
    return parseJourneyDiagram(source);
  }
  if (kind === 'gitGraph') {
    return parseGitGraph(source);
  }
  if (kind === 'timeline') {
    return parseTimelineDiagram(source);
  }
  if (kind === 'mindmap') {
    return parseMindmapDiagram(source);
  }
  if (kind === 'gantt') {
    return parseGanttDiagram(source);
  }
  if (kind === 'sankey') return parseSankeyDiagram(source);
  if (kind === 'quadrantChart') return parseQuadrantDiagram(source);
  if (kind === 'xychart') return parseXyChartDiagram(source);
  if (kind === 'packet') return parsePacketDiagram(source);
  if (kind === 'requirementDiagram') return parseRequirementDiagram(source);
  if (kind === 'block') return parseBlockDiagram(source);
  if (kind === 'architecture') return parseArchitectureDiagram(source);
  if (kind === 'c4') return parseC4Diagram(source);

  const { frontmatter, body } = extractFrontmatter(source);
  const parseIssues: ParseIssue[] = [];
  if (body.trim().length === 0) {
    parseIssues.push({
      message: 'Diagram source is empty.',
      severity: 'error',
      range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
    });
  }
  return {
    kind: 'unknown',
    bodyLines: body.split(/\r?\n/),
    frontmatter,
    parseIssues,
    sourceText: source,
  };
}

/** Extracts fenced ```mermaid code blocks from a Markdown document, with their source ranges. */
export interface MarkdownDiagramBlock {
  source: string;
  startLine: number; // line of the code fence content start (0-based)
  endLine: number; // last line of code content (0-based, inclusive)
}

export function extractMermaidBlocksFromMarkdown(markdown: string): MarkdownDiagramBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: MarkdownDiagramBlock[] = [];
  let inBlock = false;
  let start = -1;
  let buffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const fenceOpen = /^\s*```+\s*mermaid\s*$/i.test(lines[i]);
    const fenceClose = /^\s*```+\s*$/.test(lines[i]);
    if (!inBlock && fenceOpen) {
      inBlock = true;
      start = i + 1;
      buffer = [];
      continue;
    }
    if (inBlock && fenceClose) {
      blocks.push({ source: buffer.join('\n'), startLine: start, endLine: i - 1 });
      inBlock = false;
      continue;
    }
    if (inBlock) {
      buffer.push(lines[i]);
    }
  }
  return blocks;
}
