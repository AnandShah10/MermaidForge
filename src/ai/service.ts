import { AIProvider, ChatMessage, GenerateOptions } from './types';
import { AIContext } from './contextBuilder';
import { parseMermaid } from '../core/parser/mermaidParser';
import { lintDiagram, DEFAULT_LINT_CONFIG } from '../core/linter/linter';
import {
  buildAskUserPrompt,
  buildExplainUserPrompt,
  buildFixUserPrompt,
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  buildImproveUserPrompt,
  buildModifyUserPrompt,
  buildReviewUserPrompt,
} from './prompts/prompts';

export interface StructuredAIResponse {
  action: string;
  explanation: string;
  mermaid: string;
  warnings: string[];
}

export interface AIOperationResult {
  response: StructuredAIResponse;
  /** True when the returned "mermaid" parsed without errors against our own parser. Null when there was no mermaid to validate. */
  mermaidValid: boolean | null;
  validationIssues: string[];
}

/**
 * Parses a model's reply into StructuredAIResponse. Providers vary in how
 * reliably they honor "reply with only JSON" (see AICapabilities.jsonMode),
 * so this is deliberately permissive: it tries strict JSON.parse first, then
 * extracts a fenced ```json block, then falls back to extracting a fenced
 * ```mermaid block with the rest of the text as the explanation. It never
 * throws — a completely unparseable reply becomes an explanation-only result
 * with mermaid left empty, which the caller surfaces to the user rather than
 * silently applying something we couldn't make sense of.
 */
export function parseStructuredResponse(raw: string): StructuredAIResponse {
  const trimmed = raw.trim();

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return normalize(parsed);
    }
  } catch {
    // fall through
  }

  const jsonFence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (jsonFence) {
    try {
      const parsed = JSON.parse(jsonFence[1]);
      if (parsed && typeof parsed === 'object') return normalize(parsed);
    } catch {
      // fall through
    }
  }

  const mermaidFence = /```mermaid\s*([\s\S]*?)```/i.exec(trimmed);
  if (mermaidFence) {
    const explanation = trimmed.replace(mermaidFence[0], '').trim();
    return { action: 'unknown', explanation, mermaid: mermaidFence[1].trim(), warnings: ['Response was not valid JSON; extracted a fenced Mermaid block instead.'] };
  }

  return { action: 'unknown', explanation: trimmed, mermaid: '', warnings: ['Response was not valid JSON and contained no Mermaid code block.'] };
}

function normalize(obj: any): StructuredAIResponse {
  return {
    action: typeof obj.action === 'string' ? obj.action : 'unknown',
    explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
    mermaid: typeof obj.mermaid === 'string' ? obj.mermaid : '',
    warnings: Array.isArray(obj.warnings) ? obj.warnings.filter((w: unknown) => typeof w === 'string') : [],
  };
}

async function run(provider: AIProvider, system: string, user: string, options: GenerateOptions): Promise<AIOperationResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const result = await provider.chat(messages, options);
  const response = parseStructuredResponse(result.text);
  return validate(response);
}

function validate(response: StructuredAIResponse): AIOperationResult {
  if (!response.mermaid.trim()) {
    return { response, mermaidValid: null, validationIssues: [] };
  }
  const diagram = parseMermaid(response.mermaid);
  const diagnostics = lintDiagram(diagram, DEFAULT_LINT_CONFIG);
  const errors = diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  return { response, mermaidValid: errors.length === 0, validationIssues: errors };
}

export const AIService = {
  async generateDiagram(provider: AIProvider, request: string, options: GenerateOptions): Promise<AIOperationResult> {
    return run(provider, buildGenerateSystemPrompt(), buildGenerateUserPrompt(request), options);
  },

  async modifyDiagram(provider: AIProvider, context: AIContext, instruction: string, options: GenerateOptions): Promise<AIOperationResult> {
    return run(provider, buildGenerateSystemPrompt(), buildModifyUserPrompt(context, instruction), options);
  },

  async explainDiagram(provider: AIProvider, context: AIContext, options: GenerateOptions): Promise<AIOperationResult> {
    return run(provider, buildGenerateSystemPrompt(), buildExplainUserPrompt(context), options);
  },

  async fixDiagram(provider: AIProvider, context: AIContext, parseErrors: string[], options: GenerateOptions): Promise<AIOperationResult> {
    return run(provider, buildGenerateSystemPrompt(), buildFixUserPrompt(context, parseErrors), options);
  },

  async improveDiagram(provider: AIProvider, context: AIContext, options: GenerateOptions): Promise<AIOperationResult> {
    return run(provider, buildGenerateSystemPrompt(), buildImproveUserPrompt(context), options);
  },

  async askAboutDiagram(provider: AIProvider, context: AIContext, question: string, options: GenerateOptions): Promise<AIOperationResult> {
    return run(provider, buildGenerateSystemPrompt(), buildAskUserPrompt(context, question), options);
  },

  async reviewArchitecture(provider: AIProvider, context: AIContext, options: GenerateOptions): Promise<AIOperationResult> {
    return run(provider, buildGenerateSystemPrompt(), buildReviewUserPrompt(context), options);
  },
};
