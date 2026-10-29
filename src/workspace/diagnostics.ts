import * as vscode from 'vscode';
import { parseMermaid, extractMermaidBlocksFromMarkdown } from '../core/parser/mermaidParser';
import { DEFAULT_LINT_CONFIG, LintRuleConfig, lintDiagram } from '../core/linter/linter';

const DEBOUNCE_MS = 400;

export class DiagnosticsController implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('mermaidForge');
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleLint(e.document)),
      vscode.workspace.onDidOpenTextDocument((doc) => this.scheduleLint(doc, 0)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri)),
    );
  }

  lintAllOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.scheduleLint(doc, 0);
    }
  }

  private scheduleLint(document: vscode.TextDocument, delay = DEBOUNCE_MS): void {
    if (!this.isRelevant(document)) return;
    const config = vscode.workspace.getConfiguration('mermaidForge');
    if (!config.get<boolean>('linter.enabled', true)) {
      this.collection.delete(document.uri);
      return;
    }

    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => this.lintDocument(document), delay),
    );
  }

  private isRelevant(document: vscode.TextDocument): boolean {
    return document.languageId === 'mermaid' || document.languageId === 'markdown';
  }

  private lintDocument(document: vscode.TextDocument): void {
    const config = vscode.workspace.getConfiguration('mermaidForge');
    const ruleConfig: LintRuleConfig = {
      duplicateNode: config.get('linter.rules.duplicateNode') ?? DEFAULT_LINT_CONFIG.duplicateNode,
      duplicateEdge: config.get('linter.rules.duplicateEdge') ?? DEFAULT_LINT_CONFIG.duplicateEdge,
      unreachableNode: config.get('linter.rules.unreachableNode') ?? DEFAULT_LINT_CONFIG.unreachableNode,
      emptySubgraph: config.get('linter.rules.emptySubgraph') ?? DEFAULT_LINT_CONFIG.emptySubgraph,
      invalidReference: config.get('linter.rules.invalidReference') ?? DEFAULT_LINT_CONFIG.invalidReference,
      longLabel: config.get('linter.rules.longLabel') ?? DEFAULT_LINT_CONFIG.longLabel,
      longLabelThreshold: config.get('linter.longLabelThreshold') ?? DEFAULT_LINT_CONFIG.longLabelThreshold,
    };

    const diagnostics: vscode.Diagnostic[] = [];

    if (document.languageId === 'mermaid') {
      diagnostics.push(...this.lintSource(document.getText(), 0, ruleConfig));
    } else {
      const blocks = extractMermaidBlocksFromMarkdown(document.getText());
      for (const block of blocks) {
        diagnostics.push(...this.lintSource(block.source, block.startLine, ruleConfig));
      }
    }

    this.collection.set(document.uri, diagnostics);
  }

  private lintSource(source: string, lineOffset: number, ruleConfig: LintRuleConfig): vscode.Diagnostic[] {
    if (source.trim().length === 0) return [];
    const diagram = parseMermaid(source);
    const findings = lintDiagram(diagram, ruleConfig);
    return findings.map((f) => {
      const range = new vscode.Range(
        new vscode.Position(lineOffset + f.range.startLine, f.range.startCol),
        new vscode.Position(lineOffset + f.range.endLine, Math.max(f.range.endCol, f.range.startCol + 1)),
      );
      const severity =
        f.severity === 'error' ? vscode.DiagnosticSeverity.Error : f.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const diag = new vscode.Diagnostic(range, f.message, severity);
      diag.source = 'MermaidForge';
      diag.code = f.ruleId;
      return diag;
    });
  }

  dispose(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
    this.collection.dispose();
  }
}
