import { LintDiagnostic } from '../core/linter/linter';
import { ComplexityReport, UnsupportedComplexityReport } from '../core/complexity/complexity';

export interface AIContext {
  diagramSource: string;
  diagramSummary: string;
  lintFindings: string[];
  complexitySummary: string | null;
  /** Human-readable description of exactly what was included, shown to the user before sending. */
  disclosureText: string;
  estimatedTokens: number;
}

export interface AIContextInput {
  diagramSource: string;
  sendSourceContext: boolean;
  lintDiagnostics?: LintDiagnostic[];
  complexity?: ComplexityReport | UnsupportedComplexityReport;
  maxContextTokens: number;
}

/** Extremely rough token estimate (chars/4) — good enough for a soft budget, not billing-accurate. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Builds the context block sent to an AI provider for diagram-aware
 * requests. Nothing beyond the current diagram (and, if present, its lint/
 * complexity findings — both derived locally, not sent externally otherwise)
 * is ever included unless a future workspace-context feature explicitly asks
 * the user first (see mermaidForge.ai.sendWorkspaceContext, currently unused
 * by any shipped command — no command sends source files today).
 */
export function buildDiagramContext(input: AIContextInput): AIContext {
  if (!input.sendSourceContext) {
    return {
      diagramSource: '',
      diagramSummary: '(diagram source not sent — mermaidForge.ai.sendSourceContext is disabled)',
      lintFindings: [],
      complexitySummary: null,
      disclosureText: 'No diagram content will be sent — "Send source context" is disabled in settings.',
      estimatedTokens: 0,
    };
  }

  let source = input.diagramSource;
  const budget = Math.max(500, input.maxContextTokens);
  let truncated = false;
  if (estimateTokens(source) > budget) {
    const charBudget = budget * 4;
    source = source.slice(0, charBudget) + '\n%% [truncated to fit context budget]';
    truncated = true;
  }

  const lintFindings = (input.lintDiagnostics ?? [])
    .filter((d) => d.severity !== 'information')
    .slice(0, 25)
    .map((d) => `- [${d.severity}] ${d.message}`);

  let complexitySummary: string | null = null;
  if (input.complexity?.supported) {
    const c = input.complexity;
    complexitySummary = `nodes=${c.nodeCount}, edges=${c.edgeCount}, density=${c.density}, cycles=${c.cycles.length}, complexityScore=${c.complexityScore}/10`;
  }

  const disclosureParts = ['the current diagram source'];
  if (lintFindings.length) disclosureParts.push(`${lintFindings.length} lint finding(s)`);
  if (complexitySummary) disclosureParts.push('complexity metrics');
  if (truncated) disclosureParts.push('(source truncated to fit the context budget)');

  return {
    diagramSource: source,
    diagramSummary: `Diagram source (${source.length} chars${truncated ? ', truncated' : ''})`,
    lintFindings,
    complexitySummary,
    disclosureText: `Sending: ${disclosureParts.join(', ')}.`,
    estimatedTokens: estimateTokens(source) + lintFindings.join('\n').length / 4,
  };
}
