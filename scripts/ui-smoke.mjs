// Headless-Chromium check of the diagram webview as the extension serves it: real HTML template with its real CSP,
// real bundle, stub VS Code API. Covers: error clears after the source is fixed (no stray Mermaid error elements),
// PNG export under the CSP, export with a different theme than the live one, toolbar per mode, comment badges.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
// Always bundle the current HTML templates, so the test never runs against stale CSS.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const tplOut = path.join(os.tmpdir(), `mf-tpl-${process.pid}.cjs`);
execFileSync('npx', ['esbuild', new URL('./ui-smoke-entry.ts', import.meta.url).pathname, '--bundle', '--platform=node', '--format=cjs', `--outfile=${tplOut}`, '--log-level=error'], { stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname });
require(tplOut);
const bundle = fs.readFileSync(new URL('../dist/webview/previewMain.js', import.meta.url), 'utf8');
let fail = 0;
const check = (ok, name, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : extra}`); if (!ok) fail++; };

const browser = await chromium.launch();
async function open(mode) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const msgs = [];
  await page.exposeFunction('__post', (m) => msgs.push(m));
  let html = globalThis.__tpl(mode);
  const nonce = /script-src 'nonce-([^']+)'/.exec(html)[1];
  html = html.replace(/<script nonce="[^"]+" src="[^"]*"><\/script>/, '')
    .replace('</body>', () => `<script nonce="${nonce}">window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__post(m),getState:()=>({}),setState:()=>{}});</script><script nonce="${nonce}">${bundle.replace(/<\/script/g, '<\\/script')}</script></body>`);
  const cspErrors = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message)); page.on('console', (m) => { if (m.type()==='error') console.log('CONSOLE', m.text().slice(0,300)); });
  await page.setContent(html);
  await page.waitForFunction(() => !!document.getElementById('mf-toolbar')?.children.length);
  return { page, msgs, cspErrors };
}
const send = (page, m) => page.evaluate((x) => window.postMessage(x, '*'), m);
const settle = (page) => page.waitForTimeout(700);

// --- viewer mode: toolbar + error recovery + PNG export
{
  const { page, msgs, cspErrors } = await open('viewer');
  const labels = await page.$$eval('#mf-toolbar button', (b) => b.map((x) => x.textContent));
  check(labels.includes('← Return to code') && labels.includes('Present') && labels.includes('Studio') && labels.some((l) => l.startsWith('Export')), 'viewer toolbar buttons', labels.join('|'));

  await send(page, { type: 'update', source: 'flowchart TD\nA-->B', theme: 'default', background: 'auto', kind: 'flowchart' });
  await settle(page);
  check(await page.$$eval('#diagram-svg-host svg', (e) => e.length) === 1, 'good diagram renders');

  await send(page, { type: 'update', source: 'flowchart TD\nA--> ((( ]]', theme: 'default', background: 'auto', kind: 'flowchart' });
  await settle(page);
  const bad = await page.evaluate(() => ({ err: getComputedStyle(document.getElementById('error-panel')).display, strays: document.querySelectorAll('body > svg, body > [id^="dmermaid"], body > [id^="mermaidforge"]').length }));
  check(bad.err === 'block', 'syntax error is shown');
  check(bad.strays === 0, 'no stray Mermaid error graphics left in the page', JSON.stringify(bad));

  await send(page, { type: 'update', source: 'flowchart TD\nA-->B-->C', theme: 'default', background: 'auto', kind: 'flowchart' });
  await settle(page);
  const good = await page.evaluate(() => ({ err: getComputedStyle(document.getElementById('error-panel')).display, svgs: document.querySelectorAll('svg[aria-roledescription]').length, strays: document.querySelectorAll('body > svg, body > [id^="dmermaid"]').length }));
  check(good.err === 'none' && good.svgs === 1 && good.strays === 0, 'error clears once the source is fixed', JSON.stringify(good));

  for (const [theme, label] of [[undefined, 'live theme'], ['dark', 'different theme (offscreen re-render)']]) {
    msgs.length = 0;
    await send(page, { type: 'exportRequest', format: 'png', scale: 2, background: 'white', theme });
    await page.waitForTimeout(1500);
    const r = msgs.find((m) => m.type === 'exportData');
    check(r?.ok && /^data:image\/png;base64,/.test(r.dataUrl) && r.dataUrl.length > 2000, `PNG export under CSP – ${label}`, JSON.stringify(r)?.slice(0, 200));
  }
  msgs.length = 0;
  await send(page, { type: 'exportRequest', format: 'svg', scale: 2, background: 'white', theme: 'dark' });
  await page.waitForTimeout(1200);
  const svg = msgs.find((m) => m.type === 'exportData');
  check(svg?.ok && svg.svgText.includes('<svg') && !(await page.evaluate(() => document.getElementById('mf-export-holder')?.children.length)), 'SVG export with other theme cleans its offscreen copy');
  check(cspErrors.length === 0, 'no CSP violations', cspErrors.join('\n'));

  msgs.length = 0;
  await page.click('#mf-toolbar .mf-menu > button');
  await page.click('.mf-menu-list button:text("PNG")');
  check(msgs.some((m) => m.type === 'toolbar' && m.action === 'export' && m.format === 'png'), 'Export ▾ → PNG posts toolbar message');
  msgs.length = 0;
  await page.click('button:text("← Return to code")');
  check(msgs.some((m) => m.type === 'toolbar' && m.action === 'returnToCode'), 'Return to code posts toolbar message');

  // Fit: diagram must fit inside the container
  await page.click('button:text("Fit")');
  const fit = await page.evaluate(() => { const r = document.querySelector('#diagram-svg-host svg').getBoundingClientRect(); const c = document.getElementById('diagram-container').getBoundingClientRect(); return r.width <= c.width + 1 && r.height <= c.height + 1; });
  check(fit, 'Fit keeps the diagram inside the view');

  // Centering: wide, tall and tiny diagrams all sit in the middle of the view, on first render and after +/−
  const centered = () => page.evaluate(() => {
    const r = document.querySelector('#diagram-svg-host svg').getBoundingClientRect();
    const c = document.getElementById('diagram-container').getBoundingClientRect();
    return Math.abs((r.left + r.right) / 2 - (c.left + c.right) / 2) < 3 && Math.abs((r.top + r.bottom) / 2 - (c.top + c.bottom) / 2) < 3;
  });
  const shapes = {
    wide: 'flowchart LR\n' + Array.from({ length: 14 }, (_, i) => `N${i}-->N${i + 1}`).join('\n'),
    tall: 'flowchart TD\n' + Array.from({ length: 14 }, (_, i) => `N${i}-->N${i + 1}`).join('\n'),
    tiny: 'flowchart TD\nA',
  };
  for (const [name, src] of Object.entries(shapes)) {
    await send(page, { type: 'update', source: src, theme: 'default', background: 'auto', kind: 'flowchart' });
    await settle(page);
    check(await centered(), `${name} diagram is centred on open`, JSON.stringify(await page.evaluate(() => ({ r: document.querySelector('#diagram-svg-host svg').getBoundingClientRect().toJSON(), c: document.getElementById('diagram-container').getBoundingClientRect().toJSON(), t: document.getElementById('diagram-svg-host').style.transform, w: document.querySelector('#diagram-svg-host svg').getAttribute('width') }))));
  }
  await page.click('button[title="Zoom in"]');
  check(await centered(), 'stays centred after zoom in');
  await page.click('button:text("Fit")');
  check(await centered(), 'centred after Fit');

  // Comments
  await send(page, { type: 'comments', kind: 'flowchart', items: [{ id: '1', targetType: 'node', targetId: 'A', author: 'me', text: 'check this', resolved: false }, { id: '2', targetType: 'diagram', targetId: null, author: 'me', text: 'general', resolved: false }] });
  await page.waitForTimeout(300);
  check(await page.$$eval('g.mf-badge', (e) => e.length) === 1, 'comment badge drawn on the commented node');
  await page.click('button[title="Show comments"]');
  check(await page.$$eval('#mf-comments-popover .mf-comment', (e) => e.length) === 2, 'comments popover lists node and diagram comments');
  await page.close();
}

// --- other modes' toolbars
for (const [mode, must, mustNot] of [['preview', ['Viewer', 'Present', 'Studio'], ['← Return to code']], ['presentation', ['← Return to code'], ['Present']], ['studio', ['Viewer', 'Present'], ['Studio']]]) {
  const { page } = await open(mode);
  const labels = await page.$$eval('#mf-toolbar button', (b) => b.map((x) => x.textContent));
  check(must.every((m) => labels.includes(m)) && mustNot.every((m) => !labels.includes(m)), `${mode} toolbar`, labels.join('|'));
  await page.close();
}

// --- dark VS Code theme: auto → Mermaid dark theme, no white slab
{
  const { page } = await open('viewer');
  await page.evaluate(() => document.body.classList.add('vscode-dark'));
  await send(page, { type: 'update', source: 'flowchart TD\nA-->B', theme: 'auto', background: 'auto', kind: 'flowchart' });
  await settle(page);
  const dark = await page.evaluate(() => document.querySelector('#diagram-svg-host svg').outerHTML.includes('#333') || document.querySelector('#diagram-svg-host svg').outerHTML.includes('#1f2020') || document.querySelector('#diagram-svg-host svg').outerHTML.includes('#ccc'));
  check(dark, 'auto theme follows a dark VS Code theme');
  await page.close();
}
await browser.close();
process.exit(fail ? 1 : 0);
