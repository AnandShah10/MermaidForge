// Applies each refactoring to sample diagrams and asks real Mermaid whether the result still parses.
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const { parseMermaid, removeUnusedNodes, extractSubgraph, renameNode, formatMermaid } = req('../.conformance-build/ref.cjs');
const cases = [
  ['remove class', 'classDiagram\nclass Animal {\n  +name string\n}\nclass Dog\nclass Lonely {\n  +x int\n}\nAnimal <|-- Dog', (d) => removeUnusedNodes(d)],
  ['remove er', 'erDiagram\nA ||--o{ B : has\nORPHAN {\n  int id PK\n}\nB {\n  int id\n}', (d) => removeUnusedNodes(d)],
  ['remove state', 'stateDiagram-v2\n[*] --> A\nA --> B\nstate "Floating" as F', (d) => removeUnusedNodes(d)],
  ['remove requirement', 'requirementDiagram\nrequirement r1 {\nid: 1\ntext: t\nrisk: low\nverifymethod: test\n}\nrequirement lonely {\nid: 2\ntext: t\nrisk: low\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\ne1 - satisfies -> r1', (d) => removeUnusedNodes(d)],
  ['remove c4', 'C4Context\nPerson(u,"U")\nSystem(s,"S")\nSystem(x,"X")\nRel(u,s,"uses")', (d) => removeUnusedNodes(d)],
  ['remove architecture', 'architecture-beta\nservice a(server)[A]\nservice b(server)[B]\nservice c(server)[C]\na:R -- L:b', (d) => removeUnusedNodes(d)],
  ['extract class', 'classDiagram\nclass A {\n  +x int\n}\nclass B\nclass C\nA <|-- B\nB --> C', (d) => extractSubgraph(d, ['A', 'B'], 'core', 'Core')],
  ['extract c4', 'C4Container\nPerson(u,"U")\nContainer(w,"Web","JS")\nContainer(a,"Api","Go")\nRel(u,w,"x")\nRel(w,a,"y")', (d) => extractSubgraph(d, ['w', 'a'], 'sys', 'My System')],
  ['extract architecture', 'architecture-beta\nservice a(server)[A]\nservice b(server)[B]\nservice c(server)[C]\na:R -- L:b\nb:R -- L:c', (d) => extractSubgraph(d, ['a', 'b'], 'grp', 'Backend')],
  ['extract state', 'stateDiagram-v2\n[*] --> A\nA --> B\nB --> C\nC --> D\nD --> [*]\nA : first', (d) => extractSubgraph(d, ['B', 'C'], 'mid', 'Mid')],
  ['extract state (declared)', 'stateDiagram-v2\n[*] --> A\nA --> B\nstate "Bee" as B\nB : the b\nB --> C', (d) => extractSubgraph(d, ['B', 'C'], 'grp', 'G')],
  ['extract block', 'block-beta\ncolumns 3\nA B C\nD:2 E\nA --> D', (d) => extractSubgraph(d, ['D', 'E'], 'low', 'Low')],
  ['rename class', 'classDiagram\nclass Animal {\n  +name string\n}\nAnimal <|-- Dog : is\nAnimal : +eat()\nnote for Animal "n"', (d) => renameNode(d, 'Animal', 'Beast')],
  ['rename er', 'erDiagram\nCUSTOMER ||--o{ ORDER : places\nCUSTOMER {\n  string name\n}', (d) => renameNode(d, 'CUSTOMER', 'CLIENT')],
  ['rename state', 'stateDiagram-v2\n[*] --> Idle\nIdle --> Busy : go\nstate Busy {\n  [*] --> W\n}', (d) => renameNode(d, 'Busy', 'Active')],
  ['rename sequence', 'sequenceDiagram\nparticipant A as Alice\nparticipant B\nA->>B: hi\nNote over A,B: hello', (d) => renameNode(d, 'A', 'Al')],
  ['rename flowchart', 'flowchart TD\nA[A thing]-->B\nB-->|A|C\nsubgraph S[A]\nC\nend', (d) => renameNode(d, 'C', 'Z')],
  ...Object.entries({
    sequence: 'sequenceDiagram\nparticipant A\nparticipant B\nloop every day\nA->>B: hi\nalt ok\nB-->>A: yes\nelse no\nB-->>A: no\nend\nend\nNote over A,B: done',
    class: 'classDiagram\nclass Animal {\n+name string\n    +eat() void\n}\nnamespace Zoo {\nclass Cat {\n+purr()\n}\nclass Dog\n}\nAnimal <|-- Cat',
    er: 'erDiagram\nCUSTOMER ||--o{ ORDER : places\n    CUSTOMER {\nstring name PK\n}',
    state: 'stateDiagram-v2\n[*] --> A\nstate A {\n[*] --> B\nB --> C\n--\nD --> E\n}\nnote right of A\ntext\nend note',
    requirement: 'requirementDiagram\nrequirement r1 {\nid: 1\ntext: hello\nrisk: low\nverifymethod: test\n}\nelement e1 {\ntype: sim\n}\ne1 - satisfies -> r1',
    c4: 'C4Container\nBoundary(b, "B") {\nContainer(w, "Web", "JS")\nBoundary(c, "C") {\nContainer(d, "Db", "SQL")\n}\n}\nRel(w, d, "x")',
    block: 'block-beta\ncolumns 3\nA B\nblock:grp\nC D\nend\nA --> C',
    gantt: 'gantt\ntitle T\ndateFormat YYYY-MM-DD\nsection One\nTask a :a1, 2024-01-01, 3d\nTask b :after a1, 2d\nsection Two\nTask c :2024-02-01, 1d',
    journey: 'journey\ntitle Day\nsection Morning\nWake: 3: Me\nCoffee: 5: Me',
    timeline: 'timeline\ntitle History\nsection Early\n2002 : LinkedIn\n2004 : Facebook : Google',
  }).map(([k, src]) => ['format ' + k, src, (d) => ({ ok: true, newSource: formatMermaid(d.sourceText) })]),
];
const RENDER_CHECKS = { 'extract state': ['mid', ['B', 'C']], 'extract state (declared)': ['grp', ['B', 'C']] };
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<body></body>');
await page.addScriptTag({ path: new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url).pathname });
let fail = 0;
for (const [name, src, op] of cases) {
  const before = await page.evaluate(async (s) => { try { await mermaid.parse(s); return null; } catch (e) { return String(e.message).split('\n')[0]; } }, src);
  const r = op(parseMermaid(src));
  if (!r.ok) { console.log(`FAIL ${name}: refactor refused: ${r.reason}`); fail++; continue; }
  const after = await page.evaluate(async (s) => { try { await mermaid.parse(s); return null; } catch (e) { return String(e.message).split('\n')[0]; } }, r.newSource);
  let ok = before === null && after === null;
  let renderNote = '';
  if (ok && /^(stateDiagram|block)/.test(r.newSource.trim())) {
    // Parsing alone is not enough: the result must also render, and a moved state must end up inside its composite.
    const parsed = parseMermaid(r.newSource);
    const renderErr = await page.evaluate(async (s) => { try { await mermaid.render('x' + Math.random().toString(36).slice(2), s); return null; } catch (e) { return String(e.message).split('\n')[0]; } }, r.newSource);
    if (renderErr) { ok = false; renderNote = ' render failed: ' + renderErr; }
    const chk = RENDER_CHECKS[name];
    if (ok && chk && parsed.kind === 'stateDiagram') {
      for (const id of chk[1]) if (parsed.states.get(id)?.parentId !== chk[0]) { ok = false; renderNote = ` state ${id} is not inside ${chk[0]} (parent=${parsed.states.get(id)?.parentId})`; }
    }
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${before ? ' (INPUT invalid: ' + before + ')' : ''}${after ? ' -> ' + after + '\n' + r.newSource : ''}${renderNote ? renderNote + '\n' + r.newSource : ''}`);
  if (!ok) fail++;
}
await browser.close();
process.exit(fail ? 1 : 0);
