// Checks the styling lint rules against real Mermaid. For every case the SAME diagram is rendered with and
// without the styling statement: a statement the linter flags must change nothing (or, where the rule is an
// error, make Mermaid throw), and a clean statement must change the SVG. Run after
// `esbuild .conformance-build/gantt-entry.ts --bundle --platform=node --format=cjs --outfile=.conformance-build/gantt.cjs`.
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const { parseMermaid, lintDiagram } = req('../.conformance-build/gantt.cjs');

const REQ = 'requirementDiagram\nrequirement r1 {\nid: 1\ntext: t\nrisk: high\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\ne1 - satisfies -> r1\nclassDef imp fill:#f00,stroke:#000';
const BLK = 'block-beta\ncolumns 2\na b\nclassDef k fill:#f00';
const C4 = 'C4Context\nPerson(a, "A")\nSystem(b, "B")\nSystem(c, "C")\nRel(a, b, "uses")';
const QUAD = 'quadrantChart\nx-axis L --> R\ny-axis L --> H\nquadrant-1 a\nquadrant-2 b\nquadrant-3 c\nquadrant-4 d\nclassDef k color: #f00, radius: 20';
// [name, base diagram, statement, expectation]: 'effect' (clean, must change SVG), 'noop' (flagged warning, SVG unchanged), 'throws' (flagged error)
const cases = [
  ['req class applies', REQ, 'class r1 imp', 'effect'],
  ['req style applies', REQ, 'style e1 fill:#0f0', 'effect'],
  ['req ::: applies', REQ.replace('requirement r1 {', 'requirement r1:::imp {'), '', 'effect', REQ],
  ['req class unknown class', REQ, 'class r1 nope', 'noop'],
  ['req class unknown target', REQ, 'class ghost imp', 'noop'],
  ['req style unknown target', REQ, 'style ghost fill:#0f0', 'noop'],
  ['block class applies', BLK, 'class a k', 'effect'],
  ['block style applies', BLK, 'style b fill:#0f0', 'effect'],
  ['block class unknown target', BLK, 'class ghost k', 'noop'],
  ['block style unknown target', BLK, 'style ghost fill:#0f0', 'throws'],
  ['c4 element style applies', C4, 'UpdateElementStyle(a, $bgColor="red")', 'effect'],
  ['c4 rel style applies', C4, 'UpdateRelStyle(a, b, $textColor="red", $lineColor="blue")', 'effect'],
  ['c4 element style unknown', C4, 'UpdateElementStyle(zzz, $bgColor="red")', 'noop'],
  ['c4 rel style unknown alias', C4, 'UpdateRelStyle(a, zzz, $textColor="red")', 'noop'],
  ['c4 rel style no such rel', C4, 'UpdateRelStyle(a, c, $textColor="red")', 'noop'],
  ['c4 rel style reversed', C4, 'UpdateRelStyle(b, a, $textColor="red")', 'noop'],
  ['quadrant class applies', QUAD + '\nP:::k: [0.3, 0.6]', '', 'effect', QUAD + '\nP: [0.3, 0.6]'],
  ['quadrant unknown class', QUAD + '\nP:::nope: [0.3, 0.6]', '', 'noop', QUAD + '\nP: [0.3, 0.6]'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<body><div id="h"></div></body>');
await page.addScriptTag({ path: new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url).pathname });
await page.evaluate(() => mermaid.initialize({ startOnLoad: false, deterministicIds: true, deterministicIDSeed: 'x' }));
// Visual signature = computed fill / stroke / colour of every element in the rendered SVG, so an extra CSS class
// name or an unused rule in the embedded <style> (which Mermaid adds for unknown targets) does not count as an effect.
const render = (text) => page.evaluate(async (t) => {
  try {
    const { svg } = await mermaid.render('r' + Math.random().toString(36).slice(2, 8), t);
    const h = document.getElementById('h');
    h.innerHTML = svg;
    return [...h.querySelectorAll('svg *')].map((el) => { const c = getComputedStyle(el); return `${el.tagName}|${c.fill}|${c.stroke}|${c.color}|${c.strokeWidth}`; }).join('\n');
  } catch (e) { return 'THROWS'; }
}, text);

let fail = 0;
for (const [name, base, stmt, expect, baseline] of cases) {
  const withStmt = base + (stmt ? '\n' + stmt : '');
  const [a, b] = [await render(baseline ?? base), await render(withStmt)];
  const diags = lintDiagram(parseMermaid(withStmt)).filter((d) => /^style(Unknown|Unused)/.test(d.ruleId ?? '') && d.ruleId !== 'styleUnusedClass');
  const outcome = b === 'THROWS' ? 'throws' : a === b ? 'noop' : 'effect';
  const flagged = diags.length > 0;
  const ok = outcome === expect && flagged === (expect !== 'effect') && (expect !== 'throws' || diags.some((d) => d.severity === 'error'));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: Mermaid ${outcome} (expected ${expect}), lint ${flagged ? diags.map((d) => d.severity).join('/') : 'clean'}`);
  if (!ok) fail++;
}
await browser.close();
if (fail) process.exit(1);
