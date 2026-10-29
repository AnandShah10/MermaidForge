import { describe, it, expect } from 'vitest';
import { parseFlowchart } from '../src/core/parser/flowchartParser';
import { buildAutoSteps, buildPresentationSteps, parseStepDirectives } from '../src/presentation/presentationEngine';

describe('buildAutoSteps', () => {
  it('creates one cumulative step per node in declaration order', () => {
    const diagram = parseFlowchart('flowchart TD\nA-->B\nB-->C');
    const steps = buildAutoSteps(diagram);
    expect(steps).toHaveLength(3);
    expect(steps[0].revealedNodeIds).toEqual(['A']);
    expect(steps[1].revealedNodeIds).toEqual(['A', 'B']);
    expect(steps[2].revealedNodeIds).toEqual(['A', 'B', 'C']);
  });

  it('returns an empty array for a diagram with no nodes', () => {
    const diagram = parseFlowchart('flowchart TD');
    expect(buildAutoSteps(diagram)).toEqual([]);
  });
});

describe('parseStepDirectives', () => {
  it('returns null when the diagram has no %% step: comments', () => {
    const diagram = parseFlowchart('flowchart TD\nA-->B');
    expect(parseStepDirectives(diagram)).toBeNull();
  });

  it('parses explicit cumulative steps with default labels', () => {
    const diagram = parseFlowchart('flowchart TD\n%% step: A\n%% step: B, C\nA-->B-->C');
    const steps = parseStepDirectives(diagram);
    expect(steps).not.toBeNull();
    expect(steps!.map((s) => s.revealedNodeIds)).toEqual([['A'], ['A', 'B', 'C']]);
    expect(steps![0].label).toBe('Step 1');
  });

  it('parses a custom label after a pipe', () => {
    const diagram = parseFlowchart('flowchart TD\n%% step: A | Introduce the client\nA-->B');
    const steps = parseStepDirectives(diagram);
    expect(steps![0].label).toBe('Introduce the client');
  });
});

describe('buildPresentationSteps', () => {
  it('prefers explicit directives over auto-generated steps', () => {
    const diagram = parseFlowchart('flowchart TD\n%% step: A, B\nA-->B-->C');
    const steps = buildPresentationSteps(diagram);
    expect(steps).toHaveLength(1);
    expect(steps[0].revealedNodeIds).toEqual(['A', 'B']);
  });

  it('falls back to auto steps when there are no directives', () => {
    const diagram = parseFlowchart('flowchart TD\nA-->B-->C');
    const steps = buildPresentationSteps(diagram);
    expect(steps).toHaveLength(3);
  });
});

import { buildPresentationPlan } from '../src/presentation/presentationEngine';
import { parseMermaid as parseAny } from '../src/core/parser/mermaidParser';

describe('buildPresentationPlan (non-flowchart kinds)', () => {
  it('class diagram: one cumulative step per class', () => {
    const p: any = buildPresentationPlan(parseAny('classDiagram\nclass A\nclass B\nA <|-- B'));
    expect(p.ok).toBe(true);
    expect(p.kind).toBe('classDiagram');
    expect(p.steps.map((s: any) => s.revealedNodeIds)).toEqual([['A'], ['A', 'B']]);
  });
  it('state diagram omits the [*] marker', () => {
    const p: any = buildPresentationPlan(parseAny('stateDiagram-v2\n[*] --> A\nA --> B'));
    expect(p.steps[p.steps.length - 1].revealedNodeIds).toEqual(['A', 'B']);
  });
  it('mindmap uses Mermaid node_<index> ids', () => {
    const p: any = buildPresentationPlan(parseAny('mindmap\n  root\n    a\n    b'));
    expect(p.steps[2].revealedNodeIds).toEqual(['node_0', 'node_1', 'node_2']);
  });
  it('honours %% step directives', () => {
    const p: any = buildPresentationPlan(parseAny('classDiagram\nclass A\nclass B\nclass C\nA <|-- B\nB <|-- C\n%% step: A, B | core\n%% step: C'));
    expect(p.steps.map((s: any) => s.label)).toEqual(['core', 'Step 2']);
    expect(p.steps[1].revealedNodeIds).toEqual(['A', 'B', 'C']);
  });
  it('sequence reveals one message per step, sankey one link per step', () => {
    const s: any = buildPresentationPlan(parseAny('sequenceDiagram\nA->>B: one\nB-->>A: two'));
    expect(s.ok).toBe(true);
    expect(s.kind).toBe('sequenceDiagram');
    expect(s.steps.map((x: any) => x.revealedNodeIds)).toEqual([['msg:0'], ['msg:0', 'msg:1']]);
    expect(s.steps[0].label).toBe('Step 1: A → B: one');
    const k: any = buildPresentationPlan(parseAny('sankey-beta\nA,B,10\nB,C,5'));
    expect(k.kind).toBe('sankey');
    expect(k.steps[0].revealedNodeIds).toEqual(['node:A', 'node:B', 'link:0']);
    expect(k.steps[1].revealedNodeIds).toEqual(['node:A', 'node:B', 'link:0', 'node:C', 'link:1']);
  });
  it('sequence without messages and sankey without links have nothing to present', () => {
    expect((buildPresentationPlan(parseAny('sequenceDiagram\nparticipant A')) as any).ok).toBe(false);
  });
  it('explains why pie is unavailable', () => {
    for (const src of ['pie\n"a":1']) {
      const p: any = buildPresentationPlan(parseAny(src));
      expect(p.ok).toBe(false);
      expect(p.reason).toBeTruthy();
    }
  });
});
