// Real-Mermaid check of presentation mode and click-to-source: for each presentable kind, render in the
// built webview bundle, start presentation at step 1, and verify that the first node stays visible while
// other nodes (and, where Mermaid gives edges ids, edges) get dimmed. Needs `npm run build` + the entry bundle
// (esbuild .conformance-build/pres-entry.ts --bundle --platform=node --format=cjs --outfile=.conformance-build/pres.cjs).
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const { parseMermaid, buildPresentationPlan } = req('../.conformance-build/pres.cjs');
const samples = {
  flowchart: 'flowchart TD\nA[Start]-->B{Ok}\nB-->|yes|C\nC-->D',
  classDiagram: 'classDiagram\nclass Animal {\n+name string\n}\nAnimal <|-- Dog : is\nDog --> Cat',
  erDiagram: 'erDiagram\nCUSTOMER ||--o{ ORDER : places\nORDER ||--|{ ITEM : has',
  stateDiagram: 'stateDiagram-v2\n[*] --> Idle\nIdle --> Busy : go\nBusy --> Done\nDone --> [*]',
  requirementDiagram: 'requirementDiagram\nrequirement r1 {\nid: 1\ntext: t\nrisk: low\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\nelement e2 {\ntype: sim\n}\ne1 - satisfies -> r1\ne2 - satisfies -> r1',
  c4: 'C4Context\nPerson(u,"U")\nSystem(s,"S")\nSystem(t,"T")\nRel(u,s,"x")\nRel(s,t,"y")',
  architecture: 'architecture-beta\nservice a(server)[A]\nservice b(database)[B]\nservice c(server)[C]\na:R -- L:b\nb:R -- L:c',
  block: 'block-beta\ncolumns 3\na["A"] b["B"] c["C"]\na --> b\nb --> c',
  mindmap: 'mindmap\n  root\n    alpha\n    beta\n      gamma',
  sequenceDiagram: 'sequenceDiagram\nparticipant A\nparticipant B\nA->>B: one\nB-->>A: two\nNote over A,B: n\nA-)B: three',
  sankey: 'sankey-beta\nA,B,10\nB,C,5\nA,C,3',
};
const browser = await chromium.launch();
const page = await browser.newPage();
const msgs = [];
await page.exposeFunction('__post', (m) => msgs.push(m));
await page.setContent('<html><body><div id="error-panel"></div><div id="diagram-svg-host"></div></body></html>');
await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__post(m), getState: () => ({}), setState: () => {} }); });
await page.addScriptTag({ path: new URL('../dist/webview/previewMain.js', import.meta.url).pathname });
let fail = 0;
for (const [kind, src] of Object.entries(samples)) {
  const plan = buildPresentationPlan(parseMermaid(src));
  if (!plan.ok) { console.log(`FAIL ${kind}: ${plan.reason}`); fail++; continue; }
  await page.evaluate((s) => window.postMessage({ type: 'update', source: s, theme: 'default', background: '' }, '*'), src);
  await page.waitForSelector('#diagram-svg-host svg', { timeout: 15000 });
  await page.evaluate((p) => window.postMessage({ type: 'presentationStart', kind: p.kind, steps: p.steps }, '*'), plan);
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => ({
    dimmed: document.querySelectorAll('#diagram-svg-host .mf-presentation-dimmed').length,
    total: document.querySelectorAll('#diagram-svg-host g.node, #diagram-svg-host g.architecture-service, #diagram-svg-host g.mindmap-node').length,
    undimmedNodes: [...document.querySelectorAll('#diagram-svg-host g.node, #diagram-svg-host g.architecture-service')].filter((e) => !e.classList.contains('mf-presentation-dimmed')).length,
  }));
  const exact = kind === 'sequenceDiagram' ? await page.evaluate(() => document.querySelectorAll('#diagram-svg-host text.messageText.mf-presentation-dimmed').length) : kind === 'sankey' ? await page.evaluate(() => document.querySelectorAll('#diagram-svg-host g.link.mf-presentation-dimmed').length) : null;
  // after the last step nothing may be dimmed
  await page.evaluate((n) => { for (let i = 1; i < n; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); }, plan.steps.length);
  await page.waitForTimeout(100);
  const last = await page.evaluate(() => document.querySelectorAll('#diagram-svg-host .mf-presentation-dimmed').length);
  const ok = r.dimmed > 0 && last === 0 && (['mindmap', 'sequenceDiagram', 'sankey'].includes(kind) || r.undimmedNodes >= 1);
  if (exact !== null && exact !== 2) { console.log(`FAIL ${kind}: expected 2 of 3 messages/links dimmed at step 1, got ${exact}`); fail++; }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${kind}: step1 dimmed=${r.dimmed}, visible nodes=${r.undimmedNodes}/${r.total}, dimmed after last step=${last}`);
  if (!ok) fail++;
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
}
// click-to-source on a flowchart
msgs.length = 0;
await page.evaluate((s) => window.postMessage({ type: 'update', source: s, theme: 'default', background: '' }, '*'), samples.flowchart);
await page.waitForSelector('#diagram-svg-host g.node');
await page.click('#diagram-svg-host g.node >> nth=0');
await page.waitForTimeout(100);
const clicked = msgs.find((m) => m.type === 'nodeClicked');
console.log(`${clicked ? 'ok  ' : 'FAIL'} click-to-source ${clicked ? clicked.nodeId : ''}`);
if (!clicked) fail++;
await browser.close();
process.exit(fail ? 1 : 0);
