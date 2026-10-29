import { AIContext } from '../contextBuilder';

/**
 * Every diagram-mutating/explaining prompt asks the model to reply with a
 * single JSON object matching this shape. Not every provider supports native
 * structured output/JSON mode (see AICapabilities), so ai/service.ts treats
 * this as a strong instruction, not a guarantee, and falls back to permissive
 * parsing (see parseStructuredResponse) when a provider replies with prose or
 * a fenced code block instead.
 */
export const RESPONSE_SCHEMA_INSTRUCTIONS = `Respond with a single JSON object and nothing else (no markdown fences, no commentary outside the JSON), matching exactly this shape:
{
  "action": "generate" | "explain" | "modify" | "review",
  "explanation": string,
  "mermaid": string,
  "warnings": string[]
}
- "mermaid" must be valid Mermaid source (omit it, or leave it as an empty string, for pure explanations that don't propose a diagram).
- "warnings" should note anything you were unsure about or could not do.`;

const SYSTEM_PREAMBLE = `You are an expert Mermaid diagram assistant embedded in a VS Code extension called MermaidForge. You help developers, architects, and technical writers create and refine Mermaid diagrams. You are precise about Mermaid syntax and never invent syntax that does not exist. When modifying an existing diagram, preserve everything the user did not ask you to change.`;

export function buildGenerateSystemPrompt(): string {
  return `${SYSTEM_PREAMBLE}\n\n${RESPONSE_SCHEMA_INSTRUCTIONS}`;
}

export function buildGenerateUserPrompt(request: string): string {
  return `Generate a new Mermaid diagram for this request:\n\n${request}\n\nChoose the most appropriate diagram type (flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, etc.) for the request unless the user specified one.`;
}

export function buildModifyUserPrompt(context: AIContext, instruction: string): string {
  return [
    `Here is the current Mermaid diagram:`,
    '```mermaid',
    context.diagramSource,
    '```',
    context.lintFindings.length ? `Known lint findings:\n${context.lintFindings.join('\n')}` : '',
    `Instruction: ${instruction}`,
    `Modify the diagram to satisfy the instruction. Keep everything else about the diagram the same — do not rename, reorder, or restyle anything the instruction doesn't ask you to change.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildExplainUserPrompt(context: AIContext): string {
  return [
    `Here is a Mermaid diagram:`,
    '```mermaid',
    context.diagramSource,
    '```',
    `Explain what this diagram represents in clear, concise language a teammate unfamiliar with it could follow. Describe the overall structure first, then call out anything notable (bottlenecks, cycles, isolated nodes) if relevant.`,
    `Leave "mermaid" empty in your response — this is an explanation only.`,
  ].join('\n\n');
}

export function buildFixUserPrompt(context: AIContext, parseErrors: string[]): string {
  return [
    `This Mermaid diagram fails to parse:`,
    '```mermaid',
    context.diagramSource,
    '```',
    `Parser errors:\n${parseErrors.map((e) => `- ${e}`).join('\n')}`,
    `Fix the syntax errors while changing as little else as possible. Return the corrected diagram in "mermaid".`,
  ].join('\n\n');
}

export function buildImproveUserPrompt(context: AIContext): string {
  return [
    `Here is a Mermaid diagram:`,
    '```mermaid',
    context.diagramSource,
    '```',
    context.lintFindings.length ? `Lint findings to address if reasonable:\n${context.lintFindings.join('\n')}` : '',
    context.complexitySummary ? `Complexity metrics: ${context.complexitySummary}` : '',
    `Improve this diagram: reduce unnecessary complexity, group related nodes into subgraphs where it clarifies structure, fix any lint issues you can, and improve labels for clarity. Preserve the diagram's intent — do not remove real information.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildAskUserPrompt(context: AIContext, question: string): string {
  return [
    `Here is a Mermaid diagram:`,
    '```mermaid',
    context.diagramSource,
    '```',
    `Question: ${question}`,
    `Answer the question about this diagram. Leave "mermaid" empty — this is a question, not a modification request.`,
  ].join('\n\n');
}

export function buildReviewUserPrompt(context: AIContext): string {
  return [
    `Here is a Mermaid architecture diagram:`,
    '```mermaid',
    context.diagramSource,
    '```',
    context.complexitySummary ? `Complexity metrics: ${context.complexitySummary}` : '',
    `Review this as a software architect. Look for: missing authentication/authorization boundaries, single points of failure, circular dependencies, poor layering, excessive coupling, inconsistent naming, missing observability or retries, suspicious synchronous dependencies between services, unclear boundaries, overloaded services, and database bottlenecks.`,
    `Clearly label your findings as suggestions, not established facts — you are reasoning from the diagram alone, not the real system. Put your review in "explanation" as a structured list. Leave "mermaid" empty unless you are proposing a concrete diagram change, in which case explain why in "explanation" first.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
