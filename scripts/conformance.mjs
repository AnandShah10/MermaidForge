// Runs every corpus sample through real Mermaid (in headless Chromium) and
// through MermaidForge's parser, and reports disagreements.
// usage: node scripts/conformance.mjs   (needs dist/ built by `node esbuild.js`? no — uses tsx-free bundle below)
import { createRequire as cr } from 'node:module';
const { chromium } = cr(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const corpus = JSON.parse(readFileSync(new URL('./conformance-corpus.json', import.meta.url)));
const extra = existsSync(new URL('./conformance-extra.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('./conformance-extra.json', import.meta.url))) : {};
for (const [k, v] of Object.entries(extra)) { corpus[k] ??= { valid: [], invalid: [] }; corpus[k].valid.push(...(v.valid ?? [])); corpus[k].invalid.push(...(v.invalid ?? [])); }
const { parseMermaid, lintDiagram } = require('../.conformance-build/parser.cjs');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ path: new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url).pathname });
await page.evaluate(() => mermaid.initialize({ startOnLoad: false }));
let bad = 0, total = 0;
for (const [type, { valid, invalid }] of Object.entries(corpus)) {
  for (const [expectOk, list] of [[true, valid], [false, invalid]]) {
    for (const src of list) {
      total++;
      const r = await page.evaluate(async (s) => { try { await mermaid.parse(s); return { ok: true }; } catch (e) { return { ok: false, err: String(e.message ?? e).split('\n')[0] }; } }, src);
      const d = parseMermaid(src);
      // "flagged" = a parse error, an unrecognised statement, or a lint *error* (the linter's errors are the ones Mermaid would also reject or fail to render).
      const flags = [...d.parseIssues.filter((i) => i.severity === 'error' || /^(Unrecognized statement|Unknown C4 macro)/.test(i.message)).map((i) => i.message), ...lintDiagram(d).filter((x) => x.severity === 'error').map((x) => x.message)];
      const ours = flags.length === 0;
      const tag = `${type} [expect ${expectOk ? 'valid' : 'invalid'}]`;
      if (r.ok !== expectOk) { console.log(`CORPUS-vs-MERMAID ${tag}: mermaid says ${r.ok ? 'valid' : 'invalid'} (${r.err ?? ''})\n  ${JSON.stringify(src).slice(0, 160)}`); bad++; }
      else if (ours !== r.ok) { console.log(`PARSER-vs-MERMAID ${tag}: ours ${ours ? 'accepts' : 'rejects'} (${flags.join(' | ')})\n  ${JSON.stringify(src).slice(0, 160)}`); bad++; }
    }
  }
}
await browser.close();
console.log(`${total - bad}/${total} agree`);
process.exit(bad ? 1 : 0);
