// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { applyPresentationStep, clearPresentationDimming } from '../src/webviews/media/presentation';

function makeSvg(): Document {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <svg>
      <g id="flowchart-A-1"></g>
      <g id="flowchart-B-2"></g>
      <g id="flowchart-C-3"></g>
      <path id="L-A-B-0"></path>
      <path id="L-B-C-0"></path>
      <text>unrelated element with no id pattern match</text>
    </svg>
  </body>`);
  return dom.window.document;
}

describe('applyPresentationStep', () => {
  it('dims nodes not yet revealed and leaves revealed ones undimmed', () => {
    const doc = makeSvg();
    applyPresentationStep(doc, new Set(['A']));
    expect(doc.getElementById('flowchart-A-1')!.classList.contains('mf-presentation-dimmed')).toBe(false);
    expect(doc.getElementById('flowchart-B-2')!.classList.contains('mf-presentation-dimmed')).toBe(true);
    expect(doc.getElementById('flowchart-C-3')!.classList.contains('mf-presentation-dimmed')).toBe(true);
  });

  it('dims an edge when either endpoint is not yet revealed', () => {
    const doc = makeSvg();
    applyPresentationStep(doc, new Set(['A']));
    expect(doc.getElementById('L-A-B-0')!.classList.contains('mf-presentation-dimmed')).toBe(true);
  });

  it('undims an edge once both endpoints are revealed', () => {
    const doc = makeSvg();
    applyPresentationStep(doc, new Set(['A', 'B']));
    expect(doc.getElementById('L-A-B-0')!.classList.contains('mf-presentation-dimmed')).toBe(false);
    expect(doc.getElementById('L-B-C-0')!.classList.contains('mf-presentation-dimmed')).toBe(true);
  });

  it('re-applying a later step undims previously-dimmed nodes', () => {
    const doc = makeSvg();
    applyPresentationStep(doc, new Set(['A']));
    applyPresentationStep(doc, new Set(['A', 'B', 'C']));
    expect(doc.getElementById('flowchart-B-2')!.classList.contains('mf-presentation-dimmed')).toBe(false);
    expect(doc.getElementById('flowchart-C-3')!.classList.contains('mf-presentation-dimmed')).toBe(false);
  });

  it('does not throw or misfire on elements whose id matches no known pattern', () => {
    const doc = makeSvg();
    expect(() => applyPresentationStep(doc, new Set())).not.toThrow();
  });
});

describe('clearPresentationDimming', () => {
  it('removes all dimming classes', () => {
    const doc = makeSvg();
    applyPresentationStep(doc, new Set(['A']));
    clearPresentationDimming(doc);
    expect(doc.querySelectorAll('.mf-presentation-dimmed').length).toBe(0);
  });
});

describe('applyPresentationStep with Mermaid 11 ids', () => {
  it('handles the per-render prefix for flowcharts and splits edges by known ids', () => {
    const dom = new JSDOM(`<body><svg>
      <g id="mermaidforge-123-flowchart-A_1-0" class="node"></g>
      <g id="mermaidforge-123-flowchart-B-1" class="node"></g>
      <path id="mermaidforge-123-L_A_1_B_0"></path>
    </svg></body>`);
    const doc = dom.window.document;
    applyPresentationStep(doc, new Set(['A_1']), 'flowchart', new Set(['A_1', 'B']));
    expect(doc.getElementById('mermaidforge-123-flowchart-A_1-0')!.classList.contains('mf-presentation-dimmed')).toBe(false);
    expect(doc.getElementById('mermaidforge-123-flowchart-B-1')!.classList.contains('mf-presentation-dimmed')).toBe(true);
    expect(doc.getElementById('mermaidforge-123-L_A_1_B_0')!.classList.contains('mf-presentation-dimmed')).toBe(true);
  });
  it('class and ER ids', () => {
    const dom = new JSDOM(`<body><svg>
      <g id="p-classId-Dog-1" class="node"></g><g id="p-classId-Cat-2" class="node"></g><path id="p-id_Dog_Cat_1"></path>
      <g id="p-entity-A-0" class="node"></g><g id="p-entity-B-1" class="node"></g><path id="p-id_entity-A-0_entity-B-1_0"></path>
    </svg></body>`);
    const doc = dom.window.document;
    // the 'p-' prefix is not a render prefix, so these exercise the bare-id path via renamed ids
    for (const el of Array.from(doc.querySelectorAll('[id]'))) el.id = el.id.replace(/^p-/, '');
    applyPresentationStep(doc, new Set(['Dog']), 'classDiagram', new Set(['Dog', 'Cat']));
    expect(doc.getElementById('classId-Dog-1')!.classList.contains('mf-presentation-dimmed')).toBe(false);
    expect(doc.getElementById('classId-Cat-2')!.classList.contains('mf-presentation-dimmed')).toBe(true);
    expect(doc.getElementById('id_Dog_Cat_1')!.classList.contains('mf-presentation-dimmed')).toBe(true);
    applyPresentationStep(doc, new Set(['A', 'B']), 'erDiagram', new Set(['A', 'B']));
    expect(doc.getElementById('id_entity-A-0_entity-B-1_0')!.classList.contains('mf-presentation-dimmed')).toBe(false);
  });
});

describe('presentation id scheme guard', () => {
  it('returns 0 matched nodes when ids do not look like Mermaid output (so the webview can warn)', () => {
    const dom = new JSDOM('<body><svg><g id="something-else"></g></svg></body>');
    expect(applyPresentationStep(dom.window.document, new Set(['A']), 'flowchart')).toBe(0);
  });
  it('the installed Mermaid is the version whose ids were verified; re-run scripts/presentation-smoke.mjs before changing this', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const installed = JSON.parse(require('node:fs').readFileSync(require.resolve('mermaid/package.json'), 'utf8')).version;
    expect(installed).toBe('12.2.0');
  });
});

describe('applyPresentationStep: sequence and sankey (matched by document order)', () => {
  const seqDoc = () =>
    new JSDOM(`<body><svg>
      <text class="messageText">one</text><line class="messageLine0"></line>
      <text class="messageText">two</text><path class="messageLine1"></path>
      <text class="messageText">three</text><line class="messageLine0"></line>
    </svg></body>`).window.document;
  const known = new Set(['msg:0', 'msg:1', 'msg:2']);
  it('sequence: dims later messages together with their lines', () => {
    const doc = seqDoc();
    const n = applyPresentationStep(doc, new Set(['msg:0']), 'sequenceDiagram', known);
    expect(n).toBe(3);
    const dimmed = [...doc.querySelectorAll('.mf-presentation-dimmed')].map((e) => e.getAttribute('class')?.replace(' mf-presentation-dimmed', ''));
    expect(dimmed).toEqual(['messageText', 'messageLine1', 'messageText', 'messageLine0']);
  });
  it('sequence: returns 0 and dims nothing when the message count differs', () => {
    const doc = seqDoc();
    expect(applyPresentationStep(doc, new Set(['msg:0']), 'sequenceDiagram', new Set(['msg:0', 'msg:1']))).toBe(0);
    expect(doc.querySelectorAll('.mf-presentation-dimmed').length).toBe(0);
  });
  const sankeyDoc = () =>
    new JSDOM(`<body><svg>
      <g class="nodes"><g class="node"></g><g class="node"></g><g class="node"></g></g>
      <g class="node-labels"><text>A\n13</text><text>B\n10</text><text>C\n8</text></g>
      <g class="links"><g class="link"></g><g class="link"></g></g>
    </svg></body>`).window.document;
  const sk = new Set(['node:A', 'node:B', 'node:C', 'link:0', 'link:1']);
  it('sankey: reveals nodes and links cumulatively', () => {
    const doc = sankeyDoc();
    expect(applyPresentationStep(doc, new Set(['node:A', 'node:B', 'link:0']), 'sankey', sk)).toBe(3);
    expect(doc.querySelectorAll('g.node.mf-presentation-dimmed').length).toBe(1);
    expect(doc.querySelectorAll('text.mf-presentation-dimmed').length).toBe(1);
    expect(doc.querySelectorAll('g.link.mf-presentation-dimmed').length).toBe(1);
  });
  it('sankey: refuses when labels do not match the expected node names', () => {
    const doc = sankeyDoc();
    expect(applyPresentationStep(doc, new Set(['node:A']), 'sankey', new Set(['node:A', 'node:B', 'node:X', 'link:0', 'link:1']))).toBe(0);
    expect(doc.querySelectorAll('.mf-presentation-dimmed').length).toBe(0);
  });
});
