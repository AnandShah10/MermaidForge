// Loads the built webview bundle (dist/webview/previewMain.js) in headless Chromium with a stub
// VS Code API, sends it diagrams the way the extension host does, and checks an <svg> appears.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const samples = {
  flowchart: 'flowchart TD\nA-->B',
  packet: 'packet-beta\n 0-15: "Src"\n 16-31: "Dst"',
  architecture: 'architecture-beta\n group api(cloud)[API]\n service db(database)[DB] in api\n service s(server)[S] in api\n db:L -- R:s',
  sankey: 'sankey-beta\nA,B,10\nB,C,5',
  xychart: 'xychart-beta\n x-axis [a,b]\n bar [1,2]',
  quadrant: 'quadrantChart\n x-axis L --> H\n y-axis L --> H\n P: [0.3,0.6]',
  block: 'block-beta\n columns 2\n a b',
  c4: 'C4Context\n Person(u,"U")\n System(s,"S")\n Rel(u,s,"x")',
  requirement: 'requirementDiagram\n requirement r {\n id: 1\n text: t\n risk: low\n verifymethod: test\n }',
};
const browser = await chromium.launch();
const page = await browser.newPage();
const msgs = [];
await page.exposeFunction('__post', (m) => msgs.push(m));
await page.setContent('<html><body><div id="error-panel"></div><div id="diagram-svg-host"></div></body></html>');
await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__post(m), getState: () => ({}), setState: () => {} }); });
await page.addScriptTag({ path: new URL('../dist/webview/previewMain.js', import.meta.url).pathname });
let fail = 0;
for (const [name, src] of Object.entries(samples)) {
  msgs.length = 0;
  await page.evaluate((s) => window.postMessage({ type: 'update', source: s, theme: 'default', background: '' }, '*'), src);
  await page.waitForFunction(() => document.querySelector('#diagram-svg-host svg') || document.querySelector('#error-panel').textContent, null, { timeout: 15000 }).catch(() => {});
  const r = await page.evaluate(() => ({ svg: !!document.querySelector('#diagram-svg-host svg'), err: document.querySelector('#error-panel').textContent }));
  console.log(`${r.svg && !r.err ? 'ok  ' : 'FAIL'} ${name} ${r.err}`);
  if (!r.svg || r.err) fail++;
  await page.evaluate(() => { document.querySelector('#diagram-svg-host').innerHTML = ''; document.querySelector('#error-panel').textContent = ''; });
}
await browser.close();
process.exit(fail ? 1 : 0);
