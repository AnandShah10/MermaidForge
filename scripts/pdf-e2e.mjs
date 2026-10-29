// End to end vector-PDF check on REAL Mermaid output: render in the built webview bundle,
// request the svgFlat export exactly like the extension host, convert, validate with qpdf + pdftotext.
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const { svgToPdfContent, buildSinglePageVectorPdf } = req('../.conformance-build/pdf.cjs');
const samples = {
  flowchart: ['flowchart TD\nA[Start]-->B{Ok?}\nB-->|yes| C[Done]', 'Start'],
  sequence: ['sequenceDiagram\nAlice->>Bob: Hello Bob', 'Hello Bob'],
  class: ['classDiagram\nAnimal <|-- Dog\nclass Animal {\n+name string\n}', 'Animal'],
  packet: ['packet-beta\n 0-15: "Source"\n 16-31: "Dest"', 'Source'],
  architecture: ['architecture-beta\n service s(server)[Web]\n service d(database)[Store]\n s:R -- L:d', 'Web'],
  sankey: ['sankey-beta\nA,B,10\nB,C,5', 'A'],
  xychart: ['xychart-beta\n title "Sales"\n x-axis [jan,feb]\n bar [1,2]', 'Sales'],
};
const dir = mkdtempSync(join(tmpdir(), 'pdfe2e-'));
const browser = await chromium.launch();
const page = await browser.newPage();
const msgs = [];
await page.exposeFunction('__post', (m) => msgs.push(m));
await page.setContent('<html><body><div id="error-panel"></div><div id="diagram-svg-host"></div></body></html>');
await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__post(m), getState: () => ({}), setState: () => {} }); });
await page.addScriptTag({ path: new URL('../dist/webview/previewMain.js', import.meta.url).pathname });
let fail = 0;
for (const [name, [src, word]] of Object.entries(samples)) {
  msgs.length = 0;
  await page.evaluate((s) => window.postMessage({ type: 'update', source: s, theme: 'default', background: '' }, '*'), src);
  await page.waitForSelector('#diagram-svg-host svg', { timeout: 15000 });
  await page.evaluate(() => window.postMessage({ type: 'exportRequest', format: 'svgFlat', scale: 1, background: '#ffffff' }, '*'));
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !msgs.some((m) => m.type === 'exportData'); i++) await new Promise((r) => setTimeout(r, 100));
  const m = msgs.find((x) => x.type === 'exportData');
  let status = 'ok  ', detail = '';
  try {
    const conv = svgToPdfContent(m.svgText, { background: '#ffffff' });
    const pdf = buildSinglePageVectorPdf({ widthPt: conv.widthPt, heightPt: conv.heightPt, contentStream: conv.contentStream, extGStates: conv.extGStates });
    const f = join(dir, name + '.pdf'); writeFileSync(f, pdf);
    execFileSync('qpdf', ['--check', f], { stdio: 'pipe' });
    const text = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' });
    if (!text.includes(word)) { status = 'FAIL'; detail = `text missing "${word}": ${JSON.stringify(text.slice(0, 60))}`; }
    detail ||= `${Math.round(conv.widthPt)}x${Math.round(conv.heightPt)}pt, ${conv.warnings.length} warning(s)`;
    execFileSync('pdftoppm', ['-png', '-r', '50', f, join(dir, name)]);
  } catch (e) { status = 'FAIL'; detail = String(e.message).split('\n')[0]; }
  if (status === 'FAIL') fail++;
  console.log(`${status} ${name} ${detail}`);
}
console.log('output dir', dir);
await browser.close();
process.exit(fail ? 1 : 0);
