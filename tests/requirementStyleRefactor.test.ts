import { it, expect } from 'vitest';
import { parseMermaid } from '../src/core/parser/mermaidParser';
import { lintDiagram } from '../src/core/linter/linter';
import { removeUnusedNodes } from '../src/core/refactoring/refactoring';
it('requirement remove-unused cleans style references', () => {
  const src = 'requirementDiagram\nrequirement r1:::imp {\nid: 1\ntext: t\nrisk: high\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\nelement lonely {\ntype: x\n}\ne1 - satisfies -> r1\nclassDef imp fill:#f00\nclass r1,lonely imp\nclass lonely imp\nstyle lonely fill:#0f0';
  const r = removeUnusedNodes(parseMermaid(src)) as any;
  expect(r.ok).toBe(true);
  expect(r.newSource).toContain('class r1 imp');
  expect(r.newSource).not.toContain('lonely');
  expect(lintDiagram(parseMermaid(r.newSource)).filter((d) => /^style/.test(d.ruleId ?? ''))).toEqual([]);
});
